import { randomBytes } from 'node:crypto';

import { APPROVE_OPTION, MAX_CARD_QUESTION_LENGTH, REJECT_OPTION } from '../../channels/ask-question.js';
import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { getPendingApproval, getPendingApprovalsByAction, getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { formatLocalTime, resolveTimezone } from '../../timezone.js';
import type { PendingApproval } from '../../types.js';
import { expireApproval, withdrawApproval } from '../approvals/lifecycle.js';
import {
  approvalCardThread,
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
  type ApprovalResolvedEvent,
} from '../approvals/primitive.js';
import { quoted } from '../approvals/request-text.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { isVerifiedPrincipalUser, principalApproverUserId } from '../gws-ea-profile/db.js';
import {
  resolveMainConversation,
  writeNoteForMain,
  type NoteForMain,
  type NoteForMainResult,
} from '../gws-ea-profile/main-note.js';
import { loadTimeline, zoneAt } from '../gws-ea-whereabouts/timeline.js';
import { webReadiness } from '../gws-ea-web/index.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';
import type { WebReadiness } from '../gws-ea-web/runtime.js';
import { canonicalArgsHash } from './canonical.js';
import {
  capUtf16,
  escapeInvisibleChars,
  renderCompactArgs,
  renderDistilledArgs,
  renderDistilledContext,
} from './held-card.js';
import {
  getAppRelay,
  outcomeFromSettledRecord,
  UNKNOWN_OUTCOME_MESSAGE,
  type AppRelay,
  type HoldCallHandler,
  type HoldCallInput,
  type RelayCallOutcome,
} from './relay.js';
import type { ConnectionsStore, RecentRelayResult, RelayInvocationRecord } from './store.js';

export const HELD_APP_CALL_ACTION = 'app_tool_call';
const APP_TOOL_ASK_ACTION_NAME = 'app_tool_ask';
export const HELD_CALL_ANSWER = "I've asked the principal; the result will arrive as a note.";
export const HELD_CALL_TTL_MS = 24 * 60 * 60_000;

const CARD_SAFE_BUDGET = MAX_CARD_QUESTION_LENGTH - 120;
const APP_CONTEXT_STORAGE_MAX = 64 * 1024;
const RESULT_NOTE_MAX = 32_000;
const SUMMARY_CARD_MAX = 280;
const TOOL_CARD_MAX = 120;

export { escapeInvisibleChars, renderCompactArgs };

export interface HeldAppCallContext {
  readonly toolName: string;
  readonly text: string;
}

export interface HeldAppCallPayload {
  readonly viewId?: string;
  readonly invocationId: string;
  readonly appId: string;
  readonly appName: string;
  readonly appHost: string;
  readonly grantGeneration: number;
  readonly toolName: string;
  readonly definitionHash: string;
  readonly canonicalArgs: string;
  readonly argsHash: string;
  readonly summary: string | null;
  readonly appContext: HeldAppCallContext | null;
  readonly expiresAt: string;
}

export interface HeldCallsDependencies {
  readonly relay: () => AppRelay | undefined | Promise<AppRelay | undefined>;
  readonly store?: () => ConnectionsStore | undefined | Promise<ConnectionsStore | undefined>;
  readonly writeNote?: (note: NoteForMain) => Promise<NoteForMainResult>;
  readonly now?: () => number;
}

function collectArgStrings(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 6 || out.size > 40) return;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.length >= 3) out.add(trimmed);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) collectArgStrings(item, out, depth + 1);
    return;
  }
  if (isRecord(value)) {
    for (const entry of Object.values(value)) collectArgStrings(entry, out, depth + 1);
  }
}

export function extractResultText(result: Record<string, unknown>): string {
  const parts: string[] = [];
  if (Array.isArray(result.content)) {
    for (const block of result.content) {
      if (isRecord(block) && block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
        parts.push(block.text.trim());
      }
    }
  }
  if (isRecord(result.structuredContent)) {
    const structured = JSON.stringify(result.structuredContent);
    if (!parts.some((p) => p.includes(structured))) parts.push(structured);
  }
  if (parts.length > 0) return parts.join('\n');
  return JSON.stringify(result);
}

function matchNeedlesInRecent(
  needles: ReadonlySet<string>,
  recent: readonly RecentRelayResult[],
): HeldAppCallContext | null {
  if (needles.size === 0) return null;
  for (const item of recent) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(item.outcomeJson);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    const text = isRecord(parsed) ? extractResultText(parsed) : item.outcomeJson;
    for (const needle of needles) {
      if (text.includes(needle)) {
        return { toolName: item.toolName, text: text.slice(0, APP_CONTEXT_STORAGE_MAX) };
      }
    }
  }
  return null;
}

