import fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { IncomingMessage } from 'node:http';
import { Socket } from 'node:net';
import { expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createWebIdentity, createWebIdentityVerifier } from './access.js';

it('verifies only configured RS256 issuer, audience, lifetime and email using cached configured JWKS', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'first', alg: 'RS256', use: 'sig' };
  const urls: string[] = [];
  const verify = createWebIdentityVerifier('https://team.cloudflareaccess.com', 'app', async (input) => {
    urls.push(String(input));
    return Response.json({ keys: [jwk] });
  });
  const token = (claims: Record<string, unknown> = {}, issuer = 'https://team.cloudflareaccess.com', aud = 'app') =>
    new SignJWT({ email: 'Principal@Example.com', ...claims })
      .setProtectedHeader({ alg: 'RS256', kid: 'first', jku: 'https://evil.example/keys' })
      .setIssuer(issuer)
      .setAudience(aud)
      .setExpirationTime('1h')
      .sign(privateKey);
  expect(await verify(await token())).toBe('principal@example.com');
  expect(await verify(await token())).toBe('principal@example.com');
  expect(urls).toEqual(['https://team.cloudflareaccess.com/cdn-cgi/access/certs']);
  expect(await verify(await token({}, 'https://evil.example'))).toBeUndefined();
  expect(await verify(await token({}, undefined, 'other'))).toBeUndefined();
  expect(await verify(await token({ email: 'invalid' }))).toBeUndefined();
  expect(await verify(await token({ nbf: Math.floor(Date.now() / 1000) + 3600 }))).toBeUndefined();
  const expired = await new SignJWT({ email: 'principal@example.com' })
    .setProtectedHeader({ alg: 'RS256', kid: 'first' })
    .setIssuer('https://team.cloudflareaccess.com')
    .setAudience('app')
    .setExpirationTime(1)
    .sign(privateKey);
  expect(await verify(expired)).toBeUndefined();
  expect(await verify('forged')).toBeUndefined();
  expect(await verify(undefined)).toBeUndefined();
});

it('refreshes the configured JWKS for a rotated key and rejects a forged signature and symmetric algorithm', async () => {
  const first = await generateKeyPair('RS256');
  const second = await generateKeyPair('RS256');
  let keys = [{ ...(await exportJWK(first.publicKey)), kid: 'first', alg: 'RS256' }];
  let reads = 0;
  const verify = createWebIdentityVerifier('https://team.cloudflareaccess.com', 'app', async () => {
    reads++;
    return Response.json({ keys });
  });
  const sign = (key: Awaited<ReturnType<typeof generateKeyPair>>['privateKey'], kid: string) =>
    new SignJWT({ email: 'guest@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid })
      .setIssuer('https://team.cloudflareaccess.com')
      .setAudience('app')
      .setExpirationTime('1h')
      .sign(key);
  expect(await verify(await sign(first.privateKey, 'first'))).toBe('guest@example.com');
  expect(await verify(await sign(second.privateKey, 'first'))).toBeUndefined();
  keys = [{ ...(await exportJWK(second.publicKey)), kid: 'second', alg: 'RS256' }];
  const now = Date.now();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(now + 31000);
  try {
    expect(await verify(await sign(second.privateKey, 'second'))).toBe('guest@example.com');
  } finally {
    clock.mockRestore();
  }
  expect(reads).toBe(2);
  const symmetric = await new SignJWT({ email: 'guest@example.com' })
    .setProtectedHeader({ alg: 'HS256' })
    .setIssuer('https://team.cloudflareaccess.com')
    .setAudience('app')
    .setExpirationTime('1h')
    .sign(new Uint8Array(32));
  expect(await verify(symmetric)).toBeUndefined();
});

it.each(['disable', 'audience'] as const)(
  'refuses an identity when the policy changes during real JWT verification: %s',
  async (change) => {
    const root = fs.mkdtempSync(path.join(fs.realpathSync(tmpdir()), 'web-identity-'));
    const file = path.join(root, 'policy.json');
    const config = {
      schemaVersion: 1 as const,
      enabled: true,
      hostname: 'aya.example.com',
      listenPort: 9123,
      accessIssuer: 'https://team.cloudflareaccess.com',
      accessAud: 'aya-aud',
      cloudflare: { accountId: 'account', applicationId: 'aya', operatorConfigFile: path.join(root, 'operator.json') },
    };
    fs.writeFileSync(file, JSON.stringify(config), { mode: 0o600 });
    vi.stubEnv('GWS_EA_WEB_POLICY_FILE', file);
    const key = await generateKeyPair('RS256');
    const jwk = { ...(await exportJWK(key.publicKey)), kid: 'current', alg: 'RS256' };
    const jwt = await new SignJWT({ email: 'principal@example.com' })
      .setProtectedHeader({ alg: 'RS256', kid: 'current' })
      .setIssuer(config.accessIssuer)
      .setAudience(config.accessAud)
      .setExpirationTime('1h')
      .sign(key.privateKey);
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered: (() => void) | undefined;
    const observed = new Promise<void>((resolve) => {
      entered = resolve;
    });
    const fetcher = vi.fn(async () => {
      entered?.();
      await gate;
      return Response.json({ keys: [jwk] });
    });
    const identity = createWebIdentity(
      config,
      createWebIdentityVerifier(config.accessIssuer, config.accessAud, fetcher),
    );
    const request = new IncomingMessage(new Socket());
    request.headers['cf-access-jwt-assertion'] = jwt;
    try {
      const pending = identity(request);
      await observed;
      fs.writeFileSync(
        file,
        JSON.stringify(change === 'disable' ? { ...config, enabled: false } : { ...config, accessAud: 'juno-aud' }),
      );
      release?.();
      expect(await pending).toBeUndefined();
      expect(await identity(request)).toBeUndefined();
      expect(fetcher).toHaveBeenCalledTimes(1);
    } finally {
      release?.();
      vi.unstubAllEnvs();
      fs.rmSync(root, { recursive: true, force: true });
    }
  },
);
