import { AsyncLocalStorage } from 'node:async_hooks';
import { setTimeout as delay } from 'node:timers/promises';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport, StreamableHTTPError } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { FetchLike } from '@modelcontextprotocol/sdk/shared/transport.js';

import { getDb } from '../../db/connection.js';
import { getPendingApproval } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log as hostLog } from '../../log.js';
import type { Session } from '../../types.js';
import { EgressError, publicFetch, type EgressDependencies } from '../gws-ea-egress/fetch.js';
import { resolveDestination } from '../gws-ea-egress/resolve.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { notifyMainToolsChanged } from './apply.js';
import {
  catalogEntryFor,
  catalogRulesMatch,
  offeredDefinition,
  refusedArgumentIn,
  type CatalogEntry,
  type RefusedArgument,
} from './catalog.js';
import {
  ASSISTANT_SUMMARY_FIELD,
  canonicalArgsHash,
  canonicalJson,
  normalizeToolDefinition,
  sha256Hex,
  type ToolDefinition,
} from './canonical.js';
import {
  HOST_PROCESS_IDLE_MS,
  HostCliUnavailableError,
  HostProcessTransport,
  isHostCliEntry,
  resolveHostCliLaunch,
} from './host-process.js';
import { withAppLock } from './locks.js';
import {
  getConnectionsRefresher,
  readStoredUsableToken,
  type ConnectionsRefresher,
  type UsableToken,
} from './refresher.js';
import { schemaAcceptsSummaryArg } from './sort-rules.js';
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
const TERMINATE_SESSION_TIMEOUT_MS = 2_000;
const MAX_LIST_PAGES = 50;
const MAX_RELAYED_INSTRUCTIONS_CHARS = 2_000;
const META_TOOL_PAGE_SIZE = 20;

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
  readonly stripSummary?: boolean;
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
  readonly invocationId?: string;
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
  readonly hostProcessIdleMs?: number;
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

type PreflightResult = { readonly ok: true } | { readonly ok: false; readonly reason: string };

interface CallTrace {
  egressError: EgressError | undefined;
  fetchStarted: boolean;
  httpSent: boolean;
  httpStatus: number | undefined;
  verifyBeforeDial: (() => Promise<PreflightResult>) | undefined;
  dialPreflightFailure: string | undefined;
}

function newTrace(): CallTrace {
  return {
    egressError: undefined,
    fetchStarted: false,
    httpSent: false,
    httpStatus: undefined,
    verifyBeforeDial: undefined,
    dialPreflightFailure: undefined,
  };
}

