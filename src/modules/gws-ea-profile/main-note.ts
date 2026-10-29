/**
 * Notes the host writes for `main`, into its shared session, routed to the
 * principal's direct message so main's answer reaches the principal.
 *
 * A note names the pieces of work it is about. Each open matter they sit in
 * comes with it, rendered live once however many of its pieces the note
 * names, and stamped with when its links were read, and so does each matter
 * it names by id. A new piece in no open matter brings instead the open
 * matters it may belong to. Both are best effort: what cannot be read is left
 * out, and the note is written all the same.
 *
 * The note keeps the pieces and matters it names beside its words, for the
 * host alone: main reads only the words. A turn that fails reading the note
 * names them again (`noteNames`).
 *
 * Importing it loads no GWS-EA module entry point but gws-ea-google's, which
 * loads before every module that writes a note, so it never reorders the
 * registrations a module's `index.ts` makes.
 */
import { createHash } from 'node:crypto';

import type { OutboundFile } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import {
  candidatesFor,
  ownAddresses,
  renderCandidates,
  type CandidateReads,
  type NewPiece,
} from '../gws-ea-matters/candidates.js';
import {
  canonicalReference,
  getMatter,
  linkKey,
  listOpenMatterLinks,
  PIECE_KINDS,
  type PieceKind,
} from '../gws-ea-matters/db.js';
import { hostSources, type Lens } from '../gws-ea-matters/live.js';
import { principalLens, renderMatter } from '../gws-ea-matters/render.js';
import { getMainAgentGroupId, principalContact } from './db.js';

/** A piece of work a note is about, by the id its writer holds. */
export interface NotePiece {
  readonly kind: PieceKind;
  readonly reference: string;
  /**
   * Set when the note brings the piece new. In no open matter, the note
   * carries the open matters it may belong to, and only when Google names
   * who it came from.
   */
  readonly arrival?: Omit<NewPiece, 'kind' | 'reference'>;
}

export interface NoteForMain {
  /** The message id; one derived from what the note reports makes writing it again a no-op. */
  readonly id: string;
  readonly timestamp: string;
  readonly text: string;
  /** Whether main takes a turn now; otherwise the note waits for its next one. */
  readonly wake: boolean;
  /** Host-only receipt classification, assigned by the writer, never inferred from words. */
  readonly noteKind?: NoteKind;
  /** Files that come with it, saved in main's inbox beside it, each recorded there by its SHA-256. */
  readonly files?: readonly OutboundFile[];
  /** The pieces it is about, whose open matters come with it. */
  readonly pieces?: readonly NotePiece[];
  /** Matters it is about by id, each rendered with it as a piece's matter is. */
  readonly matters?: readonly string[];
}

export type NoteKind = 'host-receipt' | 'clock-retimed' | 'unplaced-thread';
const RECEIPT_KINDS: ReadonlySet<string> = new Set(['host-receipt', 'clock-retimed', 'unplaced-thread']);

export function noteCarriesNewFact(content: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return true;
    throw error;
  }
  return !isRecord(value) || typeof value.noteKind !== 'string' || !RECEIPT_KINDS.has(value.noteKind);
}

export interface NoteNames {
  readonly pieces: readonly NotePiece[];
  readonly matters: readonly string[];
}

export type NoMainConversation = 'no-main' | 'no-principal';

/** `already-written`: a note with this id is in main's session. */
export type NoteForMainResult = 'written' | 'already-written' | NoMainConversation;

/** main's one shared conversation, and the principal's direct message its answers go to. */
export interface MainConversation {
  readonly session: Session;
  readonly directMessage: MessagingGroup;
}

/**
 * main's one shared conversation with the principal; its session is created
 * the first time. Until the profile names main and the principal has a
 * direct message, which of the two is missing.
 */
export async function resolveMainConversation(): Promise<MainConversation | NoMainConversation> {
  const mainAgentGroupId = await getMainAgentGroupId();
  if (mainAgentGroupId === null) return 'no-main';
  const principal = await principalContact();
  if (principal === undefined) return 'no-principal';
  const { directMessage } = principal;
  const { session } = await resolveSession(mainAgentGroupId, directMessage.id, null, 'agent-shared');
  return { session, directMessage };
}

export function isDuplicateNote(error: unknown): boolean {
  return isUniqueViolation(error) && error instanceof Error && /messages_in\.id\b/iu.test(error.message);
}

/** A file as a note carries it; core saves its bytes into the session's inbox, and its SHA-256 stays beside them. */
interface NoteAttachment {
  readonly name: string;
  readonly size: number;
  readonly sha256: string;
  readonly data: string;
}

function attachmentsOf(files: readonly OutboundFile[] = []): { readonly attachments?: readonly NoteAttachment[] } {
  if (files.length === 0) return {};
  return {
    attachments: files.map((file) => ({
      name: file.filename,
      size: file.data.length,
      sha256: createHash('sha256').update(file.data).digest('hex'),
      data: file.data.toString('base64'),
    })),
  };
}

const PIECE_WORDS: Readonly<Record<PieceKind, string>> = {
  thread: 'Thread',
  event: 'Event',
  file: 'File',
  job: 'Browser job',
};

