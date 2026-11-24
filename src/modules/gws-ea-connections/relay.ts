import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { log as hostLog } from '../../log.js';
import type { Session } from '../../types.js';
import { EgressError, publicFetch, type EgressDependencies } from '../gws-ea-egress/fetch.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { notifyMainToolsChanged } from './apply.js';
import {
  canonicalArgsHash,
  canonicalJson,
  normalizeToolDefinition,
  sha256Hex,
  type ToolDefinition,
} from './canonical.js';
import { withAppLock } from './locks.js';
import {
  getConnectionsRefresher,
  readStoredUsableToken,
  type ConnectionsRefresher,
  type UsableToken,
} from './refresher.js';
import {
  ConnectionsStoreError,
  type ConnectionApp,
  type ConnectionsStore,
  type LiveGrant,
  type PinnedAppTool,
  type PinToolsResult,
  type ToolLabel,
} from './store.js';

export const PIN_FRESHNESS_MS = 10 * 60_000;
export const RELAY_TIMEOUT_MS = 60_000;
export const RELAY_MAX_BODY_BYTES = 4 * 1024 * 1024;
export const RELAY_SHUTDOWN_WAIT_MS = 15_000;
const MAX_LIST_PAGES = 50;
const MAX_RELAYED_INSTRUCTIONS_CHARS = 2_000;

export const ASK_FIRST_DESCRIPTION_SUFFIX = 'Asks the principal first.';
export const UNSORTED_DESCRIPTION_SUFFIX = 'Still being set up; try again shortly.';
export const UNSORTED_TOOL_MESSAGE = 'This tool is still being set up, try again shortly.';
export const TOO_LARGE_RESPONSE_MESSAGE = 'The app answered, but the result was too large to read.';
export const UNKNOWN_OUTCOME_MESSAGE = 'The outcome of this call is unknown; check before retrying.';

export interface RelayedTool {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly annotations?: ToolDefinition['annotations'];
  readonly label: ToolLabel | null;
}

export interface RelayedToolList {
  readonly instructions: string | null;
  readonly tools: readonly RelayedTool[];
  readonly toolsVersion?: string;
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
  | { readonly status: 'completed'; readonly result: Record<string, unknown>; readonly toolsVersion?: string }
  | { readonly status: 'held'; readonly text: string; readonly approvalId?: string; readonly toolsVersion?: string }
  | { readonly status: 'unsorted'; readonly text: string; readonly toolsVersion?: string }
  | { readonly status: 'too_large'; readonly text: string; readonly toolsVersion?: string }
  | { readonly status: 'unsent'; readonly text: string; readonly reason?: string; readonly toolsVersion?: string }
  | { readonly status: 'unknown'; readonly text: string; readonly toolsVersion?: string };

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
  closeApp(appId: string): Promise<void>;
  closeAll(): Promise<void>;
  drain(waitMs?: number): Promise<void>;
}

interface CallTrace {
  egressError: EgressError | undefined;
  httpSent: boolean;
  httpStatus: number | undefined;
}

function newTrace(): CallTrace {
  return { egressError: undefined, httpSent: false, httpStatus: undefined };
}

class UpstreamUnauthorizedError extends Error {
  constructor() {
    super('Upstream MCP server rejected credentials with HTTP 401');
  }
}

class RelayClosedError extends Error {
  constructor() {
    super('App relay is closed');
  }
}

