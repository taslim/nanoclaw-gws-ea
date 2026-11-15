/**
 * Claude Code remembers each MCP server that answered 401: for fifteen minutes in its needs-auth cache, and for a
 * week as a tokenless rejection on the server's entry in its credentials store. Either one makes the next query
 * start the server as needing sign-in, without connecting to it. For a host-managed server that memory outlives its
 * cause: once the host restores the credential, the next turn must reach the server. The group's Claude home is
 * shared by its sessions and kept across containers, so both are dropped before each query starts.
 */
import fs from 'fs';
import path from 'path';

import { isHostManagedMcpServer } from './claude-config.js';
import { claudeConfigDirectory } from './claude-history.js';

export const MCP_NEEDS_AUTH_CACHE = 'mcp-needs-auth-cache.json';
/** Claude Code's credentials store on Linux, the container's platform; on macOS it uses the Keychain instead. */
export const CLAUDE_CREDENTIALS_FILE = '.credentials.json';

function log(msg: string): void {
  console.error(`[claude-mcp-auth] ${msg}`);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A file Claude Code itself could not read is left for it to replace. */
function readObject(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (isErrno(error)) return undefined;
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    if (error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isRecord(parsed) ? parsed : undefined;
}

/** Keeps only the entries whose server is not host-managed, or returns undefined when there is nothing to drop. */
function withoutHostManaged(
  entries: Record<string, unknown>,
  serverOf: (key: string) => string,
): Record<string, unknown> | undefined {
  const kept = Object.fromEntries(Object.entries(entries).filter(([key]) => !isHostManagedMcpServer(serverOf(key))));
  return Object.keys(kept).length === Object.keys(entries).length ? undefined : kept;
}

/**
 * Renamed into place, so a session starting alongside never reads half a file, and owner-only like the credentials
 * store it may replace. A file that cannot be rewritten only delays the server's tools, so the turn goes ahead.
 */
function replace(file: string, contents: Record<string, unknown>): void {
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(staged, JSON.stringify(contents), { mode: 0o600 });
    fs.renameSync(staged, file);
  } catch (error) {
    if (!isErrno(error)) throw error;
    fs.rmSync(staged, { force: true });
    log(`Could not clear host-managed servers from ${path.basename(file)}: ${error.code}`);
  }
}

/** Removes every host-managed server from Claude Code's sign-in memory and keeps the rest. */
export function forgetHostManagedMcpAuth(configDirectory: string = claudeConfigDirectory()): void {
  const cacheFile = path.join(configDirectory, MCP_NEEDS_AUTH_CACHE);
  const cache = readObject(cacheFile);
  const keptCache = cache && withoutHostManaged(cache, (server) => server);
  if (keptCache) replace(cacheFile, keptCache);

  // A host-managed server never signs in from the container, so none of its stored entries is a credential to keep.
  const storeFile = path.join(configDirectory, CLAUDE_CREDENTIALS_FILE);
  const store = readObject(storeFile);
  const signIns = store?.mcpOAuth;
  if (!store || !isRecord(signIns)) return;
  // Entries are keyed `<server name>|<config hash>`.
  const keptSignIns = withoutHostManaged(signIns, (key) => key.split('|', 1)[0] ?? key);
  if (keptSignIns) replace(storeFile, { ...store, mcpOAuth: keptSignIns });
}