export async function resolveDetailsHostname(
  readPolicy: typeof readWebPolicy = readWebPolicy,
  readiness: Pick<WebReadiness, 'publicationReady'> = webReadiness,
): Promise<string | undefined> {
  const policy = await readPolicy();
  if (policy.status !== 'enabled') return undefined;
  return (await readiness.publicationReady(policy.config)) ? policy.config.hostname : undefined;
}

function defaultWebHostname(): Promise<string | undefined> {
  return resolveDetailsHostname();
}

/** Resolves the principal's local clock for `isoInstant` via whereabouts, falling back to install timezone. */
export async function resolvePrincipalZoneAt(isoInstant: string): Promise<string> {
  const instant = Date.parse(isoInstant);
  try {
    const zone = zoneAt(await loadTimeline(), Number.isFinite(instant) ? instant : Date.now());
    return resolveTimezone(zone ?? TIMEZONE);
    /* eslint-disable-next-line no-catch-all/no-catch-all -- fall back to install timezone when whereabouts tables are absent */
  } catch {
    return TIMEZONE;
  }
}

type BuiltHeldCallCard =
  | { readonly kind: 'card'; readonly title: string; readonly question: string }
  | { readonly kind: 'unreachable_details' };

function allocateBodyBudgets(
  argsLength: number,
  contextLength: number | undefined,
  targetBody: number,
): { readonly argsBudget: number; readonly contextBudget: number } {
  if (contextLength === undefined) {
    return { argsBudget: targetBody, contextBudget: 0 };
  }
  if (argsLength + contextLength <= targetBody) {
    return { argsBudget: argsLength, contextBudget: contextLength };
  }
  const argsShare = Math.floor(targetBody * 0.45);
  const contextShare = targetBody - argsShare;
  if (argsLength <= argsShare) {
    return { argsBudget: argsLength, contextBudget: targetBody - argsLength };
  }
  if (contextLength <= contextShare) {
    return { argsBudget: targetBody - contextLength, contextBudget: contextLength };
  }
  return { argsBudget: argsShare, contextBudget: contextShare };
}

async function buildHeldCallCard(input: {
  readonly viewId: string;
  readonly appName: string;
  readonly appHost: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly summary: string | undefined;
  readonly appContext: HeldAppCallContext | null;
  readonly expiresAt: string;
  readonly timezone: string;
  readonly readHostname: () => Promise<string | undefined>;
}): Promise<BuiltHeldCallCard> {
  const displayToolName = capUtf16(input.toolName, TOOL_CARD_MAX);
  const toolNameTruncated = displayToolName !== input.toolName;
  const title = capUtf16(`Allow ${input.appName} to run ${displayToolName}?`, 120);
  const rawArgs = renderCompactArgs(input.args);
  const distilledArgs = renderDistilledArgs(input.args);
  const summaryOut = input.summary && input.summary.trim() ? escapeInvisibleChars(input.summary.trim()) : undefined;
  const rawContextOut = input.appContext ? escapeInvisibleChars(input.appContext.text) : undefined;
  const contextToolOut = input.appContext ? escapeInvisibleChars(input.appContext.toolName) : undefined;
  const distilledContext = input.appContext
    ? renderDistilledContext(input.appContext.text, distilledArgs.opaqueTokens)
    : undefined;
  const hasInvisible =
    rawArgs.hasInvisible ||
    distilledArgs.hasInvisible ||
    summaryOut?.hasInvisible === true ||
    rawContextOut?.hasInvisible === true ||
    contextToolOut?.hasInvisible === true ||
    distilledContext?.hasInvisible === true;
  const detailsCompacted = distilledArgs.compacted || distilledContext?.compacted === true;
  const summaryLine = summaryOut
    ? `Assistant's description: ${quoted(summaryOut.rendered, SUMMARY_CARD_MAX)}`
    : "Assistant's description: no summary given";
  const invisibleLine = hasInvisible
    ? 'Warning: call details contain invisible or hidden characters (shown as [U+...]).'
    : undefined;
  const expiryLine = `Expires: ${formatLocalTime(input.expiresAt, input.timezone)}`;

  const headerLines = [
    `App: ${input.appName} (${input.appHost})`,
    `Tool: ${displayToolName}`,
    summaryLine,
    ...(invisibleLine ? [invisibleLine] : []),
  ];

  const contextHeader = input.appContext
    ? `From ${input.appName} (${capUtf16(contextToolOut?.rendered ?? input.appContext.toolName, TOOL_CARD_MAX)}):\n`
    : '';
  const rawQuestion = [
    ...headerLines,
    `Arguments:\n${rawArgs.text}`,
    ...(rawContextOut ? [`${contextHeader}${rawContextOut.rendered}`] : []),
    expiryLine,
  ].join('\n');

  if (!detailsCompacted && !toolNameTruncated && title.length + rawQuestion.length <= CARD_SAFE_BUDGET) {
    return { kind: 'card', title, question: rawQuestion };
  }

  const webHostname = await input.readHostname().catch(() => undefined);
  if (!webHostname) {
    if (!toolNameTruncated && title.length + rawQuestion.length <= CARD_SAFE_BUDGET) {
      return { kind: 'card', title, question: rawQuestion };
    }
    return { kind: 'unreachable_details' };
  }

  const detailsUrl = `https://${webHostname}/connections/held/${encodeURIComponent(input.viewId)}`;
  const compactLinkLine = `Full details: ${detailsUrl}`;
  const distilledQuestion = [
    ...headerLines,
    `Arguments:\n${distilledArgs.text}`,
    ...(distilledContext ? [`${contextHeader}${distilledContext.text}`] : []),
    compactLinkLine,
    expiryLine,
  ].join('\n');
  if (!toolNameTruncated && title.length + distilledQuestion.length <= CARD_SAFE_BUDGET) {
    return { kind: 'card', title, question: distilledQuestion };
  }

  const linkLine = `Full details are too long for this message — review them in full: ${detailsUrl}`;
  const overhead =
    title.length +
    headerLines.join('\n').length +
    1 +
    'Arguments:\n'.length +
    (distilledContext ? 1 + contextHeader.length : 0) +
    1 +
    linkLine.length +
    1 +
    expiryLine.length;
  const available = MAX_CARD_QUESTION_LENGTH - overhead;
  if (available < 40) {
    return { kind: 'unreachable_details' };
  }
  const targetBody = Math.min(available, Math.max(40, CARD_SAFE_BUDGET - overhead));
  const { argsBudget, contextBudget } = allocateBodyBudgets(
    distilledArgs.text.length,
    distilledContext?.text.length,
    targetBody,
  );

  const trimmedParts = [
    ...headerLines,
    `Arguments:\n${capUtf16(distilledArgs.text, argsBudget)}`,
    ...(distilledContext ? [`${contextHeader}${capUtf16(distilledContext.text, contextBudget)}`] : []),
    linkLine,
    expiryLine,
  ];
  return { kind: 'card', title, question: trimmedParts.join('\n') };
}