function isHttp401Error(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

interface ManagedClient {
  readonly appId: string;
  readonly url: string;
  readonly grantGeneration: number;
  readonly client: Client;
  readonly auth: { token: string | undefined };
}

type UpstreamCallResult =
  | { readonly status: 'completed'; readonly result: Record<string, unknown> }
  | { readonly status: 'too_large' }
  | { readonly status: 'unsent'; readonly reason: string }
  | { readonly status: 'unknown' };

function appendDescriptionSuffix(description: string | undefined, suffix: string): string {
  const trimmed = description?.trim();
  if (!trimmed) return suffix;
  if (trimmed.includes(suffix)) return trimmed;
  return `${trimmed}\n\n${suffix}`;
}

function formatRelayedInstructions(instructions: string | null, host: string): string | null {
  const trimmed = instructions?.trim();
  if (!trimmed) return null;
  return untrusted(trimmed, MAX_RELAYED_INSTRUCTIONS_CHARS, host);
}

function computeToolsVersion(listHash: string, tools: readonly PinnedAppTool[]): string {
  const summary = tools.map((tool) => [tool.name, tool.definitionHash, tool.label]);
  return sha256Hex(canonicalJson({ listHash, tools: summary })).slice(0, 16);
}

function formatToolForMain(pinned: PinnedAppTool): RelayedTool {
  const description =
    pinned.label === 'ask_first'
      ? appendDescriptionSuffix(pinned.definition.description, ASK_FIRST_DESCRIPTION_SUFFIX)
      : pinned.label === null
        ? appendDescriptionSuffix(pinned.definition.description, UNSORTED_DESCRIPTION_SUFFIX)
        : pinned.definition.description;
  return {
    name: pinned.definition.name,
    ...(pinned.definition.title === undefined ? {} : { title: pinned.definition.title }),
    ...(description === undefined ? {} : { description }),
    inputSchema: pinned.definition.inputSchema,
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

  const holdHandler: HoldCallHandler = dependencies.onHoldCall ?? defaultHoldRefusal;
  const onToolsNeedSort = dependencies.onToolsNeedSort;

  const clients = new Map<string, ManagedClient>();
  const relayQueues = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<void>>();
  const activeOps = new Set<Promise<unknown>>();
  const traceStore = new AsyncLocalStorage<CallTrace>();
  let stopping = false;
  let closed = false;

  /**
   * Serializes upstream MCP operations per app without acquiring the credential app lock,
   * so one call never resets trace state or tears down a client while a sibling is in flight
   * and nested `refresher.ensureToken` calls never deadlock.
   */
  async function withRelayQueue<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = relayQueues.get(appId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    relayQueues.set(appId, tail);
    try {
      return await run;
    } finally {
      if (relayQueues.get(appId) === tail) relayQueues.delete(appId);
    }
  }

  function trackOp<T>(operation: () => Promise<T>): Promise<T> {
    const promise = operation();
    activeOps.add(promise);
    const cleanup = (): void => {
      activeOps.delete(promise);
    };
    promise.then(cleanup, cleanup);
    return promise;
  }

  type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

  async function verifyLiveGrant(appId: string, expectedGeneration: number): Promise<boolean> {
    return withAppLock(appId, async () => {
      try {
        const [freshApp, freshGrant] = await Promise.all([store.get(appId), store.currentGrant(appId)]);
        return freshApp.status === 'connected' && freshGrant?.generation === expectedGeneration;
      } catch (error) {
        if (error instanceof ConnectionsStoreError) return false;
        throw error;
      }
    });
  }

  async function verifySendPreflight(input: {
    readonly appId: string;
    readonly expectedGeneration: number;
    readonly toolName: string;
    readonly expectedDefinitionHash: string;
    readonly requireJustDo: boolean;
  }): Promise<PreflightResult> {
    return withAppLock(input.appId, async () => {
      try {
        const [freshApp, freshGrant, freshTool] = await Promise.all([
          store.get(input.appId),
          store.currentGrant(input.appId),
          store.getTool(input.appId, input.toolName),
        ]);
        if (freshApp.status !== 'connected' || freshGrant?.generation !== input.expectedGeneration) {
          return { ok: false, reason: 'grant_changed' };
        }
        if (!freshTool || freshTool.definitionHash !== input.expectedDefinitionHash) {
          return { ok: false, reason: 'definition_changed' };
        }
        if (input.requireJustDo) {
          if (freshTool.label === 'ask_first') return { ok: false, reason: 'label_changed_to_ask_first' };
          if (freshTool.label !== 'just_do') return { ok: false, reason: 'tool_unsorted' };
        }
        return { ok: true };
      } catch (error) {
        if (error instanceof ConnectionsStoreError) return { ok: false, reason: 'grant_changed' };
        throw error;
      }
    });
  }

  async function resolveBearer(
    app: ConnectionApp,
    grant: LiveGrant,
    forceRenew = false,
  ): Promise<UsableToken | undefined> {
    if (app.auth === 'none') return undefined;
    const refresher = readRefresher();
    if (refresher) return refresher.ensureToken(app.id, { forceRenew });
    return readStoredUsableToken(store, app.id, grant, now);
  }

  async function closeClient(managed: ManagedClient): Promise<void> {
    if (clients.get(managed.appId) === managed) clients.delete(managed.appId);
    try {
      await managed.client.close();
      /* eslint-disable-next-line no-catch-all/no-catch-all -- best-effort cleanup of an upstream transport */
    } catch {
      return;
    }
  }

  async function ensureClient(
    app: ConnectionApp,
    grant: LiveGrant,
    forceRenew = false,
    forceReconnect = false,
  ): Promise<ManagedClient> {
    if (closed) throw new RelayClosedError();
    let token: string | undefined;
    if (app.auth !== 'none') {
      const usable = await resolveBearer(app, grant, forceRenew);
      if (!usable || usable.generation !== grant.generation) {
        throw new EgressError('refused', { sent: false });
      }
      token = usable.token;
    }
    if (closed) throw new RelayClosedError();

    const existing = clients.get(app.id);
    if (!forceReconnect && existing && existing.url === app.url && existing.grantGeneration === grant.generation) {
      existing.auth.token = token;
      return existing;
    }
    if (existing) await closeClient(existing);

    const auth = { token };
    const client = new Client({ name: 'nanoclaw-host-relay', version: '1.0.0' }, { capabilities: {} });
    const customFetch: FetchLike = async (input, init) => {
      const method = (init?.method ?? 'GET').toUpperCase();
      // Never open the standalone GET SSE stream: returning 405 tells StreamableHTTPClientTransport it is unsupported.
      if (method === 'GET') return new Response(null, { status: 405 });
      const headers = new Headers(init?.headers);
      if (auth.token !== undefined) headers.set('Authorization', `Bearer ${auth.token}`);
      else headers.delete('Authorization');
      const activeTrace = traceStore.getStore();
      try {
        const response = await rawFetch(input, { ...init, headers });
        if (activeTrace) {
          activeTrace.httpSent = true;
          activeTrace.httpStatus = response.status;
        }
        return response;
      } catch (error) {
        if (activeTrace && error instanceof EgressError) activeTrace.egressError = error;
        throw error;
      }
    };
    const transport = new StreamableHTTPClientTransport(new URL(app.url), {
      fetch: customFetch,
    });
    const entry: ManagedClient = {
      appId: app.id,
      url: app.url,
      grantGeneration: grant.generation,
      client,
      auth,
    };
    transport.onclose = () => {
      if (clients.get(app.id) === entry) clients.delete(app.id);
    };
    const connectTrace = newTrace();
    try {
      await traceStore.run(connectTrace, () => client.connect(transport));
    } catch (error) {
      const unauthorized = connectTrace.httpStatus === 401 || isHttp401Error(error);
      await closeClient(entry);
      if (unauthorized) throw new UpstreamUnauthorizedError();
      throw error;
    }
    if (closed) {
      await closeClient(entry);
      throw new RelayClosedError();
    }
    clients.set(app.id, entry);
    return entry;
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

  async function requireConnectedApp(serverKey: string): Promise<{ app: ConnectionApp; grant: LiveGrant }> {
    const app = await store.byServerKey(serverKey);
    if (!app || app.status !== 'connected') {
      throw new ConnectionsStoreError('app_not_found');
    }
    const grant = await store.currentGrant(app.id);
    if (!grant) throw new ConnectionsStoreError('app_not_found');
    return { app, grant };
  }

  async function pinConnectedApp(app: ConnectionApp, grant: LiveGrant): Promise<PinToolsResult> {
    const listed = await withRelayQueue(app.id, async () => {
      if (closed) throw new ConnectionsStoreError('store_unavailable');
      const run = async (
        forceRenew: boolean,
      ): Promise<{ instructions: string | null; tools: readonly ToolDefinition[] }> => {
        // Always open a fresh handshake during catalog confirmation so instruction-only changes reach the pin.
        const managed = await ensureClient(app, grant, forceRenew, true);
        const listTrace = newTrace();
        try {
          const tools = await traceStore.run(listTrace, () => listAllUpstreamTools(managed));
          const instructions = managed.client.getInstructions() ?? null;
          return { instructions, tools };
        } catch (error) {
          const unauthorized = listTrace.httpStatus === 401 || isHttp401Error(error);
          await closeClient(managed);
          if (unauthorized) throw new UpstreamUnauthorizedError();
          throw error;
        }
      };
      try {
        return await run(false);
      } catch (error) {
        if (
          error instanceof UpstreamUnauthorizedError &&
          app.auth === 'oauth' &&
          grant.kind === 'oauth' &&
          grant.renewable
        ) {
          return await run(true);
        }
        throw error;
      }
    });
    const result = await store.pinTools(app.id, {
      instructions: listed.instructions,
      tools: listed.tools,
      expectedGrantGeneration: grant.generation,
      at: new Date(now()).toISOString(),
    });
    if (result.changed) await notifyMainToolsChanged(store);
    if (result.unsortedCount > 0) onToolsNeedSort?.(app.id, result.pin.listHash);
    return result;
  }

  async function pinApp(appId: string): Promise<PinToolsResult> {
    if (stopping) throw new ConnectionsStoreError('store_unavailable');
    return trackOp(async () => {
      const [app, grant] = await Promise.all([store.get(appId), store.currentGrant(appId)]);
      if (app.status !== 'connected' || !grant) {
        throw new ConnectionsStoreError('app_not_found');
      }
      return pinConnectedApp(app, grant);
    });
  }

  function triggerBackgroundRefresh(appId: string): void {
    if (stopping || refreshing.has(appId)) return;
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
    grant: LiveGrant,
    toolName: string,
    args: Record<string, unknown>,
    options: { readonly verifyBeforeCall?: () => Promise<PreflightResult> } = {},
  ): Promise<UpstreamCallResult> {
    return withRelayQueue(app.id, async () => {
      if (closed) return { status: 'unsent' as const, reason: 'relay_stopping' };
      const attempt = async (forceRenew: boolean) => {
        if (closed) return { status: 'unsent' as const, reason: 'relay_stopping' };
        let managed: ManagedClient;
        try {
          managed = await ensureClient(app, grant, forceRenew);
          /* eslint-disable-next-line no-catch-all/no-catch-all -- classify any connect/handshake failure into retry_401, unsent, or unknown */
        } catch (error) {
          if (closed) return { status: 'unsent' as const, reason: 'relay_stopping' };
          if (error instanceof UpstreamUnauthorizedError && !forceRenew && app.auth === 'oauth') {
            return 'retry_401' as const;
          }
          if (error instanceof EgressError && error.detail?.sent === true) {
            return { status: 'unknown' as const };
          }
          return {
            status: 'unsent' as const,
            reason:
              error instanceof UpstreamUnauthorizedError
                ? 'unauthorized'
                : error instanceof EgressError
                  ? error.code
                  : 'connect_failed',
          };
        }
        if (closed) {
          await closeClient(managed);
          return { status: 'unsent' as const, reason: 'relay_stopping' };
        }
        if (options.verifyBeforeCall) {
          const check = await options.verifyBeforeCall();
          if (!check.ok) {
            if (check.reason === 'grant_changed') await closeClient(managed);
            return { status: 'unsent' as const, reason: check.reason };
          }
        }
        if (closed) {
          await closeClient(managed);
          return { status: 'unsent' as const, reason: 'relay_stopping' };
        }
        const callTrace = newTrace();
        try {
          const result = await traceStore.run(callTrace, () =>
            managed.client.callTool({ name: toolName, arguments: args }),
          );
          return { status: 'completed' as const, result: result as Record<string, unknown> };
          /* eslint-disable-next-line no-catch-all/no-catch-all -- classify any upstream MCP call failure into too_large, unsent, or unknown */
        } catch (error) {
          const { egressError, httpSent, httpStatus } = callTrace;
          if ((httpStatus === 401 || isHttp401Error(error)) && !forceRenew && app.auth === 'oauth') {
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
    });
  }

  function outcomeFromSettledRecord(
    record: { readonly state: string; readonly outcomeJson: string | null },
    toolsVersion?: string,
  ): RelayCallOutcome {
    const versionField = toolsVersion === undefined ? {} : { toolsVersion };
    if (record.state === 'completed' && record.outcomeJson) {
      return {
        status: 'completed',
        result: JSON.parse(record.outcomeJson) as Record<string, unknown>,
        ...versionField,
      };
    }
    if (record.state === 'too_large') {
      return { status: 'too_large', text: TOO_LARGE_RESPONSE_MESSAGE, ...versionField };
    }
    if (record.state === 'unsent') {
      const parsed = record.outcomeJson ? (JSON.parse(record.outcomeJson) as { reason?: string; text?: string }) : {};
      return {
        status: 'unsent',
        reason: parsed.reason,
        text: parsed.text ?? 'Nothing was sent to the app.',
        ...versionField,
      };
    }
    return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE, ...versionField };
  }

  async function settleUpstreamOutcome(
    callId: string,
    upstream: UpstreamCallResult,
    persistUnsentDetails: boolean,
    toolsVersion?: string,
  ): Promise<RelayCallOutcome> {
    const versionField = toolsVersion === undefined ? {} : { toolsVersion };
    const settledAt = new Date(now()).toISOString();
    switch (upstream.status) {
      case 'completed':
        await store.settleRelayCall(callId, {
          state: 'completed',
          outcomeJson: JSON.stringify(upstream.result),
          at: settledAt,
        });
        return { status: 'completed', result: upstream.result, ...versionField };
      case 'too_large':
        await store.settleRelayCall(callId, { state: 'too_large', at: settledAt });
        return { status: 'too_large', text: TOO_LARGE_RESPONSE_MESSAGE, ...versionField };
      case 'unsent': {
        const text =
          upstream.reason === 'definition_changed'
            ? 'The tool definition changed since approval was requested, so nothing was sent.'
            : upstream.reason === 'relay_stopping'
              ? 'The app relay is shutting down, so nothing was sent.'
              : upstream.reason === 'grant_changed'
                ? 'The app was disconnected or reconnected since approval was requested, so nothing was sent.'
                : 'The app could not be reached, so nothing was sent.';
        await store.settleRelayCall(callId, {
          state: 'unsent',
          ...(persistUnsentDetails ? { outcomeJson: JSON.stringify({ reason: upstream.reason, text }) } : {}),
          at: settledAt,
        });
        return { status: 'unsent', reason: upstream.reason, text, ...versionField };
      }
      case 'unknown':
        await store.settleRelayCall(callId, { state: 'unknown', at: settledAt });
        return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE, ...versionField };
    }
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

  async function drain(waitMs = RELAY_SHUTDOWN_WAIT_MS): Promise<void> {
    stopping = true;
    const pending = [...activeOps, ...refreshing.values()];
    if (pending.length > 0 && waitMs > 0) {
      const bound = new AbortController();
      await Promise.race([
        Promise.allSettled(pending),
        delay(waitMs, undefined, { signal: bound.signal }).catch(() => undefined),
      ]);
      bound.abort();
    }
    closed = true;
    await closeAll();
  }

  return {
    pinApp,

    async pinUnpinnedApps(): Promise<void> {
      if (stopping) return;
      const [apps, pins] = await Promise.all([store.apps(), store.listPins()]);
      const pinnedIds = new Set(pins.map((pin) => pin.appId));
      const unpinned = apps.filter((app) => app.status === 'connected' && !pinnedIds.has(app.id));
      await Promise.all(
        unpinned.map(async (app) => {
          if (stopping) return;
          try {
            await pinApp(app.id);
            /* eslint-disable-next-line no-catch-all/no-catch-all -- startup pinning is best-effort per app so one down app never blocks others */
          } catch (error) {
            hostLog.warn('Could not pin connected app tools at startup', {
              appId: app.id,
              code: error instanceof EgressError ? error.code : 'failed',
            });
          }
        }),
      );
    },

    async initializeApp(serverKey: string): Promise<{ readonly instructions: string | null }> {
      if (stopping) throw new ConnectionsStoreError('store_unavailable');
      return trackOp(async () => {
        const { app, grant } = await requireConnectedApp(serverKey);
        const pin = await store.getPin(app.id);
        if (pin) return { instructions: formatRelayedInstructions(pin.instructions, app.host) };
        try {
          const pinned = await pinConnectedApp(app, grant);
          return { instructions: formatRelayedInstructions(pinned.pin.instructions, app.host) };
          /* eslint-disable-next-line no-catch-all/no-catch-all -- initialize succeeds even when the upstream app is temporarily unreachable */
        } catch {
          return { instructions: null };
        }
      });
    },

    async listToolsForSession(serverKey: string): Promise<RelayedToolList> {
      if (stopping) throw new ConnectionsStoreError('store_unavailable');
      return trackOp(async () => {
        const { app, grant } = await requireConnectedApp(serverKey);
        const loaded = await store.readAppTools(app.id);
        if (loaded?.pin) {
          triggerBackgroundRefresh(app.id);
          return {
            instructions: formatRelayedInstructions(loaded.pin.instructions, app.host),
            tools: loaded.tools.map(formatToolForMain),
            toolsVersion: computeToolsVersion(loaded.pin.listHash, loaded.tools),
          };
        }
        const pinned = await pinConnectedApp(app, grant);
        return {
          instructions: formatRelayedInstructions(pinned.pin.instructions, app.host),
          tools: pinned.tools.map(formatToolForMain),
          toolsVersion: computeToolsVersion(pinned.pin.listHash, pinned.tools),
        };
      });
    },

    async callTool(input): Promise<RelayCallOutcome> {
      if (stopping) {
        return {
          status: 'unsent',
          reason: 'relay_stopping',
          text: 'The app relay is shutting down, so nothing was sent.',
        };
      }
      return trackOp(async () => {
        const { app, grant } = await requireConnectedApp(input.serverKey);
        const loaded = await store.readAppTools(app.id);
        let pin = loaded?.pin;
        let tools: readonly PinnedAppTool[] = loaded?.tools ?? [];
        let tool: PinnedAppTool | undefined;
        if (!pin) {
          const pinned = await pinConnectedApp(app, grant);
          pin = pinned.pin;
          tools = pinned.tools;
          tool = tools.find((entry) => entry.name === input.toolName);
        } else {
          tool = tools.find((entry) => entry.name === input.toolName);
        }
        let toolsVersion = computeToolsVersion(pin.listHash, tools);
        if (!tool) {
          return { status: 'unsent', reason: 'unknown_tool', text: `Unknown tool "${input.toolName}".`, toolsVersion };
        }

        if (tool.label === 'just_do' && now() - Date.parse(pin.confirmedAt) > PIN_FRESHNESS_MS) {
          let refreshed: PinToolsResult;
          try {
            refreshed = await pinConnectedApp(app, grant);
            /* eslint-disable-next-line no-catch-all/no-catch-all -- if the freshness check cannot reach the app, refuse before running */
          } catch {
            return {
              status: 'unsent',
              reason: 'unreachable',
              text: 'Could not confirm the tool definition with the app right now; nothing was sent.',
              toolsVersion,
            };
          }
          pin = refreshed.pin;
          tools = refreshed.tools;
          toolsVersion = computeToolsVersion(pin.listHash, tools);
          tool = tools.find((entry) => entry.name === input.toolName);
          if (!tool) {
            return {
              status: 'unsent',
              reason: 'unknown_tool',
              text: `Tool "${input.toolName}" is no longer offered by this app.`,
              toolsVersion,
            };
          }
        }

        if (tool.label === null) {
          return { status: 'unsorted', text: UNSORTED_TOOL_MESSAGE, toolsVersion };
        }

        const { canonical, hash: argsHash } = canonicalArgsHash(input.args);

        if (tool.label === 'ask_first') {
          const held = await holdHandler({
            app,
            grantGeneration: grant.generation,
            tool,
            args: input.args,
            canonicalArgs: canonical,
            argsHash,
            summary: input.summary,
            session: input.session,
            requestId: input.requestId,
          });
          return { ...held, toolsVersion };
        }

        const callId = `direct:${input.session.id}:${input.requestId}`;
        const at = new Date(now()).toISOString();
        const directClaim = await store.claimDirectCall({
          id: callId,
          appId: app.id,
          grantGeneration: grant.generation,
          toolName: tool.name,
          definitionHash: tool.definitionHash,
          argsHash,
          at,
        });
        if (directClaim.status === 'app_not_found') {
          return {
            status: 'unsent',
            reason: 'app_gone',
            text: 'The app is no longer connected, so nothing was sent.',
            toolsVersion,
          };
        }
        if (directClaim.status === 'already_executing') {
          return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE, toolsVersion };
        }
        if (directClaim.status === 'already_settled') {
          return outcomeFromSettledRecord(directClaim.record, toolsVersion);
        }

        const upstream = await invokeUpstreamTool(app, grant, tool.name, input.args, {
          verifyBeforeCall: () =>
            verifySendPreflight({
              appId: app.id,
              expectedGeneration: grant.generation,
              toolName: tool.name,
              expectedDefinitionHash: tool.definitionHash,
              requireJustDo: true,
            }),
        });
        if (
          upstream.status === 'unsent' &&
          (upstream.reason === 'label_changed_to_ask_first' ||
            upstream.reason === 'definition_changed' ||
            upstream.reason === 'tool_unsorted')
        ) {
          await store.deleteRelayCall(callId);
          const latest = await store.readAppTools(app.id);
          const latestVersion = latest?.pin ? computeToolsVersion(latest.pin.listHash, latest.tools) : toolsVersion;
          const latestTool = latest?.tools.find((entry) => entry.name === input.toolName);
          if (!latestTool) {
            return {
              status: 'unsent',
              reason: 'unknown_tool',
              text: `Tool "${input.toolName}" is no longer offered by this app.`,
              toolsVersion: latestVersion,
            };
          }
          if (latestTool.label === null) {
            return { status: 'unsorted', text: UNSORTED_TOOL_MESSAGE, toolsVersion: latestVersion };
          }
          if (latestTool.label === 'ask_first') {
            const held = await holdHandler({
              app,
              grantGeneration: grant.generation,
              tool: latestTool,
              args: input.args,
              canonicalArgs: canonical,
              argsHash,
              summary: input.summary,
              session: input.session,
              requestId: input.requestId,
            });
            return { ...held, toolsVersion: latestVersion };
          }
        }
        return settleUpstreamOutcome(callId, upstream, true, toolsVersion);
      });
    },

    async executeApprovedCall(input: ExecuteApprovedCallInput): Promise<RelayCallOutcome> {
      if (stopping) {
        return {
          status: 'unsent',
          reason: 'relay_stopping',
          text: 'The app relay is shutting down, so nothing was sent.',
        };
      }
      return trackOp(async () => {
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

        if (claim.status === 'app_not_found') {
          return {
            status: 'unsent',
            reason: 'app_gone',
            text: 'The app is no longer connected, so nothing was sent.',
          };
        }
        if (claim.status === 'already_executing') {
          return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
        }
        if (claim.status === 'already_settled') {
          return outcomeFromSettledRecord(claim.record);
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
        let grant: LiveGrant | undefined;
        try {
          [app, grant] = await Promise.all([store.get(input.appId), store.currentGrant(input.appId)]);
        } catch (error) {
          if (error instanceof ConnectionsStoreError) {
            return failUnsent('app_gone', 'The app is no longer connected, so nothing was sent.');
          }
          throw error;
        }
        if (app.status !== 'connected' || !grant || grant.generation !== input.grantGeneration) {
          return failUnsent(
            'grant_changed',
            'The app was disconnected or reconnected since approval was requested, so nothing was sent.',
          );
        }

        let refreshed: PinToolsResult;
        try {
          refreshed = await pinConnectedApp(app, grant);
          /* eslint-disable-next-line no-catch-all/no-catch-all -- pre-send re-read failure leaves nothing sent */
        } catch (error) {
          if (error instanceof ConnectionsStoreError && error.reason === 'app_changed') {
            return failUnsent(
              'grant_changed',
              'The app was disconnected or reconnected since approval was requested, so nothing was sent.',
            );
          }
          return failUnsent(
            'unreachable',
            'The app did not answer when confirming the tool definition, so nothing was sent.',
          );
        }

        const freshTool = refreshed.tools.find((entry) => entry.name === input.toolName);
        if (!freshTool || freshTool.definitionHash !== input.definitionHash) {
          return failUnsent(
            'definition_changed',
            'The tool definition changed since approval was requested, so nothing was sent.',
          );
        }

        if (!(await verifyLiveGrant(input.appId, input.grantGeneration))) {
          return failUnsent(
            'grant_changed',
            'The app was disconnected or reconnected since approval was requested, so nothing was sent.',
          );
        }

        const upstream = await invokeUpstreamTool(app, grant, input.toolName, input.args, {
          verifyBeforeCall: () =>
            verifySendPreflight({
              appId: input.appId,
              expectedGeneration: input.grantGeneration,
              toolName: input.toolName,
              expectedDefinitionHash: input.definitionHash,
              requireJustDo: false,
            }),
        });
        return settleUpstreamOutcome(input.approvalId, upstream, true);
      });
    },

    closeApp,
    closeAll,
    drain,
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

export async function stopAppRelay(waitMs = RELAY_SHUTDOWN_WAIT_MS): Promise<void> {
  const current = activeRelay;
  activeRelay = undefined;
  if (current) await current.drain(waitMs);
}
