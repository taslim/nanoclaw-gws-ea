/**
 * The apps a principal can connect without an address. Entries are reviewed and pinned here and ship with a release;
 * the page, main's facts and the operator connectors all read this one list, and every rule an entry carries is data
 * that the relay and the sorter apply by exact name.
 */
import fs from 'node:fs';
import path from 'node:path';
import { readRegularFileBounded } from '../../anchored-dir.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { hostOf } from './admit.js';
import { catalogPolicyFile } from './config.js';
import type { ConnectionApp } from './store.js';

export type CatalogEntryId = 'chowdeck' | 'notion' | 'granola' | 'todoist' | 'shop' | 'link';

export type CatalogTransport =
  | { readonly kind: 'remote'; readonly url: string }
  | {
      readonly kind: 'host_cli';
      /** The npm package, installed per pinned version from a committed lockfile. */
      readonly package: string;
      /** An exact version: the install receipt is verified against it before every spawn. */
      readonly version: string;
      /** The command in the package's `bin` map. */
      readonly bin: string;
      readonly mcpArgs: readonly string[];
      /**
       * The CLI's MCP mode offers search and call meta-tools rather than its commands, so the host unpacks the inner
       * commands into tools of their own.
       */
      readonly metaTools: boolean;
    };

export type RefusedArgumentMatch =
  | { readonly kind: 'any' }
  | { readonly kind: 'values'; readonly values: readonly string[] }
  | { readonly kind: 'non_https_url' };

/** An argument main may never pass, keyed on the exact names of the pinned schema. */
export interface RefusedArgument {
  readonly tools: 'all' | readonly string[];
  readonly argument: string;
  readonly match: RefusedArgumentMatch;
}

/** What the operator sets up once per host before an entry can be offered. */
export type OperatorPrerequisite = 'none' | 'link_install' | 'shop_client';

export interface CatalogEntry {
  readonly id: CatalogEntryId;
  readonly name: string;
  readonly goodFor: string;
  /** What the principal's account needs, shown before connecting. */
  readonly requirements?: string;
  readonly transport: CatalogTransport;
  /** Tools whose action the app itself confirms with the principal, so the assistant adds no approval of its own. */
  readonly confirmedByApp: readonly string[];
  /** Commands the host never offers. */
  readonly withheld: readonly string[];
  readonly refusedArguments: readonly RefusedArgument[];
  readonly prerequisite: OperatorPrerequisite;
}

const ANY = { kind: 'any' } as const;
const NO_RULES = { confirmedByApp: [], withheld: [], refusedArguments: [] } as const;

