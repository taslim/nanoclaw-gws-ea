import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WEB_PUBLIC_PATHS, writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { defineGuardedAction, DENY } from '../../guard/index.js';
import type { WebMount } from './mounts.js';
import { WebRuntime } from './runtime.js';
import type { WebPolicyFile } from './policy.js';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
vi.mock('../gws-ea-profile/db.js', () => ({
  listPrincipalAddresses: async () => [{ email: 'principal@example.com', added_at: '2026-11-01T00:00:00.000Z' }],
}));

const mounts: readonly WebMount[] = [
  {
    name: 'artifacts',
    audience: 'artifact-readers',
    path: '/artifacts',
    methods: ['GET', 'HEAD'],
    handler: () => (_request, response) => response.end('artifact'),
    admissionEmails: async () => readers,
    authoredContent: () => false,
  },
  {
    name: 'logins',
    audience: 'principal',
    path: '/logins',
    methods: ['GET', 'HEAD', 'POST'],
    title: 'Logins',
    status: async () => 'No saved logins',
    linkGuard: defineGuardedAction({ action: 'test.web-runtime-logins-link', decide: () => DENY('test') }),
    handler: () => (_request, response) => response.end('logins'),
  },
];

let root: string;
let config: WebPolicyFile;
let runtime: WebRuntime;
let blocker: Server | undefined;
let unavailable: boolean;
let admitted: readonly string[] = [];
let checkedPublicPaths: readonly string[] | undefined;
let readers: readonly string[];
let documentPath: boolean;
let verifications: number;
const emails = ['juno@example.com', 'principal@example.com'];
beforeEach(async () => {
  root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'web-runtime-'));
  const port = createServer();
  await new Promise<void>((resolve) => port.listen(0, '127.0.0.1', resolve));
  const address = port.address();
  if (!address || typeof address === 'string') throw new Error('No fixture port');
  await new Promise<void>((resolve) => port.close(() => resolve()));
  config = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'aya.example.com',
    listenPort: address.port,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: {
      accountId: 'account',
      applicationId: 'app',
      operatorConfigFile: path.join(root, 'web', 'config.json'),
    },
  };
  fs.mkdirSync(path.dirname(config.cloudflare.operatorConfigFile), { recursive: true, mode: 0o700 });
  await writeWebOperatorConfig(config.cloudflare.operatorConfigFile, {
    schemaVersion: 1,
    accountId: 'account',
    zoneId: 'zone',
    zoneApex: 'example.com',
    teamName: 'team',
    credentialFile: path.join(root, 'web', 'management-token'),
    cloudflaredPath: '/usr/local/bin/cloudflared',
    dns: {},
    tunnelId: 'tunnel',
    pin: { id: 'pin', owned: true },
    assistants: {
      '00000000-0000-4000-8000-000000000001': {
        claim: { hostname: config.hostname, listen_port: config.listenPort },
        enabled: true,
        publicationReady: true,
        applicationId: 'app',
        policyId: 'policy',
        aud: 'aud',
      },
    },
  });
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify(config), { mode: 0o600 });
  vi.stubEnv('GWS_EA_WEB_POLICY_FILE', path.join(root, 'policy.json'));
  unavailable = false;
  admitted = [];
  readers = ['juno@example.com'];
  documentPath = false;
  verifications = 0;
  runtime = new WebRuntime(() => mounts, {
    reconcileAccess: async (options) => {
      verifications++;
      if (unavailable) throw new Error('Admission unavailable');
      admitted = typeof options.emails === 'function' ? await options.emails() : options.emails;
      checkedPublicPaths = options.publicPaths;
      return { verified: true, emails: admitted, changed: false, clientDocumentPath: documentPath };
    },
  });
});
it('serves registered mounts through the same ready origin and closes publication readiness on stop', async () => {
  expect(await runtime.publicationReady(config)).toBe(false);
  await runtime.reconcile();
  expect(await runtime.publicationReady(config)).toBe(true);
  async function request(route: string, method = 'GET'): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const req = httpRequest(
        { hostname: '127.0.0.1', port: config.listenPort, path: route, method, headers: { host: config.hostname } },
        (res) => {
          let body = '';
          res.on('data', (chunk: Buffer) => {
            body += chunk.toString();
          });
          res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
        },
      );
      req.on('error', reject);
      req.end();
    });
  }
  expect(await request('/artifacts/id')).toEqual({ status: 200, body: 'artifact' });
  expect(await request('/artifacts/id', 'POST')).toEqual({ status: 405, body: '' });
  // Without a verified principal assertion the principal gate answers before the page handler.
  expect(await request('/logins', 'POST')).toEqual({ status: 404, body: '' });
  expect(admitted).toEqual(emails);
  await runtime.stop();
  expect(await runtime.publicationReady(config)).toBe(false);
});
it('verifies Access against the public paths its policy records, again whenever they change', async () => {
  await runtime.reconcile();
  expect(checkedPublicPaths).toEqual([]);
  const recorded = { ...config, publicPaths: ['/artifacts/public/*', '/oauth-client/*'] };
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify(recorded));
  await runtime.reconcile();
  expect(checkedPublicPaths).toEqual(['/artifacts/public/*', '/oauth-client/*']);
  expect(await runtime.publicationReady(recorded)).toBe(true);
});
afterEach(async () => {
  vi.useRealTimers();
  await runtime?.stop();
  await new Promise<void>((resolve) => (blocker ? blocker.close(() => resolve()) : resolve()));
  blocker = undefined;
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
it('keeps a port conflict local and becomes ready after the port is released without rewriting enabled policy', async () => {
  blocker = createServer();
  await new Promise<void>((resolve) => blocker!.listen(config.listenPort, '127.0.0.1', resolve));
  await expect(runtime.reconcile()).resolves.toBeUndefined();
  expect(await runtime.health()).toMatchObject({
    enabled: true,
    availability: 'unavailable',
    listener: { state: 'stopped' },
  });
  await new Promise<void>((resolve) => blocker!.close(() => resolve()));
  blocker = undefined;
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({
    availability: 'available',
    listener: { state: 'listening', port: config.listenPort },
  });
  expect(JSON.parse(fs.readFileSync(path.join(root, 'policy.json'), 'utf8'))).toEqual(config);
});
it('closes a listening origin on invalid policy or failed admission, without throwing from startup', async () => {
  await runtime.reconcile();
  expect(await runtime.publicationReady(config)).toBe(true);
  fs.writeFileSync(path.join(root, 'policy.json'), '{');
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({
    availability: 'unavailable',
    reason: 'invalid-web-policy',
    listener: { state: 'stopped' },
  });
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify(config));
  unavailable = true;
  const controller = new AbortController();
  expect(() => runtime.start(controller.signal)).not.toThrow();
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({
    enabled: true,
    availability: 'unavailable',
    reason: 'web-origin-unavailable',
  });
  expect(await runtime.publicationReady(config)).toBe(false);
  controller.abort();
});
it('reports client documents served only while a ready origin verified them under a policy recording their path', async () => {
  // The host first verifies the artifact-only Access app under a policy that records no public paths.
  await runtime.reconcile();
  expect(runtime.clientDocumentsServed()).toBe(false);
  // Provisioning converges the app and then records the paths; the digest change alone triggers verification.
  documentPath = true;
  const before = verifications;
  fs.writeFileSync(path.join(root, 'policy.json'), JSON.stringify({ ...config, publicPaths: [...WEB_PUBLIC_PATHS] }));
  await runtime.reconcile();
  expect(verifications).toBe(before + 1);
  expect(admitted).toEqual(emails);
  expect(runtime.clientDocumentsServed()).toBe(true);
  // A failed admission closes the listener.
  readers = ['remy@example.com'];
  unavailable = true;
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({ availability: 'unavailable', listener: { state: 'stopped' } });
  expect(runtime.clientDocumentsServed()).toBe(false);
  // Recovery once the retry window has passed.
  unavailable = false;
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(Date.now() + 16_000);
  await runtime.reconcile();
  expect(await runtime.health()).toMatchObject({ availability: 'available' });
  expect(runtime.clientDocumentsServed()).toBe(true);
  await runtime.stop();
  expect(runtime.clientDocumentsServed()).toBe(false);
});
