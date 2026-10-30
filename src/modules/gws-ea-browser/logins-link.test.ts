import fs from 'node:fs';
import path from 'node:path';
import { createServer } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), 'browser-logins-link-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';
import { WebRuntime } from '../gws-ea-web/runtime.js';
import './index.js';
import { registerLoginsPageDelivery } from './logins-link.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from './onepassword-policy.js';
import { BrowserVault } from './onepassword.js';
import { writePrivateFile } from './paths.js';
import { configureBrowserAccess } from './testing/browser-access.js';
import { deliverAction } from './testing/delivery-answer.js';

const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const VAULT_ID = 'morganelleryvault000000001';
const TOKEN = 'ops_fixture-runtime-service-account-token';
let config: WebPolicyFile;
let runtime: WebRuntime;
let main: Session;
let vault: BrowserVault;
let resourceFile: string;

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  for (const id of ['main', 'research', 'browser', 'external', 'other'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: '2026-10-29T00:00:00Z' });
  await getDb().run(
    "UPDATE gws_ea_profile SET assistant_first_name='Juno',principal_first_name='Morgan',main_agent_group_id='main',browser_agent_group_id='browser',external_email_agent_group_id='external' WHERE singleton=1",
  );
  const instanceRoot = path.join(ROOT, INSTANCE_ID.slice(0, 8));
  const browserRoot = path.join(instanceRoot, 'browser');
  await configureBrowserAccess(browserRoot, ['research']);
  await writePrivateFile(
    path.join(instanceRoot, 'state', 'data', 'gws-ea', 'instance.json'),
    JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }),
  );
  const policyFile = onePasswordHostPaths(path.join(ROOT, 'config')).policyFile;
  await writeOnePasswordHostPolicy(policyFile, {
    schemaVersion: 2,
    enabled: true,
    accountId: ACCOUNT_ID,
    signInAddress: 'hale.1password.com',
    cliPath: '/nonexistent-onepassword-cli/op',
    managementServiceAccountId: null,
  });
  const files = onePasswordInstancePaths(instanceRoot);
  resourceFile = files.resourceFile;
  await writeOnePasswordResources(resourceFile, {
    schemaVersion: 2,
    instanceId: INSTANCE_ID,
    accountId: ACCOUNT_ID,
    vault: {
      id: VAULT_ID,
      createdBy: { kind: 'management_service_account', serviceAccountId: 'MANAGEMENTSERVICEACCOUNT01' },
    },
    operatorGrant: null,
    runtimeServiceAccountId: 'RUNTIMESERVICEACCOUNT00001',
    retiredRuntimeServiceAccountIds: [],
  });
  await writePrivateFile(files.runtimeTokenFile, TOKEN);
  vault = new BrowserVault({ browserRoot, onePasswordPolicyFile: policyFile });
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
  runtime = new WebRuntime(
    { artifacts: () => (_request, response) => response.end(), logins: () => (_request, response) => response.end() },
    async () => ['morgan@example.com'],
    { reconcileAccess: async () => ({ verified: true, emails: ['morgan@example.com'], changed: false }) },
  );
  registerLoginsPageDelivery({ vault, publicationReady: (policy) => runtime.publicationReady(policy) });
  main = (await resolveSystemSession('main', 'system:logins-link')).session;
});

afterEach(async () => {
  await runtime?.stop();
  await closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('distinguishes setup from a temporarily unavailable origin, and returns only the ready host URL', async () => {
  fs.rmSync(path.join(ROOT, 'web-policy.json'));
  expect(await deliverAction(main, 'logins_page', {})).toMatchObject({ ok: true, data: { status: 'operator_needed' } });
  await writePrivateFile(path.join(ROOT, 'web-policy.json'), JSON.stringify(config));
  const resources = fs.readFileSync(resourceFile);
  fs.rmSync(resourceFile);
  expect(await deliverAction(main, 'logins_page', {})).toMatchObject({ ok: true, data: { status: 'operator_needed' } });
  await writePrivateFile(resourceFile, resources.toString());
  expect(await deliverAction(main, 'logins_page', {})).toMatchObject({ ok: true, data: { status: 'unavailable' } });
  await runtime.reconcile();
  const answer = await deliverAction(main, 'logins_page', {});
  expect(answer).toMatchObject({ ok: true, data: { status: 'available', url: 'https://juno.example.com/logins' } });
  for (const privateValue of [TOKEN, ACCOUNT_ID, VAULT_ID]) expect(JSON.stringify(answer)).not.toContain(privateValue);
  await runtime.stop();
  expect(await deliverAction(main, 'logins_page', {})).toMatchObject({ ok: true, data: { status: 'unavailable' } });
});

it('uses native browser access for every caller and accepts no caller-selected fields', async () => {
  for (const id of ['research', 'browser', 'external', 'other']) {
    const caller = (await resolveSystemSession(id, `system:logins-link:${id}`)).session;
    const answer = await deliverAction(caller, 'logins_page', {});
    expect(answer).toMatchObject(id === 'research' ? { ok: true } : { ok: false, error: { code: 'forbidden' } });
  }
  expect(await deliverAction(main, 'logins_page', { url: 'https://foreign.example/logins' })).toMatchObject({
    ok: false,
    error: { code: 'invalid-args' },
  });
});
