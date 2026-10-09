/**
 * `rollback` (R13-R15), and the recovery of an update that failed after its
 * swap (R14). A rollback returns an assistant to the release kept in
 * `<instance>/previous/`, restorable only into its own instance. Its mode is
 * decided once the host is stopped and its checkout proven quiet, from the
 * schema as it is then (KTD5): when neither the central migrations nor the
 * session tables moved since the kept release's snapshot, only the code goes
 * back and every message, memory, and setting since is carried to it;
 * otherwise the snapshot is restored, after its time and what it discards are
 * shown and confirmed. Either way the kept release's own state is set aside,
 * never overwritten (a snapshot restore runs on a copy of it), and the
 * release left is kept whole in `outgoing/`, with that set-aside state, until
 * the next update or removal (KTD19).
 *
 * Each phase is recorded as it completes, so a rollback cut short anywhere is
 * continued by the next `rollback --id`; one cut short before its swap moved
 * the live checkout is decided and prepared again, since the release it
 * leaves may have run from the live path since. One that fails once its swap
 * moved the live checkout goes back to the release it left, whole, and says
 * so; after a code-only failure the snapshot is offered instead. One that
 * fails before is given up, and the release it would leave started again. An
 * update not yet swapped is not rolled back but discarded, and its host
 * started again.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { lstat, mkdtemp, readdir, readFile, readlink, rename, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import { formatLocalTime } from '../timezone.js';
import {
  assertCarriable,
  assertCheckoutQuiet,
  carryState,
  copyReleaseRecords,
  cutoverDocker,
  cutoverOnecli,
  cutoverQuiescence,
  cutoverServiceDependencies,
  dockerEnvironment,
  finishFollowUps,
  finishRollbackSwap,
  finishSwap,
  imageIdOf,
  moveRecordedImages,
  keepCutoverHostStopped,
  leftoverPreviousTag,
  nextAgentImage,
  openCutoverHost,
  planFollowUps,
  quietCheckoutOf,
  removeUpdateStaging,
  restoredReleaseRoot,
  restoreSetAsideState,
  reverseRollbackSwap,
  reverseRollbackSwapBeforeLiveMoved,
  reverseSwap,
  setAsideState,
  setAsideStateRoot,
  settleCheckoutDatabases,
  stopCutoverHost,
  verifyServingRelease,
  type CutoverDependencies,
  type CutoverHost,
  type RollbackReleases,
} from './cutover.js';
import {
  keepReleaseFiles,
  keptReleaseFiles,
  readKeptReleaseManifest,
  type KeptReleaseManifest,
} from './kept-release.js';
import { runStep } from './events.js';
import { assertInstanceCreated, type InstanceOperation } from './journal.js';
import { parseOnecliComposeImages, type OnecliPins } from './onecli-compose.js';
import {
  advanceOperation,
  assertNotCommitted,
  beginOperation,
  beginOperationReturn,
  commitOperationRelease,
  completeOperationReturn,
  discardOperation,
  readOperationRecord,
  reservationAt,
  withdrawRollback,
  type MovedImage,
  type OperationFollowUp,
  type OperationRecord,
  type RollbackMode,
  type SnapshotManifest,
} from './operation.js';
import { instanceMarkerFile, isRegularFile, type ControlPlanePaths } from './paths.js';
import { readDeployedSetup } from './provision.js';
import { safeErrorMessage } from './redact.js';
import { readInstanceMarkerFile } from './registry.js';
import { activeStep } from './run-log.js';
import { readOwnerOnlyFile, readOwnerOnlyJson } from './secrets.js';
import {
  INSTANCE_HOST_ENV_KEYS,
  instanceServiceDefinitionFile,
  readInstanceHostEnvironment,
  restoreInstanceServiceDefinition,
  stampUpgradeState,
} from './service.js';
import { GwsEaError, releaseOf, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord } from './validation.js';
import { backupCentralDatabase, printableName, readDerivedImageGroups, readSchemaManifest } from './verify.js';

/** How many IDs and paths a discard summary lists; the counts are always whole. */
const LISTED = 20;

/** What a snapshot restore discards, diffed from the state as it is now against the snapshot (R13). */
export interface DiscardSummary {
  /** Inbound messages the snapshot never received: they are lost. */
  readonly inbound: DiscardedRows;
  /** Inbound messages handled since, still waiting in the snapshot: they run again. */
  readonly rerun: DiscardedRows;
  /** Of those, scheduled task firings: the task acts again. */
  readonly taskFirings: DiscardedRows;
  /** Replies delivered since that the snapshot had not delivered yet: they are delivered again. */
  readonly redelivered: DiscardedRows;
  /** Rows the central database gained since, by table. */
  readonly centralRows: readonly { readonly table: string; readonly count: number }[];
  /** Memory and group files added, changed, or deleted since. */
  readonly files: { readonly count: number; readonly paths: readonly string[] };
  /** Agent groups created since: their OneCLI agents and grants stay in the vault, orphaned. */
  readonly orphanedAgents: readonly string[];
}

export interface DiscardedRows {
  readonly count: number;
  /** The first of them, by ID. */
  readonly ids: readonly string[];
}

/** Why a rollback restores the snapshot rather than only the code. */
export type SnapshotReason = 'central_schema' | 'session_schema' | 'requested';

/** What the operator sees before a snapshot restore, and confirms (R13). */
export interface RollbackPreview {
  readonly instanceId: string;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** When the update being undone stopped the assistant: the snapshot is its state as of then. */
  readonly snapshotAt: string;
  readonly reason: SnapshotReason;
  readonly discarded: DiscardSummary;
  /** Where the discarded state is kept, as the release left, until the next update or removal. */
  readonly keptAt: string;
}

export interface RollbackRequest {
  /** `--snapshot`: restore the snapshot even when neither schema moved. */
  readonly snapshot?: boolean;
  /** Shows what a snapshot restore discards, before it is confirmed. */
  readonly present: (preview: RollbackPreview) => void;
  /** Asks to restore the snapshot; absent when nobody can be asked. */
  readonly confirm?: (preview: RollbackPreview) => Promise<boolean>;
}

/** Where a rollback left the assistant. */
export type RollbackOutcome =
  | {
      readonly kind: 'rolled_back';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      readonly mode: RollbackMode;
      /** The snapshot restored in snapshot mode; in code-only mode, the one kept unused. */
      readonly snapshotAt: string;
      /** Where the release left is kept, whole. */
      readonly keptAt: string;
    }
  /** An update not yet swapped was discarded; `release` runs again. */
  | { readonly kind: 'update_discarded'; readonly release: ReleaseCoordinates; readonly discarded: ReleaseCoordinates }
  /** The follow-ups an earlier rollback left were run. */
  | { readonly kind: 'follow_ups_finished'; readonly release: ReleaseCoordinates }
  /** The snapshot restore was declined; the assistant stays on `release` as before. */
  | { readonly kind: 'declined'; readonly release: ReleaseCoordinates };

