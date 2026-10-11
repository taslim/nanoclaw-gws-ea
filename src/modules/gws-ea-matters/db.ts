import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters, parseLine } from '../../gws-ea/validation.js';
import { getThread } from '../gws-ea-inbox/thread-map.js';
import { getPerson } from '../gws-ea-people/db.js';

/** What a matter links to (R3), in the order a matter lists them. */
export const LINK_KINDS = ['thread', 'event', 'file', 'person', 'memory'] as const;
export type LinkKind = (typeof LINK_KINDS)[number];

/**
 * Pieces of work: each sits in at most one open matter, and placing it in
 * another moves it (R3). Only a piece is placed nowhere (R9).
 */
export const PIECE_KINDS = ['thread', 'event', 'file'] as const satisfies readonly LinkKind[];
export type PieceKind = (typeof PIECE_KINDS)[number];

/** A link by id: a thread key, `<calendar id>/<event id>`, a Drive file id, a person id, or a memory path. */
export interface LinkRef {
  readonly kind: LinkKind;
  readonly reference: string;
}

export interface MatterLink extends LinkRef {
  /** The agent that works this link and keeps its account of it (R7), or null while only `main` does. */
  readonly handler: string | null;
  readonly linked_at: string;
}

export interface StrandSummary {
  readonly id: string;
  readonly title: string;
  readonly open: boolean;
}

/**
 * Everything the host keeps for a matter (R2): no status, stage, priority,
 * due date, owner or log. What a link's source records is read from the
 * source, never stored here (R4).
 */
