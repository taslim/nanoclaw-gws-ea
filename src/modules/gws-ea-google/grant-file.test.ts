import fs from 'node:fs';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { readGoogleGrantFile } from './grant-file.js';

const ROOT = '/tmp/nanoclaw-gws-ea-google-test';
const FILE = path.join(ROOT, 'secrets', 'google-grant.json');
const GRANT = {
  schema_version: 1,
  account: 'juno@example.test',
  client_id: 'client.apps.googleusercontent.com',
  client_secret: 'GOCSPX-client-secret',
  refresh_token: '1//refresh-token',
  scopes: ['openid'],
  granted_at: '2026-09-30T10:00:00.000Z',
};

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(FILE), { recursive: true, mode: 0o700 });
});

afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

describe("the host's reading of the grant file", () => {
  it('reads an owner-only grant', async () => {
    fs.writeFileSync(FILE, JSON.stringify(GRANT), { mode: 0o600 });
    await expect(readGoogleGrantFile(FILE)).resolves.toEqual(GRANT);
  });

  it('has nothing before the assistant signs in', async () => {
    await expect(readGoogleGrantFile(FILE)).resolves.toBeUndefined();
  });

  it('reads the grant only as an owner-only secret: refuses one another user could read', async () => {
    fs.writeFileSync(FILE, JSON.stringify(GRANT), { mode: 0o644 });
    fs.chmodSync(FILE, 0o644);
    await expect(readGoogleGrantFile(FILE)).rejects.toMatchObject({ code: 'unsafe_mode' });
  });
});
