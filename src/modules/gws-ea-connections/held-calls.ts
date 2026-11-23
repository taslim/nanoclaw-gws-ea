/**
 * Held ask-first app tool calls: single 👍/👎 cards, exact once-only execution on 👍,
 * plain notes for every terminal outcome, 24-hour expiry notes, and withdrawal on
 * remove/disconnect/reconnect.
 */
import { randomBytes } from 'node:crypto';

import { MAX_CARD_QUESTION_LENGTH } from '../../channels/ask-question.js';
import { TIMEZONE } from '../../config.js';
import { getDb } from '../../db/connection.js';
import { getPendingApproval, getPendingApprovalsByAction } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { formatLocalTime, resolveTimezone } from '../../timezone.js';
import type { PendingApproval } from '../../types.js';
import { withdrawApproval } from '../approvals/lifecycle.js';
import {
  registerApprovalHandler,
  registerApprovalResolvedHandler,
  requestApproval,
  type ApprovalResolvedEvent,
} from '../approvals/primitive.js';
import { quoted } from '../approvals/request-text.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { getGwsEaProfile, principalApproverUserId } from '../gws-ea-profile/db.js';
import {
  resolveMainConversation,
  writeNoteForMain,
  type NoteForMain,
  type NoteForMainResult,
} from '../gws-ea-profile/main-note.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';
import {
  getAppRelay,
  type AppRelay,
  type HoldCallHandler,
  type HoldCallInput,
  type RelayCallOutcome,
} from './relay.js';
import type { ConnectionsStore, RecentRelayResult } from './store.js';

export const HELD_APP_CALL_ACTION = 'app_tool_call';
export const HELD_CALL_ANSWER = "I've asked the principal; the result will arrive as a note.";
export const HELD_CALL_TTL_MS = 24 * 60 * 60_000;

const CARD_SAFE_BUDGET = MAX_CARD_QUESTION_LENGTH - 120;
const APP_CONTEXT_STORAGE_MAX = 64 * 1024;
const RESULT_NOTE_MAX = 32_000;
const SUMMARY_CARD_MAX = 280;

/** Zero-width, bidi override/isolate, soft-hyphen and non-whitespace control characters. */
function isInvisibleCodePoint(cp: number): boolean {
  if (cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f) return true;
  if (cp === 0xad || cp === 0x034f || cp === 0x061c || cp === 0x180e || cp === 0xfeff) return true;
  if ((cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069)) return true;
  return false;
}

export interface HeldAppCallContext {
  readonly toolName: string;
  readonly text: string;
}

export interface HeldAppCallPayload {
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
  readonly store?: ConnectionsStore;
  readonly relay: () => AppRelay | undefined;
  readonly webHostname?: () => Promise<string | undefined>;
  readonly writeNote?: (note: NoteForMain) => Promise<NoteForMainResult>;
  readonly now?: () => number;
}