export function parseHeldCallPayload(raw: string): HeldAppCallPayload | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
  if (!isRecord(parsed)) return undefined;
  if (
    typeof parsed.invocationId !== 'string' ||
    typeof parsed.appId !== 'string' ||
    typeof parsed.appName !== 'string' ||
    typeof parsed.appHost !== 'string' ||
    typeof parsed.grantGeneration !== 'number' ||
    typeof parsed.toolName !== 'string' ||
    typeof parsed.definitionHash !== 'string' ||
    typeof parsed.canonicalArgs !== 'string' ||
    typeof parsed.argsHash !== 'string' ||
    typeof parsed.expiresAt !== 'string'
  ) {
    return undefined;
  }
  const appContext =
    isRecord(parsed.appContext) &&
    typeof parsed.appContext.toolName === 'string' &&
    typeof parsed.appContext.text === 'string'
      ? { toolName: parsed.appContext.toolName, text: parsed.appContext.text }
      : null;
  return {
    ...(typeof parsed.viewId === 'string' && parsed.viewId ? { viewId: parsed.viewId } : {}),
    invocationId: parsed.invocationId,
    appId: parsed.appId,
    appName: parsed.appName,
    appHost: parsed.appHost,
    grantGeneration: parsed.grantGeneration,
    toolName: parsed.toolName,
    definitionHash: parsed.definitionHash,
    canonicalArgs: parsed.canonicalArgs,
    argsHash: parsed.argsHash,
    summary: typeof parsed.summary === 'string' ? parsed.summary : null,
    appContext,
    expiresAt: parsed.expiresAt,
  };
}

function formatOutcomeNote(payload: HeldAppCallPayload, outcome: RelayCallOutcome): string {
  const callName = `${payload.appName}.${payload.toolName}`;
  switch (outcome.status) {
    case 'completed':
      return `The principal approved ${callName} and the app answered:\n${untrusted(extractResultText(outcome.result), RESULT_NOTE_MAX, payload.appHost)}`;
    case 'too_large':
      return `The principal approved ${callName}. ${outcome.text}`;
    case 'unsent':
      return `The principal approved ${callName}, but nothing was sent: ${outcome.text}`;
    case 'unknown':
      return `The principal approved ${callName}, and the outcome is unknown: ${outcome.text} Do not retry automatically; check before retrying.`;
    case 'held':
    case 'unsorted':
      return `The principal approved ${callName}, but it could not run: ${outcome.text}`;
  }
}