function releaseLine(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

/** The files a rollback works with, beside the live checkout. */
interface RollbackPlaces {
  readonly live: string;
  readonly previous: string;
  readonly previousCheckout: string;
  /** Where the kept release's own state is set aside while another is carried into its checkout. */
  readonly state: string;
  readonly outgoing: string;
  readonly outgoingCheckout: string;
  /** Where, after the swap, what `previous/` held besides its checkout is kept. */
  readonly restored: string;
  /** The failed run's logs, when a rollback goes back. */
  readonly failedLogs: string;
  /** The receipt a recorded rollback leaves beside the release it left. */
  readonly receipt: string;
}

function rollbackPlaces(host: CutoverHost): RollbackPlaces {
  const { paths, instanceId } = host.operation;
  const previous = paths.releaseRoot(instanceId, 'previous');
  const outgoing = paths.releaseRoot(instanceId, 'outgoing');
  return {
    live: host.reservation.checkout_realpath,
    previous,
    previousCheckout: paths.releaseCheckoutRoot(instanceId, 'previous'),
    state: setAsideStateRoot(previous),
    outgoing,
    outgoingCheckout: paths.releaseCheckoutRoot(instanceId, 'outgoing'),
    restored: restoredReleaseRoot(paths, instanceId),
    failedLogs: path.join(outgoing, 'failed-logs'),
    receipt: path.join(outgoing, 'rollback.json'),
  };
}

/** One rollback, from the release live now to the one kept. */
interface Rollback extends CutoverHost {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly releases: RollbackReleases;
  /** The reservation with the restored release overlaid: what must serve once it is live. */
  readonly restoredView: InstanceReservation;
  readonly places: RollbackPlaces;
  readonly request: RollbackRequest;
  /**
   * Whether giving the rollback up before its swap starts the live release
   * again: unless this rollback found it stopped. One continued from an
   * earlier attempt, which stopped it, always does.
   */
  readonly resumeLive: boolean;
}

function rollbackOf(
  host: CutoverHost,
  from: ReleaseCoordinates,
  to: ReleaseCoordinates,
  restoreSetAside: boolean,
  request: RollbackRequest,
  resumeLive = true,
): Rollback {
  return {
    ...host,
    from,
    to,
    releases: { from: from.deployed_commit, to: to.deployed_commit, restoreSetAside },
    restoredView: reservationAt(host.reservation, to),
    places: rollbackPlaces(host),
    request,
    resumeLive,
  };
}

function rollbackOfRecord(host: CutoverHost, record: OperationRecord, request: RollbackRequest): Rollback {
  return rollbackOf(host, record.from, record.to, record.commit_point === 'record', request);
}

const STOP_LABEL = 'Stopping the assistant for the rollback…';

/**
 * The kept previous release (R15): its manifest must name this assistant,
 * and its checkout's marker the same assistant and release, with its receipt
 * beside it. Refuses, naming why, when none is kept. Only reads, so `status`
 * offers a rollback exactly when this would allow one.
 */
export async function readKeptPreviousRelease(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<KeptReleaseManifest> {
  const root = paths.releaseRoot(instanceId, 'previous');
  const checkout = paths.releaseCheckoutRoot(instanceId, 'previous');
  const unavailable = (why: string): GwsEaError =>
    new GwsEaError('rollback_unavailable', `Assistant ${instanceId} ${why}, so there is nothing to roll back to.`);
  if (!(await exists(checkout))) throw unavailable('keeps no previous release');
  let manifest: KeptReleaseManifest;
  try {
    manifest = await readKeptReleaseManifest(root, instanceId);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw unavailable('keeps a previous release without its manifest');
    throw error;
  }
  const marker = await readInstanceMarkerFile(instanceMarkerFile(checkout));
  if (marker.instance_id !== instanceId) {
    throw new GwsEaError(
      'kept_release_mismatch',
      `The release kept in ${checkout} belongs to another assistant, so it cannot be restored into ${instanceId}.`,
    );
  }
  if (marker.deployed_commit !== manifest.release.deployed_commit) {
    throw new GwsEaError(
      'invalid_kept_release',
      `The release kept in ${checkout} is at ${shortCommit(marker.deployed_commit)}, not the ${shortCommit(manifest.release.deployed_commit)} its manifest names.`,
    );
  }
  if (!(await isRegularFile(keptReleaseFiles(root).receipt)))
    throw unavailable('keeps a previous release without its receipt');
  return manifest;
}

/** Where the kept release's snapshot is: set aside, or still in its checkout. */
async function snapshotRoot(rollback: Rollback): Promise<string> {
  return (await exists(rollback.places.state)) ? rollback.places.state : rollback.places.previousCheckout;
}

/** Which schema moved between two manifests (KTD5): the central migrations, else the session tables and columns. */
export function sameSchema(left: SnapshotManifest, right: SnapshotManifest): 'same' | SnapshotReason {
  const sorted = (names: readonly string[]): string => JSON.stringify([...names].sort());
  if (sorted(left.central_migrations) !== sorted(right.central_migrations)) return 'central_schema';
  const tables = (manifest: SnapshotManifest): string =>
    JSON.stringify(
      Object.entries(manifest.session_tables)
        .map(([table, columns]) => [table, [...columns].sort()] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  return tables(left) === tables(right) ? 'same' : 'session_schema';
}

/** The rollback's mode (KTD5): snapshot when asked, or when either schema moved since the snapshot; else code only. */
function decideMode(
  current: SnapshotManifest,
  snapshot: SnapshotManifest,
  requested: boolean,
): { readonly mode: RollbackMode; readonly reason: SnapshotReason | undefined } {
  const moved = sameSchema(current, snapshot);
  if (moved !== 'same') return { mode: 'snapshot', reason: moved };
  return requested ? { mode: 'snapshot', reason: 'requested' } : { mode: 'code_only', reason: undefined };
}

/**
 * Read a session database, or `empty` when the session has none. Session
 * databases keep a rollback journal (`journal_mode=DELETE`), so a read-only
 * open leaves nothing beside them.
 */
function withDatabase<T>(file: string, empty: T, read: (database: Database.Database) => T): T {
  if (!existsSync(file)) return empty;
  const database = new Database(file, { readonly: true, fileMustExist: true });
  try {
    return read(database);
  } finally {
    database.close();
  }
}

function hasTable(database: Database.Database, table: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table) !== undefined;
}

/** Every session directory under a checkout, keyed `<agent group>/<session>`. */
async function sessions(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const base = path.join(root, 'data', 'v2-sessions');
  const directories = async (directory: string): Promise<string[]> => {
    try {
      return (await readdir(directory, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name);
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return [];
      throw error;
    }
  };
  for (const group of await directories(base)) {
    for (const session of await directories(path.join(base, group))) {
      found.set(`${group}/${session}`, path.join(base, group, session));
    }
  }
  return found;
}

interface InboundRow {
  readonly id: string;
  readonly kind: string;
  readonly status: string | null;
}

const WAITING = new Set(['pending', 'processing']);
const UNFINISHED = new Set(['pending', 'processing', 'paused']);

function columnsOf(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

/** A session's inbound messages, in order; a column an older session lacks reads as unknown. */
function inboundRows(file: string): Map<string, InboundRow> {
  return withDatabase(file, new Map<string, InboundRow>(), (database) => {
    if (!hasTable(database, 'messages_in')) return new Map();
    const columns = columnsOf(database, 'messages_in');
    const optional = (column: string): string => (columns.has(column) ? column : `NULL AS ${column}`);
    const rows = database
      .prepare(
        `SELECT id, ${optional('kind')}, ${optional('status')} FROM messages_in ORDER BY ${columns.has('seq') ? 'seq, ' : ''}rowid`,
      )
      .all() as Array<{ id: string; kind: string | null; status: string | null }>;
    return new Map(rows.map((row) => [row.id, { id: row.id, kind: row.kind ?? 'unknown', status: row.status }]));
  });
}

function deliveredIds(file: string): Set<string> {
  return withDatabase(file, new Set<string>(), (database) => {
    if (!hasTable(database, 'delivered')) return new Set();
    const rows = database.prepare("SELECT message_out_id FROM delivered WHERE status = 'delivered'").all() as Array<{
      message_out_id: string;
    }>;
    return new Set(rows.map((row) => row.message_out_id));
  });
}

function outboundIds(file: string): string[] {
  return withDatabase(file, [] as string[], (database) => {
    if (!hasTable(database, 'messages_out')) return [];
    return (database.prepare('SELECT id FROM messages_out ORDER BY seq, id').all() as Array<{ id: string }>).map(
      (row) => row.id,
    );
  });
}

class RowTally {
  count = 0;
  readonly ids: string[] = [];

  add(id: string): void {
    this.count += 1;
    if (this.ids.length < LISTED) this.ids.push(id);
  }

  get rows(): DiscardedRows {
    return { count: this.count, ids: [...this.ids] };
  }
}

/** The key of each row of a table: its primary key, or the whole row when it has none. */
function rowKeys(database: Database.Database, table: string): Set<string> {
  const quoted = `"${table.replaceAll('"', '""')}"`;
  const columns = database.prepare('SELECT name, pk FROM pragma_table_info(?)').all(table) as Array<{
    name: string;
    pk: number;
  }>;
  const key = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk);
  const selected = (key.length > 0 ? key : columns).map((column) => `"${column.name.replaceAll('"', '""')}"`);
  if (selected.length === 0) return new Set();
  const rows = database
    .prepare(`SELECT ${selected.join(', ')} FROM ${quoted}`)
    .raw()
    .all() as unknown[][];
  return new Set(rows.map((row) => JSON.stringify(row)));
}

function userTables(database: Database.Database): string[] {
  return (
    database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((row) => row.name);
}

/**
 * Read a checkout's central database from a consistent copy in a private
 * temporary directory: SQLite would leave side files beside a WAL database it
 * opens in place, even read-only, and the copy never changes what it copies.
 */
async function withCentralCopy<T>(checkoutRoot: string, read: (database: Database.Database) => T): Promise<T> {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-rollback-'));
  try {
    const copy = path.join(directory, 'v2.db');
    await backupCentralDatabase(checkoutRoot, copy);
    const database = new Database(copy, { readonly: true, fileMustExist: true });
    try {
      return read(database);
    } finally {
      database.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function agentGroups(database: Database.Database): string[] {
  if (!hasTable(database, 'agent_groups')) return [];
  return (database.prepare('SELECT id FROM agent_groups ORDER BY id').all() as Array<{ id: string }>).map(
    (row) => row.id,
  );
}

/** Rows the central database gained since the snapshot, by table, and the agent groups among them. */
async function centralGains(
  current: string,
  snapshot: string,
): Promise<Pick<DiscardSummary, 'centralRows' | 'orphanedAgents'>> {
  const before = await withCentralCopy(snapshot, (database) => ({
    keys: new Map(userTables(database).map((table) => [table, rowKeys(database, table)])),
    groups: new Set(agentGroups(database)),
  }));
  return withCentralCopy(current, (database) => {
    const centralRows: Array<{ table: string; count: number }> = [];
    for (const table of userTables(database)) {
      const known = before.keys.get(table) ?? new Set<string>();
      let count = 0;
      for (const key of rowKeys(database, table)) if (!known.has(key)) count += 1;
      if (count > 0) centralRows.push({ table, count });
    }
    return { centralRows, orphanedAgents: agentGroups(database).filter((id) => !before.groups.has(id)) };
  });
}

/** Every file under `groups/`, by path relative to it, with what it holds. */
async function groupFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>();
  const base = path.join(root, 'groups');
  const walk = async (directory: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return;
      throw error;
    }
    for (const entry of entries) {
      const target = path.join(directory, entry.name);
      const relative = path.relative(base, target);
      if (entry.isDirectory()) await walk(target);
      else if (entry.isSymbolicLink()) found.set(relative, `link ${await readlink(target)}`);
      else if (entry.isFile()) {
        found.set(
          relative,
          createHash('sha256')
            .update(await readFile(target))
            .digest('hex'),
        );
      }
    }
  };
  await walk(base);
  return found;
}

/**
 * What restoring `snapshot` over `current` discards: inbound messages it
 * never received, messages handled since that run again (and which of those
 * are task firings), replies delivered since that are delivered again, the
 * central rows added since, the memory and group files changed since, and the
 * agent groups created since, whose OneCLI agents and grants would be left
 * orphaned. Both are only read.
 */
export async function summarizeDiscard(current: string, snapshot: string): Promise<DiscardSummary> {
  const inbound = new RowTally();
  const rerun = new RowTally();
  const taskFirings = new RowTally();
  const redelivered = new RowTally();
  const [currentSessions, snapshotSessions] = await Promise.all([sessions(current), sessions(snapshot)]);
  for (const [key, directory] of currentSessions) {
    const kept = snapshotSessions.get(key);
    const now = inboundRows(path.join(directory, 'inbound.db'));
    const then = kept ? inboundRows(path.join(kept, 'inbound.db')) : new Map<string, InboundRow>();
    for (const row of now.values()) {
      const before = then.get(row.id);
      if (!before) inbound.add(row.id);
      else if (WAITING.has(before.status ?? 'pending') && !UNFINISHED.has(row.status ?? 'pending')) {
        rerun.add(row.id);
        if (row.kind === 'task') taskFirings.add(row.id);
      }
    }
    if (!kept) continue;
    const deliveredNow = deliveredIds(path.join(directory, 'inbound.db'));
    const deliveredThen = deliveredIds(path.join(kept, 'inbound.db'));
    for (const id of outboundIds(path.join(kept, 'outbound.db'))) {
      if (!deliveredThen.has(id) && deliveredNow.has(id)) redelivered.add(id);
    }
  }
  const [filesNow, filesThen] = await Promise.all([groupFiles(current), groupFiles(snapshot)]);
  const changed = [...new Set([...filesNow.keys(), ...filesThen.keys()])]
    .filter((file) => filesNow.get(file) !== filesThen.get(file))
    .sort();
  return {
    inbound: inbound.rows,
    rerun: rerun.rows,
    taskFirings: taskFirings.rows,
    redelivered: redelivered.rows,
    ...(await centralGains(current, snapshot)),
    files: { count: changed.length, paths: changed.slice(0, LISTED) },
  };
}

/** Nothing recorded since the snapshot would be lost. */
export function isLossless(summary: DiscardSummary): boolean {
  return (
    summary.inbound.count === 0 &&
    summary.rerun.count === 0 &&
    summary.redelivered.count === 0 &&
    summary.centralRows.length === 0 &&
    summary.files.count === 0 &&
    summary.orphanedAgents.length === 0
  );
}

function listed(rows: DiscardedRows): string {
  const more = rows.count > rows.ids.length ? `, and ${rows.count - rows.ids.length} more` : '';
  return rows.count === 0 ? 'none' : `${rows.count} (${rows.ids.map(printableName).join(', ')}${more})`;
}

const REASONS: Readonly<Record<SnapshotReason, string>> = {
  central_schema: 'the update migrated the central database',
  session_schema: "the update changed its session databases' schema",
  requested: 'it was asked for',
};

/** A snapshot restore's preview, one fact per line (R13), with times in `timezone`. */
export function rollbackPreviewLines(preview: RollbackPreview, timezone: string): string[] {
  const { discarded } = preview;
  const lines = [
    `Assistant: ${preview.instanceId}`,
    `From: ${releaseLine(preview.from)}`,
    `To: ${releaseLine(preview.to)}`,
    `Restores the snapshot taken ${formatLocalTime(preview.snapshotAt, timezone)}, because ${REASONS[preview.reason]}.`,
  ];
  if (isLossless(discarded)) return [...lines, 'Nothing recorded since the snapshot is lost: the restore is lossless.'];
  const tables = discarded.centralRows.map(({ table, count }) => `${printableName(table)} ${count}`).join(', ');
  const more = discarded.files.count > discarded.files.paths.length ? ', …' : '';
  return [
    ...lines,
    'It discards what the assistant recorded since:',
    `  Inbound messages lost: ${listed(discarded.inbound)}`,
    `  Messages that run again: ${listed(discarded.rerun)}`,
    `  Scheduled task firings that repeat: ${listed(discarded.taskFirings)}`,
    `  Replies delivered again: ${listed(discarded.redelivered)}`,
    `  Central rows added since: ${tables || 'none'}`,
    `  Memory and group files changed since: ${discarded.files.count === 0 ? 'none' : `${discarded.files.count} (${discarded.files.paths.map(printableName).join(', ')}${more})`}`,
    `  OneCLI agents left orphaned with their grants: ${discarded.orphanedAgents.map(printableName).join(', ') || 'none'}`,
    `The discarded state is kept in ${preview.keptAt} until the next update or removal.`,
  ];
}

/** What a finished rollback did, as one sentence tail, with times in `timezone`. */
export function describeRollback(outcome: RollbackOutcome, timezone: string): string {
  switch (outcome.kind) {
    case 'rolled_back':
      return outcome.mode === 'code_only'
        ? `the assistant runs ${releaseLine(outcome.to)} again, with everything it recorded since kept.`
        : `the assistant runs ${releaseLine(outcome.to)} again on its snapshot from ${formatLocalTime(outcome.snapshotAt, timezone)}; what it recorded since is kept in ${outcome.keptAt}.`;
    case 'update_discarded':
      return `the staged ${releaseLine(outcome.discarded)} was discarded, and the assistant runs ${releaseLine(outcome.release)} again.`;
    case 'follow_ups_finished':
      return `the assistant runs ${releaseLine(outcome.release)}, and its rollback is finished.`;
    case 'declined':
      return `the snapshot restore was declined, and the assistant stays on ${releaseLine(outcome.release)} as before.`;
  }
}

/** A snapshot needs confirmation nobody can give. */
function confirmationRequired(instanceId: string): GwsEaError {
  return new GwsEaError(
    'input_required',
    `Rolling back assistant ${instanceId} restores its pre-update snapshot, which needs confirmation: pass --yes, or run gws-ea rollback in a terminal to be asked.`,
  );
}

/** Ask for a snapshot restore, showing what it discards; undefined when nobody can be asked. */
async function confirmSnapshot(
  rollback: Rollback,
  reason: SnapshotReason,
  current: string,
): Promise<boolean | undefined> {
  const { paths, instanceId } = rollback.operation;
  const manifest = await readKeptReleaseManifest(paths.releaseRoot(instanceId, 'previous'), instanceId);
  const preview: RollbackPreview = {
    instanceId,
    from: rollback.from,
    to: rollback.to,
    snapshotAt: manifest.snapshot_at,
    reason,
    discarded: await summarizeDiscard(current, await snapshotRoot(rollback)),
    keptAt: rollback.places.outgoing,
  };
  rollback.request.present(preview);
  return rollback.request.confirm ? rollback.request.confirm(preview) : undefined;
}

/** What the stop found: when it happened, whether it was graceful, the schema, and the mode it decides. */
interface Stopped {
  readonly at: string;
  readonly graceful: boolean;
  readonly manifest: SnapshotManifest;
  readonly mode: RollbackMode;
}

/** How deciding went: a mode, or a snapshot restore declined or that nobody can confirm. */
type Decision =
  | { readonly outcome: 'decided'; readonly stopped: Stopped }
  | { readonly outcome: 'declined' | 'unconfirmable' };

/**
 * Stop the live host and its agents, prove its checkout quiet and settle its
 * databases (KTD18), and decide the mode from the schema as it is now (KTD5).
 * A snapshot restore is shown and confirmed here, with the assistant stopped
 * so what it discards is exact.
 */
async function stopAndDecide(rollback: Rollback): Promise<Decision> {
  const { places, reporter } = rollback;
  await stopCutoverHost(rollback, STOP_LABEL);
  const at = new Date().toISOString();
  const settled = await runStep(
    reporter,
    { id: 'prove_quiet', label: 'Checking nothing still uses its state…' },
    async () => {
      await assertCheckoutQuiet(quietCheckoutOf(rollback, places.live), cutoverQuiescence(rollback));
      const { graceful } = settleCheckoutDatabases(places.live);
      return { graceful, manifest: readSchemaManifest(places.live) };
    },
  );
  const { mode, reason } = decideMode(
    settled.manifest,
    readSchemaManifest(await snapshotRoot(rollback)),
    rollback.request.snapshot === true,
  );
  if (mode === 'snapshot' && reason) {
    const confirmed = await confirmSnapshot(rollback, reason, places.live);
    if (confirmed !== true) return { outcome: confirmed === undefined ? 'unconfirmable' : 'declined' };
  }
  return { outcome: 'decided', stopped: { at, graceful: settled.graceful, manifest: settled.manifest, mode } };
}

/** gws-ea's `.env` keys as a kept release holds them. */
async function keptHostEnvironment(file: string): Promise<Record<string, string>> {
  const value = await readOwnerOnlyJson(file, 'Kept host environment', 'invalid_kept_release');
  const owned: readonly string[] = INSTANCE_HOST_ENV_KEYS;
  if (!isRecord(value)) throw new GwsEaError('invalid_kept_release', `${file} holds no environment`);
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!owned.includes(key) || typeof entry !== 'string') {
      throw new GwsEaError('invalid_kept_release', `${file} holds a key gws-ea does not own: ${key}`);
    }
    environment[key] = entry;
  }
  return environment;
}

/**
 * Make the kept release ready to take over, with the live one stopped: set
 * its own state aside (KTD19), carry in the live state (code only) or a copy
 * of its own snapshot, put back its own marker and runtime record, re-apply
 * its own `.env` keys, and stamp its tripwire with its own script. Only then
 * are the outgoing release's files kept in `outgoing/`, replacing whatever a
 * release left there before (KTD19). Run again, all of it runs again.
 */
async function prepareRestored(rollback: Rollback, stopped: Stopped): Promise<void> {
  const { places, operation, runtime, dependencies, reservation } = rollback;
  const { paths, instanceId } = operation;
  await setAsideState(places.previousCheckout, places.state);
  await carryState(stopped.mode === 'code_only' ? places.live : places.state, places.previousCheckout);
  await copyReleaseRecords(places.state, places.previousCheckout);
  const kept = keptReleaseFiles(places.previous);
  const environment = await keptHostEnvironment(kept.hostEnvironment);
  if (Object.keys(environment).length > 0) dependencies.upsertEnvVars(environment, places.previousCheckout);
  await stampUpgradeState(places.previousCheckout, rollback.run, {
    ...dockerEnvironment(runtime, dependencies),
    NANOCLAW_INSTALL_ID: runtime.install_id,
  });
  const definition = instanceServiceDefinitionFile(runtime, cutoverServiceDependencies(rollback));
  await keepReleaseFiles(places.outgoing, {
    manifest: { schema_version: 1, instance_id: instanceId, release: rollback.from, snapshot_at: stopped.at },
    receipt: paths.releasePreflightFile(instanceId),
    compose: rollback.onecli.composeFile,
    serviceDefinition: (await isRegularFile(definition)) ? definition : undefined,
    hostEnvironment: readInstanceHostEnvironment(reservation.checkout_realpath),
  });
}

/**
 * Give up a rollback before its swap, whether its snapshot restore was not
 * confirmed or its preparation failed: the kept release gets its own state
 * back (an earlier attempt may have set it aside), the half-built outgoing
 * files go, the live release is started again unless this rollback found it
 * stopped, and the rollback is withdrawn, giving back the update it replaced.
 */
async function abandonPreparation(rollback: Rollback): Promise<void> {
  await restoreSetAsideState(rollback.places.previousCheckout, rollback.places.state);
  await rm(`${rollback.places.outgoing}.building`, { recursive: true, force: true });
  if (rollback.resumeLive) await rollback.service.start();
  await withdrawRollback(rollback.operation);
}

/**
 * The follow-ups a rollback runs once recorded (KTD2): the images its retag
 * displaced, released by ID; and for a rollback of the recorded release, the
 * per-group images rebuilt on the restored base with those they displace, a
 * previous release an update set aside and never deleted. A rollback reverting
 * an unrecorded update rebuilt nothing, since that update's follow-ups never
 * ran, and puts its set-aside release back.
 */
async function rollbackFollowUps(
  rollback: Rollback,
  record: OperationRecord,
  mode: RollbackMode,
): Promise<OperationFollowUp[]> {
  const moved = new Set(record.images.map((image) => image.image_id));
  const displaced: OperationFollowUp[] = record.images
    .flatMap((image) => (image.displaced_image_id === null ? [] : [image.displaced_image_id]))
    .filter((id) => !moved.has(id))
    .map((id) => ({ kind: 'delete_image', image_id: id }));
  if (rollback.releases.restoreSetAside) return displaced;
  const { paths, instanceId } = rollback.operation;
  const base = getInstallScopedNames(rollback.runtime.install_id).containerImageBase;
  // The groups the restored release runs are those of the central database it takes over.
  const database = mode === 'code_only' ? rollback.places.live : rollback.places.state;
  const rebuilds: OperationFollowUp[] = [];
  for (const group of readDerivedImageGroups(database, base)) {
    rebuilds.push({ kind: 'rebuild_group_image', agent_group_id: group.id });
    const id = await imageIdOf(rollback, `${base}:${group.id}`);
    if (id) displaced.push({ kind: 'delete_image', image_id: id });
  }
  const superseded: OperationFollowUp[] = (await exists(paths.releaseRoot(instanceId, 'superseded')))
    ? [{ kind: 'delete_release', release: 'superseded_previous' }]
    : [];
  return [...rebuilds, ...displaced, ...superseded];
}

/** A rollback given up before its swap: nothing changed, and the release it would have left runs again. */
function notPrepared(rollback: Rollback, cause: unknown): GwsEaError {
  return new GwsEaError(
    'rollback_not_prepared',
    `${safeErrorMessage(cause)} The rollback to ${releaseLine(rollback.to)} stopped before changing anything, and the assistant stays on ${releaseLine(rollback.from)}.`,
    { cause, ...(cause instanceof GwsEaError && cause.details ? { details: cause.details } : {}) },
  );
}

/**
 * `staged` or `stopped` → `swapping`: stop, decide, and prepare the kept
 * release, then record the mode. Up to the swap nothing the rollback does is
 * lost if it stops: a snapshot restore declined, or nobody there to confirm
 * it, or any failure gives the rollback up (see `abandonPreparation`).
 * Returns undefined when it was declined.
 */
async function prepareRollback(rollback: Rollback, record: OperationRecord): Promise<OperationRecord | undefined> {
  let stopped: Stopped;
  try {
    await assertCarriable(rollback.places.live);
    await assertCarriable(rollback.places.previousCheckout);
    const decision = await stopAndDecide(rollback);
    if (decision.outcome !== 'decided') {
      await abandonPreparation(rollback);
      if (decision.outcome === 'unconfirmable') throw confirmationRequired(rollback.operation.instanceId);
      return undefined;
    }
    stopped = decision.stopped;
    await advanceOperation(rollback.operation, 'stopped', {
      stop: { at: stopped.at, graceful: stopped.graceful },
      manifest: stopped.manifest,
    });
    await runStep(
      rollback.reporter,
      {
        id: 'prepare_restored',
        label:
          stopped.mode === 'code_only'
            ? 'Carrying conversations, memory, and settings to the previous release…'
            : 'Restoring the pre-update snapshot…',
      },
      () => prepareRestored(rollback, stopped),
    );
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'input_required') throw error;
    await abandonPreparation(rollback);
    throw notPrepared(rollback, error);
  }
  return advanceOperation(rollback.operation, 'swapping', {
    mode: stopped.mode,
    follow_ups: planFollowUps(record.follow_ups, await rollbackFollowUps(rollback, record, stopped.mode)),
  });
}

/**
 * Take a rollback's swap back to `stopped` when it never moved the live
 * checkout, dropping its mode (see `reverseRollbackSwapBeforeLiveMoved`): the
 * release it leaves may have run from the live path since, so the mode is
 * decided, and the kept release prepared, again. Returns the record then, or
 * undefined when the live checkout moved.
 */
async function unwindSwap(rollback: Rollback): Promise<OperationRecord | undefined> {
  const { operation, dependencies } = rollback;
  const reversed = await reverseRollbackSwapBeforeLiveMoved(
    operation.paths,
    operation.instanceId,
    rollback.releases,
    dependencies.rename ? { rename: dependencies.rename } : {},
  );
  return reversed ? advanceOperation(operation, 'stopped') : undefined;
}

/**
 * `swapping` → `swapped`: with the host stopped (again, in case the OS
 * started one) and the checkout at the live path proven quiet, swap the
 * releases from wherever an interrupted swap left them.
 */
async function swapRollback(rollback: Rollback): Promise<OperationRecord> {
  const { places, operation, dependencies } = rollback;
  await keepCutoverHostStopped(rollback);
  await runStep(rollback.reporter, { id: 'swap_releases', label: 'Switching to the previous release…' }, async () => {
    const live = (await exists(places.live)) ? places.live : places.outgoingCheckout;
    await assertCheckoutQuiet(quietCheckoutOf(rollback, live), cutoverQuiescence(rollback));
    await finishRollbackSwap(
      operation.paths,
      operation.instanceId,
      rollback.releases,
      dependencies.rename ? { rename: dependencies.rename } : {},
    );
  });
  return advanceOperation(operation, 'swapped');
}

/** The OneCLI versions the live receipt records; releases never differ in them (R9). */
async function livePins(rollback: Rollback, release: ReleaseCoordinates): Promise<OnecliPins> {
  const view = reservationAt(rollback.reservation, release);
  const { onecli } = await readDeployedSetup(rollback.operation.paths, view, [release.deployed_commit]);
  return { gateway: onecli.gateway, cli: onecli.cli };
}

async function composeGateway(file: string): Promise<string> {
  return parseOnecliComposeImages(await readOwnerOnlyFile(file)).gateway;
}

/** Whether the restored release runs another gateway than the one the release left ran (KTD8). */
async function rollbackChangesGateway(rollback: Rollback): Promise<boolean> {
  const { places } = rollback;
  const [left, restored] = await Promise.all([
    composeGateway(keptReleaseFiles(places.outgoing).compose),
    composeGateway(keptReleaseFiles(places.restored).compose),
  ]);
  return left !== restored;
}

/** Put a kept release's Compose file and service definition back, recreating the gateway when it differs. */
async function restoreReleaseFiles(rollback: Rollback, keptRoot: string, release: ReleaseCoordinates): Promise<void> {
  const kept = keptReleaseFiles(keptRoot);
  const compose = await readOwnerOnlyFile(kept.compose);
  if (parseOnecliComposeImages(compose).gateway !== (await composeGateway(rollback.onecli.composeFile))) {
    await runStep(rollback.reporter, { id: 'restore_gateway', label: 'Recreating the credential gateway…' }, async () =>
      cutoverOnecli(rollback).restore(rollback.onecli, await livePins(rollback, release), compose),
    );
  }
  if (await isRegularFile(kept.serviceDefinition)) {
    await restoreInstanceServiceDefinition(
      rollback.runtime,
      await readFile(kept.serviceDefinition, 'utf8'),
      cutoverServiceDependencies(rollback),
    );
  }
}

/**
 * `swapped` → `started`: stop any host the OS started meanwhile; drop an
 * unrecorded update's `:next` tag, then move each agent image tag to the
 * image the restored release ran (recorded by ID before the rollback began),
 * every image the moves name held meanwhile (KTD19); put back its gateway and
 * service definition; start the host.
 */
async function startRestored(rollback: Rollback, record: OperationRecord): Promise<OperationRecord> {
  await keepCutoverHostStopped(rollback);
  await runStep(rollback.reporter, { id: 'move_images', label: "Moving the assistant's images back…" }, () =>
    moveRecordedImages(rollback, record.images, async () => {
      const next = nextAgentImage(rollback.runtime);
      // Held already, so removing the tag never deletes the image the update built: its follow-up releases it.
      if (rollback.releases.restoreSetAside && (await imageIdOf(rollback, next))) {
        await cutoverDocker(rollback, ['image', 'rm', next]);
      }
      for (const image of record.images) await cutoverDocker(rollback, ['tag', image.image_id, image.tag]);
    }),
  );
  await restoreReleaseFiles(rollback, rollback.places.restored, rollback.to);
  await runStep(rollback.reporter, { id: 'start_release', label: 'Starting the previous release…' }, () =>
    rollback.service.start(),
  );
  return advanceOperation(rollback.operation, 'started');
}

/** `started` → `verified`: the restored release serves (see `verifyServingRelease`). */
async function verifyRestored(rollback: Rollback, record: OperationRecord): Promise<OperationRecord> {
  await runStep(rollback.reporter, { id: 'verify_release', label: 'Checking the previous release serves…' }, async () =>
    verifyServingRelease(rollback, {
      view: rollback.restoredView,
      pins: await livePins(rollback, rollback.to),
      leaseHeld: record.stop?.graceful === false,
      gatewayChanged: await rollbackChangesGateway(rollback),
      subject: 'The restored release',
    }),
  );
  return advanceOperation(rollback.operation, 'verified');
}

/**
 * The rollback's receipt, beside the release it left: its mode, stop and
 * snapshot times, both schemas, and in snapshot mode what it discarded, by
 * count and ID. Written just before the commit, from state both releases
 * hold frozen.
 */
async function writeRollbackReceipt(rollback: Rollback, record: OperationRecord): Promise<void> {
  const { places, operation } = rollback;
  const snapshot = setAsideStateRoot(places.restored);
  const manifest = await readKeptReleaseManifest(places.restored, operation.instanceId);
  await writePrivate(places.receipt, {
    schema_version: 1,
    instance_id: operation.instanceId,
    from: rollback.from,
    to: rollback.to,
    mode: record.mode,
    stopped_at: record.stop?.at ?? null,
    snapshot_at: manifest.snapshot_at,
    schema: { left: record.manifest ?? null, restored: readSchemaManifest(snapshot) },
    discarded: record.mode === 'snapshot' ? await summarizeDiscard(places.outgoingCheckout, snapshot) : null,
  });
}

/**
 * Go back to the release a rollback left (KTD19), from whatever it got to:
 * the host stopped, every image tag moved back, the swap undone, the kept
 * release's own state put back (the failed run's logs kept in
 * `outgoing/failed-logs/`), and the left release's gateway and service
 * definition restored, then started again. Every step converges when run
 * again, so a return cut short is finished by the next `rollback --id`.
 */
async function returnToLeft(rollback: Rollback, record: OperationRecord): Promise<void> {
  const { places, operation, dependencies } = rollback;
  await beginOperationReturn(operation);
  await stopCutoverHost(rollback, STOP_LABEL);
  await runStep(rollback.reporter, { id: 'return', label: 'Going back to the release it left…' }, async () => {
    const live = (await exists(places.live)) ? places.live : places.outgoingCheckout;
    await assertCheckoutQuiet(quietCheckoutOf(rollback, live), cutoverQuiescence(rollback));
    await moveRecordedImages(rollback, record.images, async () => {
      for (const image of record.images) {
        if (image.displaced_image_id !== null) {
          await cutoverDocker(rollback, ['tag', image.displaced_image_id, image.tag]);
        }
      }
    });
    await reverseRollbackSwap(
      operation.paths,
      operation.instanceId,
      rollback.releases,
      dependencies.rename ? { rename: dependencies.rename } : {},
    );
    const logs = path.join(places.previousCheckout, 'logs');
    if ((await exists(places.state)) && (await exists(logs)) && !(await exists(places.failedLogs))) {
      await rename(logs, places.failedLogs);
    }
    await restoreSetAsideState(places.previousCheckout, places.state);
    await rm(places.receipt, { force: true });
    await restoreReleaseFiles(rollback, places.outgoing, rollback.from);
  });
  await completeOperationReturn(operation);
  await rollback.service.start();
  await withdrawRollback(operation);
}

/** A rollback that failed and went back, reported with where the assistant is and what can be done next. */
function returned(rollback: Rollback, mode: RollbackMode | undefined, cause: unknown): GwsEaError {
  const id = rollback.operation.instanceId;
  const next =
    mode === 'code_only'
      ? ` To restore the pre-update snapshot instead, run gws-ea rollback --id ${id} --snapshot.`
      : '';
  const where = rollback.releases.restoreSetAside
    ? `the assistant runs ${releaseLine(rollback.from)} again, which its update left unrecorded; continue the rollback with gws-ea rollback --id ${id}.`
    : `the assistant runs ${releaseLine(rollback.from)} again.`;
  return new GwsEaError(
    'rollback_failed',
    `${cause === undefined ? 'An earlier attempt failed.' : safeErrorMessage(cause)} The rollback to ${releaseLine(rollback.to)} went back: ${where} The failed run's logs are in ${rollback.places.failedLogs}.${next}`,
    { ...(cause === undefined ? {} : { cause }), details: { continueWith: `gws-ea rollback --id ${id}` } },
  );
}

/**
 * Run a rollback whose swap began until it is recorded. A failure once the
 * swap moved the live checkout goes back to the release it left; one before
 * changed nothing live, and gives the rollback up as a failure before its
 * swap does. One the registry already records stands (`assertNotCommitted`).
 */
async function finishRollback(rollback: Rollback, start: OperationRecord): Promise<void> {
  let record = start;
  try {
    for (;;) {
      switch (record.phase) {
        case 'staged':
        case 'stopped':
          throw new GwsEaError('operation_phase', `A rollback at ${record.phase} has not prepared its swap`);
        case 'swapping':
          record = await swapRollback(rollback);
          break;
        case 'swapped':
          record = await startRestored(rollback, record);
          break;
        case 'started':
          record = await verifyRestored(rollback, record);
          break;
        case 'verified':
          await runStep(rollback.reporter, { id: 'record_release', label: 'Recording the rollback…' }, async () => {
            await writeRollbackReceipt(rollback, record);
            await commitOperationRelease(rollback.operation);
          });
          return;
        case 'recorded':
          return;
      }
    }
  } catch (error) {
    await assertNotCommitted(rollback.operation, error);
    const failed = (await readOperationRecord(rollback.operation.paths, rollback.operation.instanceId)) ?? record;
    if (failed.phase === 'recorded') throw error;
    if (failed.phase === 'swapping' && !failed.returning && (await unwindSwap(rollback))) {
      await abandonPreparation(rollback);
      throw notPrepared(rollback, error);
    }
    try {
      await returnToLeft(rollback, failed);
    } catch (returnError) {
      throw new GwsEaError(
        'rollback_return_failed',
        `${safeErrorMessage(error)} Going back to ${releaseLine(rollback.from)} did not finish either: ${safeErrorMessage(returnError)} ` +
          `Continue it with gws-ea rollback --id ${rollback.operation.instanceId}.`,
        { cause: returnError },
      );
    }
    throw returned(rollback, failed.mode, error);
  }
}

/**
 * Carry a rollback record from its phase to recorded: prepare when it has not
 * swapped, or when an earlier run's swap never moved the live checkout, then
 * finish.
 */
async function runRollback(rollback: Rollback, start: OperationRecord): Promise<RollbackOutcome> {
  if (start.returning) {
    await returnToLeft(rollback, start);
    throw returned(rollback, start.mode, undefined);
  }
  const current = start.phase === 'swapping' ? ((await unwindSwap(rollback)) ?? start) : start;
  const record =
    current.phase === 'staged' || current.phase === 'stopped' ? await prepareRollback(rollback, current) : current;
  if (!record) return { kind: 'declined', release: rollback.from };
  const { mode } = record;
  if (!mode) {
    throw new GwsEaError('invalid_operation', `The rollback record at ${record.phase} names no rollback mode`);
  }
  await finishRollback(rollback, record);
  const { snapshot_at: snapshotAt } = await readKeptReleaseManifest(
    rollback.places.restored,
    rollback.operation.instanceId,
  );
  return {
    kind: 'rolled_back',
    from: rollback.from,
    to: rollback.to,
    mode,
    snapshotAt,
    keptAt: rollback.places.outgoing,
  };
}

/**
 * Discard an update that has not swapped anything: its staging goes, the
 * host it stopped starts again, and only then is its record deleted, so a
 * discard cut short is finished by the next `rollback --id`.
 */
async function discardUnswappedUpdate(host: CutoverHost, update: OperationRecord): Promise<RollbackOutcome> {
  const { operation, runtime, dependencies } = host;
  await runStep(host.reporter, { id: 'discard_staging', label: 'Removing the staged release…' }, () =>
    removeUpdateStaging(operation.paths, operation.instanceId, runtime, dependencies),
  );
  await runStep(host.reporter, { id: 'start', label: 'Starting the assistant…' }, () => host.service.start());
  await discardOperation(operation);
  return { kind: 'update_discarded', release: update.from, discarded: update.to };
}

/** The image moves that undo an update's retag: each tag back to the image it displaced (KTD7). */
function reversedMoves(update: OperationRecord): MovedImage[] {
  return update.images.flatMap((image) =>
    image.displaced_image_id === null || image.displaced_image_id === image.image_id
      ? []
      : [{ tag: image.tag, image_id: image.displaced_image_id, displaced_image_id: image.image_id }],
  );
}

/**
 * Revert an update that is unfinished (KTD2). Before its renames it is
 * discarded. At `swapping`, a swap that already put the release live is
 * finished, since that release may have run, and one that had not is undone
 * and discarded. From `swapped` on it is rolled back by R13, the rollback
 * replacing the update's record in one write so the gate never lifts.
 */
async function revertOpenUpdate(
  operation: InstanceOperation,
  update: OperationRecord,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  const host = await openCutoverHost(operation, dependencies);
  const { paths, instanceId } = operation;
  let record = update;
  if (record.phase === 'swapping') {
    await keepCutoverHostStopped(host);
    const releases = { from: record.from.deployed_commit, to: record.to.deployed_commit };
    const live = host.reservation.checkout_realpath;
    const liveCommit = (await exists(instanceMarkerFile(live)))
      ? (await readInstanceMarkerFile(instanceMarkerFile(live))).deployed_commit
      : undefined;
    const seams = dependencies.rename ? { rename: dependencies.rename } : {};
    if (liveCommit === record.to.deployed_commit) {
      await finishSwap(paths, instanceId, releases, seams);
      record = await advanceOperation(operation, 'swapped');
    } else {
      const outgoing = liveCommit === undefined ? paths.releaseCheckoutRoot(instanceId, 'previous') : live;
      await assertCheckoutQuiet(quietCheckoutOf(host, outgoing), cutoverQuiescence(host));
      await reverseSwap(paths, instanceId, releases, seams);
      record = await advanceOperation(operation, 'stopped');
    }
  }
  if (record.phase === 'staged' || record.phase === 'stopped') return discardUnswappedUpdate(host, record);
  const rollback = rollbackOf(host, record.to, record.from, true, request);
  const reverting = await beginOperation(operation, {
    kind: 'rollback',
    from: record.to,
    to: record.from,
    images: reversedMoves(record),
  });
  return runRollback(rollback, reverting);
}

/**
 * Roll the recorded release back to the one kept in `previous/` (R13, R15).
 * Every refusal comes before anything changes: no previous release, one of
 * another assistant, or its agent image gone. The mode is first judged while
 * the assistant serves, so a snapshot restore nobody can confirm is refused
 * before the stop; it is decided again, and confirmed, once stopped. A
 * rollback recorded with nothing else to follow up leaves no record, so the
 * `:previous` tag its cleanup had yet to drop is what says it is unfinished.
 */
async function rollBackRecorded(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  const host = await openCutoverHost(operation, dependencies);
  const { instanceId } = operation;
  if (await leftoverPreviousTag(host)) return { kind: 'follow_ups_finished', release: releaseOf(host.reservation) };
  const kept = await readKeptPreviousRelease(host.operation.paths, instanceId);
  const from = releaseOf(host.reservation);
  const to = kept.release;
  const live = await readInstanceMarkerFile(instanceMarkerFile(host.reservation.checkout_realpath));
  if (live.deployed_commit !== from.deployed_commit || to.deployed_commit === from.deployed_commit) {
    throw new GwsEaError(
      'rollback_unavailable',
      `Assistant ${instanceId} runs ${shortCommit(live.deployed_commit)}, and its kept release is ${shortCommit(to.deployed_commit)}, so there is nothing to roll back to.`,
    );
  }
  const base = getInstallScopedNames(host.runtime.install_id).containerImageBase;
  const [ran, previous] = await Promise.all([imageIdOf(host, `${base}:latest`), imageIdOf(host, `${base}:previous`)]);
  if (!previous || !ran) {
    throw new GwsEaError(
      'rollback_unavailable',
      `Assistant ${instanceId}'s agent image ${previous ? `${base}:latest` : `${base}:previous`} is missing, so ${releaseLine(to)} cannot run again.`,
    );
  }
  const rollback = rollbackOf(host, from, to, false, request, host.service.detect().active);
  const current = readSchemaManifest(host.reservation.checkout_realpath);
  const tentative = decideMode(current, readSchemaManifest(await snapshotRoot(rollback)), request.snapshot === true);
  if (tentative.mode === 'snapshot' && tentative.reason && !request.confirm) {
    await confirmSnapshot(rollback, tentative.reason, host.reservation.checkout_realpath);
    throw confirmationRequired(instanceId);
  }
  const record = await beginOperation(operation, {
    kind: 'rollback',
    from,
    to,
    images: ran === previous ? [] : [{ tag: `${base}:latest`, image_id: previous, displaced_image_id: ran }],
  });
  return runRollback(rollback, record);
}

/**
 * `rollback --id` (R13-R16): continue whatever this assistant's record says
 * is unfinished, or roll its recorded release back to the one kept. An open
 * update is reverted, an open rollback continued, a recorded rollback's
 * follow-ups left for the caller to run. The caller runs the follow-ups of a
 * recorded rollback (`finishFollowUps`).
 */
export async function rollBack(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  await assertInstanceCreated(paths, instanceId);
  const record = await readOperationRecord(paths, instanceId);
  if (record?.phase === 'recorded' && record.kind === 'rollback') {
    return { kind: 'follow_ups_finished', release: record.to };
  }
  if (record && record.phase !== 'recorded') {
    if (record.kind === 'update') return revertOpenUpdate(operation, record, dependencies, request);
    return runRollback(rollbackOfRecord(await openCutoverHost(operation, dependencies), record, request), record);
  }
  return rollBackRecorded(operation, dependencies, request);
}

/** An automatic rollback shows what a snapshot restore discards in its step log; the update's confirmation covers it. */
const AUTOMATIC: RollbackRequest = {
  present: (preview) => activeStep()?.write(`${rollbackPreviewLines(preview, localTimezone()).join('\n')}\n`),
  confirm: async () => true,
};

/** This machine's timezone, which what a person reads is shown in. */
export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * Roll back an update that failed after its swap (R14), by R13's rule, which
 * its own confirmation covers; then run the rollback's follow-ups, whose
 * failure only leaves them for `rollback --id` to retry. Returns where the
 * assistant was left.
 */
export async function revertUpdate(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
): Promise<RollbackOutcome> {
  const reverted = await rollBack(operation, dependencies, AUTOMATIC);
  try {
    await finishFollowUps(operation, dependencies);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(`${safeErrorMessage(error)}\n`);
  }
  return reverted;
}