export function escapeInvisibleChars(text: string): { readonly rendered: string; readonly hasInvisible: boolean } {
  let hasInvisible = false;
  let rendered = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(cp)) {
      hasInvisible = true;
      rendered += `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
    } else {
      rendered += ch;
    }
  }
  return { rendered, hasInvisible };
}

export function renderCompactArgs(args: Record<string, unknown>): {
  readonly text: string;
  readonly hasInvisible: boolean;
} {
  const entries = Object.entries(args);
  if (entries.length === 0) return { text: '(none)', hasInvisible: false };
  let hasInvisible = false;
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const rawValue = typeof value === 'string' ? value : JSON.stringify(value);
    const keyOut = escapeInvisibleChars(key);
    const valOut = escapeInvisibleChars(rawValue);
    if (keyOut.hasInvisible || valOut.hasInvisible) hasInvisible = true;
    lines.push(`${keyOut.rendered}: ${valOut.rendered}`);
  }
  return { text: lines.join('\n'), hasInvisible };
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

export function findMatchingAppContext(
  args: Record<string, unknown>,
  recent: readonly RecentRelayResult[],
): HeldAppCallContext | null {
  const needles = new Set<string>();
  collectArgStrings(args, needles);
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

function clampExcerpt(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return `${chars
    .slice(0, Math.max(1, maxChars - 1))
    .join('')
    .trimEnd()}…`;
}

function defaultWebHostname(): Promise<string | undefined> {
  return readWebPolicy().then((policy) => (policy.status === 'enabled' ? policy.config.hostname : undefined));
}

async function resolvePrincipalTimezone(): Promise<string> {
  try {
    const profile = await getGwsEaProfile();
    return resolveTimezone(profile.principal_timezone ?? TIMEZONE);
    /* eslint-disable-next-line no-catch-all/no-catch-all -- fall back to install timezone when profile table is absent */
  } catch {
    return TIMEZONE;
  }
}

export function formatHeldCallCard(input: {
  readonly approvalId: string;
  readonly appName: string;
  readonly appHost: string;
  readonly toolName: string;
  readonly args: Record<string, unknown>;
  readonly summary: string | undefined;
  readonly appContext: HeldAppCallContext | null;
  readonly expiresAt: string;
  readonly timezone: string;
  readonly webHostname: string | undefined;
}): { readonly title: string; readonly question: string } {
  const title = `Allow ${input.appName} to run ${input.toolName}?`.slice(0, 120);
  const { text: renderedArgs, hasInvisible } = renderCompactArgs(input.args);
  const summaryLine =
    input.summary && input.summary.trim()
      ? `Assistant's description: ${quoted(input.summary.trim(), SUMMARY_CARD_MAX)}`
      : "Assistant's description: no summary given";
  const invisibleLine = hasInvisible
    ? 'Warning: arguments contain invisible or hidden characters (shown as [U+...]).'
    : undefined;
  const expiryLine = `Expires: ${formatLocalTime(input.expiresAt, input.timezone)}`;

  const headerLines = [
    `App: ${input.appName} (${input.appHost})`,
    `Tool: ${input.toolName}`,
    summaryLine,
    ...(invisibleLine ? [invisibleLine] : []),
  ];

  const fullParts = [
    ...headerLines,
    `Arguments:\n${renderedArgs}`,
    ...(input.appContext ? [`From ${input.appName} (${input.appContext.toolName}):\n${input.appContext.text}`] : []),
    expiryLine,
  ];
  const fullQuestion = fullParts.join('\n');
  if (title.length + fullQuestion.length <= CARD_SAFE_BUDGET) {
    return { title, question: fullQuestion };
  }

  // Details exceed the card budget: preserve host-rendered arg excerpt and an excerpt of the app's own words,
  // explicitly state details are too long, and link to the principal-only held-call view.
  const detailsUrl = input.webHostname
    ? `https://${input.webHostname}/connections/held/${encodeURIComponent(input.approvalId)}`
    : `/connections/held/${encodeURIComponent(input.approvalId)}`;
  const linkLine = `Full details are too long for this message — review them in full: ${detailsUrl}`;

  const fixedLen =
    title.length +
    headerLines.join('\n').length +
    expiryLine.length +
    linkLine.length +
    'Arguments:\n'.length +
    (input.appContext ? `From ${input.appName} (${input.appContext.toolName}):\n`.length : 0) +
    64;
  const remaining = Math.max(160, CARD_SAFE_BUDGET - fixedLen);
  const argsBudget = input.appContext ? Math.max(100, Math.floor(remaining * 0.6)) : remaining;
  const contextBudget = input.appContext ? Math.max(80, remaining - argsBudget) : 0;

  const trimmedParts = [
    ...headerLines,
    `Arguments:\n${clampExcerpt(renderedArgs, argsBudget)}`,
    ...(input.appContext
      ? [`From ${input.appName} (${input.appContext.toolName}):\n${clampExcerpt(input.appContext.text, contextBudget)}`]
      : []),
    linkLine,
    expiryLine,
  ];
  return { title, question: trimmedParts.join('\n') };
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

async function findPendingByInvocation(invocationId: string): Promise<PendingApproval | undefined> {
  const rows = await getPendingApprovalsByAction(HELD_APP_CALL_ACTION);
  for (const row of rows) {
    if (row.status !== 'pending') continue;
    const payload = parseHeldCallPayload(row.payload);
    if (payload?.invocationId === invocationId) return row;
  }
  return undefined;
}

export function createHoldCallHandler(dependencies: {
  readonly store: ConnectionsStore;
  readonly relay: () => AppRelay | undefined;
  readonly webHostname?: () => Promise<string | undefined>;
  readonly now?: () => number;
}): HoldCallHandler {
  const readHostname = dependencies.webHostname ?? defaultWebHostname;
  const now = dependencies.now ?? Date.now;

  return async (input: HoldCallInput): Promise<RelayCallOutcome> => {
    const invocationId = `${input.session.id}:${input.requestId}`;
    const existing = await findPendingByInvocation(invocationId);
    if (existing) {
      return { status: 'held', text: HELD_CALL_ANSWER, approvalId: existing.approval_id };
    }

    const conversation = await resolveMainConversation();
    if (typeof conversation === 'string') {
      return {
        status: 'unsent',
        reason: conversation,
        text: 'Could not reach the principal to ask for approval; nothing was sent.',
      };
    }
    const approverUserId = await principalApproverUserId();
    if (!approverUserId) {
      return {
        status: 'unsent',
        reason: 'no_principal',
        text: 'No verified principal is configured to approve app actions; nothing was sent.',
      };
    }

    const recent = await dependencies.store.recentCompletedResults(input.app.id, input.grantGeneration, 20);
    const appContext = findMatchingAppContext(input.args, recent);
    const expiresAt = new Date(now() + HELD_CALL_TTL_MS).toISOString();
    const timezone = await resolvePrincipalTimezone();
    const webHostname = await readHostname().catch(() => undefined);
    const approvalId = `appr-${now()}-${randomBytes(4).toString('hex')}`;

    const card = formatHeldCallCard({
      approvalId,
      appName: input.app.name,
      appHost: input.app.host,
      toolName: input.tool.name,
      args: input.args,
      summary: input.summary,
      appContext,
      expiresAt,
      timezone,
      webHostname,
    });

    const payload: HeldAppCallPayload = {
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
      approvalId,
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
    return { status: 'held', text: HELD_CALL_ANSWER, approvalId: deliveredId };
  };
}

let activeDependencies: HeldCallsDependencies = { relay: getAppRelay };
let resolvedListenerRegistered = false;

async function handleApprovalResolved(event: ApprovalResolvedEvent): Promise<void> {
  if (event.approval.action !== HELD_APP_CALL_ACTION || event.outcome !== 'expired') return;
  const payload = parseHeldCallPayload(event.approval.payload);
  if (!payload) return;
  const writeNote = activeDependencies.writeNote ?? writeNoteForMain;
  const now = activeDependencies.now ?? Date.now;
  await writeNote({
    id: `app-call-expired:${event.approval.approval_id}`,
    timestamp: new Date(now()).toISOString(),
    wake: false,
    text: `The approval request for ${payload.appName}.${payload.toolName} expired after 24 hours without an answer. Nothing was sent.`,
  });
}

/** Registers the restart-safe approval handler, rejection wording, and expiry observer for held app calls. */
export function registerHeldAppCallHandlers(dependencies: HeldCallsDependencies = { relay: getAppRelay }): void {
  activeDependencies = dependencies;

  registerApprovalHandler(
    HELD_APP_CALL_ACTION,
    async ({ approval }) => {
      const payload = parseHeldCallPayload(approval.payload);
      const writeNote = activeDependencies.writeNote ?? writeNoteForMain;
      const now = activeDependencies.now ?? Date.now;
      if (!payload) {
        log.warn('Approved held app call had an unreadable payload', { approvalId: approval.approval_id });
        return;
      }
      const relay = activeDependencies.relay();
      let outcome: RelayCallOutcome;
      if (!relay) {
        outcome = {
          status: 'unsent',
          reason: 'relay_unavailable',
          text: 'The app relay is not running right now, so nothing was sent.',
        };
      } else {
        let args: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(payload.canonicalArgs);
          if (isRecord(parsed)) args = parsed;
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          args = {};
        }
        outcome = await relay.executeApprovedCall({
          approvalId: approval.approval_id,
          appId: payload.appId,
          grantGeneration: payload.grantGeneration,
          toolName: payload.toolName,
          definitionHash: payload.definitionHash,
          args,
        });
      }
      await writeNote({
        id: `app-call-outcome:${approval.approval_id}`,
        timestamp: new Date(now()).toISOString(),
        wake: true,
        text: formatOutcomeNote(payload, outcome),
      });
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

/** Withdraws every pending held-call approval card belonging to `appId`. */
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

/** Reads a pending held-call approval and its decoded payload for the principal-only details view. */
export async function getHeldCallApproval(
  approvalId: string,
): Promise<{ readonly approval: PendingApproval; readonly payload: HeldAppCallPayload } | undefined> {
  if (!(await getDb().hasTable('pending_approvals'))) return undefined;
  const approval = await getPendingApproval(approvalId);
  if (!approval || approval.action !== HELD_APP_CALL_ACTION || approval.status !== 'pending') return undefined;
  const payload = parseHeldCallPayload(approval.payload);
  if (!payload) return undefined;
  return { approval, payload };
}
