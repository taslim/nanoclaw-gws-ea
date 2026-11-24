import { setTimeout as delay } from 'node:timers/promises';

import {
  ANSWER_LATER,
  ActionRefusal,
  answeredGuard,
  answeringAction,
  forbidden,
  invalidArgs,
  writeActionResponse,
} from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { clearOutbox } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { readMainAgentGroupId } from '../gws-ea-profile/db.js';
import { APP_SERVER_PREFIX } from './apply.js';
import { ASSISTANT_SUMMARY_FIELD } from './canonical.js';
import { getAppRelay, RELAY_SHUTDOWN_WAIT_MS, type AppRelay } from './relay.js';
import { ConnectionsStoreError } from './store.js';

export const APP_RELAY_ACTION = 'app_relay';

const RELAY_OPS = new Set(['initialize', 'tools/list', 'tools/call']);
const SUMMARY_MAX = 500;

export const appRelayGuard = defineGuardedAction({
  action: 'gws_ea_connections.app_relay',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await readMainAgentGroupId())
      ? ALLOW('Main reaches its connected principal apps through the host relay.')
      : DENY('Only main may reach connected principal apps through the host relay.');
  },
});

export interface RelayActionDependencies {
  readonly relay: () => Promise<AppRelay | undefined>;
}

type ParsedRelayRequest =
  | { readonly op: 'initialize'; readonly serverKey: string }
  | { readonly op: 'tools/list'; readonly serverKey: string }
  | {
      readonly op: 'tools/call';
      readonly serverKey: string;
      readonly tool: string;
      readonly args: Record<string, unknown>;
      readonly summary?: string;
    };

function parseRelayRequest(content: Record<string, unknown>): ParsedRelayRequest {
  const op = content.op;
  if (typeof op !== 'string' || !RELAY_OPS.has(op)) {
    throw invalidArgs('op must be initialize, tools/list, or tools/call.');
  }
  const serverKey = content.serverKey;
  if (typeof serverKey !== 'string' || !serverKey.startsWith(APP_SERVER_PREFIX)) {
    throw invalidArgs('serverKey must name a principal-connected app.');
  }
  if (op === 'initialize') return { op, serverKey };
  if (op === 'tools/list') return { op, serverKey };
  const tool = content.tool;
  if (typeof tool !== 'string' || !tool.trim()) {
    throw invalidArgs('tool is required for tools/call.');
  }
  const rawArgs = content.arguments;
  if (rawArgs !== undefined && !isRecord(rawArgs)) {
    throw invalidArgs('arguments must be a JSON object.');
  }
  const cleanArgs: Record<string, unknown> = {};
  if (rawArgs) {
    for (const [key, value] of Object.entries(rawArgs)) {
      if (key === ASSISTANT_SUMMARY_FIELD) continue;
      cleanArgs[key] = value;
    }
  }
  const rawSummary = content.summary;
  if (rawSummary !== undefined && typeof rawSummary !== 'string') {
    throw invalidArgs('summary must be a string.');
  }
  const summary =
    typeof rawSummary === 'string' && rawSummary.trim() ? rawSummary.trim().slice(0, SUMMARY_MAX) : undefined;
  return {
    op: 'tools/call',
    serverKey,
    tool,
    args: cleanArgs,
    ...(summary === undefined ? {} : { summary }),
  };
}

function errorFrame(requestId: string, error: unknown): ResponseFrame {
  if (error instanceof ActionRefusal) {
    return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
  }
  if (error instanceof ConnectionsStoreError) {
    const code = error.reason === 'app_not_found' ? 'forbidden' : 'handler-error';
    const message =
      error.reason === 'app_not_found' ? 'That app is not connected.' : 'Connected apps are unavailable right now.';
    return { id: requestId, ok: false, error: { code, message } };
  }
  return {
    id: requestId,
    ok: false,
    error: { code: 'handler-error', message: 'The app relay could not finish this request.' },
  };
}

const activeDeferred = new Set<Promise<void>>();

export async function drainRelayActions(waitMs = RELAY_SHUTDOWN_WAIT_MS): Promise<void> {
  if (activeDeferred.size === 0 || waitMs <= 0) return;
  const bound = new AbortController();
  await Promise.race([
    Promise.allSettled([...activeDeferred]),
    delay(waitMs, undefined, { signal: bound.signal }).catch(() => undefined),
  ]);
  bound.abort();
}

export function createRelayAction(dependencies: RelayActionDependencies) {
  const inFlight = new Set<string>();

  async function runDeferred(
    parsed: ParsedRelayRequest,
    session: Session,
    requestId: string,
    key: string,
  ): Promise<void> {
    let frame: ResponseFrame;
    /* eslint-disable no-catch-all/no-catch-all -- every deferred relay request must produce one response frame */
    try {
      const relay = await dependencies.relay();
      if (!relay) {
        throw forbidden('The app relay is not running.');
      }
      let data: Record<string, unknown>;
      switch (parsed.op) {
        case 'initialize':
          data = { ...(await relay.initializeApp(parsed.serverKey)) };
          break;
        case 'tools/list':
          data = { ...(await relay.listToolsForSession(parsed.serverKey)) };
          break;
        case 'tools/call':
          data = {
            ...(await relay.callTool({
              serverKey: parsed.serverKey,
              toolName: parsed.tool,
              args: parsed.args,
              ...(parsed.summary === undefined ? {} : { summary: parsed.summary }),
              session,
              requestId,
            })),
          };
          break;
      }
      frame = { id: requestId, ok: true, data };
    } catch (error) {
      if (!(error instanceof ActionRefusal) && !(error instanceof ConnectionsStoreError)) {
        log.warn('App relay request failed', {
          op: parsed.op,
          serverKey: parsed.serverKey,
          requestId,
          sessionId: session.id,
        });
      }
      frame = errorFrame(requestId, error);
    } finally {
      inFlight.delete(key);
    }
    try {
      await writeActionResponse(session, requestId, frame);
      clearOutbox(session.agent_group_id, session.id, requestId);
    } catch (error) {
      log.warn('Failed to write app relay response', {
        op: parsed.op,
        serverKey: parsed.serverKey,
        requestId,
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  return answeringAction(APP_RELAY_ACTION, async (content, session, requestId) => {
    const parsed = parseRelayRequest(content);
    const key = `${session.id}:${requestId}`;
    if (inFlight.has(key)) return ANSWER_LATER;
    inFlight.add(key);
    const task = runDeferred(parsed, session, requestId, key);
    activeDeferred.add(task);
    const cleanup = (): void => {
      activeDeferred.delete(task);
    };
    task.then(cleanup, cleanup);
    return ANSWER_LATER;
  });
}

export function registerRelayAction(
  dependencies: RelayActionDependencies = { relay: async () => getAppRelay() },
): void {
  registerDeliveryAction(APP_RELAY_ACTION, createRelayAction(dependencies), answeredGuard(appRelayGuard));
}
