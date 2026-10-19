import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ root: '' }));
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  get GROUPS_DIR() {
    return path.join(storage.root, 'groups');
  },
  get DATA_DIR() {
    return path.join(storage.root, 'data');
  },
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));
import { registerCapability } from '../../capabilities.js';
import { dispatch } from '../../cli/dispatch.js';
import { updateContainerConfigJson } from '../../db/container-configs.js';
import { closeDb, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-browser/guidance.js';
import { hasBrowserAccess } from '../gws-ea-browser/access.js';
import { ensureExternalChatGroup, reconcileChatAgents } from './index.js';
import { activateJobAgent, createJobAgent } from './jobs.js';
import { retireJobAgent } from './retire.js';

interface GatewayAgent {
  id: string;
  identifier: string;
  name: string;
  secretMode: string;
  secrets: string[];
}
const agents = new Map<string, GatewayAgent>();
let unavailable: string | undefined;
let extraCapabilityFor: string | undefined;

registerCapability('u14-unapproved-policy', {
  description: 'Test a non-baseline policy grant',
  default: 'off',
  grantedTo: async (id) => id === extraCapabilityFor,
});

beforeEach(async () => {
  storage.root = fs.mkdtempSync(path.join(os.tmpdir(), 'chat-lifecycle-'));
  agents.clear();
  unavailable = undefined;
  extraCapabilityFor = undefined;
  vi.stubEnv('ONECLI_URL', 'http://gateway.test');
  vi.stubEnv('ONECLI_API_KEY', `oc_${'k'.repeat(32)}`);
  vi.stubEnv('NANOCLAW_INSTALL_ID', '11111111111141118111111111111111');
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', path.join(storage.root, 'browser/policy.json'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      const body: unknown = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (url.pathname === '/v1/secrets')
        return Response.json([
          { id: 'model', name: 'Model', type: 'anthropic', hostPattern: 'api.anthropic.com' },
          { id: 'google', name: 'Private Google', type: 'generic', hostPattern: 'www.googleapis.com' },
        ]);
      if (url.pathname === '/v1/agents' && init?.method === 'POST') {
        const value = body as { name: string; identifier: string };
        agents.set(value.identifier, { ...value, id: `gateway-${agents.size}`, secretMode: 'all', secrets: [] });
        return Response.json({}, { status: 201 });
      }
      if (url.pathname === '/v1/agents') return Response.json([...agents.values()]);
      const match = /^\/v1\/agents\/([^/]+)\/(secret-mode|secrets)$/u.exec(url.pathname);
      const agent = [...agents.values()].find((value) => value.id === match?.[1]);
      if (!agent) throw new Error(`Unexpected gateway request ${url.pathname}`);
      if (agent.identifier === unavailable) throw new Error('Gateway observation unavailable');
      if (match?.[2] === 'secret-mode') agent.secretMode = (body as { mode: string }).mode;
      else if (init?.method === 'PUT') agent.secrets = (body as { secretIds: string[] }).secretIds;
      else return Response.json(agent.secrets);
      return Response.json({ success: true });
    }),
  );
  await runMigrations(await initTestDb());
  await getDb().run("UPDATE gws_ea_profile SET assistant_display_name = 'Robin' WHERE singleton = 1");
});
afterEach(async () => {
  await closeDb();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  fs.rmSync(storage.root, { recursive: true, force: true });
});
async function job(chat: string) {
  await createMessagingGroup({
    id: chat,
    channel_type: 'whatsapp',
    instance: 'whatsapp',
    platform_id: `${chat}@g.us`,
    name: chat,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  const created = await createJobAgent(chat);
  await activateJobAgent(created.agent_group_id);
  return created.agent_group_id;
}
async function health() {
  const response = await dispatch(
    { id: 'u14-health', command: 'gws-ea-chat-agents-health', args: {} },
    { caller: 'host' },
  );
  if (!response.ok) throw new Error(response.error.message);
  return response.data;
}

it('reports actual capability and gateway drift separately for every job while retaining healthy groups', async () => {
  const external = await ensureExternalChatGroup();
  const mode = await job('mode');
  const assignments = await job('assignments');
  const policy = await job('policy');
  const missing = await job('missing');
  const unknown = await job('unknown');
  const healthy = await job('healthy');
  agents.get(mode)!.secretMode = 'all';
  agents.get(assignments)!.secrets.push('google');
  extraCapabilityFor = policy;
  agents.delete(missing);
  unavailable = unknown;
  expect(await health()).toMatchObject({
    external_chat: { agent_group_id: external, status: 'ok', reason: null },
    jobs: expect.arrayContaining([
      expect.objectContaining({
        agent_group_id: mode,
        health: { status: 'degraded', reason: expect.stringContaining('secret mode') },
      }),
      expect.objectContaining({
        agent_group_id: assignments,
        health: { status: 'degraded', reason: expect.stringContaining('model-only') },
      }),
      expect.objectContaining({
        agent_group_id: policy,
        health: { status: 'degraded', reason: expect.stringContaining('effective capabilities') },
      }),
      expect.objectContaining({
        agent_group_id: missing,
        health: { status: 'degraded', reason: expect.stringContaining('missing') },
      }),
      expect.objectContaining({ agent_group_id: unknown, health: { status: 'unknown', reason: expect.any(String) } }),
      expect.objectContaining({ agent_group_id: healthy, health: { status: 'ok', reason: null } }),
    ]),
  });
  expect(
    await dispatch(
      { id: 'u14-agent-health', command: 'gws-ea-chat-agents-health', args: {} },
      {
        caller: 'agent',
        agentGroupId: healthy,
        sessionId: 'session',
        messagingGroupId: 'healthy',
      },
    ),
  ).toMatchObject({ ok: false, error: { code: 'forbidden' } });
});

it('reconciles the release shape at update startup while preserving an explicitly authorized job browser grant', async () => {
  const external = await ensureExternalChatGroup();
  const active = await job('active');
  const policyFile = path.join(storage.root, 'browser/policy.json');
  fs.mkdirSync(path.dirname(policyFile), { recursive: true, mode: 0o700 });
  fs.writeFileSync(policyFile, JSON.stringify({ schemaVersion: 2, enabled: true, agentGroupIds: [active] }), {
    mode: 0o600,
  });
  await updateContainerConfigJson(external, 'capabilities', ['shell']);
  await updateContainerConfigJson(active, 'capabilities', ['shell']);
  agents.get(active)!.secretMode = 'all';
  await reconcileChatAgents();
  expect(await hasBrowserAccess(active)).toBe(true);
  expect(await hasBrowserAccess(external)).toBe(false);
  expect(await health()).toMatchObject({
    external_chat: { status: 'ok' },
    jobs: [{ agent_group_id: active, health: { status: 'ok' } }],
  });
});

it('reports a retired job healthy only while its gateway has no usable credential', async () => {
  await ensureExternalChatGroup();
  const retired = await job('retired');
  await retireJobAgent(retired);
  expect(await health()).toMatchObject({ jobs: [{ state: 'retired', health: { status: 'ok', reason: null } }] });
  agents.get(retired)!.secrets = ['google'];
  expect(await health()).toMatchObject({
    jobs: [{ state: 'retired', health: { status: 'degraded', reason: expect.stringContaining('secret assignments') } }],
  });
  agents.delete(retired);
  expect(await health()).toMatchObject({ jobs: [{ state: 'retired', health: { status: 'ok', reason: null } }] });
});
