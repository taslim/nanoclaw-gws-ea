import { expect, it, vi } from 'vitest';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { createArtifactIdentityVerifier } from './access.js';

it('verifies only configured RS256 issuer, audience, lifetime and email using cached configured JWKS', async () => {
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...(await exportJWK(publicKey)), kid: 'first', alg: 'RS256', use: 'sig' };
  const urls: string[] = [];
  const verify = createArtifactIdentityVerifier('https://team.cloudflareaccess.com', 'app', async (input) => {
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
  const verify = createArtifactIdentityVerifier('https://team.cloudflareaccess.com', 'app', async () => {
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
