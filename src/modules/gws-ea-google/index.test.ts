import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { resolveCapabilities, skillsWithinCapabilities } from '../../capabilities.js';
import type { ContainerConfig } from '../../container-config.js';
import { composeSessionSpec } from '../../container-runner.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import type { AgentGroup, Session } from '../../types.js';
import { AGENT_GOOGLE_SERVICES, TAUGHT_GOOGLE_SERVICES, type TaughtGoogleServiceId } from './grant.js';
import '../capabilities/index.js';
import './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-google-skills-test';
const SKILLS_DIR = path.resolve('container', 'skills');
const GOOGLE_KEYS = ['google-calendar', 'google-mail-read', 'google-directory'];

/** The exact gog commands each service's key enables. A change here changes what agents may run. */
const GOG_COMMANDS: Readonly<Record<TaughtGoogleServiceId, readonly string[]>> = {
  calendar: [
    'calendar.calendars',
    'calendar.subscribe',
    'calendar.unsubscribe',
    'calendar.events',
    'calendar.event',
    'calendar.freebusy',
    'calendar.update',
    'calendar.delete',
    'calendar.respond',
  ],
  'gmail-read': ['gmail.search', 'gmail.messages.search', 'gmail.thread.get', 'gmail.get'],
  directory: ['people.search'],
};

/** What each Google Calendar rule must keep saying; agents in every group rely on them. */
const REQUIRED_CALENDAR_RULES = [
  'Use the `gog` command, through Bash, for everything you do in Google Calendar but two: create an event with the `create_event` tool, and change who an event invites with `change_guests`.',
  'never run `gog auth`',
  "A calendar is the principal's when its ID is one of the principal's addresses (their primary calendar) or its `dataOwner` is one of those addresses.",
  'Treat every other calendar as someone else',
  'restoring it is the operator',
  'Never send anyone a link to sign in as you',
];

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-10-01T00:00:00.000Z' };
}

async function createGroup(
  value: AgentGroup,
  config: { skills?: readonly string[]; capabilities?: readonly string[] } = {},
): Promise<void> {
  await createAgentGroup(value);
  await ensureContainerConfig(value.id);
  if (config.skills) await updateContainerConfigJson(value.id, 'skills', [...config.skills]);
  if (config.capabilities) await updateContainerConfigJson(value.id, 'capabilities', [...config.capabilities]);
}

async function configOf(agentGroupId: string): Promise<unknown> {
  const row = await getContainerConfig(agentGroupId);
  return row && { ...row, updated_at: undefined };
}

async function startHost(): Promise<void> {
  const signal = new AbortController().signal;
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal });
}

/** The gog settings a spawn gives a group holding these capabilities, from the real composition. */
function gogSettingsAtSpawn(capabilities: readonly string[]): Record<string, string> {
  const agent = composeSessionSpec({
    agentGroup: group('ag-spawned', 'spawned'),
    session: { id: 'session-1', agent_group_id: 'ag-spawned' } as Session,
    containerName: 'nanoclaw-v2-ag-spawned-1700000000000',
    mounts: [],
    containerConfig: { capabilities: [...capabilities] } as unknown as ContainerConfig,
    mailboxEnvironment: {},
    contribution: {},
    gateway: { networkAccess: { endpoint: 'localhost', target: { kind: 'host' } } },
  }).containers[0];
  return Object.fromEntries(
    Object.entries({ ...agent.env, ...agent.contributedEnv }).filter(([key]) => key.startsWith('GOG_')),
  );
}

/** A skill's SKILL.md, which it must ship, and its instructions.md when it has one. */
function readSkill(skill: string): string {
  const instructions = path.join(SKILLS_DIR, skill, 'instructions.md');
  const resident = fs.existsSync(instructions) ? fs.readFileSync(instructions, 'utf8') : '';
  return `${fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8')}\n${resident}`;
}

