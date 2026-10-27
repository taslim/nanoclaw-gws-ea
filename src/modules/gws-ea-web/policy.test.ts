import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { parseWebPolicyFile, readWebPolicy, type WebPolicyFile } from './policy.js';

const ROOT = path.join(fs.realpathSync(tmpdir()), `gws-ea-artifact-policy-${process.pid}`);
const config: WebPolicyFile = {
  schemaVersion: 1,
  enabled: true,
  hostname: 'views.example.com',
  pathPrefix: '/aya',
  listenPort: 9123,
  accessIssuer: 'https://team.cloudflareaccess.com',
  accessAud: 'assistant-aud',
  cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: '/private/tmp/operator.json' },
};
beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { mode: 0o700 });
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
});
it('retains complete disabled coordinates, distinguishes absence from malformed state and accepts a dedicated host prefix', async () => {
  const file = path.join(ROOT, 'policy.json');
  expect(await readWebPolicy(file)).toEqual({ status: 'disabled', enabled: false });
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  expect(await readWebPolicy(file)).toEqual({ status: 'enabled', enabled: true, config });
  const disabled = { ...config, enabled: false };
  fs.writeFileSync(file, JSON.stringify(disabled));
  expect(await readWebPolicy(file)).toEqual({ status: 'disabled', enabled: false, config: disabled });
  fs.writeFileSync(file, '{broken');
  expect(await readWebPolicy(file)).toMatchObject({ status: 'unavailable', enabled: false });
  expect(parseWebPolicyFile({ ...config, pathPrefix: '' })).toEqual({ ...config, pathPrefix: '' });
});
it.each([
  { schemaVersion: 2 },
  { extra: true },
  { hostname: 'localhost' },
  { hostname: 'UPPER.example.com' },
  { pathPrefix: '/public' },
  { pathPrefix: '/aya/peer' },
  { listenPort: 0 },
  { listenPort: 2.5 },
  { accessIssuer: 'https://team.cloudflareaccess.com.evil.test' },
  { accessIssuer: 'http://team.cloudflareaccess.com' },
  { cloudflare: { ...config.cloudflare, operatorConfigFile: 'relative.json' } },
])('fails closed on malformed or unsupported policy %j', async (change) => {
  const file = path.join(ROOT, 'policy.json');
  fs.writeFileSync(file, JSON.stringify({ ...config, ...change }), { mode: 0o600 });
  expect(await readWebPolicy(file)).toMatchObject({ status: 'unavailable', enabled: false });
});
it.each(['symlink', 'fifo', 'mode', 'oversized'] as const)('refuses unsafe %s policy without hanging', async (kind) => {
  const file = path.join(ROOT, 'policy.json');
  fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
  if (kind === 'symlink') {
    fs.renameSync(file, `${file}.target`);
    fs.symlinkSync(`${file}.target`, file);
  }
  if (kind === 'fifo') {
    fs.unlinkSync(file);
    execFileSync('mkfifo', [file]);
  }
  if (kind === 'mode') fs.chmodSync(file, 0o644);
  if (kind === 'oversized') fs.writeFileSync(file, Buffer.alloc(16 * 1024 + 1));
  expect(await readWebPolicy(file)).toMatchObject({ status: 'unavailable', enabled: false });
});

it('accepts canonical encoded first names and refuses ambiguous or escaping segments', () => {
  for (const name of ['élise', '李', "o'neil", 'mary-jane', 'a.b']) {
    const pathPrefix = `/${encodeURIComponent(name)}`;
    expect(parseWebPolicyFile({ ...config, pathPrefix })?.pathPrefix).toBe(pathPrefix);
  }
  for (const pathPrefix of [
    '/%61ya',
    '/%2f',
    '/%5C',
    '/%00',
    '/.',
    '/..',
    '/%70ublic',
    '/Élise',
    '/%C3%89lise',
    '/mary%20jane',
    '/%ef%bc%a1',
    '/%',
  ]) {
    expect(parseWebPolicyFile({ ...config, pathPrefix }), pathPrefix).toBeUndefined();
  }
});
