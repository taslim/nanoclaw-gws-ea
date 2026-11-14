/**
 * Host-managed MCP servers (`app_` keys) never sign in from inside the container.
 *
 * The provider's options are captured through a stubbed SDK, then replayed into the PINNED SDK with a host-managed
 * server that answers 401 and advertises OAuth with automatic registration, and an in-process stand-in for the
 * Anthropic API that holds its first request. That request carries the tool list the model would be offered. No
 * request leaves the machine.
 */
import { afterAll, afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { randomUUID } from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';

import { closeSessionDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';

const pinnedSdk = await import('@anthropic-ai/claude-agent-sdk');
const pinnedQuery = pinnedSdk.query;

interface CapturedOptions {
  disallowedTools?: string[];
  mcpServers?: Record<string, unknown>;
  [key: string]: unknown;
}
let captured: CapturedOptions | undefined;

mock.module('@anthropic-ai/claude-agent-sdk', () => ({
  ...pinnedSdk,
  query: (args: { options?: CapturedOptions }) => {
    captured = args.options;
    return (async function* () {
      yield { type: 'result', subtype: 'success', result: '' };
    })();
  },
}));

const actualConfig = await import('../config.js');
mock.module('../config.js', () => ({
  ...actualConfig,
  runnerCapabilities: () => new Set(['reply', 'files-read', 'shell', 'web', 'mcp-servers']),
}));

await import('./index.js');
await import('../provider-contracts/index.js');
const { createProvider } = await import('./factory.js');
const { MEMORY_SESSION_HOOK } = await import('../memory/session-hook.js');
const { MCP_NEEDS_AUTH_CACHE } = await import('./claude-mcp-auth.js');

const APP = 'app_0a1b2c3d4e5f';
const OPERATOR = 'homeboard';

/** A host-managed server whose credential is gone: every MCP request is refused, sign-in is advertised. */
const appRequests: string[] = [];
const app = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  fetch(request) {
    const url = new URL(request.url);
    appRequests.push(url.pathname);
    const origin = `http://127.0.0.1:${app.port}`;
    if (url.pathname.startsWith('/.well-known/oauth-protected-resource'))
      return Response.json({ resource: `${origin}/mcp`, authorization_servers: [origin] });
    if (url.pathname.startsWith('/.well-known/oauth-authorization-server'))
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
      });
    if (url.pathname === '/register') return Response.json({ client_id: 'registered-in-container' }, { status: 201 });
    return new Response('unauthorized', {
      status: 401,
      headers: { 'WWW-Authenticate': `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"` },
    });
  },
});

const waiting = new Map<string, (body: string) => void>();
const api = Bun.serve({
  hostname: '127.0.0.1',
  port: 0,
  async fetch(request) {
    const body = await request.text();
    if (new URL(request.url).pathname.endsWith('/v1/messages')) {
      for (const [nonce, resolve] of waiting) {
        if (!body.includes(nonce)) continue;
        waiting.delete(nonce);
        resolve(body);
      }
    }
    return Response.json(
      { type: 'error', error: { type: 'authentication_error', message: 'host-managed wire stub' } },
      { status: 401 },
    );
  },
});

afterAll(() => {
  app.stop(true);
  api.stop(true);
});

let tmp: string;
const previousConfigDirectory = process.env.CLAUDE_CONFIG_DIR;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-host-managed-mcp-'));
  captured = undefined;
  appRequests.length = 0;
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
  if (previousConfigDirectory === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = previousConfigDirectory;
  fs.rmSync(tmp, { recursive: true, force: true });
});

const SERVERS = {
  [APP]: { type: 'http', url: `http://127.0.0.1:${app.port}/mcp` },
  [OPERATOR]: { type: 'http', url: 'http://127.0.0.1:9/mcp' },
};

/** Runs one provider query against the stubbed SDK, with Claude's home at `configDirectory`. */
async function providerQuery(configDirectory: string, mcpServers: Record<string, unknown> = SERVERS) {
  process.env.CLAUDE_CONFIG_DIR = configDirectory;
  const provider = createProvider('claude', { mcpServers: mcpServers as never, env: { PATH: process.env.PATH } });
  provider.registerMemorySessionHook(MEMORY_SESSION_HOOK);
  for await (const _event of provider.query({ prompt: 'go', cwd: tmp }).events) {
    // Drain the stub stream so the provider has called the SDK.
  }
  if (!captured) throw new Error('the provider never called the SDK');
  return captured;
}

function writeCache(configDirectory: string, contents: string): string {
  fs.mkdirSync(configDirectory, { recursive: true });
  const file = path.join(configDirectory, MCP_NEEDS_AUTH_CACHE);
  fs.writeFileSync(file, contents);
  return file;
}

