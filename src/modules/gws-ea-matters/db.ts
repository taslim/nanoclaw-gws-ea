import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters, parseLine } from '../../gws-ea/validation.js';
import { getThread, holdThread, placeThread, THREAD_HANDLER, threadPlacement } from '../gws-ea-inbox/thread-map.js';
import { getPerson } from '../gws-ea-people/db.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  cancelBrowserJob,
  cancelBrowserJobInTransaction,
  finishBrowserJobCancellation,
  resolveBrowserJob,
  type BrowserJobCancellation,
} from '../gws-ea-browser/cancel.js';
import { readChatLink } from './chat-links.js';
import { parseMatterDueAt } from './planning.js';

/** In the order a matter lists them. */
export const LINK_KINDS = ['thread', 'event', 'file', 'person', 'memory', 'job', 'chat'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * Pieces of work: each sits in at most one open matter, and placing it in
 * another moves it. Only a piece is placed nowhere.
 */
export const PIECE_KINDS = ['thread', 'event', 'file', 'job'] as const satisfies readonly LinkKind[];
export type PieceKind = (typeof PIECE_KINDS)[number];

/** `reference` in the one spelling `canonicalReference` keeps for its kind, such as `<calendar id>/<event id>`. */
export interface LinkRef {
  readonly kind: LinkKind;
  readonly reference: string;
}

export interface MatterLink extends LinkRef {
  /** The agent that works this link and keeps its account of it, or null while only `main` does. */
  readonly handler: string | null;
  readonly linked_at: string;
  /** A chat handler's account of this matter, never shared with the chat's other matters. */
  readonly account?: { readonly text: string; readonly at: string };
}

export const CHAT_ACCOUNT_MAX = 2_000;

export interface StrandSummary {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
}

/**
 * Everything the host keeps for a matter, including planning facts but no
 * status, stage, priority, owner or log. What a link's source records is read from the source,
 * never stored here.
 */
export interface Matter {
  readonly id: string;
  /** In the principal's own words. */
  readonly title: string;
  /** What the principal wants and what happens next, which `main` rewrites as things change. */
  readonly open_loop: string;
  /** The project this matter is a strand of. */
  readonly parent_id: string | null;
  readonly open: boolean;
  /** How it ended, in a line: set while it is closed, and only then. */
  readonly outcome: string | null;
  /** The scheduled task that is its next look, or null while none is recorded. */
  readonly look_task_id: string | null;
  readonly due_at: string | null;
  readonly needs_minutes: number | null;
  readonly place: string | null;
  readonly deferrals: number;
  readonly links: readonly MatterLink[];
  /** A project's strands, open and closed, oldest first. */
  readonly strands: readonly StrandSummary[];
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

/** A piece that left the open matter it sat in. */
export interface Moved {
  readonly kind: PieceKind;
  readonly reference: string;
  readonly from: string;
}

export interface Placed {
  readonly matter: Matter;
  readonly moved: readonly Moved[];
}

/** A piece placed nowhere, with the open matter it left, if any. */
export interface PlacedNowhere {
  readonly kind: PieceKind;
  readonly reference: string;
  readonly from: string | null;
}

/** An open matter as the open list shows it, its open strands under it. */
export interface OpenMatterSummary {
  readonly id: string;
  readonly title: string;
  readonly open_loop: string;
  readonly strands: ReadonlyArray<{ readonly id: string; readonly title: string; readonly open_loop: string }>;
}

export interface ClosedMatterSummary {
  readonly id: string;
  readonly title: string;
  readonly outcome: string;
  readonly parent_id: string | null;
  readonly closed_at: string;
}

/** Unvalidated caller input: the store checks every field. */
export interface OpenMatterInput {
  readonly title: string;
  readonly openLoop: string;
  /** The project to open it as a strand of. */
  readonly parentId?: string;
  readonly links: readonly LinkRef[];
  readonly dueAt?: string | null;
  readonly needsMinutes?: number;
  readonly place?: string | null;
}

/** Unvalidated caller input. */
export interface UpdateMatterInput {
  readonly id: string;
  readonly title?: string;
  readonly openLoop?: string;
  /** A closed matter's outcome, rewritten. */
  readonly outcome?: string;
  /** The project to make it a strand of, or null for none. */
  readonly parentId?: string | null;
  /** A next look is being set: a closed matter reopens, and an open one stays as it is. */
  readonly reopen?: boolean;
  readonly unlink?: readonly LinkRef[];
  readonly dueAt?: string | null;
  readonly needsMinutes?: number;
  readonly place?: string | null;
}

export interface CloseMatterInput {
  readonly id: string;
  readonly outcome: string;
}

const TITLE_MAX_LENGTH = 120;
const OPEN_LOOP_MAX_LENGTH = 600;
const OUTCOME_MAX_LENGTH = 280;
const THREAD_KEY = /^mail-[A-Za-z0-9-]{1,80}$/u;
const EVENT_ID = /^[A-Za-z0-9_-]{1,1024}$/u;
const CALENDAR_ID_MAX_LENGTH = 254;
const FILE_ID = /^[A-Za-z0-9_-]{1,200}$/u;
const PERSON_ID = /^p-[0-9a-f]{12}$/u;
const MEMORY_DIRECTORY = 'memory/';
/** Where `main`'s workspace is mounted, which a memory path may be written from. */
const AGENT_WORKSPACE = '/workspace/agent/';
const MEMORY_PATH_MAX_LENGTH = 256;

// ---------------------------------------------------------------------------
// Parsing: every value is checked here before it reaches the schema's checks.
// ---------------------------------------------------------------------------

function isPiece(kind: LinkKind): kind is PieceKind {
  return PIECE_KINDS.some((piece) => piece === kind);
}

function parseTitle(value: string): string {
  return parseLine(value, 'Title', TITLE_MAX_LENGTH);
}

function parseOutcome(value: string): string {
  return parseLine(value, 'Outcome', OUTCOME_MAX_LENGTH);
}

function parseOpenLoop(value: string): string {
  const lines = value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  const text = lines.join('\n');
  if (!text || text.length > OPEN_LOOP_MAX_LENGTH || lines.some(hasControlCharacters)) {
    throw new Error(
      `Open loop must be 1 to ${OPEN_LOOP_MAX_LENGTH} characters: what the principal wants and what happens next, in two or three lines`,
    );
  }
  return text;
}

function eventReference(text: string, value: string): string {
  const slash = text.indexOf('/');
  const calendar = text.slice(0, slash).toLowerCase();
  const event = text.slice(slash + 1);
  const valid =
    slash > 0 &&
    calendar.length <= CALENDAR_ID_MAX_LENGTH &&
    !/[\s,]/u.test(calendar) &&
    !hasControlCharacters(calendar) &&
    EVENT_ID.test(event);
  if (!valid) {
    throw new Error(
      `Event ${JSON.stringify(value)} is invalid: use <calendar id>/<event id>, such as name@example.com/7k3q9v1m2n4p`,
    );
  }
  return `${calendar}/${event}`;
}

function memoryPath(text: string, value: string): string {
  const path = text.startsWith(AGENT_WORKSPACE) ? text.slice(AGENT_WORKSPACE.length) : text;
  const valid =
    path.startsWith(MEMORY_DIRECTORY) &&
    path.length <= MEMORY_PATH_MAX_LENGTH &&
    !hasControlCharacters(path) &&
    !path.includes('\\') &&
    path.split('/').every((segment) => segment !== '' && segment !== '.' && segment !== '..');
  if (!valid) {
    throw new Error(
      `Memory file ${JSON.stringify(value)} is invalid: use its path under memory/, such as memory/clients/acme.md`,
    );
  }
  return path;
}

/** A reference in the one spelling the store keeps, so the same piece always matches itself. */
export function canonicalReference(kind: LinkKind, value: string): string {
  const text = value.trim();
  switch (kind) {
    case 'chat':
      if (text.length === 0 || text.length > 256 || /[\s,]/u.test(text) || hasControlCharacters(text))
        throw new Error(`Chat ${JSON.stringify(value)} is invalid: use its messaging-group id`);
      return text;
    case 'job':
      if (!/^system:a2a:[^:\s]+:[^\s]+$/u.test(text) || hasControlCharacters(text))
        throw new Error('Give the browser errand thread returned when you sent the errand');
      return text;
    case 'thread':
      if (!THREAD_KEY.test(text)) throw new Error(`Thread ${JSON.stringify(value)} is invalid: use its key, mail-…`);
      return text;
    case 'event':
      return eventReference(text, value);
    case 'file':
      if (!FILE_ID.test(text)) {
        throw new Error(`File ${JSON.stringify(value)} is invalid: use its Drive file id, not its link`);
      }
      return text;
    case 'person':
      if (!PERSON_ID.test(text)) {
        throw new Error(`Person ${JSON.stringify(value)} is invalid: use their id from the people store, p-…`);
      }
      return text;
    case 'memory':
      return memoryPath(text, value);
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown link kind: ${String(unreachable)}`);
    }
  }
}

export function linkKey(kind: LinkKind, reference: string): string {
  return `${kind}\u0000${reference}`;
}

function parseLinks(links: readonly LinkRef[]): LinkRef[] {
  const parsed = new Map<string, LinkRef>();
  for (const link of links) {
    const reference = canonicalReference(link.kind, link.reference);
    parsed.set(linkKey(link.kind, reference), { kind: link.kind, reference });
  }
  return [...parsed.values()];
}

function requireSome(links: readonly LinkRef[]): void {
  if (links.length === 0) {
    throw new Error('Give at least one link to place: a thread, event, file, person, memory file, browser job or chat');
  }
}

function newMatterId(): string {
  return `m-${randomBytes(6).toString('hex')}`;
}

function noMatter(id: string): Error {
  return new Error(`No matter ${JSON.stringify(id)} exists`);
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

interface MatterRow {
  readonly id: string;
  readonly title: string;
  readonly open_loop: string;
  readonly parent_id: string | null;
  readonly outcome: string | null;
  readonly look_task_id: string | null;
  readonly due_at: string | null;
  readonly needs_minutes: number | null;
  readonly place: string | null;
  readonly deferrals: number;
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

const MATTER_COLUMNS =
  'id, title, open_loop, parent_id, outcome, look_task_id, due_at, needs_minutes, place, deferrals, created_at, updated_at, closed_at';

async function matterRow(id: string): Promise<MatterRow | undefined> {
  return getDb().get<MatterRow>(`SELECT ${MATTER_COLUMNS} FROM gws_ea_matters WHERE id = ?`, id);
}

async function requireMatterRow(id: string): Promise<MatterRow> {
  const row = await matterRow(id);
  if (!row) throw noMatter(id);
  return row;
}

function byKind(left: MatterLink, right: MatterLink): number {
  return LINK_KINDS.indexOf(left.kind) - LINK_KINDS.indexOf(right.kind);
}

/** One matter with its links and strands, open or closed. */
export async function getMatter(id: string): Promise<Matter | undefined> {
  const db = getDb();
  const row = await matterRow(id.trim());
  if (!row) return undefined;
  const rows = await db.all<
    Omit<MatterLink, 'account'> & { readonly account: string | null; readonly account_at: string | null }
  >(
    'SELECT kind, reference, handler, linked_at, account, account_at FROM gws_ea_matter_links WHERE matter_id = ? ORDER BY linked_at, rowid',
    row.id,
  );
  const links: MatterLink[] = rows.map(({ account, account_at, ...link }) => ({
    ...link,
    ...(account === null || account_at === null ? {} : { account: { text: account, at: account_at } }),
  }));
  const strands = await db.all<{ readonly id: string; readonly title: string; readonly closed_at: string | null }>(
    'SELECT id, title, closed_at FROM gws_ea_matters WHERE parent_id = ? ORDER BY created_at, id',
    row.id,
  );
  return {
    id: row.id,
    title: row.title,
    open_loop: row.open_loop,
    parent_id: row.parent_id,
    open: row.closed_at === null,
    outcome: row.outcome,
    look_task_id: row.look_task_id,
    due_at: row.due_at,
    needs_minutes: row.needs_minutes,
    place: row.place,
    deferrals: row.deferrals,
    // By kind, and within a kind in the order they were placed.
    links: [...links].sort(byKind),
    strands: strands.map((strand) => ({ id: strand.id, title: strand.title, open: strand.closed_at === null })),
    created_at: row.created_at,
    updated_at: row.updated_at,
    closed_at: row.closed_at,
  };
}

export async function requireMatter(id: string): Promise<Matter> {
  const matter = await getMatter(id);
  if (!matter) throw noMatter(id);
  return matter;
}

/** An open matter's slot for its next look: the task it records, or null while it records none. */
export interface LookSlot {
  readonly id: string;
  readonly title: string;
  readonly look_task_id: string | null;
  /**
   * When the host heard a run of this matter's look failed, until the matters loop brings it forward or another
   * look replaces it.
   */
  readonly look_failed_at: string | null;
}

export async function listOpenLookSlots(): Promise<LookSlot[]> {
  return getDb().all<LookSlot>(
    'SELECT id, title, look_task_id, look_failed_at FROM gws_ea_matters WHERE closed_at IS NULL ORDER BY created_at, id',
  );
}

/** Every open matter, most recently changed first, each project with its open strands under it. */
export async function listOpenMatters(): Promise<OpenMatterSummary[]> {
  const db = getDb();
  type Row = { readonly id: string; readonly title: string; readonly open_loop: string };
  const projects = await db.all<Row>(
    `SELECT id, title, open_loop FROM gws_ea_matters
      WHERE closed_at IS NULL AND parent_id IS NULL
      ORDER BY updated_at DESC, id`,
  );
  const strands = await db.all<Row & { readonly parent_id: string }>(
    `SELECT id, title, open_loop, parent_id FROM gws_ea_matters
      WHERE closed_at IS NULL AND parent_id IS NOT NULL
      ORDER BY created_at, id`,
  );
  return projects.map((project) => ({
    ...project,
    strands: strands
      .filter((strand) => strand.parent_id === project.id)
      .map(({ id, title, open_loop }) => ({ id, title, open_loop })),
  }));
}

export interface OpenMatterLink extends LinkRef {
  readonly matter_id: string;
}

export async function listOpenMatterLinks(): Promise<OpenMatterLink[]> {
  return getDb().all<OpenMatterLink>(
    'SELECT matter_id, kind, reference FROM gws_ea_matter_links WHERE matter_open = 1 ORDER BY matter_id, linked_at, rowid',
  );
}

/** With that matter's threads in the order they were placed, this one among them; undefined while it sits in none. */
export async function openMatterOfThread(
  threadKey: string,
): Promise<{ readonly matterId: string; readonly threads: readonly string[] } | undefined> {
  const rows = await getDb().all<{ readonly matter_id: string; readonly reference: string }>(
    `SELECT other.matter_id, other.reference
       FROM gws_ea_matter_links mine
       JOIN gws_ea_matter_links other
         ON other.matter_id = mine.matter_id AND other.kind = 'thread' AND other.matter_open = 1
      WHERE mine.kind = 'thread' AND mine.reference = ? AND mine.matter_open = 1
      ORDER BY other.linked_at, other.rowid`,
    threadKey,
  );
  const [first] = rows;
  return first === undefined ? undefined : { matterId: first.matter_id, threads: rows.map((row) => row.reference) };
}

export async function listClosedMatters(): Promise<ClosedMatterSummary[]> {
  return getDb().all<ClosedMatterSummary>(
    `SELECT id, title, outcome, parent_id, closed_at FROM gws_ea_matters
      WHERE closed_at IS NOT NULL
      ORDER BY closed_at DESC, id`,
  );
}

// ---------------------------------------------------------------------------
// Writes: each in one transaction, with the links' open flag kept in step.
// ---------------------------------------------------------------------------

/** The host keeps only references it can resolve. A job must be one main delegated, since matters are main's. */
async function assertResolvable(link: LinkRef): Promise<void> {
  if (link.kind === 'chat' && (await readChatLink(link.reference)) === undefined) {
    throw new Error(`No chat ${link.reference} exists`);
  }
  if (link.kind === 'job') {
    const main = await getMainAgentGroupId();
    if (main === null || !(await resolveBrowserJob(link.reference, undefined, main)))
      throw new Error(`No browser job ${link.reference} exists`);
  }
  if (link.kind === 'thread' && (await getThread(link.reference)) === undefined) {
    throw new Error(`No email thread ${link.reference} exists`);
  }
  if (link.kind === 'person' && (await getPerson(link.reference)) === undefined) {
    throw new Error(`No person ${link.reference} exists`);
  }
}

async function touch(id: string, now: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_matters SET updated_at = ? WHERE id = ?', now, id);
}

async function openHolder(
  link: LinkRef,
): Promise<{ readonly matter_id: string; readonly handler: string | null } | undefined> {
  return getDb().get<{ readonly matter_id: string; readonly handler: string | null }>(
    'SELECT matter_id, handler FROM gws_ea_matter_links WHERE kind = ? AND reference = ? AND matter_open = 1',
    link.kind,
    link.reference,
  );
}

async function threadsOf(matterId: string): Promise<string[]> {
  const rows = await getDb().all<{ readonly reference: string }>(
    "SELECT reference FROM gws_ea_matter_links WHERE matter_id = ? AND kind = 'thread'",
    matterId,
  );
  return rows.map((row) => row.reference);
}

/** Inside the caller's transaction. */
async function takeFromOpenMatter(
  link: LinkRef,
  now: string,
): Promise<{ readonly matter_id: string; readonly handler: string | null } | undefined> {
  const holder = await openHolder(link);
  if (holder === undefined) return undefined;
  await getDb().run(
    'DELETE FROM gws_ea_matter_links WHERE matter_id = ? AND kind = ? AND reference = ?',
    holder.matter_id,
    link.kind,
    link.reference,
  );
  await touch(holder.matter_id, now);
  return holder;
}

/**
 * Inside the caller's transaction. A piece in another open matter moves here,
 * with whoever works it; one already here stays as it is. A thread is placed,
 * and one main handed over is external-email's to work.
 */
async function linkInto(
  matterId: string,
  links: readonly LinkRef[],
  now: string,
): Promise<{ readonly moved: Moved[]; readonly changed: boolean }> {
  const db = getDb();
  const moved: Moved[] = [];
  let changed = false;
  for (const link of links) {
    await assertResolvable(link);
    const here = await db.get(
      'SELECT 1 AS present FROM gws_ea_matter_links WHERE matter_id = ? AND kind = ? AND reference = ?',
      matterId,
      link.kind,
      link.reference,
    );
    if (here) continue;
    let handler: string | null = null;
    if (isPiece(link.kind)) {
      const holder = await takeFromOpenMatter(link, now);
      if (holder !== undefined) {
        handler = holder.handler;
        moved.push({ kind: link.kind, reference: link.reference, from: holder.matter_id });
      }
    }
    if (link.kind === 'thread') {
      handler ??= (await threadPlacement(link.reference))?.released === true ? THREAD_HANDLER : null;
      await placeThread(link.reference, 'matter');
    }
    await db.run(
      `INSERT INTO gws_ea_matter_links (matter_id, kind, reference, handler, matter_open, linked_at)
       VALUES (?, ?, ?, ?, 1, ?)`,
      matterId,
      link.kind,
      link.reference,
      handler,
      now,
    );
    changed = true;
  }
  return { moved, changed };
}

async function assertProject(projectId: string, matterId: string): Promise<void> {
  if (projectId === matterId) throw new Error(`${matterId} cannot be its own project`);
  const project = await matterRow(projectId);
  if (!project) throw noMatter(projectId);
  if (project.parent_id !== null) {
    throw new Error(
      `${projectId} is a strand of ${project.parent_id}, and strands go one level deep: make it a strand of ${project.parent_id}`,
    );
  }
  if (project.closed_at !== null) throw new Error(`The project ${projectId} is closed: a strand's project is open`);
}

async function assertNoStrands(matterId: string): Promise<void> {
  const strand = await getDb().get('SELECT 1 AS present FROM gws_ea_matters WHERE parent_id = ? LIMIT 1', matterId);
  if (strand) throw new Error(`${matterId} has strands: a project cannot be a strand of another`);
}

/** Refuse to reopen while one of the matter's pieces sits in another open matter. */
async function assertReopenable(matterId: string): Promise<void> {
  const taken = await getDb().get<{
    readonly kind: PieceKind;
    readonly reference: string;
    readonly matter_id: string;
    readonly title: string;
  }>(
    `SELECT mine.kind, mine.reference, other.matter_id, holder.title
       FROM gws_ea_matter_links mine
       JOIN gws_ea_matter_links other
         ON other.kind = mine.kind AND other.reference = mine.reference
        AND other.matter_open = 1 AND other.matter_id <> mine.matter_id
       JOIN gws_ea_matters holder ON holder.id = other.matter_id
      WHERE mine.matter_id = ? AND mine.kind IN ('thread', 'event', 'file', 'job')
      ORDER BY mine.kind, mine.reference
      LIMIT 1`,
    matterId,
  );
  if (taken) {
    throw new Error(
      `${matterId} cannot reopen: its ${taken.kind} ${taken.reference} now sits in open matter ${taken.matter_id} (${JSON.stringify(taken.title)})`,
    );
  }
}

function planningMinutes(value: number | undefined): number | null {
  if (value === undefined) return null;
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error('Principal time needed must be a nonnegative whole number of minutes');
  return value;
}

function planningPlace(value: string | null | undefined): string | null {
  return value === undefined || value === null || value.trim() === '' ? null : parseLine(value, 'Place', 280);
}

export async function openMatter(input: OpenMatterInput): Promise<Placed> {
  const title = parseTitle(input.title);
  const openLoop = parseOpenLoop(input.openLoop);
  const parentId = input.parentId?.trim();
  const links = parseLinks(input.links);
  const dueAt = parseMatterDueAt(input.dueAt ?? null);
  const needsMinutes = planningMinutes(input.needsMinutes);
  const place = planningPlace(input.place);
  const id = newMatterId();
  const now = new Date().toISOString();
  const db = getDb();
  const moved = await db.transaction(async () => {
    if (parentId !== undefined) await assertProject(parentId, id);
    await db.run(
      `INSERT INTO gws_ea_matters (id, title, open_loop, parent_id, created_at, updated_at, due_at, needs_minutes, place)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      id,
      title,
      openLoop,
      parentId ?? null,
      now,
      now,
      dueAt,
      needsMinutes,
      place,
    );
    return (await linkInto(id, links, now)).moved;
  });
  return { matter: await requireMatter(id), moved };
}

export async function placeInMatter(id: string, links: readonly LinkRef[]): Promise<Placed> {
  const matterId = id.trim();
  const parsed = parseLinks(links);
  requireSome(parsed);
  const now = new Date().toISOString();
  const db = getDb();
  const moved = await db.transaction(async () => {
    const row = await requireMatterRow(matterId);
    if (row.closed_at !== null) {
      throw new Error(`${matterId} is closed: a next look reopens it before anything is placed in it`);
    }
    const linked = await linkInto(matterId, parsed, now);
    if (linked.changed) await touch(matterId, now);
    return linked.moved;
  });
  return { matter: await requireMatter(matterId), moved };
}

/**
 * For pieces nothing about which needs keeping: each leaves the open matter it
 * sits in, and no matter opens. A closed matter keeps its link.
 */
export async function placeNowhere(links: readonly LinkRef[]): Promise<PlacedNowhere[]> {
  const parsed = parseLinks(links);
  requireSome(parsed);
  const pieces = parsed.map((link) => {
    if (!isPiece(link.kind)) {
      throw new Error(
        `Only a thread, event, file or job is placed nowhere: unlink the ${link.kind} ${link.reference} from its matter instead`,
      );
    }
    return { kind: link.kind, reference: link.reference };
  });
  const now = new Date().toISOString();
  return getDb().transaction(async () => {
    const placed: PlacedNowhere[] = [];
    for (const piece of pieces) {
      await assertResolvable(piece);
      const holder = await takeFromOpenMatter(piece, now);
      if (piece.kind === 'thread') await placeThread(piece.reference, 'nowhere');
      placed.push({ ...piece, from: holder?.matter_id ?? null });
    }
    return placed;
  });
}

/**
 * Its title, open loop and, once closed, its outcome change whether it is open
 * or closed, without reopening it. Its project and links change while it is
 * open. `reopen` reopens a closed matter, unless one of its pieces now sits in
 * another open matter or its project is closed.
 */
export async function updateMatter(input: UpdateMatterInput): Promise<Matter> {
  const id = input.id.trim();
  const title = input.title === undefined ? undefined : parseTitle(input.title);
  const openLoop = input.openLoop === undefined ? undefined : parseOpenLoop(input.openLoop);
  const outcome = input.outcome === undefined ? undefined : parseOutcome(input.outcome);
  const parentId = input.parentId === undefined || input.parentId === null ? input.parentId : input.parentId.trim();
  const unlink = parseLinks(input.unlink ?? []);
  const reopen = input.reopen === true;
  const dueAt = input.dueAt === undefined ? undefined : parseMatterDueAt(input.dueAt);
  const needsMinutes = input.needsMinutes === undefined ? undefined : planningMinutes(input.needsMinutes);
  const place = input.place === undefined ? undefined : planningPlace(input.place);
  if (
    title === undefined &&
    openLoop === undefined &&
    outcome === undefined &&
    parentId === undefined &&
    unlink.length === 0 &&
    dueAt === undefined &&
    needsMinutes === undefined &&
    place === undefined &&
    !reopen
  ) {
    throw new Error(
      'Nothing to change: give a title, open loop, outcome, planning facts, project, links to unlink, or a next look',
    );
  }

  const now = new Date().toISOString();
  const db = getDb();
  await db.transaction(async () => {
    const row = await requireMatterRow(id);
    const reopening = reopen && row.closed_at !== null;
    const open = row.closed_at === null || reopening;
    if (outcome !== undefined && open) {
      throw new Error(`${id} is open, and an open matter has no outcome: it gets one when it closes`);
    }
    if (!open && (parentId !== undefined || unlink.length > 0)) {
      throw new Error(`${id} is closed: only its words and planning facts change until a next look reopens it`);
    }

    let changed = reopening;
    if (parentId !== undefined && parentId !== row.parent_id) {
      if (parentId !== null) {
        await assertProject(parentId, id);
        await assertNoStrands(id);
      }
      await db.run('UPDATE gws_ea_matters SET parent_id = ? WHERE id = ?', parentId, id);
      changed = true;
    } else if (reopening && row.parent_id !== null) {
      await assertProject(row.parent_id, id);
    }
    // Before reopening, so a piece taken off here no longer stands in its way.
    for (const link of unlink) {
      const removed = await db.run(
        'DELETE FROM gws_ea_matter_links WHERE matter_id = ? AND kind = ? AND reference = ?',
        id,
        link.kind,
        link.reference,
      );
      if (removed.changes === 0) throw new Error(`${id} does not link ${link.kind} ${link.reference}`);
      // Taken out of its open matter, a thread is in none, as placing it nowhere leaves it.
      if (open && link.kind === 'thread') await placeThread(link.reference, 'nowhere');
      changed = true;
    }
    if (reopening) {
      await assertReopenable(id);
      await db.run('UPDATE gws_ea_matters SET closed_at = NULL, outcome = NULL WHERE id = ?', id);
      await db.run('UPDATE gws_ea_matter_links SET matter_open = 1 WHERE matter_id = ?', id);
      for (const threadKey of await threadsOf(id)) await placeThread(threadKey, 'matter');
    }
    if (openLoop !== undefined && openLoop !== row.open_loop) {
      await db.run('UPDATE gws_ea_matters SET deferrals = 0 WHERE id = ?', id);
    }
    for (const [column, value] of [
      ['title', title],
      ['open_loop', openLoop],
      ['outcome', outcome],
      ['due_at', dueAt],
      ['needs_minutes', needsMinutes],
      ['place', place],
    ] as const) {
      if (value === undefined) continue;
      await db.run(`UPDATE gws_ea_matters SET ${column} = ? WHERE id = ?`, value, id);
      changed = true;
    }
    if (changed) await touch(id, now);
  });
  return requireMatter(id);
}

/**
 * It stays readable with its links. Its threads are main's to place again:
 * new mail on one waits, held, until main does.
 */
export async function closeMatter(input: CloseMatterInput): Promise<Matter> {
  const id = input.id.trim();
  const outcome = parseOutcome(input.outcome);
  const now = new Date().toISOString();
  const db = getDb();
  const cancellations: BrowserJobCancellation[] = [];
  await db.transaction(async () => {
    const row = await requireMatterRow(id);
    if (row.closed_at !== null) throw new Error(`${id} is already closed`);
    const strands = await db.all<{ readonly id: string; readonly title: string }>(
      'SELECT id, title FROM gws_ea_matters WHERE parent_id = ? AND closed_at IS NULL ORDER BY created_at, id',
      id,
    );
    if (strands.length > 0) {
      const named = strands.map((strand) => `${strand.id} (${JSON.stringify(strand.title)})`).join(', ');
      throw new Error(`${id} has open strands: ${named}. A project closes after its strands`);
    }
    await db.run(
      'UPDATE gws_ea_matters SET outcome = ?, closed_at = ?, updated_at = ? WHERE id = ?',
      outcome,
      now,
      now,
      id,
    );
    await db.run('UPDATE gws_ea_matter_links SET matter_open = 0 WHERE matter_id = ?', id);
    for (const threadKey of await threadsOf(id)) await holdThread(threadKey);
    const jobs = await db.all<{ reference: string }>(
      "SELECT reference FROM gws_ea_matter_links WHERE matter_id = ? AND kind = 'job'",
      id,
    );
    for (const job of jobs) cancellations.push(await cancelBrowserJobInTransaction(job.reference));
  });
  for (const cancellation of cancellations) await finishBrowserJobCancellation(cancellation);
  return requireMatter(id);
}

/** Startup closes the gap when the host was down as a linked matter closed. */
export async function cancelClosedMatterJobs(): Promise<void> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_browser_jobs'))) return;
  const jobs = await db.all<{ reference: string }>(
    "SELECT DISTINCT links.reference FROM gws_ea_matter_links links JOIN gws_ea_matters matters ON matters.id = links.matter_id WHERE links.kind = 'job' AND matters.closed_at IS NOT NULL",
  );
  for (const job of jobs) await cancelBrowserJob(job.reference);
}

/** What main handed over is the handler's to keep an account of. A piece in no open matter is left as it is. */
export async function setLinkHandler(link: LinkRef, handler: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_matter_links SET handler = ? WHERE kind = ? AND reference = ? AND matter_open = 1',
    handler,
    link.kind,
    canonicalReference(link.kind, link.reference),
  );
}

/** Leave the serving agent's report on one open matter's chat link, never on that chat's other matters. */
export async function setChatLinkAccount(
  matterId: string,
  messagingGroupId: string,
  handler: string,
  text: string,
): Promise<void> {
  const chat = canonicalReference('chat', messagingGroupId);
  const account = text.trim();
  if (account.length === 0 || account.length > CHAT_ACCOUNT_MAX)
    throw new Error(`Chat account must be 1 to ${CHAT_ACCOUNT_MAX} characters`);
  const serving = parseLine(handler, 'Chat handler', 256);
  const { changes } = await getDb().run(
    `UPDATE gws_ea_matter_links SET handler = ?, account = ?, account_at = ?
      WHERE matter_id = ? AND kind = 'chat' AND reference = ? AND matter_open = 1`,
    serving,
    account,
    new Date().toISOString(),
    matterId.trim(),
    chat,
  );
  if (changes === 0) throw new Error(`No open matter ${matterId} links chat ${chat}`);
}

/** In open and closed matters alike. */
export async function clearChatLinkAccounts(messagingGroupIds: readonly string[]): Promise<void> {
  const db = getDb();
  for (const chat of new Set(messagingGroupIds)) {
    await db.run(
      "UPDATE gws_ea_matter_links SET account = NULL, account_at = NULL WHERE kind = 'chat' AND reference = ?",
      chat,
    );
  }
}

/** `at` null clears the mark. A matter that is gone, or closed since, is left as it is. */
export async function markLookFailed(id: string, at: string | null): Promise<void> {
  await getDb().run('UPDATE gws_ea_matters SET look_failed_at = ? WHERE id = ? AND closed_at IS NULL', at, id);
}

/**
 * The task is the clock, so this is not a change to the matter itself and
 * leaves `updated_at` as it was. A new look has not failed: it clears any
 * mark the look it replaces left.
 */
export async function recordLookTask(id: string, taskId: string | null): Promise<void> {
  const matterId = id.trim();
  const result = await getDb().run(
    'UPDATE gws_ea_matters SET look_task_id = ?, look_failed_at = NULL WHERE id = ?',
    taskId,
    matterId,
  );
  if (result.changes === 0) throw noMatter(matterId);
}

/** Called only after the new check-in was recorded successfully. */
export async function recordMatterDeferral(id: string): Promise<void> {
  await getDb().run(
    'UPDATE gws_ea_matters SET deferrals = deferrals + 1, updated_at = ? WHERE id = ?',
    new Date().toISOString(),
    id,
  );
}