export const CATALOG: readonly CatalogEntry[] = [
  {
    id: 'chowdeck',
    name: 'Chowdeck',
    goodFor: 'Ordering food and groceries for delivery',
    transport: { kind: 'remote', url: 'https://api.chowdeck.com/mcp' },
    ...NO_RULES,
    prerequisite: 'none',
  },
  {
    id: 'notion',
    name: 'Notion',
    goodFor: 'Finding, reading and updating pages and databases in Notion',
    transport: { kind: 'remote', url: 'https://mcp.notion.com/mcp' },
    ...NO_RULES,
    prerequisite: 'none',
  },
  {
    id: 'granola',
    name: 'Granola',
    goodFor: 'Looking up notes and transcripts of meetings Granola recorded',
    requirements: 'Transcripts and edits need a paid Granola plan.',
    transport: { kind: 'remote', url: 'https://mcp.granola.ai/mcp' },
    ...NO_RULES,
    prerequisite: 'none',
  },
  {
    id: 'todoist',
    name: 'Todoist',
    goodFor: 'Managing tasks and projects in Todoist',
    transport: { kind: 'remote', url: 'https://ai.todoist.net/mcp' },
    ...NO_RULES,
    prerequisite: 'none',
  },
  {
    id: 'shop',
    name: 'Shop',
    goodFor: 'Finding products and buying from Shopify stores through Shop',
    // Served at the origin's root; the server answers /mcp with a 404.
    transport: { kind: 'remote', url: 'https://mcp.shop.com/' },
    confirmedByApp: [],
    // Both exist only to issue and return a single-use card for another store, which the assistant cannot use yet.
    withheld: ['create_spend_request', 'get_spend_request'],
    refusedArguments: [],
    prerequisite: 'shop_client',
  },
  {
    id: 'link',
    name: 'Link',
    goodFor: 'Paying with your Link wallet; you approve each payment in the Link app',
    requirements: 'Payments work only for US and Canadian Link accounts, and financial insights only for US accounts.',
    transport: {
      kind: 'host_cli',
      package: '@stripe/link-cli',
      version: '1.6.0',
      bin: 'link-cli',
      mcpArgs: ['--mcp'],
      metaTools: true,
    },
    confirmedByApp: ['spend-request_create', 'spend-request_request-approval', 'mpp_pay'],
    // The host owns the sign-in, and account setup happens in the Link app.
    withheld: ['auth_login', 'auth_upgrade', 'auth_logout', 'auth_status', 'onboard', 'demo', 'payment-methods_add'],
    refusedArguments: [
      // Main may never tell Link the principal already approved.
      { tools: 'all', argument: 'approve', match: ANY },
      { tools: 'all', argument: 'approval_detail', match: ANY },
      { tools: 'all', argument: 'use_approval_policy', match: ANY },
      // Files and credential locations stay the host's.
      { tools: 'all', argument: 'output_file', match: ANY },
      { tools: 'all', argument: 'force', match: ANY },
      { tools: 'all', argument: 'auth', match: ANY },
      // Returns card numbers or payment tokens whatever its value.
      { tools: 'all', argument: 'include', match: ANY },
      // A card would open a spending limit the assistant cannot use until host-filled cards exist.
      { tools: ['spend-request_create'], argument: 'credential_type', match: { kind: 'values', values: ['card'] } },
      { tools: ['mpp_pay'], argument: 'url', match: { kind: 'non_https_url' } },
    ],
    prerequisite: 'link_install',
  },
];

export function catalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}

/**
 * An app made from the catalog names its entry; one added earlier by address is its entry when it is on that entry's
 * host, so it carries its connection, tools and labels without being converted. A host-run app's placeholder host
 * belongs to no remote entry.
 */
export function catalogEntryFor(
  app: Pick<ConnectionApp, 'catalogId' | 'transport' | 'host'>,
): CatalogEntry | undefined {
  if (app.catalogId !== null) return catalogEntry(app.catalogId);
  if (app.transport !== 'remote') return undefined;
  return CATALOG.find((entry) => entry.transport.kind === 'remote' && hostOf(entry.transport.url) === app.host);
}

export const CATALOG_POLICY_SCHEMA_VERSION = 1;
const POLICY_MAX_BYTES = 16 * 1024;
const EXACT_VERSION = /^\d+\.\d+\.\d+$/u;
/** RFC 6749 client identifiers are visible ASCII. */
const CLIENT_ID = /^[\x21-\x7e]{1,2048}$/u;

/** What the operator enabled on this host; written by `gws-ea connector`, read by every assistant on use. */
export interface CatalogPolicy {
  readonly schemaVersion: typeof CATALOG_POLICY_SCHEMA_VERSION;
  readonly link: {
    readonly enabled: boolean;
    readonly versions: Readonly<Record<string, { readonly installationDir: string }>>;
  } | null;
  readonly shop: { readonly clientId: string; readonly clientSecretFile: string | null } | null;
}

export type CatalogPolicyState =
  /** No locator or no file: the operator has enabled nothing. */
  | { readonly status: 'absent' }
  | { readonly status: 'read'; readonly policy: CatalogPolicy }
  /** Unreadable or malformed. Nothing it names is offered, and nothing is read as the operator disabling it. */
  | { readonly status: 'invalid' };

function absoluteFile(value: unknown): value is string {
  return typeof value === 'string' && path.isAbsolute(value) && path.resolve(value) === value;
}

function parseLink(value: unknown): CatalogPolicy['link'] | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.enabled !== 'boolean' || !isRecord(value.versions)) return undefined;
  const versions: Record<string, { readonly installationDir: string }> = {};
  for (const [version, install] of Object.entries(value.versions)) {
    if (!EXACT_VERSION.test(version) || !isRecord(install) || !absoluteFile(install.installationDir)) return undefined;
    versions[version] = { installationDir: install.installationDir };
  }
  return { enabled: value.enabled, versions };
}

