/**
 * The operation record: `<instance>/operation.json`, the durable state of one
 * assistant's update or rollback. It lives beside the provision journal for as
 * long as the instance does, is written atomically and owner-only under the
 * instance lock, and readers ignore unknown fields.
 *
 * Its phases run `staged → fenced → snapshotted → switched → started →
 * verified → committed` and only move forward. From `staged` through
 * `verified` the record is open, and `acquireInstanceOperation` admits only
 * the command that continues or reverts it. `committed` releases that gate:
 * the record then only lists the follow-ups still to run, and is deleted once
 * none remain. A record closed `failed` (an update with no release to return
 * to, or a rollback whose return failed too) admits only an update to another
 * release, which supersedes it (fix-forward, KTD9).
 *
 * The commit point is the registry compare-and-swap, so recovery reads the
 * registry first: an open record whose target the registry already names was
 * committed, and counts as committed whatever phase it last reached. Settling
 * a committed release also settles the rollback point (`rollback-point.json`):
 * an update names the release it left and the snapshot it took as it left it,
 * and a rollback leaves nothing to roll back to (KTD4).
 */
import { writePrivate } from '../community-portal/private-file.js';
import { isErrno } from '../community-portal/errors.js';
import type { InstanceOperation } from './journal.js';
import type { ControlPlanePaths } from './paths.js';
import { safeErrorMessage } from './redact.js';
import {
  assertInstanceId,
  getInstanceReservation,
  swapInstanceRelease,
  validateReleaseCoordinates,
} from './registry.js';
import { operationName } from './release-layout.js';
import { readOwnerOnlyJson, removePrivateFile } from './secrets.js';
import {
  GwsEaError,
  releaseOf,
  sameRelease,
  shortCommit,
  type InstanceReservation,
  type ReleaseCoordinates,
} from './types.js';
import { isRecord, requireCanonicalTimestamp, requireString } from './validation.js';

const OPERATION_RECORD_SCHEMA_VERSION = 2 as const;

