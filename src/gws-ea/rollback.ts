/**
 * `rollback`, and the revert of an update that failed once its release
 * started. A rollback returns an assistant to its rollback point: the release
 * its last update left, and the snapshot that update took of the state as the
 * release left it. Its mode is decided while the assistant is fenced, from the
 * schema as it is then: when neither the central migrations nor the session
 * tables moved since the snapshot, and no restore was asked for, only the code
 * goes back and every message, memory, and setting since is kept; otherwise
 * the snapshot is restored, once its time and what it discards are shown and
 * confirmed. A restore moves the state aside whole into `quarantine/<op>/`;
 * the switch itself moves no state.
 *
 * Each phase is recorded as it completes, so a rollback cut short anywhere is
 * continued by the next `rollback --id`. One that fails goes back to the
 * release it left; when that fails too, the record is closed for fix-forward
 * once the state it replaced is back.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdtemp, readdir, readFile, readlink, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { peopleForgetHandoffFile, writePeopleForgetHandoff } from '../modules/gws-ea-people/forget-handoff.js';
import { formatLocalTime } from '../timezone.js';
import { provideReleaseImage, readInstallCjkFonts } from './agent-image-release.js';
import { assertBrowserPolicyReadable } from './browser-capability.js';
import { committedTree } from './checkout.js';
import {
  assistantImageDocker,
  fenceInstance,
  finishFollowUps,
  openCutoverHost,
  reconcileMainSkills,
  releaseFollowUps,
  serveLeftRelease,
  startRelease,
  switchTo,
  verifyServingRelease,
  type CutoverDependencies,
  type CutoverHost,
} from './cutover.js';
import { runStep } from './events.js';
import { assertInstanceCreated, type InstanceOperation } from './journal.js';
import {
  advanceOperation,
  assertNotCommitted,
  beginOperation,
  beginOperationReturn,
  closeOperationFailed,
  commitOperationRelease,
  discardOperation,
  planFollowUps,
  readOperationRecord,
  readRollbackPoint,
  recordOperationFacts,
  reservationAt,
  targetMayHaveStarted,
  type OperationRecord,
  type RollbackMode,
  type SnapshotManifest,
} from './operation.js';
import { readDeployedSetup } from './provision.js';
import { safeErrorMessage } from './redact.js';
import {
  exists,
  isReleaseComplete,
  operationName,
  readCurrent,
  releaseName,
  restoreSnapshot,
  returnQuarantinedState,
  snapshotTakenAt,
} from './release-layout.js';
import { activeStep } from './run-log.js';
import { bindInstanceHostPolicies } from './service.js';
import { GwsEaError, releaseLine, releaseOf, type ReleaseCoordinates } from './types.js';
import { backupCentralDatabase, printableName, readForgottenFingerprints, readSchemaManifest } from './verify.js';

/** How many IDs and paths a discard summary lists; the counts are always whole. */
const LISTED = 20;

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
  /** Job registry entries absent from the snapshot. */
  readonly jobAgents: readonly {
    readonly agent_group_id: string;
    readonly messaging_group_id: string;
    readonly state: string;
  }[];
}

export interface DiscardedRows {
  readonly count: number;
  /** The first `LISTED` of them. */
  readonly ids: readonly string[];
}

export type SnapshotReason = 'central_schema' | 'session_schema' | 'requested';

