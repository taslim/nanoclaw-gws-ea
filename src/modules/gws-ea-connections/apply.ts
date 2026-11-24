import { isDeepStrictEqual } from 'node:util';

import { mcpServerPluginOwner } from '../../container-config.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig, updateContainerConfigJson } from '../../db/container-configs.js';
import { readMainAgentGroupId } from '../gws-ea-profile/db.js';
import { checkRestartSoon } from './idle-restart.js';
import { withAppLock } from './locks.js';
import type { ConnectionApp, ConnectionsStore } from './store.js';

/** The key prefix the store gives every app; main's entries under it belong to the store alone. */
export const APP_SERVER_PREFIX = 'app_';
export const APP_RELAY_COMMAND = 'bun';
export const APP_RELAY_SCRIPT = '/app/src/mcp-tools/app-relay.ts';

export interface AppRelayServerEntry {
  readonly command: typeof APP_RELAY_COMMAND;
  readonly args: readonly ['run', typeof APP_RELAY_SCRIPT, string];
}

export function appRelayServerEntry(serverKey: string): AppRelayServerEntry {
  return { command: APP_RELAY_COMMAND, args: ['run', APP_RELAY_SCRIPT, serverKey] };
}

export interface OperatorServer {
  readonly key: string;
  readonly url: string;
}

export type OperatorRemoval = 'removed' | 'absent' | 'not_operator';

/** Main's stored servers cannot be read as a map of entries, so nothing in them can be kept or replaced safely. */
export class MainServersUnreadableError extends Error {
  constructor() {
    super("Main's stored MCP servers are not a map of entries");
  }
}

type StoredServers = Record<string, unknown>;
type AppEntry = AppRelayServerEntry;

/** Applies and removals read, change and write one stored column, so one runs at a time. */
const MAIN_SERVERS_LOCK = 'main-servers';

async function readServers(agentGroupId: string): Promise<StoredServers | undefined> {
  const row = await getContainerConfig(agentGroupId);
  if (!row) return undefined;
  const parsed: unknown = JSON.parse(row.mcp_servers);
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new MainServersUnreadableError();
  return parsed as StoredServers;
}

function isAppEntry(key: string, entry: unknown): boolean {
  return key.startsWith(APP_SERVER_PREFIX) && mcpServerPluginOwner(entry) === undefined;
}

function desiredAppEntries(apps: readonly ConnectionApp[]): Map<string, AppEntry> {
  return new Map(
    apps
      .filter((app) => app.status === 'connected')
      .map((app): [string, AppEntry] => [app.serverKey, appRelayServerEntry(app.serverKey)])
      .sort(([a], [b]) => a.localeCompare(b)),
  );
}

function appEntriesMatch(servers: StoredServers, desired: ReadonlyMap<string, AppEntry>): boolean {
  const current = Object.entries(servers).filter(([key, entry]) => isAppEntry(key, entry));
  if (current.length !== desired.size) return false;
  return current.every(([key, entry]) => isDeepStrictEqual(entry, desired.get(key)));
}

function withAppEntries(servers: StoredServers, desired: ReadonlyMap<string, AppEntry>): StoredServers {
  const next: StoredServers = {};
  for (const [key, entry] of Object.entries(servers)) if (!isAppEntry(key, entry)) next[key] = entry;
  for (const [key, entry] of desired) if (!(key in next)) next[key] = entry;
  return next;
}

/**
 * Records the restart before the write as well as after it, so a host that stops between the two still restarts
 * the containers the write left behind.
 */
async function writeAndRequestRestart<T>(store: ConnectionsStore, write: () => Promise<T>): Promise<T> {
  await store.requestRestart(new Date().toISOString());
  const outcome = await write();
  await store.requestRestart(new Date().toISOString());
  checkRestartSoon();
  return outcome;
}

/** Schedules an idle restart of main's containers so live sessions pick up updated tool definitions or labels. */
export async function notifyMainToolsChanged(store: ConnectionsStore): Promise<void> {
  await store.requestRestart(new Date().toISOString());
  checkRestartSoon();
}

/**
 * Reconciles main's entries to the store and returns whether they changed. Without a canonical main, or before its
 * configuration exists, there is nothing to reconcile.
 */
export function applyMainServers(store: ConnectionsStore): Promise<boolean> {
  return withAppLock(MAIN_SERVERS_LOCK, async () => {
    const desired = desiredAppEntries(await store.apps());
    const agentGroupId = await readMainAgentGroupId();
    if (!agentGroupId) return false;
    const before = await readServers(agentGroupId);
    if (!before || appEntriesMatch(before, desired)) return false;
    return writeAndRequestRestart(store, () =>
      getDb().transaction(async () => {
        const current = await readServers(agentGroupId);
        if (!current || appEntriesMatch(current, desired)) return false;
        await updateContainerConfigJson(agentGroupId, 'mcp_servers', withAppEntries(current, desired));
        return true;
      }),
    );
  });
}

function operatorServer(key: string, entry: unknown): OperatorServer | undefined {
  if (key.startsWith(APP_SERVER_PREFIX) || typeof entry !== 'object' || entry === null) return undefined;
  if (mcpServerPluginOwner(entry) !== undefined) return undefined;
  const { type, url } = entry as Record<string, unknown>;
  return type === 'http' && typeof url === 'string' ? { key, url } : undefined;
}

/** Main's `http` servers the operator added; stdio and plugin servers are theirs to manage elsewhere. */
export async function mainOperatorServers(): Promise<readonly OperatorServer[]> {
  const agentGroupId = await readMainAgentGroupId();
  const servers = agentGroupId ? await readServers(agentGroupId) : undefined;
  if (!servers) return [];
  return Object.entries(servers).flatMap(([key, entry]) => operatorServer(key, entry) ?? []);
}

/** Takes one operator server away from main; an app's entry or a plugin's is never removed this way. */
export function removeOperatorServer(store: ConnectionsStore, key: string): Promise<OperatorRemoval> {
  return withAppLock(MAIN_SERVERS_LOCK, async () => {
    const agentGroupId = await readMainAgentGroupId();
    const before = agentGroupId ? await readServers(agentGroupId) : undefined;
    if (!agentGroupId || !before || !Object.hasOwn(before, key)) return 'absent';
    if (!operatorServer(key, before[key])) return 'not_operator';
    return writeAndRequestRestart(store, () =>
      getDb().transaction(async (): Promise<OperatorRemoval> => {
        const current = await readServers(agentGroupId);
        if (!current || !Object.hasOwn(current, key)) return 'absent';
        if (!operatorServer(key, current[key])) return 'not_operator';
        const { [key]: _removed, ...rest } = current;
        await updateContainerConfigJson(agentGroupId, 'mcp_servers', rest);
        return 'removed';
      }),
    );
  });
}
