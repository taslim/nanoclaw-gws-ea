import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), `web-page-link-tests-${process.pid}`);
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
}));

import { getGroupCapabilities } from '../../capabilities.js';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import '../gws-ea-browser/index.js';
import { writePrivateFile } from '../gws-ea-browser/paths.js';
import { configureBrowserAccess } from '../gws-ea-browser/testing/browser-access.js';
import { deliverAction } from '../gws-ea-browser/testing/delivery-answer.js';
import './index.js';
import { registerWebMount, webMounts } from './mounts.js';
import { PRINCIPAL_PAGE_ACTION, PRINCIPAL_PAGES_CAPABILITY, registerPrincipalPageDelivery } from './page-link.js';
import type { WebPolicyFile } from './policy.js';
import { WebRuntime } from './runtime.js';

const FACTS = { apps: [{ name: 'HomeBoard', key: 'homeboard', status: 'needs_reconnecting' }] };
// A main-only page with link facts, as the connections page registers itself.
registerWebMount({
  name: 'connections',
  audience: 'principal',
  path: '/connections',
  methods: ['GET'],
  title: 'Connections',
  status: async () => '',
  linkGuard: defineGuardedAction({
    action: 'test.page-link-connections',
    decide: ({ actor }) =>
      actor.kind === 'agent' && actor.agentGroupId === 'main' ? ALLOW('main') : DENY('main only'),
  }),
  linkFacts: async () => FACTS,
  handler: () => (_request, response) => response.end(),
});

const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
let config: WebPolicyFile;
let runtime: WebRuntime;
let main: Session;

async function session(id: string): Promise<Session> {
  return (await resolveSystemSession(id, `system:page-link:${id}`)).session;
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  for (const id of ['main', 'research', 'browser', 'external', 'other'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-29T00:00:00Z' });
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Juno',principal_first_name='Morgan',main_agent_group_id='main',browser_agent_group_id='browser',external_email_agent_group_id='external' WHERE singleton=1",
  );
  const instanceRoot = path.join(ROOT, INSTANCE_ID.slice(0, 8));
  await configureBrowserAccess(path.join(instanceRoot, 'browser'), ['research']);
  await writePrivateFile(
    path.join(instanceRoot, 'state', 'data', 'gws-ea', 'instance.json'),
    JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }),
  );
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  config = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'juno.example.com',
    listenPort: address.port,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: {
      accountId: 'account',
      applicationId: 'app',
      operatorConfigFile: path.join(ROOT, 'web', 'config.json'),
    },
  };
  fs.mkdirSync(path.dirname(config.cloudflare.operatorConfigFile), { recursive: true, mode: 0o700 });
  await writeWebOperatorConfig(config.cloudflare.operatorConfigFile, {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    zoneApex: 'example.com',
    teamName: 'team',
    credentialFile: path.join(ROOT, 'web', 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: true },
    assistants: {
      [INSTANCE_ID]: {
        claim: { hostname: config.hostname, listen_port: config.listenPort },
        enabled: true,
        publicationReady: true,
        applicationId: 'app',
        policyId: 'policy',
        aud: 'aud',
      },
    },
  });
  await writePrivateFile(path.join(ROOT, 'web-policy.json'), JSON.stringify(config));
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(ROOT, 'web-policy.json'));
  runtime = new WebRuntime(webMounts, {
    reconcileAccess: async () => ({ verified: true, emails: ['morgan@example.com'], changed: false }),
  });
  registerPrincipalPageDelivery({ publicationReady: (policy) => runtime.publicationReady(policy) });
  main = await session('main');
});

afterEach(async () => {
  await runtime?.stop();
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('tells main to ask the operator without web, to try later while it cannot serve, and gives each exact page address once it serves', async () => {
  fs.rmSync(path.join(ROOT, 'web-policy.json'));
  expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page: 'connections' })).toEqual({
    id: expect.any(String),
    ok: true,
    data: { status: 'operator_needed', facts: FACTS },
  });
  await writePrivateFile(path.join(ROOT, 'web-policy.json'), JSON.stringify(config));
  expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page: 'connections' })).toMatchObject({
    ok: true,
    data: { status: 'unavailable', facts: FACTS },
  });
  await runtime.reconcile();
  for (const [page, url] of [
    ['home', 'https://juno.example.com/'],
    ['logins', 'https://juno.example.com/logins'],
  ])
    expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page })).toMatchObject({
      ok: true,
      data: { status: 'available', url },
    });
  expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page: 'connections' })).toMatchObject({
    ok: true,
    data: { status: 'available', url: 'https://juno.example.com/connections', facts: FACTS },
  });
  await runtime.stop();
  expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page: 'logins' })).toMatchObject({
    ok: true,
    data: { status: 'unavailable' },
  });
});

it("applies each page's own link guard: a delegator gets only the logins link, and sealed groups none", async () => {
  await runtime.reconcile();
  const outcomes: Record<string, Record<string, boolean>> = {};
  for (const id of ['main', 'research', 'browser', 'external', 'other']) {
    const caller = await session(id);
    outcomes[id] = {};
    for (const page of ['home', 'logins', 'connections'])
      outcomes[id][page] = (await deliverAction(caller, PRINCIPAL_PAGE_ACTION, { page })).ok;
  }
  expect(outcomes).toEqual({
    main: { home: true, logins: true, connections: true },
    research: { home: false, logins: true, connections: false },
    browser: { home: false, logins: false, connections: false },
    external: { home: false, logins: false, connections: false },
    other: { home: false, logins: false, connections: false },
  });
  expect(await deliverAction(await session('research'), PRINCIPAL_PAGE_ACTION, { page: 'home' })).toMatchObject({
    ok: false,
    error: { code: 'forbidden' },
  });
});

it('answers a page that is not registered, or any other field, as invalid arguments', async () => {
  for (const fields of [
    {},
    { page: 'settings' },
    { page: 'connections/callback/homeboard.example.test' },
    { page: 7 },
    { page: 'logins', url: 'https://foreign.example/logins' },
  ])
    expect(await deliverAction(main, PRINCIPAL_PAGE_ACTION, fields)).toMatchObject({
      ok: false,
      error: { code: 'invalid-args' },
    });
  const refused = await deliverAction(main, PRINCIPAL_PAGE_ACTION, { page: 'settings' });
  for (const page of ['home', 'logins', 'connections'])
    expect(refused).toMatchObject({ error: { message: expect.stringContaining(page) } });
});

it('gives the link tool to exactly the groups some page would give a link', async () => {
  const holders = [];
  for (const id of ['main', 'research', 'browser', 'external', 'other'])
    if ((await getGroupCapabilities(id)).has(PRINCIPAL_PAGES_CAPABILITY)) holders.push(id);
  expect(holders).toEqual(['main', 'research']);
});