export interface RollbackPreview {
  readonly instanceId: string;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** When the update being undone fenced the assistant, which is when the snapshot was taken. */
  readonly snapshotAt: string;
  readonly reason: SnapshotReason;
  readonly discarded: DiscardSummary;
  /** Where the discarded state is kept. */
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

export type RollbackOutcome =
  | ({
      readonly kind: 'rolled_back';
      readonly from: ReleaseCoordinates;
      readonly to: ReleaseCoordinates;
      /** The snapshot restored in snapshot mode; in code-only mode, the one left unused. */
      readonly snapshotAt: string;
      /** Why its Google Chat waits on a new sign-in, which still counts as serving; null otherwise. */
      readonly signInNeeded: string | null;
    } & (
      | { readonly mode: 'code_only' }
      | {
          readonly mode: 'snapshot';
          /** Where the state it replaced is kept. */
          readonly keptAt: string;
        }
    ))
  /** An update whose release had not started was discarded; `release` runs again. */
  | { readonly kind: 'update_discarded'; readonly release: ReleaseCoordinates; readonly discarded: ReleaseCoordinates }
  /** The follow-ups an earlier rollback left were run. */
  | { readonly kind: 'follow_ups_finished'; readonly release: ReleaseCoordinates }
  /** The snapshot restore was declined; the assistant runs `release` as before. */
  | { readonly kind: 'declined'; readonly release: ReleaseCoordinates };

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

/**
 * Session databases keep a rollback journal (`journal_mode=DELETE`), so a
 * read-only open leaves nothing beside them.
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

/** Keyed `<agent group>/<session>`. */
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

// A held message waits for a module to release it, and runs once released.
const WAITING = new Set(['pending', 'processing', 'held']);
const UNFINISHED = new Set(['pending', 'processing', 'paused', 'held']);

function columnsOf(database: Database.Database, table: string): Set<string> {
  return new Set(
    (database.prepare('SELECT name FROM pragma_table_info(?)').all(table) as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
}

/** A column an older session lacks reads as unknown. */
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

/** Each row's primary key, or the whole row when the table has none. */
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
function jobAgents(database: Database.Database): DiscardSummary['jobAgents'] {
  if (!hasTable(database, 'gws_ea_job_agents')) return [];
  return database
    .prepare('SELECT agent_group_id, messaging_group_id, state FROM gws_ea_job_agents ORDER BY agent_group_id')
    .all() as DiscardSummary['jobAgents'];
}

async function centralGains(
  current: string,
  snapshot: string,
): Promise<Pick<DiscardSummary, 'centralRows' | 'orphanedAgents' | 'jobAgents'>> {
  const before = await withCentralCopy(snapshot, (database) => ({
    keys: new Map(userTables(database).map((table) => [table, rowKeys(database, table)])),
    groups: new Set(agentGroups(database)),
    jobs: new Set(jobAgents(database).map((job) => job.agent_group_id)),
  }));
  return withCentralCopy(current, (database) => {
    const centralRows: Array<{ table: string; count: number }> = [];
    for (const table of userTables(database)) {
      const known = before.keys.get(table) ?? new Set<string>();
      let count = 0;
      for (const key of rowKeys(database, table)) if (!known.has(key)) count += 1;
      if (count > 0) centralRows.push({ table, count });
    }
    return {
      centralRows,
      orphanedAgents: agentGroups(database).filter((id) => !before.groups.has(id)),
      jobAgents: jobAgents(database).filter((job) => !before.jobs.has(job.agent_group_id)),
    };
  });
}

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

/** What restoring `snapshot` over `current` discards; both are only read. */
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

function isLossless(summary: DiscardSummary): boolean {
  return (
    summary.inbound.count === 0 &&
    summary.rerun.count === 0 &&
    summary.redelivered.count === 0 &&
    summary.centralRows.length === 0 &&
    summary.files.count === 0 &&
    summary.orphanedAgents.length === 0 &&
    summary.jobAgents.length === 0
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
    `  Job agents created since: ${discarded.jobAgents.map((job) => `${printableName(job.agent_group_id)} (chat ${printableName(job.messaging_group_id)}, ${printableName(job.state)})`).join(', ') || 'none'}`,
    `The discarded state is kept in ${preview.keptAt} until another snapshot restore replaces it, or the assistant is removed.`,
  ];
}

/** A sentence's tail, for the caller to begin. */
export function describeRollback(outcome: RollbackOutcome, timezone: string): string {
  switch (outcome.kind) {
    case 'rolled_back': {
      const runs =
        outcome.mode === 'code_only'
          ? `the assistant runs ${releaseLine(outcome.to)} again, with everything it recorded since kept.`
          : `the assistant runs ${releaseLine(outcome.to)} again on its snapshot from ${formatLocalTime(outcome.snapshotAt, timezone)}; what it recorded since is kept in ${outcome.keptAt}.`;
      return outcome.signInNeeded ? `${runs} ${outcome.signInNeeded}.` : runs;
    }
    case 'update_discarded':
      return `the update to ${releaseLine(outcome.discarded)} was discarded, and the assistant runs ${releaseLine(outcome.release)} again.`;
    case 'follow_ups_finished':
      return `the assistant runs ${releaseLine(outcome.release)}, and its rollback is finished.`;
    case 'declined':
      return `the snapshot restore was declined, and the assistant runs ${releaseLine(outcome.release)} as before.`;
  }
}

function confirmationRequired(instanceId: string): GwsEaError {
  return new GwsEaError(
    'input_required',
    `Rolling back assistant ${instanceId} restores its pre-update snapshot, which needs confirmation: pass --yes, or run gws-ea rollback in a terminal to be asked.`,
  );
}

interface RollbackPlan {
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  /** The snapshot it restores in snapshot mode: the rollback point's, or the one the update it reverts took. */
  readonly snapshot: string;
  readonly request: RollbackRequest;
}

interface Rollback extends CutoverHost, RollbackPlan {
  /** The operation's name: `quarantine/<op>/` keeps the state a restore replaces. */
  readonly op: string;
  /** It reverts an update that never committed, and so commits by its own record. */
  readonly reverting: boolean;
}

const STOP_LABEL = 'Stopping the assistant for the rollback…';

/**
 * A revert restores the snapshot its update took, which the rollback's own
 * name finds because the rollback keeps the update's start; any other
 * restores the rollback point's.
 */
async function rollbackOf(host: CutoverHost, record: OperationRecord, request: RollbackRequest): Promise<Rollback> {
  const op = operationName(record.started_at);
  const reverting = record.commit_point === 'record';
  const point = reverting ? undefined : await readRollbackPoint(host.operation.paths, host.operation.instanceId);
  if (!reverting && !point) {
    throw new GwsEaError('rollback_unavailable', `Assistant ${record.instance_id} has lost its rollback point.`);
  }
  return { ...host, from: record.from, to: record.to, op, snapshot: point?.snapshot ?? op, reverting, request };
}

function decideMode(
  current: SnapshotManifest,
  snapshot: SnapshotManifest,
  requested: boolean,
): { readonly mode: RollbackMode; readonly reason: SnapshotReason | undefined } {
  const moved = sameSchema(current, snapshot);
  if (moved !== 'same') return { mode: 'snapshot', reason: moved };
  return requested ? { mode: 'snapshot', reason: 'requested' } : { mode: 'code_only', reason: undefined };
}

/** Presents what the restore discards, then asks for it; undefined when nobody can be asked. */
async function confirmSnapshot(
  host: CutoverHost,
  plan: RollbackPlan,
  reason: SnapshotReason,
  current: string,
): Promise<boolean | undefined> {
  const { layout, operation } = host;
  const preview: RollbackPreview = {
    instanceId: operation.instanceId,
    from: plan.from,
    to: plan.to,
    snapshotAt: await snapshotTakenAt(layout, plan.snapshot),
    reason,
    discarded: await summarizeDiscard(current, layout.snapshot(plan.snapshot)),
    keptAt: path.join(layout.root, 'quarantine'),
  };
  plan.request.present(preview);
  return plan.request.confirm ? plan.request.confirm(preview) : undefined;
}

/**
 * Before anything changes, judge the mode from the state as it is while the
 * assistant serves: a snapshot restore nobody can confirm is refused here,
 * showing what it would discard. It is decided again, and confirmed, once
 * fenced.
 */
async function assertConfirmable(host: CutoverHost, plan: RollbackPlan): Promise<void> {
  if (plan.request.confirm) return;
  const { layout } = host;
  const { mode, reason } = decideMode(
    readSchemaManifest(layout.state),
    readSchemaManifest(layout.snapshot(plan.snapshot)),
    plan.request.snapshot === true,
  );
  if (mode !== 'snapshot' || !reason) return;
  await confirmSnapshot(host, plan, reason, layout.state);
  throw confirmationRequired(host.operation.instanceId);
}

/**
 * Write the forget handoff from the state a restore replaced: every identity
 * forgotten there that the restored database does not record, for the host to
 * forget again before it routes anything. Read-only on both databases;
 * recomputed whole whenever the restore step runs.
 */
async function handOffForgets(rollback: Rollback): Promise<void> {
  const { layout } = rollback;
  const restored = new Set(readForgottenFingerprints(layout.state).map((row) => row.fingerprint));
  const missing = readForgottenFingerprints(layout.quarantine(rollback.op)).filter(
    (row) => !restored.has(row.fingerprint),
  );
  if (missing.length === 0) return;
  await writePeopleForgetHandoff(peopleForgetHandoffFile(path.join(layout.state, 'data')), { fingerprints: missing });
}

type Decision = RollbackMode | 'declined' | 'unconfirmable';

/**
 * `fenced` → `snapshotted`, deciding from the schema the fence read. A restore
 * that began is finished without deciding again, since the state is no longer
 * the one decided on.
 */
async function decideAndRestore(rollback: Rollback, record: OperationRecord): Promise<Decision> {
  const { layout, reporter } = rollback;
  let mode: RollbackMode = 'snapshot';
  if (!(await exists(layout.quarantine(rollback.op)))) {
    const decided = decideMode(
      record.manifest ?? readSchemaManifest(layout.state),
      readSchemaManifest(layout.snapshot(rollback.snapshot)),
      rollback.request.snapshot === true,
    );
    mode = decided.mode;
    if (decided.reason) {
      const confirmed = await confirmSnapshot(rollback, rollback, decided.reason, layout.state);
      if (confirmed !== true) return confirmed === undefined ? 'unconfirmable' : 'declined';
    }
  }
  if (mode === 'snapshot') {
    await runStep(reporter, { id: 'restore_snapshot', label: 'Restoring the pre-update snapshot…' }, async () => {
      await restoreSnapshot(layout, rollback.snapshot, rollback.op);
      await handOffForgets(rollback);
    });
  }
  return mode;
}

async function writeRollbackReceipt(rollback: Rollback, record: OperationRecord): Promise<void> {
  const { layout, operation } = rollback;
  const snapshot = layout.snapshot(rollback.snapshot);
  await writePrivate(path.join(layout.kept(releaseName(rollback.to.deployed_commit)), 'rollback.json'), {
    schema_version: 1,
    instance_id: operation.instanceId,
    from: rollback.from,
    to: rollback.to,
    mode: record.mode,
    stopped_at: record.stop?.at ?? null,
    snapshot_at: await snapshotTakenAt(layout, rollback.snapshot),
    schema: { left: record.manifest ?? null, restored: readSchemaManifest(snapshot) },
    discarded: record.mode === 'snapshot' ? await summarizeDiscard(layout.quarantine(rollback.op), snapshot) : null,
  });
}

async function pinsOf(rollback: Rollback, release: ReleaseCoordinates): Promise<{ readonly gateway: string }> {
  const { onecli } = await readDeployedSetup(rollback.operation.paths, reservationAt(rollback.reservation, release));
  return { gateway: onecli.gateway };
}

/**
 * Go back to the release a rollback left, recorded first so a return cut short
 * is finished by the next `rollback --id`. The state the rollback's target
 * produced is kept in `quarantine/<op>-returned/`. A record that carried a
 * committed update's follow-ups gives them back.
 */
async function goBack(rollback: Rollback): Promise<void> {
  const { operation, layout } = rollback;
  await beginOperationReturn(operation);
  await serveLeftRelease(rollback, rollback, () => returnQuarantinedState(layout, rollback.op));
  await runStep(rollback.reporter, { id: 'verify_release', label: 'Checking the release it left serves…' }, async () =>
    verifyServingRelease(rollback, {
      view: reservationAt(rollback.reservation, rollback.from),
      pins: await pinsOf(rollback, rollback.from),
      // The return's fence may have killed the host the rollback started, whose lease then delays this one's.
      leaseHeld: true,
      subject: 'The release the rollback left',
    }),
  );
  await discardOperation(operation);
}

function returned(rollback: Rollback, mode: RollbackMode | undefined, cause: unknown): GwsEaError {
  const id = rollback.operation.instanceId;
  const next =
    mode === 'code_only'
      ? ` To restore the pre-update snapshot instead, run gws-ea rollback --id ${id} --snapshot.`
      : '';
  return new GwsEaError(
    'rollback_failed',
    `${cause === undefined ? 'An earlier attempt failed.' : safeErrorMessage(cause)} The rollback to ${releaseLine(rollback.to)} went back: the assistant runs ${releaseLine(rollback.from)} again.${next}`,
    { ...(cause === undefined ? {} : { cause }), details: { continueWith: `gws-ea rollback --id ${id}` } },
  );
}

async function closedForFixForward(rollback: Rollback, cause: unknown, why: string): Promise<GwsEaError> {
  await closeOperationFailed(rollback.operation);
  const id = rollback.operation.instanceId;
  return new GwsEaError(
    'rollback_return_failed',
    `${safeErrorMessage(cause)} ${why} Fix it forward: update it to a newer release with gws-ea update --id ${id}.`,
    { cause, details: { continueWith: `gws-ea update --id ${id}` } },
  );
}

/**
 * A rollback whose return failed too: closed for fix-forward once the state
 * its restore replaced is back, or when it restored none. Until the return
 * has put that state back, the record stays open and going back, so the next
 * `rollback --id` finishes the return, rather than a fix-forward building on
 * the restored snapshot while what the assistant recorded since stays in
 * quarantine.
 */
async function returnFailed(rollback: Rollback, cause: unknown, why: string): Promise<GwsEaError> {
  if (!(await exists(rollback.layout.quarantine(rollback.op)))) return closedForFixForward(rollback, cause, why);
  const id = rollback.operation.instanceId;
  return new GwsEaError(
    'rollback_return_unfinished',
    `${safeErrorMessage(cause)} ${why} The state it replaced is not back yet. Continue going back with gws-ea rollback --id ${id}.`,
    { cause, details: { continueWith: `gws-ea rollback --id ${id}` } },
  );
}

/** Refusals a rollback makes on purpose, which never send it back. */
function deliberate(error: unknown): boolean {
  return error instanceof GwsEaError && (error.code === 'input_required' || error.code === 'rollback_declined');
}

/**
 * A rollback resumed while fenced may find something started since: it is
 * stopped and the instance proven quiet again before anything goes on.
 */
async function refence(rollback: Rollback, record: OperationRecord): Promise<OperationRecord> {
  const { layout } = rollback;
  // A restore cut short holds the state aside; it is finished first, still fenced, so the state is whole again.
  if (record.phase === 'fenced' && (await exists(layout.quarantine(rollback.op)))) {
    await restoreSnapshot(layout, rollback.snapshot, rollback.op);
  }
  const stop = await fenceInstance(rollback, 'Making sure the assistant is still stopped…');
  return recordOperationFacts(rollback.operation, { stop });
}

async function fenceForRollback(rollback: Rollback): Promise<OperationRecord> {
  let manifest: SnapshotManifest | undefined;
  const stop = await fenceInstance(rollback, STOP_LABEL, () => {
    manifest = readSchemaManifest(rollback.layout.state);
  });
  return advanceOperation(rollback.operation, 'fenced', { stop, ...(manifest ? { manifest } : {}) });
}

/**
 * Carry a rollback from the phase its record reached until it is committed. A
 * resume between the fence and the start fences again first.
 */
async function runRollback(rollback: Rollback, start: OperationRecord): Promise<RollbackOutcome> {
  const { operation, layout, reporter } = rollback;
  if (start.returning) {
    try {
      await goBack(rollback);
    } catch (error) {
      throw await returnFailed(
        rollback,
        error,
        `Going back from the rollback to ${releaseLine(rollback.to)} to ${releaseLine(rollback.from)} failed.`,
      );
    }
    throw returned(rollback, start.mode, undefined);
  }
  let record = start;
  let definitionChanged = false;
  let signInNeeded: string | null = null;
  try {
    if (record.phase === 'fenced' || record.phase === 'snapshotted' || record.phase === 'switched') {
      record = await refence(rollback, record);
    }
    for (;;) {
      switch (record.phase) {
        case 'staged':
          record = await fenceForRollback(rollback);
          break;
        case 'fenced': {
          const decision = await decideAndRestore(rollback, record);
          if (decision === 'declined' || decision === 'unconfirmable') {
            if (rollback.reverting) {
              throw new GwsEaError(
                decision === 'declined' ? 'rollback_declined' : 'input_required',
                `The rollback needs its pre-update snapshot restored, which was not confirmed, so it stopped with assistant ${operation.instanceId} stopped. Continue it with gws-ea rollback --id ${operation.instanceId}, confirming the restore or passing --yes.`,
              );
            }
            await goBack(rollback);
            if (decision === 'unconfirmable') throw confirmationRequired(operation.instanceId);
            return { kind: 'declined', release: rollback.from };
          }
          record = await advanceOperation(operation, 'snapshotted', { mode: decision });
          break;
        }
        case 'snapshotted':
          definitionChanged = await switchTo(rollback, record.to, record.from, 'Switching to the previous release…');
          record = await advanceOperation(operation, 'switched');
          break;
        case 'switched':
          if ((await readCurrent(layout)) !== releaseName(record.to.deployed_commit)) {
            definitionChanged = await switchTo(rollback, record.to, record.from, 'Switching to the previous release…');
          }
          await bindInstanceHostPolicies(
            rollback.runtime,
            rollback.operation.paths.configRoot,
            rollback.dependencies.upsertEnvVars,
          );
          await startRelease(rollback, definitionChanged, 'Starting the previous release…');
          record = await advanceOperation(operation, 'started');
          break;
        case 'started': {
          const started = record;
          await reconcileMainSkills(rollback, started.stop?.graceful === false);
          ({ signInNeeded } = await runStep(
            reporter,
            { id: 'verify_release', label: 'Checking the previous release serves…' },
            async () =>
              verifyServingRelease(rollback, {
                view: reservationAt(rollback.reservation, started.to),
                pins: await pinsOf(rollback, started.to),
                leaseHeld: started.stop?.graceful === false,
                subject: 'The restored release',
              }),
          ));
          record = await advanceOperation(operation, 'verified', {
            follow_ups: planFollowUps(record.follow_ups, releaseFollowUps(rollback.runtime)),
          });
          break;
        }
        case 'verified': {
          const verified = record;
          await runStep(reporter, { id: 'record_release', label: 'Recording the rollback…' }, async () => {
            await writeRollbackReceipt(rollback, verified);
            await commitOperationRelease(operation);
          });
          return rolledBack(rollback, verified, signInNeeded);
        }
        case 'committed':
          return rolledBack(rollback, record, signInNeeded);
      }
    }
  } catch (error) {
    if (deliberate(error)) throw error;
    await assertNotCommitted(operation, error);
    const failed = (await readOperationRecord(operation.paths, operation.instanceId)) ?? record;
    if (rollback.reverting) {
      throw await closedForFixForward(
        rollback,
        error,
        `The rollback to ${releaseLine(rollback.to)} failed, and the update it reverts has no release to go back to.`,
      );
    }
    try {
      await goBack(rollback);
    } catch (returnError) {
      throw await returnFailed(
        rollback,
        returnError,
        `The rollback to ${releaseLine(rollback.to)} failed (${safeErrorMessage(error)}), and going back to ${releaseLine(rollback.from)} failed too.`,
      );
    }
    throw returned(rollback, failed.mode, error);
  }
}

async function rolledBack(
  rollback: Rollback,
  record: OperationRecord,
  signInNeeded: string | null,
): Promise<RollbackOutcome> {
  const mode = record.mode ?? 'code_only';
  const { from, to } = rollback;
  const snapshotAt = await snapshotTakenAt(rollback.layout, rollback.snapshot);
  return mode === 'snapshot'
    ? { kind: 'rolled_back', from, to, mode, snapshotAt, signInNeeded, keptAt: rollback.layout.quarantine(rollback.op) }
    : { kind: 'rolled_back', from, to, mode, snapshotAt, signInNeeded };
}

/**
 * An unfinished update whose release cannot have started is discarded and the
 * release it left served again. One whose release may have started
 * (`targetMayHaveStarted`) is rolled back by the rollback rules, from the
 * snapshot it took, the rollback replacing its record in one write so the
 * gate never lifts. One with no release to return to is refused: it is fixed
 * forward, as is one whose release cannot read the browser policy.
 */
async function revertOpenUpdate(
  operation: InstanceOperation,
  update: OperationRecord,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  const id = operation.instanceId;
  if (update.no_rollback_target) {
    throw new GwsEaError(
      'rollback_unavailable',
      `Assistant ${id}'s update to ${releaseLine(update.to)} has no release to roll back to. Continue it with gws-ea update --id ${id}, or fix it forward to a newer release.`,
    );
  }
  const host = await openCutoverHost(operation, dependencies);
  await assertBrowserPolicyReadable(
    host.runtime,
    host.layout.release(releaseName(update.from.deployed_commit)),
    releaseLine(update.from),
  );
  if (!targetMayHaveStarted(update)) {
    await serveLeftRelease(host, update);
    await discardOperation(operation);
    return { kind: 'update_discarded', release: update.from, discarded: update.to };
  }
  const plan = { from: update.to, to: update.from, snapshot: operationName(update.started_at), request };
  await assertConfirmable(host, plan);
  const record = await beginOperation(operation, { kind: 'rollback', from: plan.from, to: plan.to });
  const rollback = await rollbackOf(host, record, request);
  return runRollback(rollback, record);
}

/**
 * Every refusal comes before the assistant changes. The release's agent image
 * is provided first, rebuilt hermetically when it is gone.
 */
async function rollBackCommitted(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  const host = await openCutoverHost(operation, dependencies);
  const { paths, instanceId } = operation;
  const { layout, runtime } = host;
  const point = await readRollbackPoint(paths, instanceId);
  const from = releaseOf(host.reservation);
  const unavailable = (why: string): GwsEaError =>
    new GwsEaError('rollback_unavailable', `Assistant ${instanceId} ${why}, so there is nothing to roll back to.`);
  if (!point) throw unavailable('keeps no rollback point');
  const to = point.release;
  const live = await readCurrent(layout);
  if (live !== releaseName(from.deployed_commit)) {
    throw unavailable(`runs ${live ?? 'no release'}, not ${releaseLine(from)} as its record says`);
  }
  const name = releaseName(to.deployed_commit);
  if (!(await isReleaseComplete(layout, name))) throw unavailable(`no longer keeps ${releaseLine(to)} whole`);
  await assertBrowserPolicyReadable(runtime, layout.release(name), releaseLine(to));
  await runStep(
    host.reporter,
    { id: 'prepare_agent_image', label: "Preparing the previous release's agent image…" },
    async () =>
      provideReleaseImage(assistantImageDocker(runtime, dependencies), {
        layout,
        release: name,
        installId: runtime.install_id,
        inputs: {
          contextTree: await committedTree(layout.release(name), to.deployed_commit, 'container', {
            runCommand: host.run,
          }),
          installCjkFonts: readInstallCjkFonts(layout.state),
        },
      }),
  );
  await assertConfirmable(host, { from, to, snapshot: point.snapshot, request });
  const record = await beginOperation(operation, { kind: 'rollback', from, to });
  return runRollback(await rollbackOf(host, record, request), record);
}

/** `rollback --id`. A committed rollback's follow-ups are left for the caller to run (`finishFollowUps`). */
export async function rollBack(
  operation: InstanceOperation,
  dependencies: CutoverDependencies,
  request: RollbackRequest,
): Promise<RollbackOutcome> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  await assertInstanceCreated(paths, instanceId);
  const record = await readOperationRecord(paths, instanceId);
  if (record?.phase === 'committed' && record.kind === 'rollback') {
    return { kind: 'follow_ups_finished', release: record.to };
  }
  if (record && record.phase !== 'committed') {
    if (record.kind === 'update') return revertOpenUpdate(operation, record, dependencies, request);
    return runRollback(await rollbackOf(await openCutoverHost(operation, dependencies), record, request), record);
  }
  return rollBackCommitted(operation, dependencies, request);
}

/** Shows what a snapshot restore discards in the step log; the update's own confirmation covers it. */
const AUTOMATIC: RollbackRequest = {
  present: (preview) => activeStep()?.write(`${rollbackPreviewLines(preview, localTimezone()).join('\n')}\n`),
  confirm: async () => true,
};

export function localTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone;
}

/**
 * For an update that failed once its release started; its own confirmation
 * covers a snapshot restore. A follow-up failure only leaves them for
 * `rollback --id` to retry.
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