export const OPERATION_PHASES = [
  'staged',
  'fenced',
  'snapshotted',
  'switched',
  'started',
  'verified',
  'committed',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

const OPERATION_KINDS = ['update', 'rollback'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Where an operation's release is committed. `registry`: the registry
 * compare-and-swap from `from` to `to`. `record`: the registry already names
 * `to` (a rollback reverting an update that was never committed), so writing
 * `committed` is the commit.
 */
const COMMIT_POINTS = ['registry', 'record'] as const;
export type OperationCommitPoint = (typeof COMMIT_POINTS)[number];

/**
 * How a rollback treats what the assistant recorded since the snapshot it
 * returns to (R3): `code_only` keeps it; `snapshot` restores the snapshot,
 * keeping the state it replaces in `quarantine/<op>/`.
 */
const ROLLBACK_MODES = ['code_only', 'snapshot'] as const;
export type RollbackMode = (typeof ROLLBACK_MODES)[number];

export interface OperationStop {
  readonly at: string;
  /** False when the host had to be killed: its claim lease then delays the next host's claims. */
  readonly graceful: boolean;
}

/** What "the schema moved" is decided from, as it stood when the host stopped. */
export interface SnapshotManifest {
  /** The central database's `schema_version` migration names. */
  readonly central_migrations: readonly string[];
  /** Every table, and its columns, across the session databases. */
  readonly session_tables: Readonly<Record<string, readonly string[]>>;
}

/** Work that runs once the release is committed; its failure never rolls back. */
export type OperationFollowUp =
  /** Rebuild an agent group's own image on the live release's image. */
  | { readonly kind: 'rebuild_group_image'; readonly agent_group_id: string }
  /** Remove an image a rebuild displaced, by ID, once no tag names it. */
  | { readonly kind: 'reclaim_image'; readonly image_id: string }
  /** Delete the releases, snapshots, and quarantines nothing keeps any more (KTD4). */
  | { readonly kind: 'prune' };

export interface OperationRecord {
  readonly schema_version: typeof OPERATION_RECORD_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly kind: OperationKind;
  readonly commit_point: OperationCommitPoint;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly phase: OperationPhase;
  /** When it began, which names its snapshot and quarantine (`operationName`). */
  readonly started_at: string;
  readonly updated_at: string;
  /** The fence's stop; required from `fenced` until committed. */
  readonly stop?: OperationStop;
  /** The live schema: as staging read it, until the fence records it again. */
  readonly manifest?: SnapshotManifest;
  /** A rollback's mode, decided while fenced; required from `snapshotted` on. */
  readonly mode?: RollbackMode;
  /** Planned by `verified`; what is left of it once committed. */
  readonly follow_ups: readonly OperationFollowUp[];
  /** An update with no release to return to: once its target started, a failure closes it (KTD9). */
  readonly no_rollback_target?: true;
  /** A rollback that failed, going back to the release it left (KTD5): continuing it finishes that return. */
  readonly returning?: true;
  /** Closed for fix-forward: only an update to another release goes on from here (KTD9). */
  readonly closed?: 'failed';
}

/** Facts an operation adds as it runs; each one given replaces what the record held. */
export type OperationFacts = Partial<Pick<OperationRecord, 'stop' | 'manifest' | 'mode' | 'follow_ups'>>;

export type OperationStart = Pick<OperationRecord, 'kind' | 'from' | 'to'> &
  Partial<Pick<OperationRecord, 'manifest' | 'no_rollback_target'>>;

/**
 * A command that takes the instance lock, and for `update` the release it
 * would deploy. `list`, `status`, and `logs` take no lock and `remove` holds
 * its own, so an open record never stops them.
 */
export type OperationIntent =
  | {
      readonly command: 'create' | 'resume' | 'start' | 'stop' | 'restart' | 'ncl' | 'rollback' | 'connect-google';
    }
  | { readonly command: 'update'; readonly target: ReleaseCoordinates };

/** The commands that continue or revert an unfinished operation. */
export interface OperationNextSteps {
  readonly continueWith: string;
  readonly revertWith?: string;
}

/** What `list` and `status` report, read without the instance lock. */
export type OperationInspection =
  | { readonly state: 'none' }
  | { readonly state: 'open' | 'failed'; readonly record: OperationRecord; readonly next: OperationNextSteps }
  | { readonly state: 'committed'; readonly record: OperationRecord }
  | { readonly state: 'unreadable'; readonly code: string; readonly message: string };

/** The release a rollback returns to, and the snapshot of the state it left (KTD4). */
export interface RollbackPoint {
  readonly release: ReleaseCoordinates;
  /** The name of the snapshot in `snapshots/`. */
  readonly snapshot: string;
  /** The schema the snapshot holds. */
  readonly manifest: SnapshotManifest;
  readonly taken_at: string;
}

const INVALID = 'invalid_operation';
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
/** Docker's tag grammar: a per-group image is tagged with its agent group's ID. */
const AGENT_GROUP_ID_PATTERN = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;

function invalid(message: string): GwsEaError {
  return new GwsEaError(INVALID, message);
}

function rank(phase: OperationPhase): number {
  return OPERATION_PHASES.indexOf(phase);
}

function oneOf<T extends string>(values: readonly T[], value: unknown, label: string): T {
  const found = values.find((candidate) => candidate === value);
  if (found === undefined) throw invalid(`Operation record ${label} is invalid`);
  return found;
}

function timestamp(value: unknown, label: string): string {
  return requireCanonicalTimestamp(value, INVALID, `Operation record ${label} is invalid`);
}

function name(value: unknown, label: string): string {
  return requireString(value, `Operation record ${label}`, INVALID, 256);
}

function matching(value: unknown, pattern: RegExp, label: string): string {
  const text = name(value, label);
  if (!pattern.test(text)) throw invalid(`Operation record ${label} is invalid`);
  return text;
}

function list<T>(value: unknown, label: string, parse: (entry: unknown) => T): readonly T[] {
  if (!Array.isArray(value)) throw invalid(`Operation record ${label} is invalid`);
  return value.map((entry: unknown) => parse(entry));
}

function flag(value: unknown, label: string): boolean {
  if (value !== undefined && value !== true) throw invalid(`Operation record ${label} is invalid`);
  return value === true;
}

function parseRelease(value: unknown, label: string): ReleaseCoordinates {
  try {
    return validateReleaseCoordinates(value);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw invalid(`Operation record ${label} release is invalid`);
  }
}

function parseStop(value: unknown): OperationStop {
  if (!isRecord(value) || typeof value.graceful !== 'boolean') throw invalid('Operation record stop is invalid');
  return { at: timestamp(value.at, 'stop time'), graceful: value.graceful };
}

function parseManifest(value: unknown): SnapshotManifest {
  if (!isRecord(value) || !isRecord(value.session_tables)) throw invalid('Operation record manifest is invalid');
  return {
    central_migrations: list(value.central_migrations, 'central migrations', (entry) => name(entry, 'migration')),
    // fromEntries defines each table as an own field, so a table named `__proto__` stays data.
    session_tables: Object.fromEntries(
      Object.entries(value.session_tables).map(([table, columns]) => [
        name(table, 'session table'),
        list(columns, 'session columns', (entry) => name(entry, 'session column')),
      ]),
    ),
  };
}

function parseFollowUp(value: unknown): OperationFollowUp {
  if (!isRecord(value)) throw invalid('Operation record follow-up is invalid');
  switch (value.kind) {
    case 'rebuild_group_image':
      return {
        kind: 'rebuild_group_image',
        agent_group_id: matching(value.agent_group_id, AGENT_GROUP_ID_PATTERN, 'agent group ID'),
      };
    case 'reclaim_image':
      return { kind: 'reclaim_image', image_id: matching(value.image_id, IMAGE_ID_PATTERN, 'image ID') };
    case 'prune':
      return { kind: 'prune' };
    default:
      throw invalid('Operation record follow-up is invalid');
  }
}

/** What makes two follow-ups the same work, so planning one twice records it once. */
function followUpKey(followUp: OperationFollowUp): string {
  switch (followUp.kind) {
    case 'rebuild_group_image':
      return `${followUp.kind}:${followUp.agent_group_id}`;
    case 'reclaim_image':
      return `${followUp.kind}:${followUp.image_id}`;
    case 'prune':
      return followUp.kind;
  }
}

/** Add follow-ups to those planned, each at most once. */
export function planFollowUps(
  planned: readonly OperationFollowUp[],
  added: readonly OperationFollowUp[],
): OperationFollowUp[] {
  const known = new Set(planned.map(followUpKey));
  return [...planned, ...added.filter((followUp) => !known.has(followUpKey(followUp)))];
}

function recreate(instanceId: string): string {
  return `remove it with gws-ea remove --id ${instanceId}, then create it again`;
}

/** Validate a record read from disk or about to be written; unknown fields are dropped. */
function parseOperationRecord(value: unknown, instanceId: string): OperationRecord {
  if (!isRecord(value)) throw invalid('Operation record is invalid');
  if (value.schema_version !== OPERATION_RECORD_SCHEMA_VERSION) {
    const version = typeof value.schema_version === 'number' ? value.schema_version : 'unknown';
    throw new GwsEaError(
      'unsupported_operation',
      `This assistant's unfinished update or rollback was recorded by a different gws-ea ` +
        `(operation record schema ${version}; this one reads ${OPERATION_RECORD_SCHEMA_VERSION}). ` +
        `Continue it with that gws-ea, or ${recreate(instanceId)}.`,
    );
  }
  if (value.instance_id !== instanceId) throw invalid('Operation record belongs to another instance');
  const from = parseRelease(value.from, 'from');
  const to = parseRelease(value.to, 'to');
  if (from.deployed_commit === to.deployed_commit) {
    throw invalid('An update or rollback must change the deployed commit');
  }
  const phase = oneOf(OPERATION_PHASES, value.phase, 'phase');
  const kind = oneOf(OPERATION_KINDS, value.kind, 'kind');
  const commitPoint = oneOf(COMMIT_POINTS, value.commit_point, 'commit point');
  const stop = value.stop === undefined ? undefined : parseStop(value.stop);
  if (!stop && rank(phase) >= rank('fenced') && phase !== 'committed') {
    throw invalid(`Operation record at ${phase} must record its stop`);
  }
  const mode = value.mode === undefined ? undefined : oneOf(ROLLBACK_MODES, value.mode, 'rollback mode');
  const noRollbackTarget = flag(value.no_rollback_target, 'rollback target');
  const returning = flag(value.returning, 'return');
  if (value.closed !== undefined && value.closed !== 'failed') throw invalid('Operation record closing is invalid');
  if (kind === 'update' && (mode || returning || commitPoint === 'record')) {
    throw invalid('An update records no rollback mode, return, or commit by record');
  }
  if (kind === 'rollback' && noRollbackTarget) throw invalid('A rollback always has a release to return to');
  if (kind === 'rollback' && !mode && rank(phase) >= rank('snapshotted')) {
    throw invalid(`A rollback at ${phase} must record its mode`);
  }
  if (returning && commitPoint === 'record') throw invalid('A rollback reverting an update never goes back to it');
  return {
    schema_version: OPERATION_RECORD_SCHEMA_VERSION,
    instance_id: instanceId,
    kind,
    commit_point: commitPoint,
    from,
    to,
    phase,
    started_at: timestamp(value.started_at, 'start time'),
    updated_at: timestamp(value.updated_at, 'update time'),
    ...(stop ? { stop } : {}),
    ...(value.manifest === undefined ? {} : { manifest: parseManifest(value.manifest) }),
    ...(mode ? { mode } : {}),
    follow_ups: list(value.follow_ups, 'follow-ups', parseFollowUp),
    ...(noRollbackTarget ? { no_rollback_target: true as const } : {}),
    ...(returning ? { returning: true as const } : {}),
    ...(value.closed === 'failed' ? { closed: 'failed' as const } : {}),
  };
}

/** The record of this instance's update or rollback, or undefined when none is under way. */
export async function readOperationRecord(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<OperationRecord | undefined> {
  assertInstanceId(instanceId);
  let raw: unknown;
  try {
    raw = await readOwnerOnlyJson(paths.operationFile(instanceId), 'Operation record', INVALID);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof GwsEaError) throw error;
    throw invalid('Operation record cannot be read safely');
  }
  return parseOperationRecord(raw, instanceId);
}

async function writeRecord(paths: ControlPlanePaths, record: OperationRecord): Promise<OperationRecord> {
  const validated = parseOperationRecord(record, record.instance_id);
  await writePrivate(paths.operationFile(record.instance_id), validated);
  return validated;
}

function parseRollbackPoint(value: unknown, instanceId: string): RollbackPoint {
  if (!isRecord(value) || value.schema_version !== 1 || value.instance_id !== instanceId) {
    throw new GwsEaError('invalid_rollback_point', `Assistant ${instanceId}'s rollback point is not its own.`);
  }
  return {
    release: parseRelease(value.release, 'rollback point'),
    snapshot: name(value.snapshot, 'rollback point snapshot'),
    manifest: parseManifest(value.manifest),
    taken_at: timestamp(value.taken_at, 'snapshot time'),
  };
}

/** The release this assistant would roll back to, or undefined when it has none (KTD4). */
export async function readRollbackPoint(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<RollbackPoint | undefined> {
  assertInstanceId(instanceId);
  let raw: unknown;
  try {
    raw = await readOwnerOnlyJson(paths.rollbackPointFile(instanceId), 'Rollback point', 'invalid_rollback_point');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return parseRollbackPoint(raw, instanceId);
}

/**
 * What a committed release leaves to roll back to: an update, the release it
 * left and the snapshot it took as it left it (none for one with no rollback
 * target); a rollback, nothing. A rollback reverting an update that was never
 * committed leaves the rollback point as it was. Rewritten whole each time,
 * so a settle cut short is settled again.
 */
async function settleRollbackPoint(paths: ControlPlanePaths, record: OperationRecord): Promise<void> {
  const file = paths.rollbackPointFile(record.instance_id);
  if (record.kind === 'rollback' && record.commit_point === 'record') return;
  if (record.kind === 'rollback' || record.no_rollback_target) {
    await removePrivateFile(file);
    return;
  }
  if (!record.manifest || !record.stop) throw invalid('A committed update must record its fence');
  await writePrivate(file, {
    schema_version: 1,
    instance_id: record.instance_id,
    release: record.from,
    snapshot: operationName(record.started_at),
    manifest: record.manifest,
    taken_at: record.stop.at,
  });
}

/**
 * Mark a committed operation committed and settle its rollback point,
 * deleting the record when no follow-up is left.
 */
async function settleCommitted(
  paths: ControlPlanePaths,
  record: OperationRecord,
): Promise<OperationRecord | undefined> {
  await settleRollbackPoint(paths, record);
  return settleFollowUps(paths, record);
}

/** A committed record with what is left to follow up, or no record once nothing is. */
async function settleFollowUps(
  paths: ControlPlanePaths,
  record: OperationRecord,
): Promise<OperationRecord | undefined> {
  if (record.follow_ups.length === 0) {
    await removePrivateFile(paths.operationFile(record.instance_id));
    return undefined;
  }
  const { returning: _returning, closed: _closed, ...rest } = record;
  return writeRecord(paths, { ...rest, phase: 'committed', updated_at: new Date().toISOString() });
}

/** An open record whose target the registry already names passed its commit point. */
function committedByRegistry(record: OperationRecord, reservation: InstanceReservation): boolean {
  return (
    record.phase !== 'committed' &&
    record.closed === undefined &&
    !record.returning &&
    record.commit_point === 'registry' &&
    sameRelease(releaseOf(reservation), record.to)
  );
}

export function operationNextSteps(record: OperationRecord): OperationNextSteps {
  const id = record.instance_id;
  if (record.closed === 'failed') return { continueWith: `gws-ea update --id ${id}` };
  return record.kind === 'update' && !record.no_rollback_target
    ? { continueWith: `gws-ea update --id ${id}`, revertWith: `gws-ea rollback --id ${id}` }
    : { continueWith: `gws-ea ${record.kind} --id ${id}` };
}

/** The clause naming what reverts an unfinished operation, or nothing when only continuing it can. */
export function revertClause(next: OperationNextSteps): string {
  return next.revertWith ? `, or revert it with ${next.revertWith}` : '';
}

/** How an unfinished record reads to an operator: its kind, target, and phase. */
function describeRecord(record: OperationRecord): string {
  const subject = `${record.kind === 'update' ? 'An update' : 'A rollback'} of this assistant`;
  return `${subject} to ${record.to.release_track} ${shortCommit(record.to.deployed_commit)}`;
}

/**
 * The refusal an unfinished operation gives, naming what continues or reverts
 * it. `deploying` is the release a conflicting `update` would have deployed:
 * the tool moved since staging, so only the gws-ea at the staged release can
 * continue it.
 */
function inProgress(record: OperationRecord, deploying?: ReleaseCoordinates): GwsEaError {
  const next = operationNextSteps(record);
  const staged = shortCommit(record.to.deployed_commit);
  const moved = deploying ? `, and this gws-ea deploys ${shortCommit(deploying.deployed_commit)}` : '';
  const continued = deploying ? `${next.continueWith} from the gws-ea at ${staged}` : next.continueWith;
  return new GwsEaError(
    'operation_in_progress',
    `${describeRecord(record)} is unfinished (${record.phase})${moved}. ` +
      `Continue it with ${continued}${revertClause(next)}.`,
    { details: { phase: record.phase, continueWith: next.continueWith, revertWith: next.revertWith ?? null } },
  );
}

/**
 * The refusal a record closed for fix-forward gives: only an update to
 * another release goes on. Only a rollback of a committed release tried to
 * go back; an update with no release to return to, or a rollback reverting
 * an update, had none to try.
 */
function closedFailed(record: OperationRecord): GwsEaError {
  const id = record.instance_id;
  const returned = record.kind === 'rollback' && record.commit_point === 'registry';
  return new GwsEaError(
    'operation_failed',
    `${describeRecord(record)} failed${returned ? ', and so did returning to the release it left' : ' and left no release to return to'} (${record.phase}). ` +
      `Fix it forward: update it to a newer release with gws-ea update --id ${id}, or remove it with gws-ea remove --id ${id}.`,
    { details: { phase: record.phase, continueWith: `gws-ea update --id ${id}` } },
  );
}

/** Whether an update to `target`, another release, may replace an unfinished `record` (KTD9): it has no release to return to. */
export function supersedable(record: OperationRecord, target: ReleaseCoordinates): boolean {
  return (
    record.phase !== 'committed' &&
    (record.closed === 'failed' || (record.kind === 'update' && record.no_rollback_target === true)) &&
    !sameRelease(record.to, target)
  );
}

function refusal(record: OperationRecord, intent: OperationIntent): GwsEaError | undefined {
  if (intent.command === 'update' && supersedable(record, intent.target)) return undefined;
  if (record.closed === 'failed') return closedFailed(record);
  switch (intent.command) {
    case 'rollback':
      return undefined;
    case 'update':
      if (record.kind === 'update' && sameRelease(record.to, intent.target)) return undefined;
      return inProgress(record, record.kind === 'update' ? intent.target : undefined);
    case 'create':
    case 'resume':
    case 'start':
    case 'stop':
    case 'restart':
    case 'ncl':
    case 'connect-google':
      return inProgress(record);
  }
}

/**
 * The gate `acquireInstanceOperation` applies under the instance lock. An
 * open record is resolved against the registry first, and one it shows
 * committed is settled here; only then may it refuse `intent`. A record that
 * cannot be read refuses every command, since nothing can tell what it left
 * half-done.
 */
export async function admitInstanceCommand(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  intent: OperationIntent,
): Promise<void> {
  const record = await readOperationRecord(paths, reservation.instance_id);
  if (!record) return;
  const resolved = committedByRegistry(record, reservation) ? await settleCommitted(paths, record) : record;
  if (!resolved || resolved.phase === 'committed') return;
  const refused = refusal(resolved, intent);
  if (refused) throw refused;
}

/**
 * Recovery's first read, the resolution the gate makes (KTD2): an operation
 * that failed before it was committed may have passed its commit point anyway.
 * When the registry already names its target, the compare-and-swap ran and
 * only the writes after it failed, so the release stands and nothing may
 * revert it: this throws `cause` reported that way, naming the command whose
 * gate settles the record and runs its follow-ups. Nothing is written, since
 * the write that failed may fail again. Otherwise it returns, and recovery
 * goes on.
 */
export async function assertNotCommitted(operation: InstanceOperation, cause: unknown): Promise<void> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const record = await readOperationRecord(paths, instanceId);
  if (!record || !committedByRegistry(record, await getInstanceReservation(paths, instanceId))) return;
  const continueWith = `gws-ea ${record.kind} --id ${instanceId}`;
  throw new GwsEaError(
    'operation_unsettled',
    `${safeErrorMessage(cause)} Assistant ${instanceId} runs ${record.to.release_track} ${shortCommit(record.to.deployed_commit)}: ` +
      `its ${record.kind} was committed before that failed, so it stands, and ${continueWith} finishes recording it.`,
    { cause, details: { phase: record.phase, continueWith } },
  );
}

/**
 * The operation as `list` and `status` show it: read-only, lock-free, and
 * resolved against the registry the same way the gate resolves it.
 */
export async function inspectOperation(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<OperationInspection> {
  let record: OperationRecord | undefined;
  try {
    record = await readOperationRecord(paths, reservation.instance_id);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    return { state: 'unreadable', code: error.code, message: error.message };
  }
  if (!record) return { state: 'none' };
  if (committedByRegistry(record, reservation)) record = { ...record, phase: 'committed' };
  if (record.phase === 'committed') return { state: 'committed', record };
  return { state: record.closed === 'failed' ? 'failed' : 'open', record, next: operationNextSteps(record) };
}

async function currentRecord(operation: InstanceOperation): Promise<OperationRecord> {
  operation.assertActive();
  const record = await readOperationRecord(operation.paths, operation.instanceId);
  if (!record) throw new GwsEaError('operation_missing', 'This assistant has no update or rollback under way');
  return record;
}

/**
 * Whether an unfinished operation's target may have run: from `switched` the
 * live link may name it, so a reboot, a login, or a start that failed after
 * the service manager began it can have run it, and leaving it takes the
 * rollback rules (R14). Before that, nothing could start it.
 */
export function targetMayHaveStarted(record: OperationRecord): boolean {
  return rank(record.phase) >= rank('switched') && record.phase !== 'committed';
}

/** Whether `start` is a rollback reverting `record`, an update whose release may have started and was never committed. */
function reverts(record: OperationRecord, start: OperationStart): boolean {
  return (
    record.kind === 'update' &&
    record.closed === undefined &&
    record.no_rollback_target === undefined &&
    targetMayHaveStarted(record) &&
    start.kind === 'rollback' &&
    sameRelease(start.from, record.to) &&
    sameRelease(start.to, record.from)
  );
}

/**
 * Record an update or rollback at `staged`, once it is decided and before
 * anything changes: staging and the preview write no record. It starts from
 * the release the registry names, and replaces in one write, so the gate
 * never lifts:
 *
 * - a committed update's record with follow-ups left, when it is a rollback,
 *   carrying those follow-ups, so a failed rebuild never blocks going back
 *   and nothing it planned is dropped;
 * - an update whose release may have started and was never committed, when it
 *   is the rollback reverting it, which commits by its own record and keeps the
 *   update's start time, so it finds the snapshot the update took;
 * - a record with no release to return to, when it is an update to another
 *   release, which supersedes it with no release to return to either,
 *   carrying the follow-ups it left, so none is dropped (KTD9).
 */
export async function beginOperation(operation: InstanceOperation, start: OperationStart): Promise<OperationRecord> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const from = parseRelease(start.from, 'from');
  const to = parseRelease(start.to, 'to');
  if (from.deployed_commit === to.deployed_commit) {
    throw invalid('An update or rollback must change the deployed commit');
  }
  const existing = await readOperationRecord(paths, instanceId);
  const now = new Date().toISOString();
  let commitPoint: OperationCommitPoint = 'registry';
  let startedAt = now;
  let followUps: readonly OperationFollowUp[] = [];
  let noRollbackTarget = start.no_rollback_target === true;
  if (existing?.phase === 'committed') {
    if (start.kind !== 'rollback') {
      throw new GwsEaError(
        'operation_follow_ups_pending',
        "This assistant's last update or rollback still has follow-ups to finish before another can start",
      );
    }
    followUps = existing.follow_ups;
  } else if (existing && reverts(existing, start)) {
    commitPoint = 'record';
    startedAt = existing.started_at;
  } else if (existing && start.kind === 'update' && supersedable(existing, to)) {
    noRollbackTarget = true;
    followUps = existing.follow_ups;
  } else if (existing) {
    throw existing.closed === 'failed' ? closedFailed(existing) : inProgress(existing);
  }
  const registered = releaseOf(await getInstanceReservation(paths, instanceId));
  if (!sameRelease(registered, commitPoint === 'record' ? to : from)) {
    throw new GwsEaError(
      'reservation_mismatch',
      "The assistant's recorded release is not the one this operation moves",
    );
  }
  return writeRecord(paths, {
    schema_version: OPERATION_RECORD_SCHEMA_VERSION,
    instance_id: instanceId,
    kind: start.kind,
    commit_point: commitPoint,
    from,
    to,
    phase: 'staged',
    started_at: startedAt,
    updated_at: now,
    ...(start.manifest ? { manifest: start.manifest } : {}),
    follow_ups: followUps,
    ...(noRollbackTarget ? { no_rollback_target: true as const } : {}),
  });
}

/** An open record that may still move: not committed, closed, or going back. */
function assertMoving(record: OperationRecord): void {
  if (record.phase === 'committed' || record.closed || record.returning) {
    throw new GwsEaError(
      'operation_phase',
      `This ${record.kind} is ${record.closed ? 'closed' : record.returning ? 'going back' : 'committed'}; it does not move on`,
    );
  }
}

/**
 * Move an open operation to `phase`, adding `facts`. Re-entering the current
 * phase records fresh facts (a fence re-established on resume records its
 * stop again); a phase is never left backward. `committed` is reached only
 * through `commitOperationRelease`.
 */
export async function advanceOperation(
  operation: InstanceOperation,
  phase: Exclude<OperationPhase, 'committed'>,
  facts: OperationFacts = {},
): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  assertMoving(record);
  if (rank(phase) < rank(record.phase)) {
    throw new GwsEaError(
      'operation_phase_regression',
      `An update or rollback cannot move back from ${record.phase} to ${phase}`,
    );
  }
  return writeRecord(operation.paths, { ...record, ...facts, phase, updated_at: new Date().toISOString() });
}

/** Add facts to an open operation without moving its phase. */
export async function recordOperationFacts(
  operation: InstanceOperation,
  facts: OperationFacts,
): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  assertMoving(record);
  return writeRecord(operation.paths, { ...record, ...facts, updated_at: new Date().toISOString() });
}

/** Mark a rollback that failed as going back to the release it left (KTD5); continuing it finishes the return. */
export async function beginOperationReturn(operation: InstanceOperation): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  if (record.returning) return record;
  if (record.kind !== 'rollback' || record.commit_point !== 'registry' || record.phase === 'committed') {
    throw new GwsEaError('operation_phase', `Only a rollback of a committed release goes back to it`);
  }
  return writeRecord(operation.paths, { ...record, returning: true, updated_at: new Date().toISOString() });
}

