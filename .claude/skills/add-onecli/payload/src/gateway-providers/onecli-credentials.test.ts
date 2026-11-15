import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it, vi } from 'vitest';

import type { GatewayCredentialTarget } from './credential-connection.js';
import {
  createOneCliCredentialConnection,
  createProviderCredentialConnection,
  listOneCliCredentialsForHost,
  removeOneCliCredentialsById,
  type OneCliCredential,
  type OneCliManagement,
} from './onecli-credentials.js';

const BEARER = { headerName: 'Authorization', valueFormat: 'Bearer {value}' };
const CALENDAR: OneCliCredential = {
  name: 'google-calendar',
  type: 'generic',
  hostPattern: 'www.googleapis.com',
  injectionConfig: BEARER,
};
const row = (id: string, spec: OneCliCredential = CALENDAR) => ({
  id,
  name: spec.name,
  type: spec.type,
  hostPattern: spec.hostPattern,
  scope: 'project',
  valueSource: 'inline',
  pathPattern: null,
  injectionConfig: spec.injectionConfig ?? null,
  metadata: {},
});

/** OneCLI's `/v1/secrets` behind `fetch`, holding `rows`; writes are recorded and applied. */
function vault(
  rows: Record<string, unknown>[],
  answer: (method: string, url: string) => Response | undefined = () => undefined,
) {
  const writes: { method: string; url: string; body?: unknown }[] = [];
  const transport = vi.fn(async (url: string, init: RequestInit) => {
    const method = init.method ?? 'GET';
    const custom = answer(method, url);
    if (custom) return custom;
    if (method === 'GET') return new Response(JSON.stringify(rows));
    const body = init.body === undefined ? undefined : JSON.parse(String(init.body));
    writes.push({ method, url, body });
    if (method === 'DELETE') {
      const id = decodeURIComponent(url.split('/').at(-1)!);
      rows.splice(
        rows.findIndex((entry) => entry.id === id),
        1,
      );
      return new Response(null, { status: 204 });
    }
    if (method === 'POST') {
      rows.push(row('created'));
      return new Response(JSON.stringify({ id: 'created', valuePreview: 'ya29.pre' }), { status: 201 });
    }
    return new Response(JSON.stringify({ success: true }));
  });
  return { transport: transport as unknown as typeof fetch, calls: transport.mock.calls, writes };
}

/** This installation's management settings, over `v`'s transport. */
function management(v: ReturnType<typeof vault>, apiKey: string, url = 'http://vault.example'): OneCliManagement {
  return { url, apiKey, projectId: 'project-fixture', fetch: v.transport };
}

describe("OneCLI's credential connection", () => {
  it('creates, then updates by id, sending the project and refusing redirects', async () => {
    const v = vault([]);
    const connection = createOneCliCredentialConnection(CALENDAR, management(v, 'oc_key', 'http://vault.example/'));

    expect(await connection.find()).toBeNull();
    const id = await connection.save('ya29.first', null);
    expect(await connection.save('ya29.second', id)).toBe('created');

    expect(v.writes.map(({ method, url }) => `${method} ${url}`)).toEqual([
      'POST http://vault.example/v1/secrets',
      'PATCH http://vault.example/v1/secrets/created',
    ]);
    expect(v.writes[0]!.body).toMatchObject({ name: 'google-calendar', value: 'ya29.first', injectionConfig: BEARER });
    for (const [, init] of v.calls) {
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer oc_key', 'X-Project-Id': 'project-fixture' });
    }
  });

  it('refuses to choose between two entries with the same name', async () => {
    const v = vault([row('a'), row('b')]);
    await expect(
      createOneCliCredentialConnection(CALENDAR, management(v, 'k', 'http://vault.example')).find(),
    ).rejects.toThrow(/Multiple google-calendar credentials/);
    expect(v.writes).toEqual([]);
  });

  it('never echoes a response or a transport error', async () => {
    const v = vault([], (method) =>
      method === 'GET' ? new Response('ya29.leaked-preview', { status: 500 }) : undefined,
    );
    const error = await createOneCliCredentialConnection(CALENDAR, management(v, 'oc_key', 'http://vault.example'))
      .find()
      .catch((caught: unknown) => caught);
    expect(String(error)).toMatch(/Could not confirm the google-calendar credential in OneCLI/);
    expect(String(error)).not.toContain('ya29');
    expect(String(error)).not.toContain('oc_key');
  });

  it('removes the entry it looked up, and only that one', async () => {
    const stale: OneCliCredential = { ...CALENDAR, name: 'google-gmail', hostPattern: 'gmail.googleapis.com' };
    const rows = [row('sec/1', stale), row('other')];
    const v = vault(rows);
    const connection = createOneCliCredentialConnection(stale, management(v, 'k', 'http://vault.example'));

    const id = await connection.find();
    await connection.remove(id!);

    expect(v.writes).toEqual([{ method: 'DELETE', url: 'http://vault.example/v1/secrets/sec%2F1', body: undefined }]);
    expect(rows.map((entry) => entry.id)).toEqual(['other']);
  });

  it('refuses to remove an entry that changed since it was looked up', async () => {
    const rows = [row('first')];
    const v = vault(rows);
    const connection = createOneCliCredentialConnection(CALENDAR, management(v, 'k', 'http://vault.example'));
    const id = await connection.find();
    rows.splice(0, 1, row('replaced'));

    await expect(connection.remove(id!)).rejects.toThrow(/changed since it was looked up/);
    expect(v.writes).toEqual([]);
  });
});

