import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { createServer, request as httpRequest, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { createWebIdentity, createWebIdentityVerifier } from '../gws-ea-web/access.js';
import type { WebPolicyFile } from '../gws-ea-web/policy.js';
import { LoginStore } from './login-store.js';
import { createLoginsPageHandler } from './logins-page.js';
import { TEST_INSTANCE_ID } from './testing/login-store.js';

const PRINCIPAL = 'principal@example.com';
const SECRET = 'Principal-only!<saved-password>';
let key: Awaited<ReturnType<typeof generateKeyPair>>;
let directory: string;
let config: WebPolicyFile;
let store: LoginStore;
let server: Server;
let port: number;
let keyReads: number;
let duringKeyRead: (() => Promise<void>) | undefined;

beforeAll(async () => {
  key = await generateKeyPair('RS256');
});
beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'logins-reveal-access-')));
  config = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'aya.example.com',
    listenPort: 9123,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aya-aud',
    cloudflare: {
      accountId: 'account',
      applicationId: 'aya',
      operatorConfigFile: path.join(directory, 'operator.json'),
    },
  };
  const policyFile = path.join(directory, 'policy.json');
  await writeFile(policyFile, JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', policyFile);
  await runMigrations(await initTestDb());
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  keyReads = 0;
  duringKeyRead = undefined;
  store = new LoginStore({
    browserRoot: path.join(directory, 'browser'),
    instanceId: TEST_INSTANCE_ID,
    runCommand: async () => {
      keyReads += 1;
      const change = duringKeyRead;
      duringKeyRead = undefined;
      await change?.();
      return { exitCode: 0, stdout: '3d'.repeat(32), stderr: '' };
    },
  });
  const jwk = { ...(await exportJWK(key.publicKey)), kid: 'current', alg: 'RS256' };
  server = createServer(
    createLoginsPageHandler({
      hostname: config.hostname,
      store,
      identity: createWebIdentity(
        config,
        createWebIdentityVerifier(config.accessIssuer, config.accessAud, async () => Response.json({ keys: [jwk] })),
      ),
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  port = address.port;
});
afterEach(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

async function token(email = PRINCIPAL, audience = config.accessAud, expires = Math.floor(Date.now() / 1000) + 60) {
  return new SignJWT({ email })
    .setProtectedHeader({ alg: 'RS256', kid: 'current' })
    .setIssuer(config.accessIssuer)
    .setAudience(audience)
    .setExpirationTime(expires)
    .sign(key.privateKey);
}
async function reveal(assertion: string | undefined, handle: string, version: number) {
  return new Promise<{ status: number; body: string; cache: string | undefined; nosniff: string | undefined }>(
    (resolve, reject) => {
      const req = httpRequest(
        {
          hostname: '127.0.0.1',
          port,
          method: 'POST',
          path: '/logins/reveal',
          headers: {
            host: config.hostname,
            'content-type': 'application/json',
            'sec-fetch-site': 'same-origin',
            ...(assertion ? { 'cf-access-jwt-assertion': assertion } : {}),
          },
        },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              cache: res.headers['cache-control'],
              nosniff:
                typeof res.headers['x-content-type-options'] === 'string'
                  ? res.headers['x-content-type-options']
                  : undefined,
            }),
          );
        },
      );
      req.on('error', reject);
      req.end(JSON.stringify({ handle, version: String(version) }));
    },
  );
}
const saved = () =>
  store.create({ site: 'https://stream.example', title: 'Stream', username: PRINCIPAL, password: SECRET });

it('reveals only through a valid current principal Access session, never a reader or another app token', async () => {
  const login = await saved();
  const valid = await token();
  const before = keyReads;
  for (const assertion of [
    undefined,
    'forged',
    await token(PRINCIPAL, 'other-app'),
    await token('reader@example.com'),
    await token(PRINCIPAL, undefined, 1),
  ]) {
    const reply = await reveal(assertion, login.id, login.version);
    expect(reply).toMatchObject({ status: 404, body: '', cache: 'no-store', nosniff: 'nosniff' });
  }
  expect(keyReads).toBe(before);
  const reply = await reveal(valid, login.id, login.version);
  expect(reply).toMatchObject({ status: 200, cache: 'no-store', nosniff: 'nosniff' });
  expect(JSON.parse(reply.body)).toEqual({ password: SECRET });
  await getDb().run('DELETE FROM gws_ea_principal_addresses');
  expect(await reveal(valid, login.id, login.version)).toMatchObject({ status: 404, body: '' });
  expect(keyReads).toBe(before + 1);
});

it.each(['address removed', 'policy disabled', 'token expired'] as const)(
  'withholds decrypted passwords when authority changes during key access: %s',
  async (change) => {
    const login = await saved();
    const valid = await token();
    const before = keyReads;
    duringKeyRead = async () => {
      if (change === 'address removed') await getDb().run('DELETE FROM gws_ea_principal_addresses');
      else if (change === 'policy disabled')
        await writeFile(path.join(directory, 'policy.json'), JSON.stringify({ ...config, enabled: false }));
      else {
        const expiredTime = Date.now() + 61_000;
        vi.useFakeTimers({ toFake: ['Date'] });
        vi.setSystemTime(expiredTime);
      }
    };
    const reply = await reveal(valid, login.id, login.version);
    expect(reply).toMatchObject({ status: 404, body: '', cache: 'no-store', nosniff: 'nosniff' });
    expect(keyReads).toBe(before + 1);
    expect(reply.body).not.toContain(SECRET);
  },
);