const REQUEST_ID_CONFLICT_OUTCOME: RelayCallOutcome = {
  status: 'unsent',
  reason: 'request_id_conflict',
  text: 'This request ID was already used for a different tool call; nothing was sent.',
};

async function findApprovalByInvocation(invocationId: string): Promise<PendingApproval | undefined> {
  if (!(await getDb().hasTable('pending_approvals'))) return undefined;
  const rows = await getPendingApprovalsByAction(HELD_APP_CALL_ACTION);
  for (const row of rows) {
    const payload = parseHeldCallPayload(row.payload);
    if (payload?.invocationId === invocationId) return row;
  }
  return undefined;
}

async function resolveExistingHeldState(
  store: ConnectionsStore,
  input: HoldCallInput,
  invocationId: string,
  existingApproval: PendingApproval | undefined,
  existingInvocation: RelayInvocationRecord | undefined,
  now: () => number,
): Promise<RelayCallOutcome | undefined> {
  if (existingInvocation) {
    if (
      existingInvocation.appId !== input.app.id ||
      existingInvocation.toolName !== input.tool.name ||
      existingInvocation.argsHash !== input.argsHash
    ) {
      return REQUEST_ID_CONFLICT_OUTCOME;
    }
    if (existingInvocation.mode === 'direct') {
      const directCall = await store.getRelayCall(`direct:${invocationId}`);
      if (!directCall || directCall.state === 'executing') {
        return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
      }
      return outcomeFromSettledRecord(directCall);
    }
  }

  if (existingApproval) {
    const existingPayload = parseHeldCallPayload(existingApproval.payload);
    if (
      existingPayload &&
      (existingPayload.appId !== input.app.id ||
        existingPayload.toolName !== input.tool.name ||
        existingPayload.argsHash !== input.argsHash)
    ) {
      return REQUEST_ID_CONFLICT_OUTCOME;
    }
    if (existingInvocation && existingInvocation.approvalId === null) {
      await store.bindHeldApproval(invocationId, existingApproval.approval_id);
    }
    switch (existingApproval.status) {
      case 'pending':
        return { status: 'held', text: HELD_CALL_ANSWER, approvalId: existingApproval.approval_id };
      case 'approved': {
        const record = await store.getRelayCall(existingApproval.approval_id);
        if (record && record.state !== 'executing') return outcomeFromSettledRecord(record);
        return { status: 'held', text: HELD_CALL_ANSWER, approvalId: existingApproval.approval_id };
      }
      case 'awaiting_reason':
      case 'rejected':
        return {
          status: 'unsent',
          reason: 'rejected',
          text: 'The principal declined this app tool call; nothing was sent.',
        };
      case 'expired':
        return {
          status: 'unsent',
          reason: 'expired',
          text: 'The approval request for this app tool call expired; nothing was sent.',
        };
      default: {
        const unreachable: never = existingApproval.status;
        throw new Error(`Unexpected approval status: ${String(unreachable)}`);
      }
    }
  }

  if (!existingInvocation) return undefined;
  if (existingInvocation.state === 'active' && existingInvocation.approvalId === null) {
    return undefined;
  }
  if (existingInvocation.approvalId) {
    const record = await store.getRelayCall(existingInvocation.approvalId);
    if (record) {
      return record.state === 'executing'
        ? { status: 'held', text: HELD_CALL_ANSWER, approvalId: existingInvocation.approvalId }
        : outcomeFromSettledRecord(record);
    }
  }
  switch (existingInvocation.state) {
    case 'active': {
      if (existingInvocation.approvalId && (await getDb().hasTable('pending_approvals'))) {
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
            log.warn('Could not reconcile orphaned held app call state', {
              invocationId,
              approvalId: existingInvocation.approvalId,
              error: error instanceof Error ? error.message : String(error),
            });
          }
          return {
            status: 'unsent',
            reason: 'withdrawn',
            text: 'The approval request for this app tool call is no longer pending; nothing was sent.',
          };
        }
      }
      return {
        status: 'held',
        text: HELD_CALL_ANSWER,
        ...(existingInvocation.approvalId ? { approvalId: existingInvocation.approvalId } : {}),
      };
    }
    case 'settled':
      return { status: 'unknown', text: UNKNOWN_OUTCOME_MESSAGE };
    case 'declined':
      return {
        status: 'unsent',
        reason: 'rejected',
        text: 'The principal declined this app tool call; nothing was sent.',
      };
    case 'expired':
      return {
        status: 'unsent',
        reason: 'expired',
        text: 'The approval request for this app tool call expired; nothing was sent.',
      };
    case 'withdrawn':
      return {
        status: 'unsent',
        reason: 'withdrawn',
        text: 'The approval request for this app tool call was withdrawn; nothing was sent.',
      };
    default: {
      const unreachable: never = existingInvocation.state;
      throw new Error(`Unexpected invocation state: ${String(unreachable)}`);
    }
  }
}

