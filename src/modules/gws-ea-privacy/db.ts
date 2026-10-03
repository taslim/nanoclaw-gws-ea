import { createHash, randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import {
  canonicalText,
  HISTORY_DIGIT_LENGTH,
  HISTORY_TEXT_LENGTH,
  PRIVATE_VALUE_KINDS,
  uncheckableReason,
  type PrivateValueKind,
  type TextStream,
} from './match.js';

export interface PrivateValue {
  readonly id: string;
  /** What the principal calls it, such as "Home". Never shown to anyone else. */
  readonly label: string;
  readonly kind: PrivateValueKind;
  /** As the principal wrote it. */
  readonly value: string;
  readonly created_at: string;
}

/** Unvalidated caller input: the store checks each field. */
export interface AddPrivateValueInput {
  readonly label: string;
  readonly kind: string;
  readonly value: string;
}

const LABEL_MAX_LENGTH = 80;

function parseKind(value: string): PrivateValueKind {
  const kind = PRIVATE_VALUE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`Kind ${JSON.stringify(value)} is invalid: use ${PRIVATE_VALUE_KINDS.join(', ')}`);
  return kind;
}

function parseLabel(value: string): string {
  const label = value.trim();
  if (!label || label.length > LABEL_MAX_LENGTH || hasControlCharacters(label)) {
    throw new Error(`Label must be one line of 1 to ${LABEL_MAX_LENGTH} characters`);
  }
  return label;
}

function parseValue(kind: PrivateValueKind, value: string): string {
  const text = value.trim();
  if (!text || hasControlCharacters(text)) throw new Error('A private value must be one line of text');
  const problem = uncheckableReason(kind, text);
  if (problem !== undefined) throw new Error(problem);
  return text;
}

/** Two spellings of one value share this key, so the store holds each value once. */
function valueKey(kind: PrivateValueKind, value: string): string {
  const canonical = canonicalText(value);
  return `${kind}:${kind === 'phone' ? canonical.replace(/[^0-9]/gu, '') : canonical}`;
}

function newValueId(): string {
  return `pv-${randomBytes(6).toString('hex')}`;
}

export async function listPrivateValues(): Promise<PrivateValue[]> {
  return getDb().all<PrivateValue>(
    'SELECT id, label, kind, value, created_at FROM gws_ea_private_values ORDER BY created_at, id',
  );
}

export async function getPrivateValue(id: string): Promise<PrivateValue | undefined> {
  return getDb().get<PrivateValue>(
    'SELECT id, label, kind, value, created_at FROM gws_ea_private_values WHERE id = ?',
    id,
  );
}

/**
 * Hold a private value. Refuses one the check could not match reliably.
 * Adding a value already held, in any spelling, changes nothing and returns
 * the held one.
 */
export async function addPrivateValue(
  input: AddPrivateValueInput,
): Promise<PrivateValue & { readonly added: boolean }> {
  const kind = parseKind(input.kind);
  const label = parseLabel(input.label);
  const value = parseValue(kind, input.value);
  const key = valueKey(kind, value);
  const db = getDb();
  return db.transaction(async () => {
    const held = (await listPrivateValues()).find((existing) => valueKey(existing.kind, existing.value) === key);
    if (held) return { ...held, added: false };
    const record: PrivateValue = { id: newValueId(), label, kind, value, created_at: new Date().toISOString() };
    await db.run(
      'INSERT INTO gws_ea_private_values (id, label, kind, value, created_at) VALUES (?, ?, ?, ?, ?)',
      record.id,
      record.label,
      record.kind,
      record.value,
      record.created_at,
    );
    return { ...record, added: true };
  });
}

/** Forget a private value, switching its check off. Callers decide who may; see `index.ts`. */
export async function removePrivateValue(id: string): Promise<PrivateValue> {
  const db = getDb();
  return db.transaction(async () => {
    const existing = await getPrivateValue(id);
    if (!existing) throw new Error(`No private value ${JSON.stringify(id)} exists`);
    await db.run('DELETE FROM gws_ea_private_values WHERE id = ?', id);
    return existing;
  });
}

// ---------------------------------------------------------------------------
// Thread records: what one outbound thread has sent, kept only for the check.
// ---------------------------------------------------------------------------

/** One outbound conversation: a channel address and, within it, a thread. */
export interface ThreadKey {
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
}

/**
 * One earlier send: a hash of its canonical text, so a retried send is never
 * read after itself, and the tail of that text and of its digits.
 */
interface RecentSend {
  readonly h: string;
  readonly t: string;
  readonly d: string;
}

interface ThreadRow {
  readonly recent: string;
  readonly refusals: number;
  readonly stopped_at: string | null;
}

export type ThreadVerdict =
  | { readonly outcome: 'allowed' }
  | {
      readonly outcome: 'refused';
      readonly kind: PrivateValueKind;
      readonly refusals: number;
      /** This refusal reached the cap and stopped the thread. */
      readonly stopped: boolean;
    }
  | { readonly outcome: 'stopped' };

