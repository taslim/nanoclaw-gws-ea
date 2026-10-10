import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { dispatch } from '../../cli/dispatch.js';
import { lookup } from '../../cli/registry.js';
import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getHostStartCallbacks } from '../../host-lifecycle.js';
import { composeGroupProjectDoc } from '../../project-doc-compose.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import { unknownToolNames } from '../../test-utils/runner-tools.js';
import type { AgentGroup } from '../../types.js';
import { reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { GUIDANCE_PATH, MAIN_SHARED_SKILLS } from './index.js';
import '../gws-ea-profile/index.js';
// They register the email channel's and the reminders' keys, whose instructions main is taught.
import '../gws-ea-external-email/index.js';
import '../gws-ea-reminders/index.js';
// It registers the `ncl people` verbs the guidance names.
import '../gws-ea-people/index.js';

const TEST_ROOT = '/tmp/nanoclaw-gws-ea-main-test';
const GUIDANCE = fs.readFileSync(path.resolve(GUIDANCE_PATH), 'utf8').trim();

/** Tools only external-email holds: main's guidance names none of them. */
const EXTERNAL_ONLY_TOOLS = ['tell_main', 'free_time', 'book', 'change_booking', 'cancel_booking'];

/** Backticked words the guidance uses that are not tools: main's own name, a preference's sources, and a handoff's field. */
const NOT_TOOLS = ['main', 'principal', 'learned', 'people'];

function group(id: string, name = 'main'): AgentGroup {
  return { id, name, folder: id, agent_provider: null, created_at: '2026-09-30T00:00:00.000Z' };
}

async function createGroup(value: AgentGroup): Promise<void> {
  await createAgentGroup(value);
  await ensureContainerConfig(value.id);
}

async function publishMain(main: AgentGroup): Promise<void> {
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: main.id,
  });
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