/** Close an operation that cannot go back for fix-forward (KTD9): only an update to another release replaces it. */
export async function closeOperationFailed(operation: InstanceOperation): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  if (record.phase === 'committed') throw new GwsEaError('operation_phase', 'A committed operation is not closed');
  const { returning: _returning, ...rest } = record;
  return writeRecord(operation.paths, { ...rest, closed: 'failed', updated_at: new Date().toISOString() });
}

/**
 * End an operation that will not commit: an update refused before its
 * release started, or a rollback declined or gone back. Its record is
 * deleted, unless it is a rollback that replaced a committed update with
 * follow-ups left: that update is committed again, with them, so nothing it
 * planned is dropped.
 */
export async function discardOperation(operation: InstanceOperation): Promise<void> {
  const record = await currentRecord(operation);
  if (record.phase === 'committed') throw new GwsEaError('operation_phase', 'A committed operation is not discarded');
  if (record.kind === 'rollback' && record.commit_point === 'registry' && record.follow_ups.length > 0) {
    await settleFollowUps(operation.paths, {
      schema_version: OPERATION_RECORD_SCHEMA_VERSION,
      instance_id: record.instance_id,
      kind: 'update',
      commit_point: 'registry',
      from: record.to,
      to: record.from,
      phase: 'committed',
      started_at: record.started_at,
      updated_at: record.updated_at,
      follow_ups: record.follow_ups,
    });
    return;
  }
  await removePrivateFile(operation.paths.operationFile(operation.instanceId));
}

