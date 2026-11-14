/**
 * Claude Code remembers each MCP server that answered 401 and, for fifteen minutes, starts without connecting to
 * it. For a host-managed server that memory outlives its cause: once the host restores the credential, the next
 * turn must reach the server. The group's Claude home is shared by its sessions and kept across containers, so
 * the entries are dropped before each query starts.
 */
import fs from 'fs';
import path from 'path';

import { isHostManagedMcpServer } from './claude-config.js';
import { claudeConfigDirectory } from './claude-history.js';

export const MCP_NEEDS_AUTH_CACHE = 'mcp-needs-auth-cache.json';

function log(msg: string): void {
  console.error(`[claude-mcp-auth] ${msg}`);
}

function isErrno(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && typeof (error as NodeJS.ErrnoException).code === 'string';
}

/** A cache Claude Code itself could not read is left for it to replace. */
function readCache(file: string): Record<string, unknown> | undefined {
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
  return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
    ? (parsed as Record<string, unknown>)
    : undefined;
}

/**
 * Removes every host-managed server from Claude Code's needs-auth memory and keeps the rest. A file that cannot be
 * rewritten only delays the server's tools, so the turn goes ahead.
 */
export function forgetHostManagedMcpAuth(configDirectory: string = claudeConfigDirectory()): void {
  const file = path.join(configDirectory, MCP_NEEDS_AUTH_CACHE);
  const cache = readCache(file);
  if (!cache) return;
  const kept = Object.fromEntries(Object.entries(cache).filter(([server]) => !isHostManagedMcpServer(server)));
  if (Object.keys(kept).length === Object.keys(cache).length) return;
  // Renamed into place, so a session starting alongside never reads half a file.
  const staged = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(staged, JSON.stringify(kept));
    fs.renameSync(staged, file);
  } catch (error) {
    if (!isErrno(error)) throw error;
    fs.rmSync(staged, { force: true });
    log(`Could not clear host-managed servers from ${MCP_NEEDS_AUTH_CACHE}: ${error.code}`);
  }
}
