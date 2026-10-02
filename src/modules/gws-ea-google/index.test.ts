import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import type { AgentGroup } from '../../types.js';
import { EXPOSED_GOOGLE_SERVICES, EXPOSED_GOOGLE_SKILLS, GOOGLE_SERVICES } from './grant.js';
import './index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-google-skills-test';
const SKILLS_DIR = path.resolve('container', 'skills');

/** What each Google Calendar rule must keep saying; agents in every group rely on them. */
const REQUIRED_CALENDAR_RULES = [
  'Use the `gog` command, through Bash, for everything you do in Google Calendar.',
  'never run `gog auth`',
  "A calendar is the principal's when its ID is one of the principal's addresses (their primary calendar) or its `dataOwner` is one of those addresses.",
  'Treat every other calendar as someone else',
  'restoring it is the operator',
  'Never send anyone a link to sign in as you',
];

function group(id: string, name: string): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-10-01T00:00:00.000Z' };
}

async function createGroup(value: AgentGroup, skills?: readonly string[]): Promise<void> {
  await createAgentGroup(value);
  await ensureContainerConfig(value.id);
  if (skills) await updateContainerConfigJson(value.id, 'skills', [...skills]);
}

async function skillsOf(agentGroupId: string): Promise<unknown> {
  const row = await getContainerConfig(agentGroupId);
  return row === undefined ? undefined : JSON.parse(row.skills);
}

async function startHost(): Promise<void> {
  const signal = new AbortController().signal;
  const deliveryAdapter = { deliver: async () => undefined };
  for (const start of getHostStartCallbacks()) await start({ db: getDb(), deliveryAdapter, signal });
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

describe("the Google services' skills", () => {
  it('names one skill per exposed service, and none for a service not yet exposed', () => {
    expect(EXPOSED_GOOGLE_SKILLS).toEqual(EXPOSED_GOOGLE_SERVICES.map((id) => GOOGLE_SERVICES[id].skill));
    expect(EXPOSED_GOOGLE_SKILLS).toContain('gcalendar');
    expect(EXPOSED_GOOGLE_SKILLS).not.toContain(GOOGLE_SERVICES.gmail.skill);
  });

  it('gives every agent group that lists its skills the exposed services’ skills, keeping what it has', async () => {
    await createGroup(group('ag-research', 'research'), ['agent-browser']);
    await createGroup(group('ag-scheduler', 'scheduler'), ['agent-browser', ...EXPOSED_GOOGLE_SKILLS]);
    await createGroup(group('ag-open', 'open'));

    await startHost();
    await startHost();

    expect(await skillsOf('ag-research')).toEqual(['agent-browser', ...EXPOSED_GOOGLE_SKILLS]);
    expect(await skillsOf('ag-scheduler')).toEqual(['agent-browser', ...EXPOSED_GOOGLE_SKILLS]);
    expect(await skillsOf('ag-open')).toBe('all');
  });

  it('ships each exposed skill with rules that need nothing only main is given', () => {
    for (const skill of EXPOSED_GOOGLE_SKILLS) {
      for (const file of ['SKILL.md', 'instructions.md']) {
        const text = fs.readFileSync(path.join(SKILLS_DIR, skill, file), 'utf8');
        expect(text, `${skill}/${file}`).not.toMatch(/Executive Assistant/u);
      }
    }
    const rules = fs.readFileSync(path.join(SKILLS_DIR, 'gcalendar', 'instructions.md'), 'utf8');
    for (const rule of REQUIRED_CALENDAR_RULES) expect(rules).toContain(rule);
  });

  it("puts a service's rules in the document of every group that has its skill, and in no other", async () => {
    const research = group('ag-research', 'research');
    const writer = group('ag-writer', 'writer');
    await createGroup(research, ['agent-browser']);
    await createGroup(writer, ['agent-browser']);
    await startHost();
    await updateContainerConfigJson(writer.id, 'skills', ['agent-browser']);
    const rules = fs.readFileSync(path.join(SKILLS_DIR, 'gcalendar', 'instructions.md'), 'utf8').trim();

    const compose = async (value: AgentGroup): Promise<string> => {
      const groupDir = path.join(TEST_ROOT, value.folder);
      await composeGroupProjectDoc(value, groupDir, { fileName: 'CLAUDE.md' });
      return fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    };

    expect(await compose(research)).toContain(`# NanoClaw Skill: gcalendar\n\n${rules}`);
    expect(await compose(writer)).not.toContain('`gog`');
  });
});