/** Every gog command a skill shows in code, as gog's dot path (`gog calendar events …` is `calendar.events`). */
function taughtGogCommands(skill: string): string[] {
  return [...readSkill(skill).matchAll(/`gog((?: [a-z][a-z-]*)+)/gu)]
    .map((match) => match[1].trim().split(' '))
    .filter((words) => words.length > 1)
    .map((words) => words.join('.'));
}

beforeEach(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe('Google capabilities', () => {
  it("bounds each service's skill by its key", () => {
    const skills = ['agent-browser', 'gcalendar', 'gmail', 'gpeople'];
    const calendarOnly = new Set(['shell', 'google-calendar']);
    expect(skillsWithinCapabilities(skills, calendarOnly)).toEqual(['agent-browser', 'gcalendar']);
    expect(skillsWithinCapabilities(skills, new Set(['shell']))).toEqual(['agent-browser']);
    expect(skillsWithinCapabilities(skills, new Set(resolveCapabilities('all', 'main')))).toEqual(skills);
  });
});

describe("the Google services' skills", () => {
  it("rewrites no group's configuration when the host starts", async () => {
    await createGroup(group('ag-research', 'research'), { skills: ['agent-browser'] });
    await createGroup(group('ag-scheduler', 'scheduler'), { skills: ['agent-browser', 'gcalendar'] });
    await createGroup(group('ag-open', 'open'));
    await createGroup(group('ag-restricted', 'restricted'), { capabilities: ['reply'] });
    const before = await Promise.all(['ag-research', 'ag-scheduler', 'ag-open', 'ag-restricted'].map(configOf));

    await startHost();
    await startHost();

    expect(await Promise.all(['ag-research', 'ag-scheduler', 'ag-open', 'ag-restricted'].map(configOf))).toEqual(
      before,
    );
  });

  it('ships the Calendar skill with rules that need nothing only main is given', () => {
    for (const file of ['SKILL.md', 'instructions.md']) {
      const text = fs.readFileSync(path.join(SKILLS_DIR, 'gcalendar', file), 'utf8');
      expect(text, `gcalendar/${file}`).not.toMatch(/Executive Assistant/u);
    }
    const rules = fs.readFileSync(path.join(SKILLS_DIR, 'gcalendar', 'instructions.md'), 'utf8');
    for (const rule of REQUIRED_CALENDAR_RULES) expect(rules).toContain(rule);
  });

  it("puts a service's rules in the document of a group that selects its skill and holds its key, and in no other", async () => {
    const open = group('ag-open', 'open');
    const listed = group('ag-listed', 'listed');
    const withoutKey = group('ag-without-key', 'without-key');
    await createGroup(open);
    await createGroup(listed, { skills: ['agent-browser'] });
    await createGroup(withoutKey, {
      capabilities: resolveCapabilities('all', 'without-key').filter((key) => key !== 'google-calendar'),
    });
    await startHost();
    const rules = fs.readFileSync(path.join(SKILLS_DIR, 'gcalendar', 'instructions.md'), 'utf8').trim();

    const compose = async (value: AgentGroup): Promise<string> => {
      const groupDir = path.join(TEST_ROOT, value.folder);
      await composeGroupProjectDoc(value, groupDir, { fileName: 'CLAUDE.md' });
      return fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    };

    expect(await compose(open)).toContain(`# NanoClaw Skill: gcalendar\n\n${rules}`);
    expect(await compose(listed)).not.toContain('`gog`');
    expect(await compose(withoutKey)).not.toContain('`gog`');
  });

  it('ships each service skill under its own name, allowed to run gog', () => {
    for (const id of TAUGHT_GOOGLE_SERVICES) {
      const { skill } = AGENT_GOOGLE_SERVICES[id];
      const text = fs.readFileSync(path.join(SKILLS_DIR, skill, 'SKILL.md'), 'utf8');
      expect(text, skill).toMatch(
        new RegExp(`^---\\nname: ${skill}\\ndescription: .+\\nallowed-tools: Bash\\(gog:\\*\\)\\n---\\n`, 'u'),
      );
    }
  });

  it("teaches in each service's skill only the gog commands its key enables", () => {
    for (const id of TAUGHT_GOOGLE_SERVICES) {
      const { skill } = AGENT_GOOGLE_SERVICES[id];
      const taught = taughtGogCommands(skill);
      expect(taught.length, skill).toBeGreaterThan(0);
      for (const command of taught) expect(GOG_COMMANDS[id], `${skill} teaches ${command}`).toContain(command);
    }
    expect(taughtGogCommands('gcalendar')).toContain('calendar.respond');
  });

  it('keeps the Gmail skill to reading', () => {
    expect(readSkill('gmail')).not.toMatch(
      /\b(?:send|sends|sending|sent|drafts?|labels?|modify|modifies|modifying)\b/iu,
    );
  });
});

describe("gog's settings at spawn", () => {
  it('gives main, on `all`, exactly the commands of every Google service, with Gmail sending off', () => {
    expect(gogSettingsAtSpawn(resolveCapabilities('all', 'main'))).toEqual({
      GOG_ACCESS_TOKEN: 'gateway-managed',
      GOG_ENABLE_COMMANDS_EXACT: TAUGHT_GOOGLE_SERVICES.flatMap((id) => GOG_COMMANDS[id]).join(','),
      GOG_GMAIL_NO_SEND: '1',
      GOG_JSON: '1',
      GOG_WRAP_UNTRUSTED: '1',
    });
  });

  it('enables only the commands of the Google keys a group holds', () => {
    expect(gogSettingsAtSpawn(['shell', 'google-mail-read']).GOG_ENABLE_COMMANDS_EXACT).toBe(
      GOG_COMMANDS['gmail-read'].join(','),
    );
    expect(gogSettingsAtSpawn(['shell', 'google-calendar', 'google-directory']).GOG_ENABLE_COMMANDS_EXACT).toBe(
      [...GOG_COMMANDS.calendar, ...GOG_COMMANDS.directory].join(','),
    );
  });

  it('gives a group without a Google key no gog settings at all', () => {
    const everythingElse = resolveCapabilities('all', 'other').filter((key) => !GOOGLE_KEYS.includes(key));

    expect(gogSettingsAtSpawn(everythingElse)).toEqual({});
    expect(gogSettingsAtSpawn([])).toEqual({});
  });
});