describe('the caller-described connection', () => {
  const target: GatewayCredentialTarget = {
    kind: 'api-key',
    name: 'google-gmail',
    host: 'gmail.googleapis.com',
    proxyValue: 'gateway-managed',
    injection: BEARER,
  };

  it('limits a target with a path to exactly that path on its host', async () => {
    const app: GatewayCredentialTarget = {
      ...target,
      name: 'gws-ea-app-a1',
      host: 'app.ledgerly.example.test',
      path: '/mcp',
    };
    const v = vault([]);
    const connection = createProviderCredentialConnection(app, management(v, 'oc_key'));

    expect(await connection.find()).toBeNull();
    await connection.save('app-token');

    expect(v.writes[0]!.body).toMatchObject({
      name: 'gws-ea-app-a1',
      hostPattern: 'app.ledgerly.example.test',
      pathPattern: '/mcp',
    });
  });

  it('refuses to adopt an entry for the same name that is not limited to the same path', async () => {
    const app: GatewayCredentialTarget = {
      ...target,
      name: 'gws-ea-app-a1',
      host: 'app.ledgerly.example.test',
      path: '/mcp',
    };
    const spec: OneCliCredential = { ...CALENDAR, name: 'gws-ea-app-a1', hostPattern: 'app.ledgerly.example.test' };
    const v = vault([row('whole-host', spec)]);

    await expect(createProviderCredentialConnection(app, management(v, 'oc_key')).find()).rejects.toThrow(
      /unexpected metadata in: pathPattern/,
    );
    const scoped = vault([{ ...row('scoped', spec), pathPattern: '/mcp' }]);
    expect(await createProviderCredentialConnection(app, management(scoped, 'oc_key')).find()).toEqual({
      reusable: true,
    });
  });

  it('removes what find observed, and nothing when it observed none', async () => {
    const spec: OneCliCredential = { ...CALENDAR, name: 'google-gmail', hostPattern: 'gmail.googleapis.com' };
    const rows: Record<string, unknown>[] = [row('stale', spec)];
    const v = vault(rows);
    const connection = createProviderCredentialConnection(target, management(v, 'oc_key'));
    await expect(connection.remove()).rejects.toThrow(/Look up/);
    expect(await connection.find()).toEqual({ reusable: true });
    await connection.remove();
    expect(await connection.find()).toBeNull();
    await connection.remove();
    expect(v.writes.map(({ method }) => method)).toEqual(['DELETE']);
  });
});

