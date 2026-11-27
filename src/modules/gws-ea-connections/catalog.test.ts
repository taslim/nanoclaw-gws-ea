import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CATALOG,
  catalogEntry,
  catalogEntryFor,
  operatorEnabled,
  readCatalogPolicy,
  type CatalogEntry,
  type CatalogPolicyState,
} from './catalog.js';
import { CATALOG_POLICY_FILE_ENV } from './config.js';
import { readListing } from './operations.js';
import type { ConnectionsStore } from './store.js';
import { testConnectionsStore } from './testing/store.js';

let directory: string;
let store: ConnectionsStore;

beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'connections-catalog-'));
  ({ store } = testConnectionsStore(path.join(directory, 'connections')));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(directory, { recursive: true, force: true });
});

function entry(id: string): CatalogEntry {
  const found = catalogEntry(id);
  if (!found) throw new Error(`No catalog entry ${id}`);
  return found;
}
const LINK_VERSION = (() => {
  const { transport } = entry('link');
  if (transport.kind !== 'host_cli') throw new Error('Link is a host CLI');
  return transport.version;
})();

async function policyFile(contents: unknown): Promise<string> {
  const file = path.join(directory, 'catalog.json');
  await writeFile(file, typeof contents === 'string' ? contents : JSON.stringify(contents));
  await chmod(file, 0o600);
  return file;
}
const installed = (version: string, enabled = true) => ({
  schemaVersion: 1,
  link: { enabled, versions: { [version]: { installationDir: `/opt/gws-ea/link/${version}` } } },
});

async function listing(policy: CatalogPolicyState = { status: 'absent' }) {
  return readListing(store, { operatorServers: async () => [], catalogPolicy: async () => policy });
}
const availableIds = (result: Awaited<ReturnType<typeof listing>>) => result.available?.map(({ entry: e }) => e.id);

describe('catalog entries', () => {
  it('has unique ids, remote entries on distinct https hosts, and host CLIs at exact versions', () => {
    expect(new Set(CATALOG.map(({ id }) => id)).size).toBe(CATALOG.length);
    const remoteHosts = CATALOG.flatMap(({ transport }) =>
      transport.kind === 'remote' ? [new URL(transport.url)] : [],
    );
    expect(remoteHosts.every((url) => url.protocol === 'https:')).toBe(true);
    expect(new Set(remoteHosts.map((url) => url.hostname)).size).toBe(remoteHosts.length);
    for (const { transport } of CATALOG)
      if (transport.kind === 'host_cli') expect(transport.version).toMatch(/^\d+\.\d+\.\d+$/u);
  });

  it('resolves an app by its catalog id, else a remote app by its host', () => {
    expect(catalogEntryFor({ catalogId: 'link', transport: 'host_cli', host: 'link.host-cli.invalid' })?.id).toBe(
      'link',
    );
    expect(catalogEntryFor({ catalogId: null, transport: 'remote', host: 'mcp.notion.com' })?.id).toBe('notion');
    expect(catalogEntryFor({ catalogId: null, transport: 'remote', host: 'mcp.chowdeck.com' })).toBeUndefined();
    expect(catalogEntryFor({ catalogId: null, transport: 'host_cli', host: 'mcp.notion.com' })).toBeUndefined();
  });
});

