/**
 * Notes the host writes for `main`, into its shared session, routed to the
 * principal's direct message so main's answer reaches the principal. The
 * inbox, the meetings, the bridge and the failure notices each write theirs
 * through here.
 *
 * A note names the pieces of work it is about (KTD11). Each open matter they
 * sit in comes with it, rendered live once however many of its pieces the
 * note names, and stamped with when its links were read. A new piece in no
 * open matter (an invitation, a share or a comment) brings instead the open
 * matters it may belong to (KTD10). Both are best effort: what cannot be
 * read is left out, and the note is written all the same.
 *
 * Importing it loads no module entry point but the shared Google helpers'
 * (gws-ea-google), which load before every module that writes a note, so it
 * never reorders the registrations a module's `index.ts` makes.
 */
import { createHash } from 'node:crypto';

import type { OutboundFile } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { log } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSession, writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, Session } from '../../types.js';
import { candidatesFor, renderCandidates, type NewPiece } from '../gws-ea-matters/candidates.js';
import { canonicalReference, getMatter, listOpenMatterLinks, type PieceKind } from '../gws-ea-matters/db.js';
import { renderMatter } from '../gws-ea-matters/render.js';
import { getMainAgentGroupId, principalContact } from './db.js';

/** A piece of work a note is about, by the id its writer holds (KTD11). */
export interface NotePiece {
  readonly kind: PieceKind;
  readonly reference: string;
  /**
   * Set when the note brings it new: an invitation, a share or a comment. In
   * no open matter, the note carries the open matters it may belong to
   * (KTD10), suggested only from whom Google verified it came from.
   */
  readonly arrival?: Omit<NewPiece, 'kind' | 'reference'>;
}

export interface NoteForMain {
  /** The message id; one derived from what the note reports makes writing it again a no-op. */
  readonly id: string;
  readonly timestamp: string;
  /** The one plain explanation main reads. */
  readonly text: string;
  /** Whether main takes a turn now; otherwise the note waits for its next one. */
  readonly wake: boolean;
  /** Files that come with it, saved in main's inbox beside it, each recorded there by its SHA-256. */
  readonly files?: readonly OutboundFile[];
  /** The pieces it is about, whose open matters come with it. */
  readonly pieces?: readonly NotePiece[];
}

/** Nobody to write to: no main yet, or no principal direct message. */
export type NoMainConversation = 'no-main' | 'no-principal';

/** `already-written`: a note with this id is in main's session. */
export type NoteForMainResult = 'written' | 'already-written' | NoMainConversation;

/** main's one shared conversation, and the principal's direct message its answers go to. */
export interface MainConversation {
  readonly session: Session;
  readonly directMessage: MessagingGroup;
}

/**
 * main's one shared conversation with the principal, where every note is
 * written and every look and the morning come back; its session is created
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

/** A write refused because a message with that id is already in the session. */
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

const PIECE_WORDS: Readonly<Record<PieceKind, string>> = { thread: 'Thread', event: 'Event', file: 'File' };

/** `work`'s answer, or `fallback` once why it failed is logged: a note never waits on what it carries beside its text. */
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

/** A matter rendered live, or nothing once it is gone. */
async function matterView(id: string): Promise<string[]> {
  const matter = await getMatter(id);
  return matter === undefined ? [] : [await renderMatter(matter)];
}

/** The open matters a new piece in none may belong to, with why; nothing when none is suggested. */
async function suggestions(piece: NewPiece): Promise<string[]> {
  const candidates = await candidatesFor(piece);
  return candidates.length === 0
    ? []
    : [`${PIECE_WORDS[piece.kind]} ${piece.reference} is in no open matter.\n${renderCandidates(candidates)}`];
}

/**
 * What a note's pieces bring with it: each open matter they sit in, rendered
 * live once, in the order the note first names it; then, for each new piece
 * in no open matter, the open matters it may belong to, when there are any.
 */
async function carried(pieces: readonly NotePiece[]): Promise<string[]> {
  if (pieces.length === 0 || !(await getDb().hasTable('gws_ea_matter_links'))) return [];
  const holders = new Map(
    (await listOpenMatterLinks()).map((link) => [`${link.kind}\u0000${link.reference}`, link.matter_id]),
  );
  const matterIds = new Set<string>();
  const unplaced = new Map<string, NewPiece>();
  for (const { kind, reference: given, arrival } of pieces) {
    const reference = canonicalReference(kind, given);
    const key = `${kind}\u0000${reference}`;
    const matterId = holders.get(key);
    if (matterId !== undefined) matterIds.add(matterId);
    else if (arrival !== undefined && !unplaced.has(key)) unplaced.set(key, { kind, reference, ...arrival });
  }
  const [matters, suggested] = await Promise.all([
    Promise.all([...matterIds].map((id) => bestEffort(`matter ${id}`, () => matterView(id), []))),
    Promise.all(
      [...unplaced.values()].map((piece) =>
        bestEffort(`what ${piece.kind} ${piece.reference} may belong to`, () => suggestions(piece), []),
      ),
    ),
  ]);
  return [...matters.flat(), ...suggested.flat()];
}

export async function writeNoteForMain(note: NoteForMain): Promise<NoteForMainResult> {
  const conversation = await resolveMainConversation();
  if (typeof conversation === 'string') return conversation;
  const { session, directMessage } = conversation;
  const text = [note.text, ...(await bestEffort('its matters', () => carried(note.pieces ?? []), []))].join('\n\n');
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id: note.id,
      kind: 'chat',
      timestamp: note.timestamp,
      platformId: directMessage.platform_id,
      channelType: directMessage.channel_type,
      threadId: null,
      content: JSON.stringify({ text, sender: 'system', senderId: 'system', ...attachmentsOf(note.files) }),
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