export function outcomeFromSettledRecord(
  record: { readonly state: string; readonly outcomeJson: string | null },
  toolsVersion?: string,
): RelayCallOutcome {
  const versionField = toolsVersion === undefined ? {} : { toolsVersion };
  if (record.state === 'completed') {
    if (record.outcomeJson) {
      return {
        status: 'completed',
        result: JSON.parse(record.outcomeJson) as Record<string, unknown>,
        ...versionField,
      };
    }
    return {
      status: 'unknown',
      text: 'This app tool call already completed, but its result is no longer available.',
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

function stripSyntheticSummary(args: Record<string, unknown>): Record<string, unknown> {
  if (!Object.hasOwn(args, ASSISTANT_SUMMARY_FIELD)) return args;
  const { [ASSISTANT_SUMMARY_FIELD]: _omitted, ...rest } = args;
  return rest;
}

function prepareCallArgs(
  rawArgs: Record<string, unknown>,
  tool: PinnedAppTool,
): {
  readonly callArgs: Record<string, unknown>;
  readonly canonical: string;
  readonly argsHash: string;
  readonly stripSummary: boolean;
} {
  const stripSummary = !schemaAcceptsSummaryArg(tool.definition.inputSchema);
  const callArgs = stripSummary ? stripSyntheticSummary(rawArgs) : rawArgs;
  const { canonical, hash: argsHash } = canonicalArgsHash(callArgs);
  return { callArgs, canonical, argsHash, stripSummary };
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

class CatalogRulesUnmatchedError extends Error {
  constructor() {
    super("The app's tool listing no longer matches its catalog rules");
  }
}

function isHttp401Error(error: unknown): boolean {
  return error instanceof StreamableHTTPError && error.code === 401;
}

type ManagedClient = {
  readonly appId: string;
  readonly grantGeneration: number;
  readonly client: Client;
} & (
  | {
      readonly kind: 'remote';
      readonly transport: StreamableHTTPClientTransport;
      readonly auth: { token: string | undefined };
    }
  | {
      readonly kind: 'host_process';
      readonly transport: HostProcessTransport;
      /** The app offers search and call meta-tools; its inner commands are pinned and called through them. */
      readonly metaTools: boolean;
      idleTimer: NodeJS.Timeout | undefined;
    }
);

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

/**
 * The commands the host offers main: the app's listing less the entry's withheld commands, without the arguments main
 * may never pass. The full listing stays here, so rules naming the pinned commands are checked against what the app
 * actually lists.
 */
function offeredTools(entry: CatalogEntry | undefined, listing: readonly ToolDefinition[]): readonly ToolDefinition[] {
  if (!entry) return listing;
  return listing.filter((tool) => !entry.withheld.includes(tool.name)).map((tool) => offeredDefinition(entry, tool));
}

function refusalText(entry: CatalogEntry, toolName: string, rule: RefusedArgument): string {
  switch (rule.match.kind) {
    case 'any':
      return `The assistant may not pass "${rule.argument}" to ${entry.name}, so nothing was sent. Call ${toolName} without it.`;
    case 'only':
      return `${toolName} needs "${rule.argument}" set to ${rule.match.values.join(' or ')}, so nothing was sent.`;
    case 'non_https_url':
      return `${toolName} takes only an https address in "${rule.argument}", so nothing was sent.`;
  }
}

function failureCode(error: unknown): string {
  if (error instanceof EgressError) return error.code;
  if (error instanceof ConnectionsStoreError) return error.reason;
  if (error instanceof HostCliUnavailableError) return error.reason;
  if (error instanceof CatalogRulesUnmatchedError) return 'rules_unmatched';
  return 'failed';
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
  const hostProcessIdleMs = dependencies.hostProcessIdleMs ?? HOST_PROCESS_IDLE_MS;
  const readRefresher = dependencies.refresher ?? getConnectionsRefresher;
  const baseResolve = dependencies.egress?.resolve ?? resolveDestination;
  const traceStore = new AsyncLocalStorage<CallTrace>();
  const rawFetch = publicFetch(
    { redirect: 'none', timeoutMs, maxBodyBytes },
    {
      ...dependencies.egress,
      resolve: async (target) => {
        const destination = await baseResolve(target);
        const activeTrace = traceStore.getStore();
        if (activeTrace?.verifyBeforeDial) {
          const check = await activeTrace.verifyBeforeDial();
          if (!check.ok) {
            activeTrace.dialPreflightFailure = check.reason;
            throw new EgressError('refused', { sent: false });
          }
        }
        return destination;
      },
    },
  );

  const holdHandler: HoldCallHandler = dependencies.onHoldCall ?? defaultHoldRefusal;
  const onToolsNeedSort = dependencies.onToolsNeedSort;

  const clients = new Map<string, ManagedClient>();
  const relayQueues = new Map<string, Promise<unknown>>();
  const refreshing = new Map<string, Promise<void>>();
  const activeOps = new Set<Promise<unknown>>();
  let stopping = false;
  let closed = false;

  /**
   * Serializes upstream MCP operations per app without acquiring the credential app lock,
   * so one call never resets trace state or tears down a client while a sibling is in flight
   * and nested `refresher.ensureToken` calls never deadlock.
   */
  async function withRelayQueue<T>(appId: string, operation: () => Promise<T>): Promise<T> {
    const previous = relayQueues.get(appId) ?? Promise.resolve();
    const step = (): Promise<T> => {
      clearIdleClose(clients.get(appId));
      return operation();
    };
    const run = previous.then(step, step);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    relayQueues.set(appId, tail);
    try {
      return await run;
    } finally {
      if (relayQueues.get(appId) === tail) {
        relayQueues.delete(appId);
        armIdleClose(appId);
      }
    }
  }

  function clearIdleClose(managed: ManagedClient | undefined): void {
    if (managed?.kind !== 'host_process' || managed.idleTimer === undefined) return;
    clearTimeout(managed.idleTimer);
    managed.idleTimer = undefined;
  }

  /** A host-run app's child lives only while it is used; the next call after an idle spell spawns a fresh one. */
  function armIdleClose(appId: string): void {
    const managed = clients.get(appId);
    if (managed?.kind !== 'host_process' || closed) return;
    clearIdleClose(managed);
    managed.idleTimer = setTimeout(() => {
      void withRelayQueue(appId, async () => {
        if (clients.get(appId) === managed) await closeClient(managed);
      });
    }, hostProcessIdleMs);
    managed.idleTimer.unref();
  }

  function requestOptions(managed: ManagedClient): { readonly timeout: number } | undefined {
    return managed.kind === 'host_process' ? { timeout: timeoutMs } : undefined;
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
        const [freshApp, freshGrant, freshTool, freshPin] = await Promise.all([
          store.get(input.appId),
          store.currentGrant(input.appId),
          store.getTool(input.appId, input.toolName),
          input.requireJustDo ? store.getPin(input.appId) : Promise.resolve(undefined),
        ]);
        if (freshApp.status !== 'connected' || freshGrant?.generation !== input.expectedGeneration) {
          return { ok: false, reason: 'grant_changed' };
        }
        if (!freshTool || freshTool.definitionHash !== input.expectedDefinitionHash) {
          return { ok: false, reason: 'definition_changed' };
        }
        if (input.requireJustDo) {
          if (!freshPin || now() - Date.parse(freshPin.confirmedAt) > PIN_FRESHNESS_MS) {
            return { ok: false, reason: 'pin_stale' };
          }
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
    clearIdleClose(managed);
    try {
      if (managed.kind === 'remote' && managed.transport.sessionId) {
        const bound = new AbortController();
        try {
          await Promise.race([
            managed.transport.terminateSession().catch(() => undefined),
            delay(TERMINATE_SESSION_TIMEOUT_MS, undefined, { signal: bound.signal }).catch(() => undefined),
          ]);
        } finally {
          bound.abort();
        }
      }
      /* eslint-disable-next-line no-catch-all/no-catch-all -- best-effort session termination before local transport close */
    } catch {
      // Proceed to close locally even if session termination fails.
    }
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
    if (app.transport === 'host_cli') return ensureHostProcessClient(app, grant);
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
    if (!forceReconnect && existing?.kind === 'remote' && existing.grantGeneration === grant.generation) {
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
      const activeTrace = method === 'POST' ? traceStore.getStore() : undefined;
      if (activeTrace) activeTrace.fetchStarted = true;
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
      kind: 'remote',
      appId: app.id,
      grantGeneration: grant.generation,
      client,
      transport,
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

  /**
   * One child per app and grant generation. Its receipt is verified before every spawn, so a changed or missing install
   * refuses before anything is written to a process.
   */
  async function ensureHostProcessClient(app: ConnectionApp, grant: LiveGrant): Promise<ManagedClient> {
    const existing = clients.get(app.id);
    if (existing?.kind === 'host_process' && existing.grantGeneration === grant.generation) return existing;
    if (existing) await closeClient(existing);
    const catalogEntry = catalogEntryFor(app);
    if (!catalogEntry || !isHostCliEntry(catalogEntry)) throw new HostCliUnavailableError('not_enabled');
    const launch = await resolveHostCliLaunch(catalogEntry);
    if (closed) throw new RelayClosedError();
    const transport = new HostProcessTransport(launch);
    transport.onwrite = () => {
      const activeTrace = traceStore.getStore();
      if (activeTrace) activeTrace.fetchStarted = true;
    };
    const managed: ManagedClient = {
      kind: 'host_process',
      appId: app.id,
      grantGeneration: grant.generation,
      client: new Client({ name: 'nanoclaw-host-relay', version: '1.0.0' }, { capabilities: {} }),
      transport,
      metaTools: catalogEntry.transport.metaTools,
      idleTimer: undefined,
    };
    transport.onclose = () => {
      clearIdleClose(managed);
      if (clients.get(app.id) === managed) clients.delete(app.id);
    };
    try {
      await managed.client.connect(transport, { timeout: timeoutMs });
    } catch (error) {
      await closeClient(managed);
      throw error;
    }
    if (closed) {
      await closeClient(managed);
      throw new RelayClosedError();
    }
    clients.set(app.id, managed);
    return managed;
  }

  async function listAllUpstreamTools(managed: ManagedClient): Promise<readonly ToolDefinition[]> {
    const collected: ToolDefinition[] = [];
    let cursor: string | undefined;
    for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
      const response = await managed.client.listTools(cursor ? { cursor } : undefined, requestOptions(managed));
      for (const raw of response.tools) collected.push(normalizeToolDefinition(raw));
      if (!response.nextCursor) return collected;
      cursor = response.nextCursor;
    }
    throw new Error(`Upstream MCP tool catalog exceeded ${MAX_LIST_PAGES} pages`);
  }

  async function callMetaTool(managed: ManagedClient, name: string, args: Record<string, unknown>): Promise<unknown> {
    const result = await managed.client.callTool({ name, arguments: args }, undefined, requestOptions(managed));
    const content = Array.isArray(result.content) ? (result.content as unknown[]) : [];
    const first = content[0];
    if (result.isError === true || !isRecord(first) || first.type !== 'text' || typeof first.text !== 'string') {
      throw new Error(`The app's ${name} gave no readable answer`);
    }
    return JSON.parse(first.text) as unknown;
  }

  /** The CLI's MCP mode lists its commands by search; each command's schema comes from its details. */
  async function listInnerTools(managed: ManagedClient): Promise<readonly ToolDefinition[]> {
    const names: string[] = [];
    let offset = 0;
    for (let page = 0; ; page += 1) {
      if (page >= MAX_LIST_PAGES) throw new Error(`Upstream MCP tool catalog exceeded ${MAX_LIST_PAGES} pages`);
      const listed = await callMetaTool(managed, 'search_tools', { limit: META_TOOL_PAGE_SIZE, offset });
      if (!isRecord(listed) || !Array.isArray(listed.tools)) throw new Error('The app listed its tools unreadably');
      for (const tool of listed.tools as unknown[]) {
        if (!isRecord(tool) || typeof tool.name !== 'string' || !tool.name) {
          throw new Error('The app listed a tool without a name');
        }
        names.push(tool.name);
      }
      if (listed.nextOffset === undefined || listed.nextOffset === null) break;
      if (typeof listed.nextOffset !== 'number' || listed.nextOffset <= offset) {
        throw new Error('The app paged its tools unreadably');
      }
      offset = listed.nextOffset;
    }
    const definitions: ToolDefinition[] = [];
    for (const name of names) {
      const definition = normalizeToolDefinition(await callMetaTool(managed, 'get_tool_details', { name }));
      if (definition.name !== name) throw new Error('The app described a different tool than asked');
      definitions.push(definition);
    }
    return definitions;
  }

  /** A meta-tool app runs each inner command through its read or write call, chosen by the pinned definition. */
  function upstreamCall(
    managed: ManagedClient,
    tool: PinnedAppTool,
    args: Record<string, unknown>,
  ): { readonly name: string; readonly arguments: Record<string, unknown> } {
    if (managed.kind !== 'host_process' || !managed.metaTools) return { name: tool.name, arguments: args };
    const route = tool.definition.annotations?.readOnlyHint === true ? 'call_read_tool' : 'call_write_tool';
    return { name: route, arguments: { name: tool.name, arguments: args } };
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
        // A remote app gets a fresh handshake during catalog confirmation so instruction-only changes reach the pin; a
        // host-run app's instructions change only with its pinned version.
        const managed = await ensureClient(app, grant, forceRenew, true);
        const listTrace = newTrace();
        try {
          const tools = await traceStore.run(listTrace, () =>
            managed.kind === 'host_process' && managed.metaTools
              ? listInnerTools(managed)
              : listAllUpstreamTools(managed),
          );
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
    const entry = catalogEntryFor(app);
    if (entry && !catalogRulesMatch(entry, listed.tools)) {
      // Every tool goes, including ones pinned from an earlier listing: the rules no longer show what is safe to offer.
      const cleared = await store.pinTools(app.id, {
        instructions: null,
        tools: [],
        expectedGrantGeneration: grant.generation,
        at: new Date(now()).toISOString(),
      });
      if (cleared.changed) await notifyMainToolsChanged(store);
      throw new CatalogRulesUnmatchedError();
    }
    const result = await store.pinTools(app.id, {
      instructions: listed.instructions,
      tools: offeredTools(entry, listed.tools),
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
        hostLog.warn('Background app tool refresh failed', { appId, code: failureCode(error) });
      })
      .finally(() => {
        if (refreshing.get(appId) === job) refreshing.delete(appId);
      });
    refreshing.set(appId, job);
  }

  async function invokeUpstreamTool(
    app: ConnectionApp,
    grant: LiveGrant,
    tool: PinnedAppTool,
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
          /* eslint-disable-next-line no-catch-all/no-catch-all -- handshake failure never dispatches tools/call, so classify into retry_401 or unsent */
        } catch (error) {
          if (closed) return { status: 'unsent' as const, reason: 'relay_stopping' };
          if (error instanceof UpstreamUnauthorizedError && !forceRenew && app.auth === 'oauth') {
            return 'retry_401' as const;
          }
          return {
            status: 'unsent' as const,
            reason:
              error instanceof UpstreamUnauthorizedError
                ? 'unauthorized'
                : error instanceof EgressError
                  ? error.code
                  : error instanceof HostCliUnavailableError
                    ? 'app_unavailable'
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
        callTrace.verifyBeforeDial =
          options.verifyBeforeCall ??
          (async () =>
            (await verifyLiveGrant(app.id, grant.generation)) ? { ok: true } : { ok: false, reason: 'grant_changed' });
        try {
          const result = await traceStore.run(callTrace, () =>
            managed.client.callTool(upstreamCall(managed, tool, args), undefined, requestOptions(managed)),
          );
          // A child's pipe is read far past the relay's cap, so the cap applies to the answer main would receive.
          if (managed.kind === 'host_process' && Buffer.byteLength(JSON.stringify(result)) > maxBodyBytes) {
            return { status: 'too_large' as const };
          }
          return { status: 'completed' as const, result: result as Record<string, unknown> };
          /* eslint-disable-next-line no-catch-all/no-catch-all -- classify any upstream MCP call failure into too_large, unsent, or unknown */
        } catch (error) {
          const { egressError, fetchStarted, httpSent, httpStatus, dialPreflightFailure } = callTrace;
          if (dialPreflightFailure) {
            if (dialPreflightFailure === 'grant_changed') await closeClient(managed);
            return { status: 'unsent' as const, reason: dialPreflightFailure };
          }
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
          if (!fetchStarted && !httpSent && egressError === undefined) {
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
            : upstream.reason === 'pin_stale'
              ? 'The pinned tool list became stale while waiting to run; please retry, nothing was sent.'
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
            hostLog.warn('Could not pin connected app tools at startup', { appId: app.id, code: failureCode(error) });
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
        // Refused before anything about the call is stored, so a refused argument can never reach a card or the app.
        const entry = catalogEntryFor(app);
        const refused = entry && refusedArgumentIn(entry, input.toolName, input.args);
        if (entry && refused) {
          return { status: 'unsent', reason: 'refused_argument', text: refusalText(entry, input.toolName, refused) };
        }
        const loaded = await store.readAppTools(app.id);
        let pin = loaded?.pin;
        let tools: readonly PinnedAppTool[] = loaded?.tools ?? [];
        const invocationId = `${input.session.id}:${input.requestId}`;
        const callId = `direct:${invocationId}`;
        const [existingInvocation, existingCall] = await Promise.all([
          store.getRelayInvocation(invocationId),
          store.getRelayCall(callId),
        ]);
        const existingVersion = pin ? computeToolsVersion(pin.listHash, tools) : undefined;
        const requestConflict = (version?: string): RelayCallOutcome => ({
          status: 'unsent',
          reason: 'request_id_conflict',
          text: 'This request ID was already used for a different tool call; nothing was sent.',
          ...(version === undefined ? {} : { toolsVersion: version }),
        });

        if (existingInvocation || existingCall) {
          const pinnedTool = tools.find((entry) => entry.name === input.toolName);
          const expectedAppId = existingInvocation?.appId ?? existingCall!.appId;
          const expectedToolName = existingInvocation?.toolName ?? existingCall!.toolName;
          const expectedArgsHash = existingInvocation?.argsHash ?? existingCall!.argsHash;
          let replayArgs: {
            readonly callArgs: Record<string, unknown>;
            readonly canonical: string;
            readonly argsHash: string;
            readonly stripSummary: boolean;
          };
          if (existingInvocation) {
            const callArgs = existingInvocation.stripSummary ? stripSyntheticSummary(input.args) : input.args;
            const { canonical, hash } = canonicalArgsHash(callArgs);
            replayArgs = { callArgs, canonical, argsHash: hash, stripSummary: existingInvocation.stripSummary };
          } else if (pinnedTool) {
            replayArgs = prepareCallArgs(input.args, pinnedTool);
          } else {
            const { canonical, hash } = canonicalArgsHash(input.args);
            replayArgs = { callArgs: input.args, canonical, argsHash: hash, stripSummary: false };
          }
          if (
            expectedAppId !== app.id ||
            expectedToolName !== input.toolName ||
            replayArgs.argsHash !== expectedArgsHash
          ) {
            return requestConflict(existingVersion);
          }
          if (existingInvocation?.mode === 'held') {
            if (pinnedTool) {
              const held = await holdHandler({
                app,
                grantGeneration: grant.generation,
                tool: pinnedTool,
                args: replayArgs.callArgs,
                canonicalArgs: replayArgs.canonical,
                argsHash: replayArgs.argsHash,
                stripSummary: replayArgs.stripSummary,
                summary: input.summary,
                session: input.session,
                requestId: input.requestId,
              });
              return existingVersion === undefined ? held : { ...held, toolsVersion: existingVersion };
            }
            if (existingInvocation.approvalId) {
              const approvedRecord = await store.getRelayCall(existingInvocation.approvalId);
              if (approvedRecord) {
                return approvedRecord.state === 'executing'
                  ? {
                      status: 'unknown',
                      text: UNKNOWN_OUTCOME_MESSAGE,
                      ...(existingVersion === undefined ? {} : { toolsVersion: existingVersion }),
                    }
                  : outcomeFromSettledRecord(approvedRecord, existingVersion);
              }
            }
            const versionField = existingVersion === undefined ? {} : { toolsVersion: existingVersion };
            if (existingInvocation.state === 'declined') {
              return {
                status: 'unsent',
                reason: 'rejected',
                text: 'The principal declined this app tool call; nothing was sent.',
                ...versionField,
              };
            }
            if (existingInvocation.state === 'expired') {
              return {
                status: 'unsent',
                reason: 'expired',
                text: 'The approval request for this app tool call expired; nothing was sent.',
                ...versionField,
              };
            }
            if (existingInvocation.state === 'withdrawn') {
              return {
                status: 'unsent',
                reason: 'withdrawn',
                text: 'The approval request for this app tool call was withdrawn; nothing was sent.',
                ...versionField,
              };
            }
            if (existingInvocation.state === 'active') {
              if (!existingInvocation.approvalId) {
                return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE, ...versionField };
              }
              if (await getDb().hasTable('pending_approvals')) {
                const pendingRow = await getPendingApproval(existingInvocation.approvalId);
                if (!pendingRow) {
                  try {
                    await store.markHeldInvocationResolved(
                      invocationId,
                      existingInvocation.approvalId,
                      'withdrawn',
                      new Date(now()).toISOString(),
                    );
                    /* eslint-disable-next-line no-catch-all/no-catch-all -- best-effort reconciliation of an orphaned held invocation */
                  } catch (error) {
                    hostLog.warn('Could not reconcile orphaned held app call state', {
                      invocationId,
                      approvalId: existingInvocation.approvalId,
                      error: error instanceof Error ? error.message : String(error),
                    });
                  }
                  return {
                    status: 'unsent',
                    reason: 'withdrawn',
                    text: 'The approval request for this app tool call is no longer pending; nothing was sent.',
                    ...versionField,
                  };
                }
                if (pendingRow.status === 'awaiting_reason' || pendingRow.status === 'rejected') {
                  return {
                    status: 'unsent',
                    reason: 'rejected',
                    text: 'The principal declined this app tool call; nothing was sent.',
                    ...versionField,
                  };
                }
                if (pendingRow.status === 'expired') {
                  return {
                    status: 'unsent',
                    reason: 'expired',
                    text: 'The approval request for this app tool call expired; nothing was sent.',
                    ...versionField,
                  };
                }
              }
              return {
                status: 'held',
                text: "I've asked the principal; the result will arrive as a note.",
                approvalId: existingInvocation.approvalId,
                ...versionField,
              };
            }
            return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE, ...versionField };
          }
          if (existingCall) {
            if (existingCall.state === 'executing') {
              return {
                status: 'unknown',
                text: UNKNOWN_OUTCOME_MESSAGE,
                ...(existingVersion === undefined ? {} : { toolsVersion: existingVersion }),
              };
            }
            return outcomeFromSettledRecord(existingCall, existingVersion);
          }
          return {
            status: 'unknown',
            text: UNKNOWN_OUTCOME_MESSAGE,
            ...(existingVersion === undefined ? {} : { toolsVersion: existingVersion }),
          };
        }

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

        const { callArgs, canonical, argsHash, stripSummary } = prepareCallArgs(input.args, tool);

        if (tool.label === 'ask_first') {
          const held = await holdHandler({
            app,
            grantGeneration: grant.generation,
            tool,
            args: callArgs,
            canonicalArgs: canonical,
            argsHash,
            stripSummary,
            summary: input.summary,
            session: input.session,
            requestId: input.requestId,
          });
          return { ...held, toolsVersion };
        }

        const at = new Date(now()).toISOString();
        const directClaim = await store.claimDirectCall({
          id: callId,
          invocationId,
          appId: app.id,
          grantGeneration: grant.generation,
          toolName: tool.name,
          definitionHash: tool.definitionHash,
          argsHash,
          stripSummary,
          at,
        });
        if (directClaim.status === 'conflict') {
          return requestConflict(toolsVersion);
        }
        if (directClaim.status === 'already_held') {
          const held = await holdHandler({
            app,
            grantGeneration: grant.generation,
            tool,
            args: callArgs,
            canonicalArgs: canonical,
            argsHash,
            stripSummary,
            summary: input.summary,
            session: input.session,
            requestId: input.requestId,
          });
          return { ...held, toolsVersion };
        }
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

        const upstream = await invokeUpstreamTool(app, grant, tool, callArgs, {
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
          const latest = await store.readAppTools(app.id);
          const latestVersion = latest?.pin ? computeToolsVersion(latest.pin.listHash, latest.tools) : toolsVersion;
          const latestTool = latest?.tools.find((entry) => entry.name === input.toolName);
          if (!latestTool) {
            await store.deleteRelayCall(callId);
            return {
              status: 'unsent',
              reason: 'unknown_tool',
              text: `Tool "${input.toolName}" is no longer offered by this app.`,
              toolsVersion: latestVersion,
            };
          }
          if (latestTool.label === null) {
            await store.deleteRelayCall(callId);
            return { status: 'unsorted', text: UNSORTED_TOOL_MESSAGE, toolsVersion: latestVersion };
          }
          if (latestTool.label === 'ask_first') {
            if (
              latestTool.definitionHash !== tool.definitionHash &&
              schemaAcceptsSummaryArg(latestTool.definition.inputSchema) !==
                schemaAcceptsSummaryArg(tool.definition.inputSchema)
            ) {
              return settleUpstreamOutcome(
                callId,
                { status: 'unsent', reason: 'definition_changed' },
                true,
                latestVersion,
              );
            }
            const rerouted = prepareCallArgs(input.args, latestTool);
            await store.rerouteDirectCallToHold({
              id: callId,
              invocationId,
              argsHash: rerouted.argsHash,
              stripSummary: rerouted.stripSummary,
              at: new Date(now()).toISOString(),
            });
            const held = await holdHandler({
              app,
              grantGeneration: grant.generation,
              tool: latestTool,
              args: rerouted.callArgs,
              canonicalArgs: rerouted.canonical,
              argsHash: rerouted.argsHash,
              stripSummary: rerouted.stripSummary,
              summary: input.summary,
              session: input.session,
              requestId: input.requestId,
            });
            return { ...held, toolsVersion: latestVersion };
          }
          return settleUpstreamOutcome(callId, upstream, true, latestVersion);
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
          ...(input.invocationId === undefined ? {} : { invocationId: input.invocationId }),
          appId: input.appId,
          grantGeneration: input.grantGeneration,
          toolName: input.toolName,
          definitionHash: input.definitionHash,
          argsHash,
          at,
        });

        if (claim.status === 'already_dispatched') {
          return {
            status: 'unsent',
            reason: 'already_dispatched',
            text: 'This app tool call already ran, so nothing was sent again.',
          };
        }

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
          if (
            (error instanceof ConnectionsStoreError && error.reason === 'app_changed') ||
            !(await verifyLiveGrant(input.appId, input.grantGeneration))
          ) {
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

        const upstream = await invokeUpstreamTool(app, grant, freshTool, input.args, {
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
