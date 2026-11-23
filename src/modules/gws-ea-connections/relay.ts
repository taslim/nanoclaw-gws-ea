/**
 * Host-side MCP relay for principal-connected apps.
 *
 * Holds one `@modelcontextprotocol/sdk` `Client` per app over `StreamableHTTPClientTransport`, using the host's
 * public fetch with host-held credentials injected per request and no standalone GET SSE stream. Every `tools/list`
 * is pinned with RFC 8785 canonical definition hashes; every `tools/call` passes through the label gate; every
 * approved call claims an atomic in-flight record before touching the network.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { log as hostLog } from '../../log.js';
import type { Session } from '../../types.js';
import { EgressError, publicFetch, type EgressDependencies } from '../gws-ea-egress/fetch.js';
import { canonicalArgsHash, normalizeToolDefinition, type ToolDefinition } from './canonical.js';
import { getConnectionsRefresher, type ConnectionsRefresher, type UsableToken } from './refresher.js';
import {
  ConnectionsStoreError,
  type ConnectionApp,
  type ConnectionsStore,
  type PinnedAppTool,
  type PinToolsResult,
  type ToolLabel,
} from './store.js';

/** Re-read `tools/list` before a "just do it" call when the pin was last confirmed longer ago than this. */
export const PIN_FRESHNESS_MS = 10 * 60_000;
/** Timeout per upstream MCP request (longer than OAuth metadata fetches). */
export const RELAY_TIMEOUT_MS = 60_000;
/** Response cap for relayed MCP requests (4 MiB). */
export const RELAY_MAX_BODY_BYTES = 4 * 1024 * 1024;
const MAX_LIST_PAGES = 50;

export const ASK_FIRST_DESCRIPTION_SUFFIX = 'Asks the principal first.';
export const UNSORTED_TOOL_MESSAGE = 'This tool is still being set up, try again shortly.';
export const TOO_LARGE_RESPONSE_MESSAGE = 'The app answered, but the result was too large to read.';
export const UNKNOWN_OUTCOME_MESSAGE = 'The outcome of this call is unknown; check before retrying.';

export interface RelayedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: ToolDefinition['annotations'];
  readonly label: ToolLabel | null;
}

export interface RelayedToolList {
  readonly instructions: string | null;
  readonly tools: readonly RelayedTool[];
}

export interface HoldCallInput {
  readonly app: ConnectionApp;
  readonly grantGeneration: number;
  readonly tool: PinnedAppTool;
  readonly args: Record<string, unknown>;
  readonly canonicalArgs: string;
  readonly argsHash: string;
  readonly summary: string | undefined;
  readonly session: Session;
  readonly requestId: string;
}

export type RelayCallOutcome =
  | { readonly status: 'completed'; readonly result: Record<string, unknown> }
  | { readonly status: 'held'; readonly text: string; readonly approvalId?: string }
  | { readonly status: 'unsorted'; readonly text: string }
  | { readonly status: 'too_large'; readonly text: string }
  | { readonly status: 'unsent'; readonly text: string; readonly reason?: string }
  | { readonly status: 'unknown'; readonly text: string };

export type HoldCallHandler = (input: HoldCallInput) => Promise<RelayCallOutcome>;

export interface ExecuteApprovedCallInput {
  readonly approvalId: string;
  readonly appId: string;
  readonly grantGeneration: number;
  readonly toolName: string;
  readonly definitionHash: string;
  readonly args: Record<string, unknown>;
}

export interface RelayDependencies {
  readonly store: ConnectionsStore;
  readonly refresher?: () => ConnectionsRefresher | undefined;
  readonly egress?: Partial<EgressDependencies>;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
  readonly now?: () => number;
  readonly onToolsNeedSort?: (appId: string, listHash: string) => void;
  readonly onHoldCall?: HoldCallHandler;
}

export interface AppRelay {
  pinApp(appId: string): Promise<PinToolsResult>;
  pinUnpinnedApps(): Promise<void>;
  initializeApp(serverKey: string): Promise<{ readonly instructions: string | null }>;
  listToolsForSession(serverKey: string): Promise<RelayedToolList>;
  callTool(input: {
    readonly serverKey: string;
    readonly toolName: string;
    readonly args: Record<string, unknown>;
    readonly summary?: string;
    readonly session: Session;
    readonly requestId: string;
  }): Promise<RelayCallOutcome>;
  executeApprovedCall(input: ExecuteApprovedCallInput): Promise<RelayCallOutcome>;
  setHoldCallHandler(handler: HoldCallHandler): void;
  setOnToolsNeedSort(callback: (appId: string, listHash: string) => void): void;
  closeApp(appId: string): Promise<void>;
  closeAll(): Promise<void>;
}