function parseShop(value: unknown): CatalogPolicy['shop'] | undefined {
  if (value === undefined || value === null) return null;
  if (!isRecord(value) || typeof value.clientId !== 'string' || !CLIENT_ID.test(value.clientId)) return undefined;
  const secret = value.clientSecretFile;
  if (secret !== undefined && secret !== null && !absoluteFile(secret)) return undefined;
  return { clientId: value.clientId, clientSecretFile: absoluteFile(secret) ? secret : null };
}

function parseCatalogPolicy(value: unknown): CatalogPolicy | undefined {
  if (!isRecord(value) || value.schemaVersion !== CATALOG_POLICY_SCHEMA_VERSION) return undefined;
  const link = parseLink(value.link);
  const shop = parseShop(value.shop);
  if (link === undefined || shop === undefined) return undefined;
  return { schemaVersion: CATALOG_POLICY_SCHEMA_VERSION, link, shop };
}

export async function readCatalogPolicy(file = catalogPolicyFile()): Promise<CatalogPolicyState> {
  if (!file) return { status: 'absent' };
  /* eslint-disable no-catch-all/no-catch-all -- bad optional operator state closes the operator's entries, never the page */
  try {
    if (!path.isAbsolute(file)) return invalidPolicy();
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      )
        return invalidPolicy();
      bytes = readRegularFileBounded(fd, POLICY_MAX_BYTES);
    } finally {
      fs.closeSync(fd);
    }
    const policy = parseCatalogPolicy(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    return policy ? { status: 'read', policy } : invalidPolicy();
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return { status: 'absent' };
    return invalidPolicy();
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function invalidPolicy(): CatalogPolicyState {
  log.warn('Catalog policy is unreadable; operator-enabled catalog apps are unavailable');
  return { status: 'invalid' };
}

/** Link counts only while this release's pinned version is installed, so a host never runs a version it did not pin. */
export function operatorEnabled(entry: CatalogEntry, state: CatalogPolicyState): boolean {
  const policy = state.status === 'read' ? state.policy : undefined;
  switch (entry.prerequisite) {
    case 'none':
      return true;
    case 'link_install':
      return (
        entry.transport.kind === 'host_cli' &&
        policy?.link?.enabled === true &&
        Object.hasOwn(policy.link.versions, entry.transport.version)
      );
    case 'shop_client':
      return policy?.shop != null;
  }
}

export interface AvailableCatalogEntry {
  readonly entry: CatalogEntry;
  /** The app an earlier connect left not connected; connecting again reuses it. */
  readonly app?: ConnectionApp;
}

export interface CatalogPlacement {
  /** The principal's apps, less the not-connected ones listed as available entries. */
  readonly apps: readonly ConnectionApp[];
  /** Each listed app's catalog entry, by app id. */
  readonly entries: Readonly<Record<string, CatalogEntry>>;
  readonly available: readonly AvailableCatalogEntry[];
}

/**
 * An entry is available until one of its apps is connected; one that needs reconnecting is still connected, so it
 * stays with the principal's apps where reconnecting happens. A not-connected app whose entry the operator no longer
 * enables stays with the apps, so it never disappears from the page.
 */
export function placeCatalogApps(apps: readonly ConnectionApp[], state: CatalogPolicyState): CatalogPlacement {
  const entryOf = new Map(apps.map((app) => [app.id, catalogEntryFor(app)]));
  const moved = new Set<string>();
  const available: AvailableCatalogEntry[] = [];
  for (const entry of CATALOG) {
    if (!operatorEnabled(entry, state)) continue;
    const own = apps.filter((app) => entryOf.get(app.id) === entry);
    if (own.some((app) => app.status !== 'not_connected')) continue;
    const reusable = own[0];
    if (reusable) moved.add(reusable.id);
    available.push(reusable ? { entry, app: reusable } : { entry });
  }
  const listed = apps.filter((app) => !moved.has(app.id));
  const entries: Record<string, CatalogEntry> = {};
  for (const app of listed) {
    const entry = entryOf.get(app.id);
    if (entry) entries[app.id] = entry;
  }
  return { apps: listed, entries, available };
}
