/**
 * Persistent key/value state owned by the registered mailbox.
 *
 * Primary use: remember each provider's opaque continuation id so the
 * agent's conversation resumes across container restarts. Keyed per
 * provider because continuations are provider-private — a Claude
 * conversation id means nothing to Codex and vice versa. Switching
 * providers is therefore lossless: each provider's last thread stays
 * on file and resumes cleanly if the user flips back.
 */
import { getAgentMailbox } from '../mailbox/index.js';
import {
  LATEST_PROVIDER_TURN_KEY,
  parseIsoTimestamp,
  type ProviderTurnCause,
  type ProviderTurnOutcome,
} from '../mailbox/model.generated.js';

const LEGACY_KEY = 'sdk_session_id';

function continuationKey(providerName: string): string {
  return `continuation:${providerName.toLowerCase()}`;
}

function getValue(key: string): string | undefined {
  return getAgentMailbox().operations.getState(key)?.value;
}

function setValue(key: string, value: string): void {
  getAgentMailbox().operations.setState(key, value);
}

function deleteValue(key: string): void {
  getAgentMailbox().operations.deleteState(key);
}

/** Only bounded provider facts enter operator state; diagnostics stay in existing logs. */
export function recordProviderTurn(provider: string, failed: boolean, cause?: ProviderTurnCause): void {
  setValue(
    LATEST_PROVIDER_TURN_KEY,
    JSON.stringify({
      version: 1,
      provider: provider.toLowerCase(),
      observedAt: parseIsoTimestamp(new Date().toISOString()),
      status: failed ? 'failed' : 'completed',
      cause: failed ? (cause ?? 'unknown') : null,
    } satisfies ProviderTurnOutcome),
  );
}

/**
 * One-time migration of the pre-per-provider continuation row.
 *
 * Before this was keyed per provider, continuations lived under the
 * single key `sdk_session_id`. On container start, if that legacy row
 * exists and the current provider has no continuation of its own, adopt
 * the legacy value into the current provider's slot (best-guess — the
 * legacy row was written by whatever provider ran last). The legacy row
 * is always deleted so future provider flips never re-read a stale id
 * through the wrong lens.
 *
 * Returns the continuation the caller should use at startup (either the
 * current provider's existing value, the adopted legacy value, or
 * undefined).
 */
export function migrateLegacyContinuation(providerName: string): string | undefined {
  const legacy = getValue(LEGACY_KEY);
  const currentKey = continuationKey(providerName);
  const current = getValue(currentKey);

  if (legacy === undefined) return current;

  // Always drop the legacy row so no future provider reads it.
  deleteValue(LEGACY_KEY);

  // Prefer the current provider's own slot if one already exists.
  if (current !== undefined) return current;

  setValue(currentKey, legacy);
  return legacy;
}

export function getContinuation(providerName: string): string | undefined {
  return getValue(continuationKey(providerName));
}

export function setContinuation(providerName: string, id: string): void {
  setValue(continuationKey(providerName), id);
}

export function clearContinuation(providerName: string): void {
  deleteValue(continuationKey(providerName));
}

/**
 * Where the message being answered came from, plus its id for the a2a return
 * path. Null routing fields mean the batch has no channel (a task run).
 */
export interface ReplyRoute {
  inReplyTo: string;
  channelType: string | null;
  platformId: string | null;
  threadId: string | null;
}

/** The reply stamp as published: the turn's route, and the ids of the batch it answers. */
export interface ReplyStamp extends ReplyRoute {
  batch: readonly string[];
}

/**
 * The reply stamp: the route of the first inbound message in the batch the
 * agent is currently processing, and the ids of every message in it. The poll
 * loop publishes it at batch start; MCP tools (`send_message`, `send_file`)
 * read it to thread a reply into the conversation being answered and to stamp
 * `in_reply_to` onto outbound rows so the host's a2a return-path routing can
 * correlate replies back to the originating session. Each message a tool
 * writes to a person names the batch (`writeMessageOut`).
 *
 * This lives in mailbox state because the MCP server runs as a separate stdio
 * subprocess; module state set by the poll loop is invisible to it.
 *
 * No age limit: the tools only run inside a query, and every query publishes
 * (or clears) the stamp before it starts, so a stamp is never older than the
 * turn it belongs to. A container killed mid-batch (SIGKILL) skips the
 * clearing finally, so the poll loop clears any leftover at startup instead.
 */
const REPLY_ROUTE_KEY = 'current_reply_route';

export function setCurrentReplyRoute(stamp: ReplyStamp | null): void {
  if (stamp === null) {
    clearCurrentReplyRoute();
    return;
  }
  const { inReplyTo, channelType, platformId, threadId, batch } = stamp;
  setValue(REPLY_ROUTE_KEY, JSON.stringify({ inReplyTo, channelType, platformId, threadId, batch }));
}

export function clearCurrentReplyRoute(): void {
  deleteValue(REPLY_ROUTE_KEY);
}

/** The ids a stamp names; a stamp that names none as strings names an empty batch. */
function stampedBatch(value: unknown): string[] {
  return Array.isArray(value) && value.every((id: unknown): id is string => typeof id === 'string') ? value : [];
}

export function getCurrentReplyRoute(): ReplyStamp | null {
  const row = getAgentMailbox().operations.getState(REPLY_ROUTE_KEY);
  if (!row) return null;
  try {
    const parsed = JSON.parse(row.value) as Partial<ReplyRoute> & { batch?: unknown };
    if (typeof parsed.inReplyTo !== 'string') return null;
    return {
      inReplyTo: parsed.inReplyTo,
      channelType: parsed.channelType ?? null,
      platformId: parsed.platformId ?? null,
      threadId: parsed.threadId ?? null,
      batch: stampedBatch(parsed.batch),
    };
  } catch {
    return null;
  }
}

export function getCurrentInReplyTo(): string | null {
  return getCurrentReplyRoute()?.inReplyTo ?? null;
}