interface CallTrace {
  egressError: EgressError | undefined;
  httpSent: boolean;
  httpStatus: number | undefined;
}

function resetTrace(trace: CallTrace): void {
  trace.egressError = undefined;
  trace.httpSent = false;
  trace.httpStatus = undefined;
}

function snapshotTrace(trace: CallTrace): Readonly<CallTrace> {
  return { egressError: trace.egressError, httpSent: trace.httpSent, httpStatus: trace.httpStatus };
}

interface ManagedClient {
  readonly appId: string;
  readonly url: string;
  readonly grantGeneration: number;
  readonly client: Client;
  readonly transport: StreamableHTTPClientTransport;
  readonly trace: CallTrace;
  /** Mutable auth header read on each HTTP request; refreshed transparently if token rotates. */
  currentToken: string | undefined;
}

function appendAskFirstSuffix(description: string | undefined): string {
  const trimmed = description?.trim();
  if (!trimmed) return ASK_FIRST_DESCRIPTION_SUFFIX;
  if (trimmed.includes(ASK_FIRST_DESCRIPTION_SUFFIX)) return trimmed;
  return `${trimmed}\n\n${ASK_FIRST_DESCRIPTION_SUFFIX}`;
}

function formatToolForMain(pinned: PinnedAppTool): RelayedTool {
  const description =
    pinned.label === 'ask_first' ? appendAskFirstSuffix(pinned.definition.description) : pinned.definition.description;
  return {
    name: pinned.definition.name,
    ...(pinned.definition.title === undefined ? {} : { title: pinned.definition.title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: pinned.definition.inputSchema,
    ...(pinned.definition.outputSchema === undefined ? {} : { outputSchema: pinned.definition.outputSchema }),
    ...(pinned.definition.annotations === undefined ? {} : { annotations: pinned.definition.annotations }),
    label: pinned.label,
  };
}

function defaultHoldRefusal(): Promise<RelayCallOutcome> {
  return Promise.resolve({
    status: 'unsent',
    reason: 'hold_unavailable',
    text: 'This tool requires principal approval, which is not available right now.',
  });
}

export function createAppRelay(dependencies: RelayDependencies): AppRelay {
  const { store } = dependencies;
  const now = dependencies.now ?? Date.now;
  const timeoutMs = dependencies.timeoutMs ?? RELAY_TIMEOUT_MS;
  const maxBodyBytes = dependencies.maxBodyBytes ?? RELAY_MAX_BODY_BYTES;
  const readRefresher = dependencies.refresher ?? getConnectionsRefresher;
  const rawFetch = publicFetch({ redirect: 'none', timeoutMs, maxBodyBytes }, dependencies.egress);

  let holdHandler: HoldCallHandler = dependencies.onHoldCall ?? defaultHoldRefusal;
  let onToolsNeedSort: ((appId: string, listHash: string) => void) | undefined = dependencies.onToolsNeedSort;

  const clients = new Map<string, ManagedClient>();
  const connecting = new Map<string, Promise<ManagedClient>>();
  const refreshing = new Map<string, Promise<void>>();

  async function resolveBearer(
    app: ConnectionApp,
    generation: number,
    forceRenew = false,
  ): Promise<UsableToken | undefined> {
    if (app.auth === 'none') return undefined;
    const refresher = readRefresher();
    if (refresher) return refresher.ensureToken(app.id, { forceRenew });
    // Direct store read fallback when running standalone without a background refresher (e.g. unit tests).
    if (app.auth === 'token') {
      const creds = await store.readGrant(app.id, generation);
      return creds?.kind === 'token' ? { generation: creds.generation, token: creds.token } : undefined;
    }
    const stored = await store.readAccessToken(app.id, generation);
    if (stored && Date.parse(stored.expiresAt) > now()) {
      return { generation: stored.generation, token: stored.token };
    }
    return undefined;
  }

  async function closeClient(managed: ManagedClient): Promise<void> {
    if (clients.get(managed.appId) === managed) clients.delete(managed.appId);
    try {
      await managed.client.close();
      /* eslint-disable-next-line no-catch-all/no-catch-all -- best-effort cleanup of an upstream transport */
    } catch {
      // Transport may already be closed or disconnected.
    }
  }

  async function ensureClient(app: ConnectionApp, generation: number, forceRenew = false): Promise<ManagedClient> {
    let token: string | undefined;
    if (app.auth !== 'none') {
      const usable = await resolveBearer(app, generation, forceRenew);
      if (!usable || usable.generation !== generation) {
        throw new EgressError('refused', { sent: false });
      }
      token = usable.token;
    }

    const existing = clients.get(app.id);
    if (existing && existing.url === app.url && existing.grantGeneration === generation) {
      existing.currentToken = token;
      return existing;
    }
    if (existing) await closeClient(existing);

    const inflight = connecting.get(app.id);
    if (inflight) {
      const ready = await inflight;
      if (ready.url === app.url && ready.grantGeneration === generation) {
        ready.currentToken = token;
        return ready;
      }
      await closeClient(ready);
    }

    const open = (async (): Promise<ManagedClient> => {
      const trace: CallTrace = { egressError: undefined, httpSent: false, httpStatus: undefined };
      const managed: {
        client: Client;
        transport: StreamableHTTPClientTransport;
        currentToken: string | undefined;
      } = {
        client: new Client({ name: 'nanoclaw-host-relay', version: '1.0.0' }, { capabilities: {} }),
        transport: undefined as unknown as StreamableHTTPClientTransport,
        currentToken: token,
      };
      const customFetch: FetchLike = async (input, init) => {
        const method = (init?.method ?? 'GET').toUpperCase();
        // Never open the standalone GET SSE stream: returning 405 tells StreamableHTTPClientTransport it is unsupported.
        if (method === 'GET') return new Response(null, { status: 405 });
        const headers = new Headers(init?.headers);
        if (managed.currentToken !== undefined) headers.set('Authorization', `Bearer ${managed.currentToken}`);
        else headers.delete('Authorization');
        try {
          const response = await rawFetch(input, { ...init, headers });
          trace.httpSent = true;
          trace.httpStatus = response.status;
          return response;
        } catch (error) {
          if (error instanceof EgressError) trace.egressError = error;
          throw error;
        }
      };
      const transport = new StreamableHTTPClientTransport(new URL(app.url), {
        fetch: customFetch,
      });
      managed.transport = transport;
      const entry: ManagedClient = {
        appId: app.id,
        url: app.url,
        grantGeneration: generation,
        client: managed.client,
        transport,
        trace,
        get currentToken() {
          return managed.currentToken;
        },
        set currentToken(next: string | undefined) {
          managed.currentToken = next;
        },
      };
      transport.onclose = () => {
        if (clients.get(app.id) === entry) clients.delete(app.id);
      };
      try {
        await managed.client.connect(transport);
      } catch (error) {
        await closeClient(entry);
        throw error;
      }
      clients.set(app.id, entry);
      return entry;
    })();

    connecting.set(app.id, open);
    try {
      return await open;
    } finally {
      if (connecting.get(app.id) === open) connecting.delete(app.id);
    }
  }

  async function listAllUpstreamTools(managed: ManagedClient): Promise<readonly ToolDefinition[]> {
    const collected: ToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await managed.client.listTools(cursor ? { cursor } : undefined);
      for (const raw of response.tools) collected.push(normalizeToolDefinition(raw));
      if (!response.nextCursor) break;
      cursor = response.nextCursor;
    }
    return collected;
  }

  async function requireConnectedApp(serverKey: string): Promise<{ app: ConnectionApp; generation: number }> {
    const app = await store.byServerKey(serverKey);
    if (!app || app.status !== 'connected') {
      throw new ConnectionsStoreError('app_not_found');
    }
    const grant = await store.currentGrant(app.id);
    if (!grant) throw new ConnectionsStoreError('app_not_found');
    return { app, generation: grant.generation };
  }

  async function pinApp(appId: string): Promise<PinToolsResult> {
    const app = await store.get(appId);
    const grant = await store.currentGrant(appId);
    if (app.status !== 'connected' || !grant) {
      throw new ConnectionsStoreError('app_not_found');
    }
    const run = async (
      forceRenew: boolean,
    ): Promise<{ instructions: string | null; tools: readonly ToolDefinition[] }> => {
      const managed = await ensureClient(app, grant.generation, forceRenew);
      resetTrace(managed.trace);
      const tools = await listAllUpstreamTools(managed);
      const instructions = managed.client.getInstructions() ?? null;
      return { instructions, tools };
    };
    let listed: { instructions: string | null; tools: readonly ToolDefinition[] };
    try {
      listed = await run(false);
    } catch (error) {
      // Retry once with a fresh token on 401 for renewable OAuth grants.
      const managed = clients.get(app.id);
      const unauthorized = managed?.trace.httpStatus === 401;
      await closeApp(app.id);
      if (unauthorized && app.auth === 'oauth' && grant.kind === 'oauth' && grant.renewable) {
        listed = await run(true);
      } else {
        throw error;
      }
    }
    const result = await store.pinTools(app.id, {
      instructions: listed.instructions,
      tools: listed.tools,
      at: new Date(now()).toISOString(),
    });
    if (result.unsortedCount > 0) onToolsNeedSort?.(app.id, result.pin.listHash);
    return result;
  }

  function triggerBackgroundRefresh(appId: string): void {
    if (refreshing.has(appId)) return;
    const job = pinApp(appId)
      .then(() => undefined)
      .catch((error: unknown) => {
        hostLog.warn('Background app tool refresh failed', {
          appId,
          code:
            error instanceof EgressError
              ? error.code
              : error instanceof ConnectionsStoreError
                ? error.reason
                : 'failed',
        });
      })
      .finally(() => {
        if (refreshing.get(appId) === job) refreshing.delete(appId);
      });
    refreshing.set(appId, job);
  }

  async function invokeUpstreamTool(
    app: ConnectionApp,
    generation: number,
    toolName: string,
    args: Record<string, unknown>,
    allowUnauthorizedRetry: boolean,
  ): Promise<
    | { readonly status: 'completed'; readonly result: Record<string, unknown> }
    | { readonly status: 'too_large' }
    | { readonly status: 'unsent'; readonly reason: string }
    | { readonly status: 'unknown' }
  > {
    const attempt = async (forceRenew: boolean) => {
      let managed: ManagedClient;
      try {
        managed = await ensureClient(app, generation, forceRenew);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- classify any connect/handshake failure into unsent vs unknown */
      } catch (error) {
        if (error instanceof EgressError && error.detail?.sent === true) {
          return { status: 'unknown' as const };
        }
        return { status: 'unsent' as const, reason: error instanceof EgressError ? error.code : 'connect_failed' };
      }
      resetTrace(managed.trace);
      try {
        const result = await managed.client.callTool({ name: toolName, arguments: args });
        return { status: 'completed' as const, result: result as Record<string, unknown> };
        /* eslint-disable-next-line no-catch-all/no-catch-all -- classify any upstream MCP call failure into too_large, unsent, or unknown */
      } catch (error) {
        const { egressError, httpSent, httpStatus } = snapshotTrace(managed.trace);
        if (httpStatus === 401 && !forceRenew && allowUnauthorizedRetry && app.auth === 'oauth') {
          await closeClient(managed);
          return 'retry_401' as const;
        }
        if (egressError?.detail?.reason === 'response_too_large') {
          return { status: 'too_large' as const };
        }
        if (egressError?.detail?.sent === false) {
          return { status: 'unsent' as const, reason: egressError.code };
        }
        if (!httpSent && egressError === undefined) {
          await closeClient(managed);
          return {
            status: 'unsent' as const,
            reason: error instanceof Error ? error.name : 'failed',
          };
        }
        await closeClient(managed);
        return { status: 'unknown' as const };
      }
    };
    const first = await attempt(false);
    if (first === 'retry_401') {
      const second = await attempt(true);
      return second === 'retry_401' ? { status: 'unsent', reason: 'unauthorized' } : second;
    }
    return first;
  }

  async function closeApp(appId: string): Promise<void> {
    const existing = clients.get(appId);
    if (existing) await closeClient(existing);
  }

  async function closeAll(): Promise<void> {
    const all = [...clients.values()];
    clients.clear();
    await Promise.all(all.map((entry) => closeClient(entry)));
  }

  return {
    pinApp,

    async pinUnpinnedApps(): Promise<void> {
      const apps = await store.apps();
      for (const app of apps) {
        if (app.status !== 'connected') continue;
        const pin = await store.getPin(app.id);
        if (pin) continue;
        try {
          await pinApp(app.id);
          /* eslint-disable-next-line no-catch-all/no-catch-all -- startup pinning is best-effort per app so one down app never blocks others */
        } catch (error) {
          hostLog.warn('Could not pin connected app tools at startup', {
            appId: app.id,
            code: error instanceof EgressError ? error.code : 'failed',
          });
        }
      }
    },

    async initializeApp(serverKey: string): Promise<{ readonly instructions: string | null }> {
      const { app } = await requireConnectedApp(serverKey);
      const pin = await store.getPin(app.id);
      if (pin) {
        triggerBackgroundRefresh(app.id);
        return { instructions: pin.instructions };
      }
      try {
        const pinned = await pinApp(app.id);
        return { instructions: pinned.pin.instructions };
        /* eslint-disable-next-line no-catch-all/no-catch-all -- initialize succeeds even when the upstream app is temporarily unreachable */
      } catch {
        return { instructions: null };
      }
    },

    async listToolsForSession(serverKey: string): Promise<RelayedToolList> {
      const { app } = await requireConnectedApp(serverKey);
      const pin = await store.getPin(app.id);
      if (pin) {
        const tools = await store.listTools(app.id);
        triggerBackgroundRefresh(app.id);
        return { instructions: pin.instructions, tools: tools.map(formatToolForMain) };
      }
      const pinned = await pinApp(app.id);
      return { instructions: pinned.pin.instructions, tools: pinned.tools.map(formatToolForMain) };
    },

    async callTool(input): Promise<RelayCallOutcome> {
      const { app, generation } = await requireConnectedApp(input.serverKey);
      let pin = await store.getPin(app.id);
      if (!pin) {
        const pinned = await pinApp(app.id);
        pin = pinned.pin;
      }
      let tool = await store.getTool(app.id, input.toolName);
      if (!tool) {
        return { status: 'unsent', reason: 'unknown_tool', text: `Unknown tool "${input.toolName}".` };
      }

      // Before a "just do it" call, re-read tools/list when last confirmation is over 10 minutes old.
      if (tool.label === 'just_do' && now() - Date.parse(pin.confirmedAt) > PIN_FRESHNESS_MS) {
        try {
          await pinApp(app.id);
          /* eslint-disable-next-line no-catch-all/no-catch-all -- if the freshness check cannot reach the app, refuse before running */
        } catch {
          return {
            status: 'unsent',
            reason: 'unreachable',
            text: 'Could not confirm the tool definition with the app right now; nothing was sent.',
          };
        }
        tool = await store.getTool(app.id, input.toolName);
        if (!tool) {
          return {
            status: 'unsent',
            reason: 'unknown_tool',
            text: `Tool "${input.toolName}" is no longer offered by this app.`,
          };
        }
      }

      if (tool.label === null) {
        return { status: 'unsorted', text: UNSORTED_TOOL_MESSAGE };
      }

      const { canonical, hash: argsHash } = canonicalArgsHash(input.args);

      if (tool.label === 'ask_first') {
        return holdHandler({
          app,
          grantGeneration: generation,
          tool,
          args: input.args,
          canonicalArgs: canonical,
          argsHash,
          summary: input.summary,
          session: input.session,
          requestId: input.requestId,
        });
      }

      // Label is confirmed "just_do" for the current definition hash.
      const callId = `direct:${input.session.id}:${input.requestId}`;
      const at = new Date(now()).toISOString();
      await store.recordDirectCallStart({
        id: callId,
        appId: app.id,
        grantGeneration: generation,
        toolName: tool.name,
        definitionHash: tool.definitionHash,
        argsHash,
        at,
      });

      const upstream = await invokeUpstreamTool(app, generation, tool.name, input.args, true);
      const settledAt = new Date(now()).toISOString();
      switch (upstream.status) {
        case 'completed':
          await store.settleRelayCall(callId, {
            state: 'completed',
            outcomeJson: JSON.stringify(upstream.result),
            at: settledAt,
          });
          return { status: 'completed', result: upstream.result };
        case 'too_large':
          await store.settleRelayCall(callId, { state: 'too_large', at: settledAt });
          return { status: 'too_large', text: TOO_LARGE_RESPONSE_MESSAGE };
        case 'unsent':
          await store.settleRelayCall(callId, { state: 'unsent', at: settledAt });
          return {
            status: 'unsent',
            reason: upstream.reason,
            text: 'The app could not be reached, so nothing was sent.',
          };
        case 'unknown':
          await store.settleRelayCall(callId, { state: 'unknown', at: settledAt });
          return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
      }
    },

    async executeApprovedCall(input: ExecuteApprovedCallInput): Promise<RelayCallOutcome> {
      const { hash: argsHash } = canonicalArgsHash(input.args);
      const at = new Date(now()).toISOString();
      const claim = await store.claimApprovedCall({
        approvalId: input.approvalId,
        appId: input.appId,
        grantGeneration: input.grantGeneration,
        toolName: input.toolName,
        definitionHash: input.definitionHash,
        argsHash,
        at,
      });

      if (claim.status === 'already_executing') {
        return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
      }
      if (claim.status === 'already_settled') {
        const { state, outcomeJson } = claim.record;
        if (state === 'completed' && outcomeJson) {
          return { status: 'completed', result: JSON.parse(outcomeJson) as Record<string, unknown> };
        }
        if (state === 'too_large') return { status: 'too_large', text: TOO_LARGE_RESPONSE_MESSAGE };
        if (state === 'unsent') {
          const parsed = outcomeJson ? (JSON.parse(outcomeJson) as { reason?: string; text?: string }) : {};
          return {
            status: 'unsent',
            reason: parsed.reason,
            text: parsed.text ?? 'Nothing was sent to the app.',
          };
        }
        return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
      }

      const failUnsent = async (reason: string, text: string): Promise<RelayCallOutcome> => {
        await store.settleRelayCall(input.approvalId, {
          state: 'unsent',
          outcomeJson: JSON.stringify({ reason, text }),
          at: new Date(now()).toISOString(),
        });
        return { status: 'unsent', reason, text };
      };

      let app: ConnectionApp;
      try {
        app = await store.get(input.appId);
      } catch (error) {
        if (error instanceof ConnectionsStoreError) {
          return failUnsent('app_gone', 'The app is no longer connected, so nothing was sent.');
        }
        throw error;
      }
      const grant = await store.currentGrant(app.id);
      if (app.status !== 'connected' || !grant || grant.generation !== input.grantGeneration) {
        return failUnsent(
          'grant_changed',
          'The app was disconnected or reconnected since approval was requested, so nothing was sent.',
        );
      }

      // Always re-read tools/list before executing an approved call to detect any definition change.
      try {
        await pinApp(app.id);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- pre-send re-read failure leaves nothing sent */
      } catch {
        return failUnsent(
          'unreachable',
          'The app did not answer when confirming the tool definition, so nothing was sent.',
        );
      }

      const freshTool = await store.getTool(app.id, input.toolName);
      if (!freshTool || freshTool.definitionHash !== input.definitionHash) {
        return failUnsent(
          'definition_changed',
          'The tool definition changed since approval was requested, so nothing was sent.',
        );
      }

      const upstream = await invokeUpstreamTool(app, grant.generation, input.toolName, input.args, true);
      const settledAt = new Date(now()).toISOString();
      switch (upstream.status) {
        case 'completed':
          await store.settleRelayCall(input.approvalId, {
            state: 'completed',
            outcomeJson: JSON.stringify(upstream.result),
            at: settledAt,
          });
          return { status: 'completed', result: upstream.result };
        case 'too_large':
          await store.settleRelayCall(input.approvalId, { state: 'too_large', at: settledAt });
          return { status: 'too_large', text: TOO_LARGE_RESPONSE_MESSAGE };
        case 'unsent':
          return failUnsent(upstream.reason, 'The app could not be reached, so nothing was sent.');
        case 'unknown':
          await store.settleRelayCall(input.approvalId, { state: 'unknown', at: settledAt });
          return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
      }
    },

    setHoldCallHandler(handler: HoldCallHandler): void {
      holdHandler = handler;
    },

    setOnToolsNeedSort(callback: (appId: string, listHash: string) => void): void {
      onToolsNeedSort = callback;
    },

    closeApp,
    closeAll,
  };
}

let activeRelay: AppRelay | undefined;

export function getAppRelay(): AppRelay | undefined {
  return activeRelay;
}

export function startAppRelay(dependencies: RelayDependencies): AppRelay {
  const relay = createAppRelay(dependencies);
  activeRelay = relay;
  return relay;
}

export async function stopAppRelay(): Promise<void> {
  const current = activeRelay;
  activeRelay = undefined;
  if (current) await current.closeAll();
}