export interface Matter {
  readonly id: string;
  /** In the principal's own words. */
  readonly title: string;
  /** What the principal wants and what happens next, which `main` rewrites as things change. */
  readonly open_loop: string;
  /** The project this matter is a strand of (R29), or null. */
  readonly parent_id: string | null;
  readonly open: boolean;
  /** How it ended, in a line: set while it is closed, and only then (R5). */
  readonly outcome: string | null;
  /** The scheduled task that is its next look (KTD4), or null while none is recorded. */
  readonly look_task_id: string | null;
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

/** An open matter as the open list shows it, its strands under it (R10). */
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
  /** A next look is being set: a closed matter reopens (KTD3), and an open one stays as it is. */
  readonly reopen?: boolean;
  readonly unlink?: readonly LinkRef[];
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

/** The open loop's lines, each trimmed, blank ones dropped. */
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

/** The links in their canonical spelling, each once, in the order given. */
function parseLinks(links: readonly LinkRef[]): LinkRef[] {
  const parsed = new Map<string, LinkRef>();
  for (const link of links) {
    const reference = canonicalReference(link.kind, link.reference);
    parsed.set(`${link.kind}\u0000${reference}`, { kind: link.kind, reference });
  }
  return [...parsed.values()];
}

function requireSome(links: readonly LinkRef[]): void {
  if (links.length === 0) {
    throw new Error('Give at least one link to place: a thread, event, file, person or memory file');
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
  readonly created_at: string;
  readonly updated_at: string;
  readonly closed_at: string | null;
}

const MATTER_COLUMNS = 'id, title, open_loop, parent_id, outcome, look_task_id, created_at, updated_at, closed_at';

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

/** One matter with its links and strands, open or closed (R5). */
export async function getMatter(id: string): Promise<Matter | undefined> {
  const db = getDb();
  const row = await matterRow(id.trim());
  if (!row) return undefined;
  const links = await db.all<MatterLink>(
    'SELECT kind, reference, handler, linked_at FROM gws_ea_matter_links WHERE matter_id = ? ORDER BY linked_at, rowid',
    row.id,
  );
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

/** An open matter's slot for its next look (KTD4): the task it records, or null while it records none. */
export interface LookSlot {
  readonly id: string;
  readonly title: string;
  readonly look_task_id: string | null;
}

/** Every open matter's look slot, oldest first. */
export async function listOpenLookSlots(): Promise<LookSlot[]> {
  return getDb().all<LookSlot>(
    'SELECT id, title, look_task_id FROM gws_ea_matters WHERE closed_at IS NULL ORDER BY created_at, id',
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

/** A link of an open matter, with the matter it sits in. */
export interface OpenMatterLink extends LinkRef {
  readonly matter_id: string;
}

/** Every link of every open matter. */
export async function listOpenMatterLinks(): Promise<OpenMatterLink[]> {
  return getDb().all<OpenMatterLink>(
    'SELECT matter_id, kind, reference FROM gws_ea_matter_links WHERE matter_open = 1 ORDER BY matter_id, linked_at, rowid',
  );
}

/** Every closed matter, most recently closed first. */
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

/** The host keeps only references it can resolve: a thread the inbox knows, a person with a record. */
async function assertResolvable(link: LinkRef): Promise<void> {
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

/** The open matter a piece sits in, with whoever works it there. */
async function openHolder(
  link: LinkRef,
): Promise<{ readonly matter_id: string; readonly handler: string | null } | undefined> {
  return getDb().get<{ readonly matter_id: string; readonly handler: string | null }>(
    'SELECT matter_id, handler FROM gws_ea_matter_links WHERE kind = ? AND reference = ? AND matter_open = 1',
    link.kind,
    link.reference,
  );
}

/** Take a piece out of the open matter it sits in, inside the caller's transaction. */
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
 * Link each of `links` to the open matter `matterId`, inside the caller's
 * transaction. A piece in another open matter moves here, with whoever
 * works it; one already here stays as it is.
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

/** Refuse `projectId` as `matterId`'s project unless it is an open matter that is not itself a strand (KTD13). */
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

/** Refuse to reopen while one of the matter's pieces sits in another open matter (KTD3). */
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
      WHERE mine.matter_id = ? AND mine.kind IN ('thread', 'event', 'file')
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

/** Open a matter, as a strand of `parentId` when given, placing `links` in it (R1–R3). */
export async function openMatter(input: OpenMatterInput): Promise<Placed> {
  const title = parseTitle(input.title);
  const openLoop = parseOpenLoop(input.openLoop);
  const parentId = input.parentId?.trim();
  const links = parseLinks(input.links);
  const id = newMatterId();
  const now = new Date().toISOString();
  const db = getDb();
  const moved = await db.transaction(async () => {
    if (parentId !== undefined) await assertProject(parentId, id);
    await db.run(
      `INSERT INTO gws_ea_matters (id, title, open_loop, parent_id, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      id,
      title,
      openLoop,
      parentId ?? null,
      now,
      now,
    );
    return (await linkInto(id, links, now)).moved;
  });
  return { matter: await requireMatter(id), moved };
}

/** Place `links` in the open matter `id`, moving a piece from any other open matter (R3). */
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
 * Place pieces nowhere, when nothing about them needs keeping (R9): each
 * leaves the open matter it sits in, and no matter opens. A closed matter
 * keeps its link.
 */
export async function placeNowhere(links: readonly LinkRef[]): Promise<PlacedNowhere[]> {
  const parsed = parseLinks(links);
  requireSome(parsed);
  const pieces = parsed.map((link) => {
    if (!isPiece(link.kind)) {
      throw new Error(
        `Only a thread, event or file is placed nowhere: unlink the ${link.kind} ${link.reference} from its matter instead`,
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
      placed.push({ ...piece, from: holder?.matter_id ?? null });
    }
    return placed;
  });
}

/**
 * Change a matter in one transaction (KTD3). Its title, open loop and, once
 * closed, its outcome change whether it is open or closed, without reopening
 * it. Its project and links change while it is open. `reopen` reopens a
 * closed matter, unless one of its pieces now sits in another open matter or
 * its project is closed.
 */
export async function updateMatter(input: UpdateMatterInput): Promise<Matter> {
  const id = input.id.trim();
  const title = input.title === undefined ? undefined : parseTitle(input.title);
  const openLoop = input.openLoop === undefined ? undefined : parseOpenLoop(input.openLoop);
  const outcome = input.outcome === undefined ? undefined : parseOutcome(input.outcome);
  const parentId = input.parentId === undefined || input.parentId === null ? input.parentId : input.parentId.trim();
  const unlink = parseLinks(input.unlink ?? []);
  const reopen = input.reopen === true;
  if (
    title === undefined &&
    openLoop === undefined &&
    outcome === undefined &&
    parentId === undefined &&
    unlink.length === 0 &&
    !reopen
  ) {
    throw new Error('Nothing to change: give a title, open loop, outcome, project, links to unlink, or a next look');
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
      throw new Error(`${id} is closed: only its title, open loop and outcome change until a next look reopens it`);
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
      changed = true;
    }
    if (reopening) {
      await assertReopenable(id);
      await db.run('UPDATE gws_ea_matters SET closed_at = NULL, outcome = NULL WHERE id = ?', id);
      await db.run('UPDATE gws_ea_matter_links SET matter_open = 1 WHERE matter_id = ?', id);
    }
    for (const [column, value] of [
      ['title', title],
      ['open_loop', openLoop],
      ['outcome', outcome],
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
 * Close a matter with its outcome in a line (R5). It stays readable with its
 * links. A project closes only once none of its strands is open (KTD13).
 */
export async function closeMatter(input: CloseMatterInput): Promise<Matter> {
  const id = input.id.trim();
  const outcome = parseOutcome(input.outcome);
  const now = new Date().toISOString();
  const db = getDb();
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
  });
  return requireMatter(id);
}

/**
 * Record the scheduled task that is a matter's next look, or null when it
 * has none (KTD4). The task is the clock, so this is not a change to the
 * matter itself and leaves `updated_at` as it was.
 */
export async function recordLookTask(id: string, taskId: string | null): Promise<void> {
  const matterId = id.trim();
  const result = await getDb().run('UPDATE gws_ea_matters SET look_task_id = ? WHERE id = ?', taskId, matterId);
  if (result.changes === 0) throw noMatter(matterId);
}