/**
 * The commit point: once verified, the registry compare-and-swap moves the
 * reservation to the target (unless the registry already names it, after a
 * crash right after the swap), then the rollback point is settled and the
 * record becomes `committed`, releasing the gate. Returns what is left to
 * follow up, or undefined once the record is deleted because nothing is.
 */
export async function commitOperationRelease(operation: InstanceOperation): Promise<OperationRecord | undefined> {
  const record = await currentRecord(operation);
  if (record.phase === 'committed') return record;
  if (record.phase !== 'verified' || record.returning || record.closed) {
    throw new GwsEaError(
      'operation_phase',
      `An update or rollback is committed only once verified; this one is at ${record.phase}`,
    );
  }
  const { paths, instanceId } = operation;
  const registered = releaseOf(await getInstanceReservation(paths, instanceId));
  if (!sameRelease(registered, record.to)) {
    if (record.commit_point === 'record') {
      throw new GwsEaError(
        'reservation_mismatch',
        "The assistant's recorded release is not the one this rollback restores",
      );
    }
    await swapInstanceRelease(paths, instanceId, record.from, record.to);
  }
  return settleCommitted(paths, record);
}

/** Add follow-ups to a committed operation's, each at most once: a rebuild records the image it displaces first. */
export async function addFollowUps(
  operation: InstanceOperation,
  followUps: readonly OperationFollowUp[],
): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  if (record.phase !== 'committed') throw new GwsEaError('operation_phase', 'Follow-ups run once committed');
  return writeRecord(operation.paths, {
    ...record,
    follow_ups: planFollowUps(record.follow_ups, followUps),
    updated_at: new Date().toISOString(),
  });
}