let lastHoldStore: ConnectionsStore | undefined;

export function createHoldCallHandler(dependencies: {
  readonly store: ConnectionsStore;
  readonly webHostname?: () => Promise<string | undefined>;
  readonly now?: () => number;
}): HoldCallHandler {
  lastHoldStore = dependencies.store;
  const readHostname = dependencies.webHostname ?? defaultWebHostname;
  const now = dependencies.now ?? Date.now;
  const invocationQueues = new Map<string, Promise<unknown>>();

  async function withInvocationLock<T>(invocationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = invocationQueues.get(invocationId) ?? Promise.resolve();
    const run = previous.then(operation, operation);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    invocationQueues.set(invocationId, tail);
    try {
      return await run;
    } finally {
      if (invocationQueues.get(invocationId) === tail) invocationQueues.delete(invocationId);
    }
  }

  return async (input: HoldCallInput): Promise<RelayCallOutcome> => {
    const invocationId = `${input.session.id}:${input.requestId}`;
    return withInvocationLock(invocationId, async () => {
      const [existingApproval, existingInvocation] = await Promise.all([
        findApprovalByInvocation(invocationId),
        dependencies.store.getRelayInvocation(invocationId),
      ]);
      const existingOutcome = await resolveExistingHeldState(
        dependencies.store,
        input,
        invocationId,
        existingApproval,
        existingInvocation,
        now,
      );
      if (existingOutcome) return existingOutcome;

      const reservation = await dependencies.store.reserveHeldInvocation({
        invocationId,
        appId: input.app.id,
        grantGeneration: input.grantGeneration,
        toolName: input.tool.name,
        argsHash: input.argsHash,
        ...(input.stripSummary === undefined ? {} : { stripSummary: input.stripSummary }),
        at: new Date(now()).toISOString(),
      });
      if (reservation.status === 'conflict') return REQUEST_ID_CONFLICT_OUTCOME;
      if (reservation.status === 'app_not_found') {
        return {
          status: 'unsent',
          reason: 'app_gone',
          text: 'The app is no longer connected, so nothing was sent.',
        };
      }
      if (reservation.status === 'existing') {
        const resolved = await resolveExistingHeldState(
          dependencies.store,
          input,
          invocationId,
          await findApprovalByInvocation(invocationId),
          reservation.invocation,
          now,
        );
        if (resolved) return resolved;
      }

      let posted = false;
      try {
        const [conversation, approverUserId] = await Promise.all([
          resolveMainConversation(),
          principalApproverUserId(),
        ]);
        if (typeof conversation === 'string') {
          return {
            status: 'unsent',
            reason: conversation,
            text: 'Could not reach the principal to ask for approval; nothing was sent.',
          };
        }
        if (!approverUserId) {
          return {
            status: 'unsent',
            reason: 'no_principal',
            text: 'No verified principal is configured to approve app actions; nothing was sent.',
          };
        }

        const needles = new Set<string>();
        collectArgStrings(input.args, needles);
        const expiresAt = new Date(now() + HELD_CALL_TTL_MS).toISOString();
        const [recent, timezone] = await Promise.all([
          needles.size > 0
            ? dependencies.store.recentCompletedResults(input.app.id, input.grantGeneration, 20)
            : Promise.resolve([]),
          resolvePrincipalZoneAt(expiresAt),
        ]);
        const appContext = matchNeedlesInRecent(needles, recent);
        const viewId = `held-${now()}-${randomBytes(4).toString('hex')}`;

        const card = await buildHeldCallCard({
          viewId,
          appName: input.app.name,
          appHost: input.app.host,
          toolName: input.tool.name,
          args: input.args,
          summary: input.summary,
          appContext,
          expiresAt,
          timezone,
          readHostname,
        });
        if (card.kind === 'unreachable_details') {
          return {
            status: 'unsent',
            reason: 'details_unavailable',
            text: 'This action has too many details to show on an approval card, and the Connections page is unavailable to review them in full; nothing was sent.',
          };
        }

        const payload: HeldAppCallPayload = {
          viewId,
          invocationId,
          appId: input.app.id,
          appName: input.app.name,
          appHost: input.app.host,
          grantGeneration: input.grantGeneration,
          toolName: input.tool.name,
          definitionHash: input.tool.definitionHash,
          canonicalArgs: input.canonicalArgs,
          argsHash: input.argsHash,
          summary: input.summary ?? null,
          appContext,
          expiresAt,
        };

        const deliveredId = await requestApproval({
          session: conversation.session,
          agentName: 'Assistant',
          action: HELD_APP_CALL_ACTION,
          payload: payload as unknown as Record<string, unknown>,
          title: card.title,
          question: card.question,
          details: { facts: { app: input.app.name, tool: input.tool.name } },
          approverUserId,
          expiresAt,
        });

        if (!deliveredId) {
          return {
            status: 'unsent',
            reason: 'delivery_failed',
            text: 'Could not send the approval request to the principal; nothing was sent.',
          };
        }
        posted = true;
        await dependencies.store.bindHeldApproval(invocationId, deliveredId, new Date(now()).toISOString());
        return { status: 'held', text: HELD_CALL_ANSWER, approvalId: deliveredId };
      } finally {
        if (!posted) {
          await dependencies.store.releaseUnpostedHeldInvocation(invocationId).catch(() => undefined);
        }
      }
    });
  };
}

