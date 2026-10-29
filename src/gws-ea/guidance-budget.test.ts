/**
 * Each agent's always-on context is its whole composed project document, the Manual's front page included for main,
 * built by the real composer from a minimal install. Tokens are estimated as characters / 4; no API call calibrates
 * the estimate, so a budget compares sizes, not billing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

const TEST_ROOT = `/tmp/nanoclaw-gws-ea-guidance-budget-${process.pid}`;

vi.mock('../config.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../config.js')>()),
  GROUPS_DIR: `/tmp/nanoclaw-gws-ea-guidance-budget-${process.pid}/groups`,
  DATA_DIR: `/tmp/nanoclaw-gws-ea-guidance-budget-${process.pid}/data`,
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));

vi.mock('../log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import { dispatch } from '../cli/dispatch.js';
import { ensureContainerConfig } from '../db/container-configs.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getAgentGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../db/index.js';
import { composeGroupProjectDoc } from '../project-doc-compose.js';
import type { AgentGroup } from '../types.js';
import { ensureBrowserGroup } from '../modules/gws-ea-browser/group.js';
import { reconcileChatShape } from '../modules/gws-ea-chat-agents/external-chat.js';
import { ensureExternalEmailGroup } from '../modules/gws-ea-external-email/group.js';
import { MAIN_SHARED_SKILLS } from '../modules/gws-ea-main/index.js';
import { registeredGuidanceFiles } from '../modules/gws-ea-profile/guidance.js';
import { recordExternalChatAgentGroupId, reconcileGwsEaProfile } from '../modules/gws-ea-profile/db.js';
import { WEB_POLICY_FILE_ENV, type WebPolicyFile } from '../modules/gws-ea-web/policy.js';
// Every module, so each agent's document holds every section the release gives it.
import '../modules/index.js';

const ROOT = path.resolve(import.meta.dirname, '../..');

type Agent = 'main' | 'external-email' | 'external-chat' | 'job' | 'browser';

/** A raise needs its reason here; each reason records the size its budget was set from. */
const BUDGETS: Readonly<Record<Agent, { readonly tokens: number; readonly reason: string }>> = {
  main: {
    tokens: 9_689,
    reason:
      "main's whole document before the guidance rewrite: 38,754 characters, with the front page as an empty install renders it. Its guidance and calendar craft fit inside that size; the front page grows only within its own budget.",
  },
  'external-email': {
    tokens: 3_900,
    reason:
      '3,827 tokens: the character, the email examples, sealed-thread authority and its scheduling tools; rounded up.',
  },
  'external-chat': {
    tokens: 3_700,
    reason: '3,624 tokens: the character, chat role and privacy, chat scheduling and WhatsApp formatting; rounded up.',
  },
  job: {
    tokens: 4_300,
    reason:
      "4,203 tokens: external-chat's scheduling and formatting, plus job memory, documents and authority; rounded up.",
  },
  browser: {
    tokens: 4_700,
    reason: '4,651 tokens: the sealed errand, its safety boundaries and the host browser tool protocols; rounded up.',
  },
};

/** Compaction re-injects at most this much of each skill an agent has loaded. */
const SKILL_TOKENS = 5_000;

const tokens = (text: string): number => Math.ceil(text.length / 4);

async function group(id: string, name: string): Promise<AgentGroup> {
  const value: AgentGroup = { id, name, folder: id, agent_provider: null, created_at: '2026-10-29T00:00:00.000Z' };
  await createAgentGroup(value);
  await ensureContainerConfig(id);
  return value;
}

async function documentOf(id: string): Promise<string> {
  const found = await getAgentGroup(id);
  if (!found) throw new Error(`No group ${id}`);
  const directory = path.join(TEST_ROOT, 'groups', found.folder);
  await composeGroupProjectDoc(found, directory, { fileName: 'CLAUDE.md' });
  return fs.readFileSync(path.join(directory, 'CLAUDE.md'), 'utf8');
}

const documents = new Map<Agent, string>();

beforeAll(async () => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
  fs.mkdirSync(TEST_ROOT, { recursive: true });
  vi.stubEnv('GWS_EA_BROWSER_ROOT', path.join(TEST_ROOT, 'browser'));
  // The web connector gives main its artifact instructions on every turn of an install that enables it.
  const policy: WebPolicyFile = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'juno.example.com',
    listenPort: 9123,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'assistant-aud',
    cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: '/private/tmp/operator.json' },
  };
  const policyFile = path.join(TEST_ROOT, 'web-policy.json');
  fs.writeFileSync(policyFile, JSON.stringify(policy), { mode: 0o600 });
  vi.stubEnv(WEB_POLICY_FILE_ENV, policyFile);
  await runMigrations(await initTestDb());

  const main = await group('ag-main', 'main');
  await reconcileGwsEaProfile({
    assistantName: { firstName: 'Juno', lastName: 'Hale' },
    assistantWorkspaceEmail: 'juno@example.test',
    principalName: { firstName: 'Morgan', lastName: 'Ellery' },
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: main.id,
    principalEmails: ['morgan@example.test'],
  });
  await dispatch(
    { id: 'budget-main', command: 'gws-ea-main-reconcile', args: { 'agent-group-id': main.id } },
    { caller: 'host' },
  );
  const externalEmail = await ensureExternalEmailGroup();
  const browser = await ensureBrowserGroup();
  const externalChat = await group('ag-external-chat', 'external-chat');
  await reconcileChatShape(externalChat.id, 'external-chat');
  await recordExternalChatAgentGroupId(externalChat.id);
  const job = await group('ag-job', 'chat-job');
  await reconcileChatShape(job.id, 'job');
  const now = new Date().toISOString();
  await createMessagingGroup({
    id: 'mg-job',
    channel_type: 'whatsapp',
    instance: 'whatsapp',
    platform_id: 'job@g.us',
    name: 'Job chat',
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents (agent_group_id, messaging_group_id, state, created_at, updated_at) VALUES (?, 'mg-job', 'active', ?, ?)",
    job.id,
    now,
    now,
  );

  for (const [agent, id] of [
    ['main', main.id],
    ['external-email', externalEmail],
    ['external-chat', externalChat.id],
    ['job', job.id],
    ['browser', browser],
  ] as const)
    documents.set(agent, await documentOf(id));
});

afterAll(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

describe("each GWS-EA agent's always-on budget", () => {
  it.each(Object.entries(BUDGETS))('keeps %s within its budget', (agent, { tokens: budget, reason }) => {
    expect(reason.trim(), agent).not.toBe('');
    const document = documents.get(agent as Agent) ?? '';
    expect(document, agent).toContain('# NanoClaw Runtime Contract');
    expect(
      tokens(document),
      `${agent}: ${tokens(document)} tokens (${document.length} characters); budget ${budget}. ${reason}`,
    ).toBeLessThanOrEqual(budget);
  });

  it("budgets every registered guidance file through an agent's document", () => {
    const composed = [...documents.values()];
    for (const file of registeredGuidanceFiles()) {
      const body = fs.readFileSync(path.join(ROOT, file), 'utf8').trim();
      expect(
        composed.some((document) => document.includes(body)),
        file,
      ).toBe(true);
    }
  });

  it.each([
    ...MAIN_SHARED_SKILLS.map((skill) => `container/skills/${skill}/SKILL.md`),
    'templates/gws-ea/main/skills/welcome/SKILL.md',
  ])('keeps %s within what compaction re-injects of a skill', (file) => {
    const size = tokens(fs.readFileSync(path.join(ROOT, file), 'utf8'));
    expect(size, `${file}: ${size} tokens`).toBeLessThanOrEqual(SKILL_TOKENS);
  });
});
