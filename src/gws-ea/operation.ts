/**
 * The operation record: `<instance>/operation.json`, the durable state of one
 * assistant's update or rollback. It lives beside the provision journal for as
 * long as the instance does, is written atomically and owner-only under the
 * instance lock, and readers ignore unknown fields.
 *
 * Its phases run `staged → stopped → swapping → swapped → started → verified →
 * recorded` and only move forward, except that recovery at `swapping` may
 * reverse the renames back to `stopped`. From `staged` through `verified` the
 * record is open, and `acquireInstanceOperation` admits only the command that
 * continues or reverts it. `recorded` releases that gate: the record then only
 * lists the follow-ups still to run, and is deleted once none remain.
 *
 * An update's commit point is the registry compare-and-swap, so recovery reads
 * the registry first: an open record whose target the registry already names
 * was committed, and counts as recorded whatever phase it last reached.
 */
import { lstat } from 'node:fs/promises';

import { writePrivate } from '../community-portal/private-file.js';
import { isErrno } from '../community-portal/errors.js';
import type { InstanceOperation } from './journal.js';
import type { ControlPlanePaths } from './paths.js';
import {
  assertInstanceId,
  getInstanceReservation,
  swapInstanceRelease,
  validateReleaseCoordinates,
} from './registry.js';
import { readOwnerOnlyJson, removePrivateFile } from './secrets.js';
import { GwsEaError, releaseOf, sameRelease, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import { isRecord, requireCanonicalTimestamp, requireString } from './validation.js';

export const OPERATION_RECORD_SCHEMA_VERSION = 1 as const;

export const OPERATION_PHASES = [
  'staged',
  'stopped',
  'swapping',
  'swapped',
  'started',
  'verified',
  'recorded',
] as const;
export type OperationPhase = (typeof OPERATION_PHASES)[number];

const OPERATION_KINDS = ['update', 'rollback'] as const;
export type OperationKind = (typeof OPERATION_KINDS)[number];

/**
 * Where an operation's release is committed. `registry`: the registry
 * compare-and-swap from `from` to `to`. `record`: the registry already names
 * `to` (a rollback reverting an update that was never recorded), so writing
 * `recorded` is the commit.
 */
const COMMIT_POINTS = ['registry', 'record'] as const;
export type OperationCommitPoint = (typeof COMMIT_POINTS)[number];

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

/**
 * An agent image tag the operation moved: the image it names after the move,
 * and the one it named before (null when it named none). Both by ID, so a
 * move cut short replays exactly, and a reversal can move it back.
 */
export interface MovedImage {
  readonly tag: string;
  readonly image_id: string;
  readonly displaced_image_id: string | null;
}

const DELETABLE_RELEASES = ['superseded_previous', 'outgoing'] as const;

/** Work that runs once the release is recorded; its failure never rolls back. */
export type OperationFollowUp =
  | { readonly kind: 'rebuild_group_image'; readonly agent_group_id: string }
  | { readonly kind: 'refresh_template' }
  | { readonly kind: 'reverse_template_restamp' }
  | { readonly kind: 'delete_release'; readonly release: (typeof DELETABLE_RELEASES)[number] }
  | { readonly kind: 'delete_image'; readonly image_id: string };

export interface OperationRecord {
  readonly schema_version: typeof OPERATION_RECORD_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly kind: OperationKind;
  readonly commit_point: OperationCommitPoint;
  readonly from: ReleaseCoordinates;
  readonly to: ReleaseCoordinates;
  readonly phase: OperationPhase;
  readonly started_at: string;
  readonly updated_at: string;
  /** The cutover's stop; required from `stopped` on. */
  readonly stop?: OperationStop;
  /** The live schema: as staging read it, until the stop records it again. */
  readonly manifest?: SnapshotManifest;
  readonly images: readonly MovedImage[];
  /** Planned before `recorded`; what is left of it after. */
  readonly follow_ups: readonly OperationFollowUp[];
}

/** Facts an operation adds as it runs; each one given replaces what the record held. */
export type OperationFacts = Partial<Pick<OperationRecord, 'stop' | 'manifest' | 'images' | 'follow_ups'>>;

export type OperationStart = Pick<OperationRecord, 'kind' | 'from' | 'to'> &
  Partial<Pick<OperationRecord, 'manifest' | 'follow_ups'>>;

/**
 * A command that takes the instance lock, and for `update` the release it
 * would deploy. `list`, `status`, and `logs` take no lock and `remove` holds
 * its own, so an open record never stops them.
 */
export type OperationIntent =
  | { readonly command: 'create' | 'resume' | 'start' | 'stop' | 'restart' | 'ncl' | 'rollback' }
  | { readonly command: 'update'; readonly target: ReleaseCoordinates };

/** The commands that continue or revert an unfinished operation. */
export interface OperationNextSteps {
  readonly continueWith: string;
  readonly revertWith?: string;
}

/** What `list` and `status` report, read without the instance lock. */
export type OperationInspection =
  | { readonly state: 'none'; readonly abandonedStaging: boolean }
  | { readonly state: 'open'; readonly record: OperationRecord; readonly next: OperationNextSteps }
  | { readonly state: 'recorded'; readonly record: OperationRecord; readonly abandonedStaging: boolean }
  | { readonly state: 'unreadable'; readonly code: string; readonly message: string };

const INVALID = 'invalid_operation';
const IMAGE_ID_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_TAG_PATTERN = /^[a-z0-9][a-z0-9._/-]*(?::[A-Za-z0-9_][A-Za-z0-9_.-]{0,127})?$/u;
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

function parseImage(value: unknown): MovedImage {
  if (!isRecord(value)) throw invalid('Operation record image is invalid');
  return {
    tag: matching(value.tag, IMAGE_TAG_PATTERN, 'image tag'),
    image_id: matching(value.image_id, IMAGE_ID_PATTERN, 'image ID'),
    displaced_image_id:
      value.displaced_image_id === null ? null : matching(value.displaced_image_id, IMAGE_ID_PATTERN, 'image ID'),
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
    case 'refresh_template':
      return { kind: 'refresh_template' };
    case 'reverse_template_restamp':
      return { kind: 'reverse_template_restamp' };
    case 'delete_release':
      return { kind: 'delete_release', release: oneOf(DELETABLE_RELEASES, value.release, 'release to delete') };
    case 'delete_image':
      return { kind: 'delete_image', image_id: matching(value.image_id, IMAGE_ID_PATTERN, 'image ID') };
    default:
      throw invalid('Operation record follow-up is invalid');
  }
}

/** What makes two follow-ups the same work, so planning one twice records it once. */
export function followUpKey(followUp: OperationFollowUp): string {
  switch (followUp.kind) {
    case 'rebuild_group_image':
      return `${followUp.kind}:${followUp.agent_group_id}`;
    case 'refresh_template':
    case 'reverse_template_restamp':
      return followUp.kind;
    case 'delete_release':
      return `${followUp.kind}:${followUp.release}`;
    case 'delete_image':
      return `${followUp.kind}:${followUp.image_id}`;
  }
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
  const stop = value.stop === undefined ? undefined : parseStop(value.stop);
  if (!stop && rank(phase) >= rank('stopped')) throw invalid(`Operation record at ${phase} must record its stop`);
  return {
    schema_version: OPERATION_RECORD_SCHEMA_VERSION,
    instance_id: instanceId,
    kind: oneOf(OPERATION_KINDS, value.kind, 'kind'),
    commit_point: oneOf(COMMIT_POINTS, value.commit_point, 'commit point'),
    from,
    to,
    phase,
    started_at: timestamp(value.started_at, 'start time'),
    updated_at: timestamp(value.updated_at, 'update time'),
    ...(stop ? { stop } : {}),
    ...(value.manifest === undefined ? {} : { manifest: parseManifest(value.manifest) }),
    images: list(value.images, 'images', parseImage),
    follow_ups: list(value.follow_ups, 'follow-ups', parseFollowUp),
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

/** Mark a committed operation recorded, deleting the record when no follow-up is left. */
async function settleRecorded(paths: ControlPlanePaths, record: OperationRecord): Promise<OperationRecord | undefined> {
  if (record.follow_ups.length === 0) {
    await removePrivateFile(paths.operationFile(record.instance_id));
    return undefined;
  }
  return writeRecord(paths, { ...record, phase: 'recorded', updated_at: new Date().toISOString() });
}

/** An open record whose target the registry already names passed its commit point. */
function committedByRegistry(record: OperationRecord, reservation: InstanceReservation): boolean {
  return (
    record.phase !== 'recorded' && record.commit_point === 'registry' && sameRelease(releaseOf(reservation), record.to)
  );
}

export function operationNextSteps(record: OperationRecord): OperationNextSteps {
  const id = record.instance_id;
  return record.kind === 'update'
    ? { continueWith: `gws-ea update --id ${id}`, revertWith: `gws-ea rollback --id ${id}` }
    : { continueWith: `gws-ea rollback --id ${id}` };
}

function abbreviate(commit: string): string {
  return commit.slice(0, 12);
}

/**
 * The refusal an unfinished operation gives, naming what continues or reverts
 * it. `deploying` is the release a conflicting `update` would have deployed:
 * the tool moved since staging, so only the gws-ea at the staged release can
 * continue it.
 */
function inProgress(record: OperationRecord, deploying?: ReleaseCoordinates): GwsEaError {
  const next = operationNextSteps(record);
  const staged = abbreviate(record.to.deployed_commit);
  const subject = `${record.kind === 'update' ? 'An update' : 'A rollback'} of this assistant`;
  const moved = deploying ? `, and this gws-ea deploys ${abbreviate(deploying.deployed_commit)}` : '';
  const continued = deploying ? `${next.continueWith} from the gws-ea at ${staged}` : next.continueWith;
  const revert = next.revertWith ? `, or revert it with ${next.revertWith}` : '';
  return new GwsEaError(
    'operation_in_progress',
    `${subject} to ${record.to.release_track} ${staged} is unfinished (${record.phase})${moved}. ` +
      `Continue it with ${continued}${revert}.`,
    { details: { phase: record.phase, continueWith: next.continueWith, revertWith: next.revertWith ?? null } },
  );
}

function refusal(record: OperationRecord, intent: OperationIntent): GwsEaError | undefined {
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
      return inProgress(record);
  }
}

/**
 * The gate `acquireInstanceOperation` applies under the instance lock. An
 * open record is resolved against the registry first, and one it shows
 * committed is recorded here; only then may it refuse `intent`. A record
 * that cannot be read refuses every command, since nothing can tell what it
 * left half-moved.
 */
export async function admitInstanceCommand(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  intent: OperationIntent,
): Promise<void> {
  const record = await readOperationRecord(paths, reservation.instance_id);
  if (!record) return;
  const resolved = committedByRegistry(record, reservation) ? await settleRecorded(paths, record) : record;
  if (!resolved || resolved.phase === 'recorded') return;
  const refused = refusal(resolved, intent);
  if (refused) throw refused;
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

/**
 * The operation as `list` and `status` show it: read-only, lock-free, and
 * resolved against the registry the same way the gate resolves it. A `next/`
 * with no open record is staging an interrupted update left behind.
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
  if (record && committedByRegistry(record, reservation)) record = { ...record, phase: 'recorded' };
  if (record && record.phase !== 'recorded') return { state: 'open', record, next: operationNextSteps(record) };
  const abandonedStaging = await exists(paths.releaseRoot(reservation.instance_id, 'next'));
  return record && record.follow_ups.length > 0
    ? { state: 'recorded', record, abandonedStaging }
    : { state: 'none', abandonedStaging };
}

async function currentRecord(operation: InstanceOperation): Promise<OperationRecord> {
  operation.assertActive();
  const record = await readOperationRecord(operation.paths, operation.instanceId);
  if (!record) throw new GwsEaError('operation_missing', 'This assistant has no update or rollback under way');
  return record;
}

/** Whether `start` is a rollback reverting `record`, an update whose renames already ran. */
function reverts(record: OperationRecord, start: OperationStart): boolean {
  return (
    record.kind === 'update' &&
    start.kind === 'rollback' &&
    rank(record.phase) >= rank('swapped') &&
    record.phase !== 'recorded' &&
    sameRelease(start.from, record.to) &&
    sameRelease(start.to, record.from)
  );
}

/**
 * Record an update or rollback at `staged`, once it is decided and before
 * anything changes: staging and the preview write no record. It starts from
 * the release the registry names, unless it is a rollback reverting an update
 * that already swapped but was never recorded; that one replaces the update's
 * record in one write, so the gate never lifts, and commits by its own record.
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
  if (existing?.phase === 'recorded') {
    throw new GwsEaError(
      'operation_follow_ups_pending',
      "This assistant's last update or rollback still has follow-ups to finish before another can start",
    );
  }
  if (existing && !reverts(existing, start)) throw inProgress(existing);
  const registered = releaseOf(await getInstanceReservation(paths, instanceId));
  if (!sameRelease(registered, existing ? to : from)) {
    throw new GwsEaError(
      'reservation_mismatch',
      "The assistant's recorded release is not the one this operation moves",
    );
  }
  const now = new Date().toISOString();
  return writeRecord(paths, {
    schema_version: OPERATION_RECORD_SCHEMA_VERSION,
    instance_id: instanceId,
    kind: start.kind,
    commit_point: existing ? 'record' : 'registry',
    from,
    to,
    phase: 'staged',
    started_at: now,
    updated_at: now,
    ...(start.manifest ? { manifest: start.manifest } : {}),
    images: [],
    follow_ups: start.follow_ups ?? [],
  });
}

/**
 * Move an open operation to `phase`, adding `facts`. Re-entering the current
 * phase records fresh facts (a cutover restarted from `stopped` stops again);
 * the one move back is `swapping → stopped`, once recovery reversed the
 * renames. `recorded` is reached only through `commitOperationRelease`.
 */
export async function advanceOperation(
  operation: InstanceOperation,
  phase: OperationPhase,
  facts: OperationFacts = {},
): Promise<OperationRecord> {
  const record = await currentRecord(operation);
  if (phase === 'recorded' || record.phase === 'recorded') {
    throw new GwsEaError('operation_phase', 'An update or rollback is recorded only by committing its release');
  }
  if (rank(phase) < rank(record.phase) && !(record.phase === 'swapping' && phase === 'stopped')) {
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
  if (record.phase === 'recorded') {
    throw new GwsEaError('operation_phase', 'A recorded update or rollback only completes its follow-ups');
  }
  return writeRecord(operation.paths, { ...record, ...facts, updated_at: new Date().toISOString() });
}

/**
 * The commit point: once verified, the registry compare-and-swap moves the
 * reservation to the target (unless the registry already names it, after a
 * crash right after the swap), then the record becomes `recorded`, releasing
 * the gate. Returns what is left to follow up, or undefined once the record is
 * deleted because nothing is.
 */
export async function commitOperationRelease(operation: InstanceOperation): Promise<OperationRecord | undefined> {
  const record = await currentRecord(operation);
  if (record.phase === 'recorded') return record;
  if (record.phase !== 'verified') {
    throw new GwsEaError(
      'operation_phase',
      `An update or rollback is recorded only once verified; this one is at ${record.phase}`,
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
  return settleRecorded(paths, record);
}

/** Mark one follow-up done; the record is deleted with the last. Returns what is left. */
export async function completeFollowUp(
  operation: InstanceOperation,
  followUp: OperationFollowUp,
): Promise<OperationRecord | undefined> {
  const record = await currentRecord(operation);
  if (record.phase !== 'recorded') {
    throw new GwsEaError('operation_phase', 'Follow-ups run only once the release is recorded');
  }
  const done = followUpKey(followUp);
  return settleRecorded(operation.paths, {
    ...record,
    follow_ups: record.follow_ups.filter((pending) => followUpKey(pending) !== done),
  });
}

/**
 * Delete the record. Before the renames an operation is discarded rather than
 * reverted (its staging is dropped and the old host restarted); a recorded
 * one's follow-ups are given up. From `swapping` until recorded the releases
 * may be half-moved, so the operation can only be continued or reverted.
 */
export async function discardOperation(operation: InstanceOperation): Promise<void> {
  operation.assertActive();
  const record = await readOperationRecord(operation.paths, operation.instanceId);
  if (!record) return;
  if (record.phase !== 'recorded' && rank(record.phase) >= rank('swapping')) throw inProgress(record);
  await removePrivateFile(operation.paths.operationFile(operation.instanceId));
}

/**
 * The commits the live checkout's marker may name: the registry's, and the
 * one an unfinished operation placed there, its origin before the renames
 * and its target from `swapping` on (either may be live mid-rename).
 */
export function liveCheckoutCommits(
  reservation: InstanceReservation,
  record: OperationRecord | undefined,
): readonly string[] {
  const commits = new Set([reservation.deployed_commit]);
  if (record && record.phase !== 'recorded') {
    if (rank(record.phase) <= rank('swapping')) commits.add(record.from.deployed_commit);
    if (rank(record.phase) >= rank('swapping')) commits.add(record.to.deployed_commit);
  }
  return [...commits];
}

/**
 * The target reservation view: the registry entry with the operation's target
 * release overlaid. An update hands it to what checks a reservation's release
 * (the materializer, runtime-config creation, receipt checks) while the
 * registry itself still names the release it moves from.
 */
export function targetReservationView(reservation: InstanceReservation, record: OperationRecord): InstanceReservation {
  if (record.instance_id !== reservation.instance_id) {
    throw new GwsEaError('operation_mismatch', 'The operation record belongs to another instance');
  }
  return reservationAt(reservation, record.to);
}

/** The registry entry with `release` overlaid: the view an update stages before it writes its record. */
export function reservationAt(reservation: InstanceReservation, release: ReleaseCoordinates): InstanceReservation {
  return { ...reservation, ...releaseOf(release) };
}