let activeDependencies: HeldCallsDependencies = { relay: getAppRelay };
let resolvedListenerRegistered = false;

async function handleApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  if (event.approval.action !== HELD_APP_CALL_ACTION) return;
  const payload = parseHeldCallPayload(event.approval.payload);
  if (!payload) return;
  const now = activeDependencies.now ?? Date.now;
  const store = (await activeDependencies.store?.()) ?? lastHoldStore;
  if (store) {
    const resolvedState =
      event.outcome === 'approve'
        ? 'settled'
        : event.outcome === 'reject'
          ? 'declined'
          : event.outcome === 'expired'
            ? 'expired'
            : 'withdrawn';
    try {
      await store.markHeldInvocationResolved(
        payload.invocationId,
        event.approval.approval_id,
        resolvedState,
        new Date(now()).toISOString(),
      );
      /* eslint-disable-next-line no-catch-all/no-catch-all -- log failed invocation state update without blocking expiry note delivery */
    } catch (error) {
      log.warn('Could not record resolved held app call state', {
        invocationId: payload.invocationId,
        approvalId: event.approval.approval_id,
        outcome: event.outcome,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  if (event.outcome !== 'expired') return;
  const writeNote = activeDependencies.writeNote ?? writeNoteForMain;
  await writeNote({
    id: `app-call-expired:${event.approval.approval_id}`,
    timestamp: new Date(now()).toISOString(),
    wake: false,
    text: `The approval request for ${payload.appName}.${payload.toolName} expired after 24 hours without an answer. Nothing was sent.`,
  });
}

export function registerHeldAppCallHandlers(dependencies: HeldCallsDependencies = { relay: getAppRelay }): void {
  activeDependencies = dependencies;

  registerApprovalHandler(
    HELD_APP_CALL_ACTION,
    async ({ approval, userId, notify }) => {
      const payload = parseHeldCallPayload(approval.payload);
      const writeNote = activeDependencies.writeNote ?? writeNoteForMain;
      const now = activeDependencies.now ?? Date.now;
      if (!payload) {
        log.warn('Approved held app call had an unreadable payload', { approvalId: approval.approval_id });
        return;
      }
      let outcome: RelayCallOutcome;
      if (!userId || approval.approver_user_id !== userId || !(await isVerifiedPrincipalUser(userId))) {
        outcome = {
          status: 'unsent',
          reason: 'principal_changed',
          text: 'The principal changed before this call ran, so nothing was sent.',
        };
      } else {
        let parsedArgs: Record<string, unknown> | undefined;
        try {
          const parsed: unknown = JSON.parse(payload.canonicalArgs);
          if (isRecord(parsed) && canonicalArgsHash(parsed).hash === payload.argsHash) {
            parsedArgs = parsed;
          }
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
        }
        if (!parsedArgs) {
          outcome = {
            status: 'unsent',
            reason: 'invalid_payload',
            text: 'The approved call arguments could not be verified, so nothing was sent.',
          };
        } else {
          const relay = await activeDependencies.relay();
          if (!relay) {
            outcome = {
              status: 'unsent',
              reason: 'relay_unavailable',
              text: 'The app relay is not running right now, so nothing was sent.',
            };
          } else {
            outcome = await relay.executeApprovedCall({
              approvalId: approval.approval_id,
              invocationId: payload.invocationId,
              appId: payload.appId,
              grantGeneration: payload.grantGeneration,
              toolName: payload.toolName,
              definitionHash: payload.definitionHash,
              args: parsedArgs,
            });
          }
        }
      }
      const noteText = formatOutcomeNote(payload, outcome);
      const written = await writeNote({
        id: `app-call-outcome:${approval.approval_id}`,
        timestamp: new Date(now()).toISOString(),
        wake: true,
        text: noteText,
      });
      if (written === 'no-principal') await notify(noteText);
    },
    {
      restartSafe: true,
      rejectionNote: (approval, reason) => {
        const payload = parseHeldCallPayload(approval.payload);
        const callName = payload ? `${payload.appName}.${payload.toolName}` : 'the app tool call';
        const suffix = reason ? `, saying ${JSON.stringify(reason)}` : '';
        return `The principal declined ${callName}${suffix}. Nothing was sent.`;
      },
    },
  );

  if (!resolvedListenerRegistered) {
    resolvedListenerRegistered = true;
    registerApprovalResolvedHandler(handleApprovalResolved);
  }
}

export async function withdrawHeldAppCalls(
  appId: string,
  resolution = 'Withdrawn — app changed or disconnected',
): Promise<number> {
  if (!(await getDb().hasTable('pending_approvals'))) return 0;
  const rows = await getPendingApprovalsByAction(HELD_APP_CALL_ACTION);
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    const payload = parseHeldCallPayload(row.payload);
    if (payload?.appId !== appId) continue;
    if (await withdrawApproval(row.approval_id, resolution)) count += 1;
  }
  return count;
}

export async function withdrawToolAskApprovals(
  appId: string,
  resolution = 'Withdrawn — app changed or disconnected',
): Promise<number> {
  if (!(await getDb().hasTable('pending_approvals'))) return 0;
  const rows = await getPendingApprovalsByAction(APP_TOOL_ASK_ACTION_NAME);
  let count = 0;
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.payload);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      continue;
    }
    if (!isRecord(parsed) || parsed.id !== appId) continue;
    if (await withdrawApproval(row.approval_id, resolution)) count += 1;
  }
  return count;
}