describe('catalog policy', () => {
  it('enables nothing without a locator or a file', async () => {
    vi.stubEnv(CATALOG_POLICY_FILE_ENV, '');
    const none = await readCatalogPolicy();
    expect(none).toEqual({ status: 'absent' });
    const missing = await readCatalogPolicy(path.join(directory, 'missing.json'));
    expect(missing).toEqual({ status: 'absent' });
    for (const state of [none, missing]) {
      expect(operatorEnabled(entry('link'), state)).toBe(false);
      expect(operatorEnabled(entry('shop'), state)).toBe(false);
      expect(operatorEnabled(entry('notion'), state)).toBe(true);
    }
  });

  it('offers Link only while it is enabled at the version this release pins', async () => {
    const pinned = await readCatalogPolicy(await policyFile(installed(LINK_VERSION)));
    expect(operatorEnabled(entry('link'), pinned)).toBe(true);
    expect(operatorEnabled(entry('link'), await readCatalogPolicy(await policyFile(installed('0.0.1'))))).toBe(false);
    expect(
      operatorEnabled(entry('link'), await readCatalogPolicy(await policyFile(installed(LINK_VERSION, false)))),
    ).toBe(false);
    expect(operatorEnabled(entry('shop'), pinned)).toBe(false);
  });

  it('offers Shop while a client is registered, read from the locator', async () => {
    vi.stubEnv(
      CATALOG_POLICY_FILE_ENV,
      await policyFile({ schemaVersion: 1, shop: { clientId: 'shop-client-remy', clientSecretFile: null } }),
    );
    const state = await readCatalogPolicy();
    expect(state).toEqual({
      status: 'read',
      policy: { schemaVersion: 1, link: null, shop: { clientId: 'shop-client-remy', clientSecretFile: null } },
    });
    expect(operatorEnabled(entry('shop'), state)).toBe(true);
  });

  it.each([
    ['not JSON', '{'],
    ['an unknown schema', { ...installed(LINK_VERSION), schemaVersion: 2 }],
    [
      'a relative installation',
      { schemaVersion: 1, link: { enabled: true, versions: { [LINK_VERSION]: { installationDir: 'link' } } } },
    ],
    ['a version range', installed('^1.6.0')],
    ['an empty client', { schemaVersion: 1, shop: { clientId: '' } }],
  ])('enables nothing from a policy with %s', async (_case, contents) => {
    const state = await readCatalogPolicy(await policyFile(contents));
    expect(state).toEqual({ status: 'invalid' });
    expect(CATALOG.filter((e) => operatorEnabled(e, state)).map(({ id }) => id)).toEqual([
      'chowdeck',
      'notion',
      'granola',
      'todoist',
    ]);
  });

  it('refuses a policy file others can read', async () => {
    const file = await policyFile(installed(LINK_VERSION));
    await chmod(file, 0o644);
    expect(await readCatalogPolicy(file)).toEqual({ status: 'invalid' });
  });
});

describe('listing', () => {
  it('lists an app added by address on a catalog host as its entry, and not again under available', async () => {
    const added = await store.create({ name: 'Notes', url: 'https://mcp.notion.com/sse', auth: 'token' });
    const { app } = await store.connect(added.id, added.version, { kind: 'token', token: 'sentinel-notion-token' });

    const result = await listing();

    expect(result.apps).toEqual([app]);
    expect(result.catalogEntries?.[app.id]?.id).toBe('notion');
    expect(availableIds(result)).toEqual(['chowdeck', 'granola', 'todoist']);
  });

  it('keeps an app that needs reconnecting with the connected apps', async () => {
    const added = await store.create({ name: 'Tasks', url: 'https://ai.todoist.net/mcp', auth: 'token' });
    await store.connect(added.id, added.version, { kind: 'token', token: 'sentinel-todoist-token' });
    await store.markRefused(added.id, 1);

    const result = await listing();

    expect(result.apps.map(({ id, status }) => [id, status])).toEqual([[added.id, 'needs_reconnecting']]);
    expect(availableIds(result)).not.toContain('todoist');
  });

  it('lists a catalog app whose sign-in was abandoned under available, carrying the app to reuse', async () => {
    const abandoned = await store.create({
      name: 'Notion',
      url: 'https://mcp.notion.com/mcp',
      auth: 'oauth',
      issuer: 'https://mcp.notion.com/',
      catalogId: 'notion',
    });

    const result = await listing();

    expect(result.apps).toEqual([]);
    expect(result.available?.find(({ entry: e }) => e.id === 'notion')?.app?.id).toBe(abandoned.id);
  });

  it('offers Link and Shop only once the operator enabled them', async () => {
    expect(availableIds(await listing())).toEqual(['chowdeck', 'notion', 'granola', 'todoist']);
    const enabled = await readCatalogPolicy(
      await policyFile({ ...installed(LINK_VERSION), shop: { clientId: 'shop-client-remy' } }),
    );
    expect(availableIds(await listing(enabled))).toEqual(['chowdeck', 'notion', 'granola', 'todoist', 'shop', 'link']);
  });

  it('keeps a not-connected app whose entry the operator disabled with the apps', async () => {
    const link = await store.create({ name: 'Link', transport: 'host_cli', catalogId: 'link' });

    const result = await listing();

    expect(result.apps.map(({ id }) => id)).toEqual([link.id]);
    expect(result.catalogEntries?.[link.id]?.id).toBe('link');
    expect(availableIds(result)).not.toContain('link');
  });
});
