import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { deriveGcpClaims } from '../../gws-ea/gcp-identity.js';
import { writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { blocksManagedLogins } from './management-url-policy.js';

const INSTANCE = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'browser-management-policy-'));
  vi.stubEnv('GWS_EA_CONFIG_ROOT', root);
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', join(root, 'web-policy.json'));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(root, { recursive: true, force: true });
});

async function ownPolicy(enabled = true): Promise<void> {
  await operatorClaims();
  await writeFile(
    join(root, 'web-policy.json'),
    JSON.stringify({
      schemaVersion: 1,
      enabled,
      hostname: 'aya.example.com',
      listenPort: 41234,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAud: 'aud',
      cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: join(root, 'web', 'config.json') },
    }),
    { mode: 0o600 },
  );
}

async function operatorClaims(hostname?: string): Promise<void> {
  await mkdir(join(root, 'web'), { recursive: true, mode: 0o700 });
  await writeWebOperatorConfig(join(root, 'web', 'config.json'), {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    zoneApex: 'example.com',
    teamName: 'team',
    credentialFile: join(root, 'web', 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    assistants: hostname ? { [INSTANCE]: { enabled: false, claim: { hostname, listen_port: 41237 } } } : {},
  });
}

async function claim(hostname: string): Promise<void> {
  await writeFile(
    join(root, 'instances.json'),
    JSON.stringify({
      schema_version: 3,
      instances: {
        [INSTANCE]: {
          instance_id: INSTANCE,
          release_track: 'test',
          source_remote: 'https://github.com/example/nanoclaw',
          deployed_commit: 'a'.repeat(40),
          allocated_ports: { onecli_app: 41235, onecli_gateway: 41236 },
          exclusive_resource_claims: {
            ...deriveGcpClaims(INSTANCE),
            gcp_account: 'operator@example.com',
            workspace_email: 'juno@example.com',
            onecli_project: 'juno',
            web: { hostname, listen_port: 41237 },
          },
        },
      },
    }),
    { mode: 0o600 },
  );
}

it('protects the mount and conservative encoded variants while leaving unrelated public paths alone', async () => {
  await ownPolicy(false);
  for (const route of [
    '/logins',
    '/logins?view=detail',
    '/logins/item/id/reveal',
    '/LOGINS/item/id',
    '/%6cogins',
    '/%256cogins%252fitem/id',
    '/%2flogins/item/id',
    '/logins%2fitem/id',
    '/logins%5citem/id',
    '/logins%3fview=detail',
    '/other%2f..%2flogins',
    '/logins%2f..%2fartifacts/id',
  ])
    expect(await blocksManagedLogins(`https://AYA.EXAMPLE.COM.${route}`), route).toBe(true);
  for (const route of ['/artifacts/id', '/loginsx', '/public/logins', '/artifacts/id?next=/logins', '/%61rtifacts/id'])
    expect(await blocksManagedLogins(`https://aya.example.com${route}`), route).toBe(false);
  expect(await blocksManagedLogins('https://shop.example/logins/item/id')).toBe(false);
  expect(await blocksManagedLogins('https://aya.example.com.evil.example/logins')).toBe(false);
});

it('bounds normalization of deeply nested encodings without blocking another public host', async () => {
  await ownPolicy();
  const route = `/%${'25'.repeat(32_768)}6cogins`;
  const started = performance.now();
  expect(await blocksManagedLogins(`https://aya.example.com${route}`)).toBe(true);
  expect(await blocksManagedLogins(`https://shop.example${route}`)).toBe(false);
  expect(performance.now() - started).toBeLessThan(1_000);
});

it('keeps public browsing available after uninstall leaves a disabled policy and removes operator metadata', async () => {
  await ownPolicy(false);
  await rm(join(root, 'web', 'config.json'));
  await claim('juno.example.com');
  expect(await blocksManagedLogins('https://shop.example/logins')).toBe(false);
  expect(await blocksManagedLogins('https://aya.example.com/logins')).toBe(true);
  expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(true);
});

it('reads all assistants retained hostname claims anew for every candidate request', async () => {
  expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(false);
  await claim('juno.example.com');
  expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(true);
  expect(await blocksManagedLogins('https://juno.example.com/artifacts/id')).toBe(false);
  await claim('sage.example.com');
  expect(await blocksManagedLogins('https://sage.example.com/logins')).toBe(true);
  expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(false);
});

it('protects retained operator hostname claims even when the machine registry has not recorded them', async () => {
  await ownPolicy();
  await operatorClaims('sage.example.com');
  expect(await blocksManagedLogins('https://sage.example.com/logins/item/id/reveal')).toBe(true);
  expect(await blocksManagedLogins('https://sage.example.com/artifacts/id')).toBe(false);
  await operatorClaims('juno.example.com');
  expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(true);
  expect(await blocksManagedLogins('https://sage.example.com/logins')).toBe(false);
});

it('fails candidate requests closed when hostname authority cannot be validated', async () => {
  await ownPolicy();
  await writeFile(join(root, 'instances.json'), '{', { mode: 0o600 });
  expect(await blocksManagedLogins('https://unrelated.example/logins')).toBe(true);
  expect(await blocksManagedLogins('https://aya.example.com/artifacts/id')).toBe(false);
  await rm(join(root, 'instances.json'));
  await writeFile(join(root, 'web-policy.json'), '{', { mode: 0o600 });
  expect(await blocksManagedLogins('https://unrelated.example/logins')).toBe(true);
  expect(await blocksManagedLogins('https://unrelated.example/public')).toBe(false);
  await ownPolicy();
  await writeFile(join(root, 'web', 'config.json'), '{', { mode: 0o600 });
  expect(await blocksManagedLogins('https://unrelated.example/logins')).toBe(true);
  await rm(join(root, 'web', 'config.json'));
  expect(await blocksManagedLogins('https://unrelated.example/logins')).toBe(true);
});

it('finds a service custom configuration root in the host environment file', async () => {
  await claim('juno.example.com');
  vi.stubEnv('GWS_EA_CONFIG_ROOT', '');
  await writeFile(join(root, '.env'), `GWS_EA_CONFIG_ROOT=${root}\n`, { mode: 0o600 });
  const cwd = process.cwd();
  try {
    process.chdir(root);
    expect(await blocksManagedLogins('https://juno.example.com/logins')).toBe(true);
  } finally {
    process.chdir(cwd);
  }
});