export interface PendingHeldCallItem {
  readonly viewId: string;
  readonly approval: PendingApproval;
  readonly payload: HeldAppCallPayload;
}

export type HeldCallDecisionResult =
  | { readonly status: 'approved'; readonly payload: HeldAppCallPayload }
  | { readonly status: 'declined'; readonly payload: HeldAppCallPayload }
  | { readonly status: 'expired'; readonly payload: HeldAppCallPayload }
  | {
      readonly status: 'already_resolved';
      readonly resolvedAs: 'approved' | 'declined' | 'withdrawn' | 'unknown';
      readonly payload: HeldAppCallPayload;
    }
  | { readonly status: 'not_found' }
  | { readonly status: 'unauthorized' };

function isExpiredHeldCall(approval: PendingApproval, payload: HeldAppCallPayload, nowMs: number): boolean {
  const payloadExpiry = Date.parse(payload.expiresAt);
  if (Number.isFinite(payloadExpiry) && payloadExpiry <= nowMs) return true;
  if (approval.expires_at) {
    const rowExpiry = Date.parse(approval.expires_at);
    if (Number.isFinite(rowExpiry) && rowExpiry <= nowMs) return true;
  }
  return false;
}

export async function listPendingHeldCallApprovals(
  now: () => number = activeDependencies.now ?? Date.now,
): Promise<readonly PendingHeldCallItem[]> {
  const db = getDb();
  if (!(await db.hasTable('pending_approvals')) || !(await db.hasTable('gws_ea_principal_users'))) return [];
  const rows = await getPendingApprovalsByAction(HELD_APP_CALL_ACTION);
  const nowMs = now();
  const items: PendingHeldCallItem[] = [];
  for (const approval of rows) {
    if (approval.status !== 'pending') continue;
    if (!approval.approver_user_id || !(await isVerifiedPrincipalUser(approval.approver_user_id))) continue;
    const payload = parseHeldCallPayload(approval.payload);
    if (!payload) continue;
    if (isExpiredHeldCall(approval, payload, nowMs)) continue;
    items.push({ viewId: payload.viewId ?? approval.approval_id, approval, payload });
  }
  items.sort((left, right) => right.approval.created_at.localeCompare(left.approval.created_at));
  return items;
}

export async function getPendingHeldCallApproval(
  viewOrApprovalId: string,
  now: () => number = activeDependencies.now ?? Date.now,
): Promise<
  { readonly approval: PendingApproval; readonly payload: HeldAppCallPayload; readonly expired: boolean } | undefined
> {
  if (!(await getDb().hasTable('pending_approvals'))) return undefined;
  const rows = await getPendingApprovalsByAction(HELD_APP_CALL_ACTION);
  const nowMs = now();
  for (const approval of rows) {
    if (approval.status !== 'pending') continue;
    const payload = parseHeldCallPayload(approval.payload);
    if (!payload) continue;
    if (payload.viewId === viewOrApprovalId || approval.approval_id === viewOrApprovalId) {
      return { approval, payload, expired: isExpiredHeldCall(approval, payload, nowMs) };
    }
  }
  return undefined;
}