/** Mark one follow-up done; the record is deleted with the last. Returns what is left. */
export async function completeFollowUp(
  operation: InstanceOperation,
  followUp: OperationFollowUp,
): Promise<OperationRecord | undefined> {
  const record = await currentRecord(operation);
  if (record.phase !== 'committed') throw new GwsEaError('operation_phase', 'Follow-ups run once committed');
  const done = followUpKey(followUp);
  return settleFollowUps(operation.paths, {
    ...record,
    follow_ups: record.follow_ups.filter((pending) => followUpKey(pending) !== done),
  });
}

/**
 * The commits the live link may name: the registry's, and while an update or
 * rollback is open or closed failed, either release it moves between.
 */
export function liveCheckoutCommits(
  reservation: InstanceReservation,
  record: OperationRecord | undefined,
): readonly string[] {
  const commits = new Set([reservation.deployed_commit]);
  if (record && record.phase !== 'committed') {
    commits.add(record.from.deployed_commit);
    commits.add(record.to.deployed_commit);
  }
  return [...commits];
}

/** The registry entry with `release` overlaid: the view an update stages before it writes its record. */
export function reservationAt(reservation: InstanceReservation, release: ReleaseCoordinates): InstanceReservation {
  return { ...reservation, ...releaseOf(release) };
}