describe('host-managed MCP servers', () => {
  it('disallow Claude Code’s sign-in tools for app servers only', async () => {
    const options = await providerQuery(path.join(tmp, '.claude'));

    expect(options.disallowedTools).toEqual(
      expect.arrayContaining([`mcp__${APP}__authenticate`, `mcp__${APP}__complete_authentication`]),
    );
    expect(options.disallowedTools?.filter((tool) => tool.includes(OPERATOR))).toEqual([]);
  });

  it('forget an app server’s remembered 401 before each query and keep the others', async () => {
    const configDirectory = path.join(tmp, '.claude');
    const file = writeCache(
      configDirectory,
      JSON.stringify({ [APP]: { timestamp: Date.now() }, [OPERATOR]: { timestamp: 1794690297151, ttlMs: 900000 } }),
    );

    await providerQuery(configDirectory);

    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({
      [OPERATOR]: { timestamp: 1794690297151, ttlMs: 900000 },
    });
    expect(fs.readdirSync(configDirectory)).toEqual([MCP_NEEDS_AUTH_CACHE]);
  });

  it('leave a missing or unreadable cache for Claude Code', async () => {
    const configDirectory = path.join(tmp, '.claude');
    await providerQuery(configDirectory);
    expect(fs.existsSync(path.join(configDirectory, MCP_NEEDS_AUTH_CACHE))).toBe(false);

    const file = writeCache(configDirectory, '{"app_0a1b2c3d4e5f":');
    await providerQuery(configDirectory);
    expect(fs.readFileSync(file, 'utf8')).toBe('{"app_0a1b2c3d4e5f":');
  });

  it('answering 401 leave no sign-in tool, auth URL or credential, and nothing remembered by the next query', async () => {
    const home = fs.mkdtempSync(path.join(tmp, 'home-'));
    const configDirectory = path.join(home, '.claude');
    const options = await providerQuery(configDirectory, { [APP]: SERVERS[APP] });
    const { pathToClaudeCodeExecutable: _binary, hooks: _hooks, ...replayed } = options;
    const nonce = `host-managed-wire-${randomUUID()}`;
    const request = new Promise<string>((resolve) => waiting.set(nonce, resolve));
    const run = pinnedQuery({
      prompt: `Reply with one word. ${nonce}`,
      options: {
        ...replayed,
        cwd: fs.mkdtempSync(path.join(tmp, 'cwd-')),
        env: {
          PATH: process.env.PATH,
          HOME: home,
          CLAUDE_CONFIG_DIR: configDirectory,
          ANTHROPIC_BASE_URL: `http://127.0.0.1:${api.port}`,
          ANTHROPIC_API_KEY: 'host-managed-wire-stub',
          DISABLE_TELEMETRY: '1',
          CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
        },
      } as never,
    });
    let resolveInit: (servers: Array<{ name: string; status: string }>) => void = () => {};
    const init = new Promise<Array<{ name: string; status: string }>>((resolve) => (resolveInit = resolve));
    const drained = (async () => {
      try {
        for await (const message of run) {
          if (message.type === 'system' && message.subtype === 'init') resolveInit(message.mcp_servers);
        }
      } catch {
        // Expected: the API stand-in refuses every request.
      }
    })();
    let body: string;
    let servers: Array<{ name: string; status: string }>;
    try {
      [body, servers] = await Promise.all([request, init]);
    } finally {
      run.close();
      await drained;
    }

    // The server was reached and refused before the model was asked, so its sign-in surface was already settled.
    expect(servers).toContainEqual(expect.objectContaining({ name: APP, status: 'needs-auth' }));
    const tools = ((JSON.parse(body) as { tools?: Array<{ name: string }> }).tools ?? []).map((tool) => tool.name);
    expect(tools.filter((tool) => tool.startsWith(`mcp__${APP}__`))).toEqual([]);
    expect(body).not.toContain(`127.0.0.1:${app.port}/authorize`);
    expect(appRequests.filter((pathname) => ['/register', '/token', '/authorize'].includes(pathname))).toEqual([]);
    expect(fs.existsSync(path.join(configDirectory, '.credentials.json'))).toBe(false);

    // The pinned Claude Code remembers the refusal, as it does for any server; the next query starts without it.
    const remembered = () =>
      Object.keys(JSON.parse(fs.readFileSync(path.join(configDirectory, MCP_NEEDS_AUTH_CACHE), 'utf8')) as object);
    expect(remembered()).toContain(APP);
    await providerQuery(configDirectory, { [APP]: SERVERS[APP] });
    expect(remembered()).not.toContain(APP);
  }, 60_000);
});