/** A bound on the record's row count; the text and digit tails bound its size. */
const MAX_RECENT_SENDS = 16;

function isRecentSend(value: unknown): value is RecentSend {
  if (typeof value !== 'object' || value === null) return false;
  const send = value as Record<string, unknown>;
  return typeof send.h === 'string' && typeof send.t === 'string' && typeof send.d === 'string';
}

/** A record that does not parse fails the send closed rather than dropping what it held. */
function parseRecent(stored: string): RecentSend[] {
  const parsed: unknown = JSON.parse(stored);
  if (!Array.isArray(parsed) || !parsed.every(isRecentSend)) {
    throw new Error('The privacy record for an outbound thread is unreadable');
  }
  return parsed;
}

function sendHash(stream: TextStream): string {
  return createHash('sha256').update(stream.text).digest('hex').slice(0, 16);
}

function historyOf(sends: readonly RecentSend[]): TextStream {
  return {
    text: sends
      .map((send) => send.t)
      .join('')
      .slice(-HISTORY_TEXT_LENGTH),
    digits: sends
      .map((send) => send.d)
      .join('')
      .slice(-HISTORY_DIGIT_LENGTH),
  };
}

/** The newest sends that together still fill the history window. */
function trimRecent(sends: readonly RecentSend[]): RecentSend[] {
  const kept: RecentSend[] = [];
  let text = 0;
  let digits = 0;
  for (let index = sends.length - 1; index >= 0 && kept.length < MAX_RECENT_SENDS; index--) {
    if (text >= HISTORY_TEXT_LENGTH && digits >= HISTORY_DIGIT_LENGTH) break;
    const send = sends[index];
    kept.unshift(send);
    text += send.t.length;
    digits += send.d.length;
  }
  return kept;
}

/** Forget what one outbound thread has sent, once its conversation is over. */
export async function deleteThreadRecord(key: ThreadKey): Promise<void> {
  await getDb().run(
    'DELETE FROM gws_ea_privacy_threads WHERE channel_type = ? AND platform_id = ? AND thread_id = ?',
    key.channelType,
    key.platformId,
    key.threadId ?? '',
  );
}

/**
 * Judge one send to anyone but the principal against its thread, and record
 * the outcome in the same transaction.
 *
 * `find` reads the send after the thread's earlier text and names the kind of
 * any private value it gives away. An allowed send joins the thread's
 * history; a refused one does not (it was never sent) but counts toward
 * `maxRefusals`, at which the thread stops. Every send to a stopped thread is
 * refused.
 */
export async function judgeThreadSend(
  key: ThreadKey,
  current: TextStream,
  find: (history: TextStream) => PrivateValueKind | undefined,
  maxRefusals: number,
): Promise<ThreadVerdict> {
  const db = getDb();
  const threadId = key.threadId ?? '';
  return db.transaction(async (): Promise<ThreadVerdict> => {
    const row = await db.get<ThreadRow>(
      `SELECT recent, refusals, stopped_at FROM gws_ea_privacy_threads
        WHERE channel_type = ? AND platform_id = ? AND thread_id = ?`,
      key.channelType,
      key.platformId,
      threadId,
    );
    if (row?.stopped_at) return { outcome: 'stopped' };

    const recent = row ? parseRecent(row.recent) : [];
    const hash = sendHash(current);
    const earlier = recent.filter((send) => send.h !== hash);
    const kind = find(historyOf(earlier));
    const now = new Date().toISOString();

    let verdict: ThreadVerdict;
    let kept = recent;
    let refusals = row?.refusals ?? 0;
    let stoppedAt: string | null = null;
    if (kind !== undefined) {
      refusals += 1;
      const stopped = refusals >= maxRefusals;
      if (stopped) stoppedAt = now;
      verdict = { outcome: 'refused', kind, refusals, stopped };
    } else {
      // A retry of a send already recorded keeps its place.
      if (current.text !== '' && earlier.length === recent.length) {
        kept = trimRecent([
          ...recent,
          { h: hash, t: current.text.slice(-HISTORY_TEXT_LENGTH), d: current.digits.slice(-HISTORY_DIGIT_LENGTH) },
        ]);
      }
      verdict = { outcome: 'allowed' };
    }

    await db.run(
      `INSERT INTO gws_ea_privacy_threads
         (channel_type, platform_id, thread_id, recent, refusals, stopped_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (channel_type, platform_id, thread_id) DO UPDATE
          SET recent = excluded.recent,
              refusals = excluded.refusals,
              stopped_at = excluded.stopped_at,
              updated_at = excluded.updated_at`,
      key.channelType,
      key.platformId,
      threadId,
      JSON.stringify(kept),
      refusals,
      stoppedAt,
      now,
    );
    return verdict;
  });
}