describe("GWS-EA's guidance for main", () => {
  it('gives canonical main the release guidance as its own section, ahead of the runtime contract, and no other group', async () => {
    const main = group('ag-main');
    const research = group('ag-research', 'research');
    await createGroup(main);
    await createGroup(research);
    await publishMain(main);

    const mainSections = await getRequiredProjectDocSections(main);
    expect(mainSections.find((section) => section.name === 'Executive Assistant')?.body).toBe(GUIDANCE);
    expect((await getRequiredProjectDocSections(research)).map((section) => section.name)).not.toContain(
      'Executive Assistant',
    );

    const groupDir = path.join(TEST_ROOT, main.folder);
    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');
    expect(document.indexOf('# Executive Assistant')).toBeGreaterThan(-1);
    expect(document.indexOf('# Executive Assistant')).toBeLessThan(document.indexOf('# NanoClaw Runtime Contract'));
  });

  it('has no section until the profile names main', async () => {
    const main = group('ag-main');
    await createGroup(main);

    expect(await getRequiredProjectDocSections(main)).toEqual([]);
  });

  it("reads the guidance from the release, never from main's own folder", async () => {
    const main = group('ag-main');
    await createGroup(main);
    await publishMain(main);
    const groupDir = path.join(TEST_ROOT, main.folder);
    fs.mkdirSync(groupDir, { recursive: true });
    fs.writeFileSync(path.join(groupDir, 'instructions.prepend.md'), 'Call me Morgan.\n');

    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');

    expect(document).toContain(`# Persona\n\nCall me Morgan.`);
    expect(document).toContain(`# Executive Assistant\n\n${GUIDANCE}`);
    expect(document.indexOf('# Persona')).toBeLessThan(document.indexOf('# Executive Assistant'));
  });

  it('names no link, address or emoji', () => {
    expect(GUIDANCE).not.toMatch(/https?:\/\//i);
    expect(GUIDANCE).not.toMatch(/\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/);
    expect(GUIDANCE).not.toMatch(/[\u{1F300}-\u{1FAFF}]/u);
  });

  it('teaches the memory file each person gets, and names only `ncl people` verbs that exist', () => {
    // `ncl people` points main at these files, and its name search at the aliases in them.
    for (const layout of ['`memory/people/`', '`type: person`', 'aliases']) expect(GUIDANCE, layout).toContain(layout);
    const verbs = [...GUIDANCE.matchAll(/`ncl people ([a-z-]+)/gu)].map(([, verb]) => verb);
    expect(verbs.length).toBeGreaterThan(0);
    for (const verb of verbs) expect(lookup(`people-${verb}`), verb).toBeDefined();
  });

  it('names no tool the agent does not have, and none only external-email holds', () => {
    expect(unknownToolNames(GUIDANCE, NOT_TOOLS)).toEqual([]);
    for (const tool of EXTERNAL_ONLY_TOOLS) expect(GUIDANCE).not.toContain(`\`${tool}\``);
  });

  it('holds no rule about being an AI', () => {
    expect(GUIDANCE).not.toMatch(/\b(?:AI|artificial intelligence|language model|chatbot|bot)\b/iu);
  });

  it('stays within 2,000 words', () => {
    expect(GUIDANCE.split(/\s+/u).filter(Boolean).length).toBeLessThanOrEqual(2_000);
  });

  it("teaches main its email and reminder tools, and none of external-email's", async () => {
    const main = group('ag-main');
    await createGroup(main);
    await publishMain(main);
    const groupDir = path.join(TEST_ROOT, main.folder);

    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');

    expect(document).toContain('# NanoClaw Module: gws-ea-email\n');
    expect(document).toContain('# NanoClaw Module: reminders\n');
    expect(document).not.toContain('# NanoClaw Module: gws-ea-email-external');
  });
});

describe("main's skills", () => {
  it("sets main's skills to the release's list through a hidden host-only command", async () => {
    const main = group('ag-main');
    await createGroup(main);
    expect(lookup('gws-ea-main-reconcile')).toMatchObject({ access: 'hidden', hostOnly: true });

    const response = await dispatch(
      { id: 'main-skills', command: 'gws-ea-main-reconcile', args: { 'agent-group-id': main.id } },
      { caller: 'host' },
    );

    const skills = ['agent-browser', 'gcalendar', 'gmail', 'gpeople', 'gworkspace'];
    expect(response).toMatchObject({ ok: true, data: { agent_group_id: main.id, skills } });
    expect(await skillsOf(main.id)).toEqual(skills);
  });

  it("puts the Calendar and Workspace rules in main's document once its skills are the release's", async () => {
    const main = group('ag-main');
    await createGroup(main);
    await publishMain(main);
    await dispatch(
      { id: 'main-skills', command: 'gws-ea-main-reconcile', args: { 'agent-group-id': main.id } },
      { caller: 'host' },
    );
    const groupDir = path.join(TEST_ROOT, main.folder);

    await composeGroupProjectDoc(main, groupDir, { fileName: 'CLAUDE.md' });
    const document = fs.readFileSync(path.join(groupDir, 'CLAUDE.md'), 'utf8');

    for (const skill of ['gcalendar', 'gworkspace']) {
      const rules = fs.readFileSync(path.resolve('container', 'skills', skill, 'instructions.md'), 'utf8').trim();
      expect(document, skill).toContain(`# NanoClaw Skill: ${skill}\n\n${rules}`);
    }
  });

  it('refuses a group with no container config, and an unknown flag', async () => {
    const unknown = await dispatch(
      { id: 'main-skills', command: 'gws-ea-main-reconcile', args: { 'agent-group-id': 'ag-missing' } },
      { caller: 'host' },
    );
    expect(unknown).toMatchObject({ ok: false });

    const flag = await dispatch(
      { id: 'main-skills', command: 'gws-ea-main-reconcile', args: { 'agent-group-id': 'ag-main', skills: 'all' } },
      { caller: 'host' },
    );
    expect(flag).toMatchObject({ ok: false });
  });

  it("rewrites no group's skills when the host starts, main's included", async () => {
    const main = group('ag-main');
    const research = group('ag-research', 'research');
    await createGroup(main);
    await createGroup(research);
    await publishMain(main);
    // As an operator, or a release before this one, left it.
    await updateContainerConfigJson(main.id, 'skills', ['agent-browser']);

    await startHost();

    expect(await skillsOf(main.id)).toEqual(['agent-browser']);
    expect(await skillsOf(research.id)).toBe('all');
  });

  it('starts cleanly before any main exists', async () => {
    await expect(startHost()).resolves.toBeUndefined();
  });

  it('names only skills the release ships', () => {
    for (const skill of MAIN_SHARED_SKILLS) {
      expect(fs.existsSync(path.resolve('container', 'skills', skill, 'SKILL.md')), skill).toBe(true);
    }
  });
});
