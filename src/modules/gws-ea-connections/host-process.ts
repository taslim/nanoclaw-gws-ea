/**
 * A host-run catalog app as an MCP transport: the operator-installed CLI, spawned only after its receipt verifies, with
 * a fixed environment, its own working directory and its own public-only proxy. Its credentials live in a file in that
 * directory, outside every container mount, and its stderr is discarded so nothing it prints reaches a log.
 */
import { lstat, mkdir } from 'node:fs/promises';
import path from 'node:path';

import type { JSONRPCMessage, Transport, TransportSendOptions } from '@modelcontextprotocol/client';
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio';

import { isRecord } from '../../gws-ea/validation.js';
import { startPublicBrowserProxy, type PublicBrowserProxy } from '../gws-ea-browser/proxy.js';
import { operatorEnabled, readCatalogPolicy, type CatalogEntry, type CatalogPolicy } from './catalog.js';
import { connectionsRoot } from './config.js';
import { HostCliInstallError, verifyHostCliReceipt, type HostCliTransport } from './host-cli-receipt.js';

export const HOST_PROCESS_IDLE_MS = 5 * 60_000;

export type HostCliEntry = CatalogEntry & { readonly transport: HostCliTransport };

export function isHostCliEntry(entry: CatalogEntry): entry is HostCliEntry {
  return entry.transport.kind === 'host_cli';
}

export type HostCliUnavailableReason = 'not_enabled' | 'invalid_install' | 'no_connections_root' | 'unsafe_directory';

export class HostCliUnavailableError extends Error {
  constructor(readonly reason: HostCliUnavailableReason) {
    super(`Host-run app unavailable: ${reason}`);
    this.name = 'HostCliUnavailableError';
  }
}

export interface HostCliLaunch {
  readonly entryFile: string;
  readonly args: readonly string[];
  readonly workDir: string;
  readonly authFile: string;
}

/**
 * Everything the child may see. The CLI routes its API calls through `LINK_HTTP_PROXY`, but its sign-in, token
 * refresh and update check use Node's global fetch, which follows the standard proxy variables only when
 * `NODE_USE_ENV_PROXY` is set; together they send every request through the public-only proxy. `NO_PROXY` stays unset
 * so nothing is exempt.
 */
export function hostCliEnvironment(input: {
  readonly workDir: string;
  readonly authFile: string;
  readonly proxyUrl: string;
}): Record<string, string> {
  return {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: input.workDir,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    LINK_AUTH_FILE: input.authFile,
    LINK_HTTP_PROXY: input.proxyUrl,
    HTTPS_PROXY: input.proxyUrl,
    HTTP_PROXY: input.proxyUrl,
    NODE_USE_ENV_PROXY: '1',
  };
}

function installationFor(entry: HostCliEntry, policy: CatalogPolicy): string | undefined {
  switch (entry.prerequisite) {
    case 'link_install':
      return policy.link?.versions[entry.transport.version]?.installationDir;
    case 'none':
    case 'shop_client':
      return undefined;
  }
}

async function privateDirectory(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const info = await lstat(dir);
  if (
    !info.isDirectory() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid())
  ) {
    throw new HostCliUnavailableError('unsafe_directory');
  }
}

export function hostCliPaths(entry: HostCliEntry): { readonly workDir: string; readonly authFile: string } {
  const root = connectionsRoot();
  if (!root || !path.isAbsolute(root)) throw new HostCliUnavailableError('no_connections_root');
  const workDir = path.join(root, entry.id);
  return { workDir, authFile: path.join(workDir, 'auth.json') };
}

async function launchFrom(entry: HostCliEntry, installationDir: string | undefined): Promise<HostCliLaunch> {
  if (installationDir === undefined) throw new HostCliUnavailableError('not_enabled');
  let entryFile: string;
  try {
    ({ entryFile } = await verifyHostCliReceipt(installationDir, entry.transport));
  } catch (error) {
    if (error instanceof HostCliInstallError) throw new HostCliUnavailableError('invalid_install');
    throw error;
  }
  const { workDir, authFile } = hostCliPaths(entry);
  await privateDirectory(workDir);
  return { entryFile, args: entry.transport.mcpArgs, workDir, authFile };
}

export async function resolveHostCliLaunch(entry: HostCliEntry): Promise<HostCliLaunch> {
  const state = await readCatalogPolicy();
  if (!operatorEnabled(entry, state)) throw new HostCliUnavailableError('not_enabled');
  return launchFrom(entry, state.status === 'read' ? installationFor(entry, state.policy) : undefined);
}

/**
 * The pinned version while it is still installed, enabled or not: an operator disables an entry before removing its
 * files, so the CLI can still revoke a sign-in on the way out.
 */
export async function resolveInstalledHostCli(entry: HostCliEntry): Promise<HostCliLaunch> {
  const state = await readCatalogPolicy();
  return launchFrom(entry, state.status === 'read' ? installationFor(entry, state.policy) : undefined);
}

export function firstText(result: { readonly content?: unknown }): string | undefined {
  if (!Array.isArray(result.content)) return undefined;
  const first: unknown = result.content[0];
  return isRecord(first) && first.type === 'text' && typeof first.text === 'string' ? first.text : undefined;
}

/**
 * link-cli answers a call it cannot authenticate with its message as the result's only text: no saved sign-in, or a
 * refresh token the sign-in server refused. A refresh that failed any other way may pass, so it does not count.
 */
const HOST_CLI_AUTH_REFUSED = /^(?:Not authenticated\.|Token refresh failed \(40[01]\):)/u;

export function hostCliAuthRefused(result: Record<string, unknown>): boolean {
  if (result.isError !== true) return false;
  const text = firstText(result);
  return text !== undefined && HOST_CLI_AUTH_REFUSED.test(text);
}

export class HostProcessTransport implements Transport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: JSONRPCMessage) => void;
  /** Runs as each message is about to be written to the child, so callers know a request may have reached it. */
  onwrite?: (message: JSONRPCMessage) => void;

  readonly #launch: HostCliLaunch;
  #proxy: PublicBrowserProxy | undefined;
  #child: StdioClientTransport | undefined;
  #running = false;
  #finished = false;

  constructor(launch: HostCliLaunch) {
    this.#launch = launch;
  }

  async start(): Promise<void> {
    const proxy = await startPublicBrowserProxy();
    this.#proxy = proxy;
    const child = new StdioClientTransport({
      command: process.execPath,
      args: [this.#launch.entryFile, ...this.#launch.args],
      cwd: this.#launch.workDir,
      env: hostCliEnvironment({ workDir: this.#launch.workDir, authFile: this.#launch.authFile, proxyUrl: proxy.url }),
      stderr: 'ignore',
    });
    child.onmessage = (message) => this.onmessage?.(message);
    child.onerror = (error) => this.onerror?.(error);
    child.onclose = () => {
      this.#running = false;
      void this.#finish();
    };
    this.#child = child;
    try {
      await child.start();
    } catch (error) {
      await this.#finish();
      throw error;
    }
    this.#running = true;
  }

  async send(message: JSONRPCMessage, _options?: TransportSendOptions): Promise<void> {
    if (!this.#running || !this.#child) throw new Error('Host-run app is not running');
    this.onwrite?.(message);
    await this.#child.send(message);
  }

  async close(): Promise<void> {
    this.#running = false;
    await this.#child?.close();
    await this.#finish();
  }

  async #finish(): Promise<void> {
    if (this.#finished) return;
    this.#finished = true;
    await this.#proxy?.close();
    this.onclose?.();
  }
}
