import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writeWebOperatorConfig } from '../../gws-ea/web-cloudflare.js';
import { WebRuntime } from './runtime.js';
import type { WebPolicyFile } from './policy.js';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

let root: string;
let config: WebPolicyFile;
let runtime: WebRuntime;
let blocker: Server | undefined;
let unavailable: boolean;
const emails = ['principal@example.com'];
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
  runtime = new WebRuntime(
    {
      artifacts: () => (_request, response) => response.end('artifact'),
      logins: () => (_request, response) => response.end('logins'),
    },
    async () => emails,
    {
      reconcileAccess: async () => {
        if (unavailable) throw new Error('Admission unavailable');
        return { verified: true, emails, changed: false };
      },
    },
  );
});
it('serves both fixed features through the same ready origin and closes publication readiness on stop', async () => {
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
  expect(await request('/logins', 'POST')).toEqual({ status: 200, body: 'logins' });
  await runtime.stop();
  expect(await runtime.publicationReady(config)).toBe(false);
});
afterEach(async () => {
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