/** A note never waits on what it carries beside its text: a failure is logged and yields `fallback`. */
async function bestEffort<T>(what: string, work: () => Promise<T>, fallback: T): Promise<T> {
  /* eslint-disable no-catch-all/no-catch-all -- a note is written without what could not be read, never held back by it */
  try {
    return await work();
  } catch (error) {
    log.warn(`A note for main goes without ${what}`, {
      error: error instanceof Error ? error.message : String(error),
    });
    return fallback;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function once<T>(read: () => Promise<T>): () => Promise<T> {
  let result: Promise<T> | undefined;
  return () => (result ??= read());
}

async function matterView(id: string, lens: () => Promise<Lens>): Promise<string[]> {
  const matter = await getMatter(id);
  return matter === undefined ? [] : [await renderMatter(matter, hostSources(), await lens())];
}

/**
 * Calendar shows the organizer the invitation names, and an invitation sent
 * as a file in an email names whoever its sender chose.
 */
const NAMED_ORGANIZER =
  'The person and organization rest on the organizer the invitation names, which whoever sent it chose.';

async function suggestions(piece: NewPiece, reads: CandidateReads): Promise<string[]> {
  const candidates = await candidatesFor(piece, reads);
  if (candidates.length === 0) return [];
  const named =
    piece.kind === 'event' &&
    candidates.some(({ reasons }) => reasons.includes('same person') || reasons.includes('same organization'));
  return [
    `${PIECE_WORDS[piece.kind]} ${piece.reference} is in no open matter.\n${renderCandidates(candidates)}` +
      (named ? `\n${NAMED_ORGANIZER}` : ''),
  ];
}

/**
 * Matters in the order the note first names them, those its pieces sit in
 * before those it names by id, then the suggestions for new pieces.
 */
async function carried({ pieces, matters: named }: NoteNames): Promise<string[]> {
  if ((pieces.length === 0 && named.length === 0) || !(await getDb().hasTable('gws_ea_matter_links'))) return [];
  const links = await listOpenMatterLinks();
  const holders = new Map(links.map((link) => [linkKey(link.kind, link.reference), link.matter_id]));
  const matterIds = new Set<string>();
  const unplaced = new Map<string, NewPiece>();
  for (const { kind, reference: given, arrival } of pieces) {
    const reference = canonicalReference(kind, given);
    const key = linkKey(kind, reference);
    const matterId = holders.get(key);
    if (matterId !== undefined) matterIds.add(matterId);
    else if (arrival !== undefined && !unplaced.has(key)) unplaced.set(key, { kind, reference, ...arrival });
  }
  for (const id of named) matterIds.add(id);
  // Who a render may name, and what each suggestion reads, are read once for the whole note.
  const lens = once(principalLens);
  const reads: CandidateReads = { links, ownAddresses: once(ownAddresses) };
  const [matters, suggested] = await Promise.all([
    Promise.all([...matterIds].map((id) => bestEffort(`matter ${id}`, () => matterView(id, lens), []))),
    Promise.all(
      [...unplaced.values()].map((piece) =>
        bestEffort(`what ${piece.kind} ${piece.reference} may belong to`, () => suggestions(piece, reads), []),
      ),
    ),
  ]);
  return [...matters.flat(), ...suggested.flat()];
}

export function noteNames(content: string): NoteNames {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    if (error instanceof SyntaxError) return { pieces: [], matters: [] };
    throw error;
  }
  const recorded = isRecord(parsed) ? parsed : {};
  return {
    pieces: Array.isArray(recorded.pieces) ? recorded.pieces.flatMap(notePieceOf) : [],
    matters: Array.isArray(recorded.matters)
      ? recorded.matters.filter((id: unknown): id is string => typeof id === 'string')
      : [],
  };
}

function isStrings(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((entry: unknown) => typeof entry === 'string');
}

function notePieceOf(value: unknown): NotePiece[] {
  if (typeof value !== 'object' || value === null) return [];
  const { kind, reference, arrival } = value as Record<string, unknown>;
  const pieceKind = PIECE_KINDS.find((candidate) => candidate === kind);
  if (pieceKind === undefined || typeof reference !== 'string') return [];
  if (arrival === undefined) return [{ kind: pieceKind, reference }];
  if (typeof arrival !== 'object' || arrival === null) return [];
  const { from, answers } = arrival as Record<string, unknown>;
  if ((from !== undefined && typeof from !== 'string') || (answers !== undefined && !isStrings(answers))) return [];
  return [{ kind: pieceKind, reference, arrival: { from, ...(answers === undefined ? {} : { answers }) } }];
}

export async function writeNoteForMain(note: NoteForMain): Promise<NoteForMainResult> {
  const conversation = await resolveMainConversation();
  if (typeof conversation === 'string') return conversation;
  const { session, directMessage } = conversation;
  const names: NoteNames = { pieces: note.pieces ?? [], matters: note.matters ?? [] };
  const text = [note.text, ...(await bestEffort('its matters', () => carried(names), []))].join('\n\n');
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: note.id,
      kind: 'chat',
      timestamp: note.timestamp,
      platformId: directMessage.platform_id,
      channelType: directMessage.channel_type,
      threadId: null,
      content: JSON.stringify({
        text,
        sender: 'system',
        ...(note.noteKind === undefined ? {} : { noteKind: note.noteKind }),
        senderId: 'system',
        ...(names.pieces.length === 0 ? {} : { pieces: names.pieces }),
        ...(names.matters.length === 0 ? {} : { matters: names.matters }),
        ...attachmentsOf(note.files),
      }),
      trigger: note.wake,
    });
  } catch (error) {
    if (!isDuplicateNote(error)) throw error;
    return 'already-written';
  }
  if (note.wake) {
    const fresh = await getSession(session.id);
    if (fresh) await requestWake(fresh, 'inbound-message');
  }
  return 'written';
}