/** True only when `viewId` names a live, unexpired held-call approval routed to a verified principal. */
export async function isLiveHeldCallView(
  viewId: string,
  now: () => number = activeDependencies.now ?? Date.now,
): Promise<boolean> {
  const db = getDb();
  if (!(await db.hasTable('pending_approvals')) || !(await db.hasTable('gws_ea_principal_users'))) return false;
  const held = await getPendingHeldCallApproval(viewId, now);
  if (!held || held.expired) return false;
  if ((held.payload.viewId ?? held.approval.approval_id) !== viewId) return false;
  return Boolean(held.approval.approver_user_id && (await isVerifiedPrincipalUser(held.approval.approver_user_id)));
}

async function resolveCardThreadId(approval: PendingApproval): Promise<string | null> {
  if (!approval.session_id || !approval.channel_type || !approval.platform_id) return null;
  const session = await getSession(approval.session_id);
  if (!session?.messaging_group_id) return null;
  const group = await getMessagingGroup(session.messaging_group_id);
  if (
    !group ||
    group.channel_type !== approval.channel_type ||
    group.platform_id !== approval.platform_id ||
    (approval.instance !== null && group.instance !== approval.instance)
  ) {
    return null;
  }
  return approvalCardThread(session, group);
}

/**
 * Resolves a pending held app call directly from the principal's Connections page using the same atomic approval
 * response pipeline as chat 👍/👎, editing the chat card in place and recording its outcome.
 */
export async function resolveHeldCallFromWeb(
  viewOrApprovalId: string,
  decision: 'approve' | 'reject',
): Promise<HeldCallDecisionResult> {
  const now = activeDependencies.now ?? Date.now;
  const found = await getPendingHeldCallApproval(viewOrApprovalId, now);
  if (!found) return { status: 'not_found' };
  const { approval, payload, expired } = found;
  const approverUserId = approval.approver_user_id;
  if (!approverUserId || !(await isVerifiedPrincipalUser(approverUserId))) {
    return { status: 'unauthorized' };
  }
  if (!approval.session_id || !(await getSession(approval.session_id))) {
    return { status: 'not_found' };
  }
  if ((await expireApproval(approval.approval_id, new Date(now()).toISOString())) || expired) {
    return { status: 'expired', payload };
  }
  const threadId = await resolveCardThreadId(approval);
  const canEditCard = Boolean(approval.platform_message_id && approval.channel_type && approval.platform_id);
  const handled = await handleApprovalsResponse({
    questionId: approval.approval_id,
    value: decision === 'approve' ? APPROVE_OPTION : REJECT_OPTION,
    userId: approverUserId,
    channelType: approval.channel_type ?? 'web',
    platformId: approval.platform_id ?? '',
    threadId,
    ...(approval.platform_message_id ? { messageId: approval.platform_message_id } : {}),
    ...(approval.instance ? { instance: approval.instance } : {}),
    deferResolution: canEditCard,
  });

  const store = (await activeDependencies.store?.()) ?? lastHoldStore;
  const [currentRow, relayCall, invocation] = await Promise.all([
    getPendingApproval(approval.approval_id).catch(() => undefined),
    store ? store.getRelayCall(approval.approval_id).catch(() => undefined) : Promise.resolve(undefined),
    store ? store.getRelayInvocation(payload.invocationId).catch(() => undefined) : Promise.resolve(undefined),
  ]);

  if (currentRow?.status === 'expired' || invocation?.state === 'expired') {
    return { status: 'expired', payload };
  }
  if (invocation?.state === 'withdrawn') {
    return { status: 'already_resolved', resolvedAs: 'withdrawn', payload };
  }

  if (decision === 'approve') {
    if (
      currentRow?.status === 'rejected' ||
      currentRow?.status === 'awaiting_reason' ||
      invocation?.state === 'declined'
    ) {
      return { status: 'already_resolved', resolvedAs: 'declined', payload };
    }
    if (!handled && relayCall === undefined && invocation?.state !== 'settled') {
      return { status: 'already_resolved', resolvedAs: 'unknown', payload };
    }
    return { status: 'approved', payload };
  }

  if (currentRow?.status === 'approved' || relayCall !== undefined || invocation?.state === 'settled') {
    return { status: 'already_resolved', resolvedAs: 'approved', payload };
  }
  if (!handled && invocation?.state !== 'declined') {
    return { status: 'already_resolved', resolvedAs: 'unknown', payload };
  }
  return { status: 'declined', payload };
}