describe("OneCLI's credentials on one host", () => {
  const LEDGERLY: OneCliCredential = { ...CALENDAR, name: 'Ledgerly', hostPattern: 'app.ledgerly.example.test' };
  // An app's entry is limited to its server's path; it is still on that host.
  const app = (id: string) => ({ ...row(id, { ...LEDGERLY, name: `gws-ea-app-${id}` }), pathPattern: '/mcp' });

  it('lists only the entries on exactly that host, and removing them by id leaves the rest', async () => {
    const rows = [
      app('a1'),
      row('calendar'),
      row('operator', LEDGERLY),
      row('wildcard', { ...LEDGERLY, name: 'Wildcard', hostPattern: '*.ledgerly.example.test' }),
    ];
    const v = vault(rows);
    const settings = management(v, 'oc_key');

    const listed = await listOneCliCredentialsForHost('app.ledgerly.example.test', settings);
    expect(listed).toEqual([
      { id: 'a1', name: 'gws-ea-app-a1' },
      { id: 'operator', name: 'Ledgerly' },
    ]);
    expect(
      await removeOneCliCredentialsById(
        listed.map(({ id }) => id),
        settings,
      ),
    ).toEqual([
      { id: 'a1', outcome: 'removed' },
      { id: 'operator', outcome: 'removed' },
    ]);
    expect(rows.map(({ id }) => id)).toEqual(['calendar', 'wildcard']);
    for (const [, init] of v.calls) {
      expect(init.redirect).toBe('error');
      expect(init.headers).toMatchObject({ Authorization: 'Bearer oc_key', 'X-Project-Id': 'project-fixture' });
    }
  });

  it('matches a host whatever its letter case, as DNS does', async () => {
    const v = vault([row('operator', { ...LEDGERLY, hostPattern: 'App.Ledgerly.Example.Test' })]);
    expect(await listOneCliCredentialsForHost('app.ledgerly.example.test', management(v, 'k'))).toEqual([
      { id: 'operator', name: 'Ledgerly' },
    ]);
  });

  it('refuses a host that is not one exact DNS name', async () => {
    const v = vault([row('operator', LEDGERLY)]);
    for (const host of [
      '*.ledgerly.example.test',
      'app.ledgerly.example.test/mcp',
      'https://app.ledgerly.example.test',
      '',
    ]) {
      await expect(listOneCliCredentialsForHost(host, management(v, 'k')), host).rejects.toThrow(/exact host/);
    }
    expect(v.calls).toEqual([]);
  });

  it('reports a delete that fails as failed, and still removes the others', async () => {
    const rows = [app('a1'), row('operator', LEDGERLY), app('a2')];
    const v = vault(rows, (method, url) =>
      method === 'DELETE' && url.endsWith('/operator')
        ? new Response('{"valuePreview":"hb-leaked"}', { status: 500 })
        : undefined,
    );

    expect(await removeOneCliCredentialsById(['a1', 'operator', 'a2'], management(v, 'k'))).toEqual([
      { id: 'a1', outcome: 'removed' },
      { id: 'operator', outcome: 'failed' },
      { id: 'a2', outcome: 'removed' },
    ]);
    expect(rows.map(({ id }) => id)).toEqual(['operator']);
  });

  it('reports an id that disappeared since it was listed as gone, deleting nothing for it', async () => {
    const rows = [app('a1'), row('operator', LEDGERLY)];
    const v = vault(rows);
    const settings = management(v, 'k');
    const listed = await listOneCliCredentialsForHost('app.ledgerly.example.test', settings);
    rows.splice(1, 1);

    expect(
      await removeOneCliCredentialsById(
        listed.map(({ id }) => id),
        settings,
      ),
    ).toEqual([
      { id: 'a1', outcome: 'removed' },
      { id: 'operator', outcome: 'gone' },
    ]);
    expect(v.writes).toEqual([{ method: 'DELETE', url: 'http://vault.example/v1/secrets/a1', body: undefined }]);
  });

  it('reports each id once, however often it is given', async () => {
    const v = vault([app('a1')]);
    expect(await removeOneCliCredentialsById(['a1', 'a1'], management(v, 'k'))).toEqual([
      { id: 'a1', outcome: 'removed' },
    ]);
    expect(v.writes).toHaveLength(1);
  });

  it('never echoes a response when it cannot read the entries', async () => {
    const v = vault([], (method) =>
      method === 'GET' ? new Response('hb-leaked-preview', { status: 500 }) : undefined,
    );
    for (const attempt of [
      listOneCliCredentialsForHost('app.ledgerly.example.test', management(v, 'oc_key')),
      removeOneCliCredentialsById(['a1'], management(v, 'oc_key')),
    ]) {
      const error = String(await attempt.catch((caught: unknown) => caught));
      expect(error).toMatch(/Could not confirm the credentials .* in OneCLI/);
      expect(error).not.toContain('hb-leaked');
      expect(error).not.toContain('oc_key');
    }
    expect(v.writes).toEqual([]);
  });
});

it('imports nothing at runtime, so setup can load the payload copy before OneCLI is installed', () => {
  const source = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'onecli-credentials.ts'),
    'utf8',
  );
  const imports = [...source.matchAll(/^import\b[^;]*;/gms)].map(([statement]) => statement);
  expect(imports.length).toBeGreaterThan(0);
  for (const statement of imports) expect(statement).toMatch(/^import type /);
});
