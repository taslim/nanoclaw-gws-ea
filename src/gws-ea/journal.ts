import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import {
  assertPrivateLocalDirectory,
  assertPrivateStateFile,
  preparePrivateLocalDirectory,
  type ControlPlanePaths,
} from './paths.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import {
  GwsEaError,
  PROVISION_JOURNAL_SCHEMA_VERSION,
  PROVISION_PHASES,
  type JournalAttempt,
  type JournalObservation,
  type JournalPhase,
  type ProvisionJournal,
  type ProvisionPhase,
} from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

const ATTEMPT_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RESOURCE_KEY_PATTERN = /^[a-z][a-z0-9-]{0,31}:[0-9a-f]{64}$/;
const FAILURE_CODE_PATTERN = /^[a-z][a-z0-9_.-]{0,63}$/;
const RESOURCE_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
const operationBrand: unique symbol = Symbol('gws-ea-instance-operation');
const activeOperations = new WeakSet<object>();

export interface InstanceOperation {
  readonly instanceId: string;
  readonly paths: ControlPlanePaths;
  readonly [operationBrand]: true;
  release(): void;
}

export interface BeginPhaseResult {
  journal: ProvisionJournal;
  attempt: JournalAttempt;
  requires_reconciliation: boolean;
}

export type PhaseObservationInput = { matched: false; resource_key?: never } | { matched: true; resource_key: string };

function assertExactKeys(value: Record<string, unknown>, expected: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new GwsEaError('invalid_journal', `${label} contains unknown or missing fields`);
  }
}

function requireIsoTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw new GwsEaError('invalid_journal', `${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw new GwsEaError('invalid_journal', `${label} is invalid`);
  }
  return value;
}

function validateResourceKey(value: unknown): string {
  if (typeof value !== 'string' || !RESOURCE_KEY_PATTERN.test(value)) {
    throw new GwsEaError('invalid_journal', 'Journal resource key is invalid');
  }
  return value;
}

function validateObservation(value: unknown, expectedResourceKey: string): JournalObservation {
  if (!isRecord(value)) throw new GwsEaError('invalid_journal', 'Journal observation is invalid');
  if (value.matched === true) {
    assertExactKeys(value, ['matched', 'observed_at', 'resource_key'], 'Journal observation');
    const resourceKey = validateResourceKey(value.resource_key);
    if (resourceKey !== expectedResourceKey) {
      throw new GwsEaError('resource_mismatch', 'Observed resource key does not match phase intent');
    }
    return {
      matched: true,
      observed_at: requireIsoTimestamp(value.observed_at, 'observed_at'),
      resource_key: resourceKey,
    };
  }
  if (value.matched === false) {
    assertExactKeys(value, ['matched', 'observed_at'], 'Journal observation');
    return { matched: false, observed_at: requireIsoTimestamp(value.observed_at, 'observed_at') };
  }
  throw new GwsEaError('invalid_journal', 'Journal observation match result is invalid');
}

function validateAttempt(value: unknown): JournalAttempt {
  if (!isRecord(value)) throw new GwsEaError('invalid_journal', 'Journal attempt is invalid');
  const allowedKeys = ['attempt_id', 'resource_key', 'intended_at', 'observation', 'failure', 'succeeded_at'];
  const actualKeys = Object.keys(value);
  if (
    actualKeys.some((key) => !allowedKeys.includes(key)) ||
    !['attempt_id', 'resource_key', 'intended_at'].every((key) => key in value)
  ) {
    throw new GwsEaError('invalid_journal', 'Journal attempt contains unknown or missing fields');
  }
  if (typeof value.attempt_id !== 'string' || !ATTEMPT_ID_PATTERN.test(value.attempt_id)) {
    throw new GwsEaError('invalid_journal', 'Journal attempt ID is invalid');
  }
  const resourceKey = validateResourceKey(value.resource_key);
  const attempt: JournalAttempt = {
    attempt_id: value.attempt_id,
    resource_key: resourceKey,
    intended_at: requireIsoTimestamp(value.intended_at, 'intended_at'),
  };
  if (value.observation !== undefined) attempt.observation = validateObservation(value.observation, resourceKey);
  if (value.failure !== undefined) {
    if (!isRecord(value.failure)) throw new GwsEaError('invalid_journal', 'Journal failure is invalid');
    assertExactKeys(value.failure, ['code', 'failed_at'], 'Journal failure');
    if (typeof value.failure.code !== 'string' || !FAILURE_CODE_PATTERN.test(value.failure.code)) {
      throw new GwsEaError('invalid_journal', 'Journal failure code is invalid');
    }
    attempt.failure = {
      code: value.failure.code,
      failed_at: requireIsoTimestamp(value.failure.failed_at, 'failed_at'),
    };
  }
  if (value.succeeded_at !== undefined) {
    if (!attempt.observation?.matched || attempt.observation.resource_key !== resourceKey) {
      throw new GwsEaError('invalid_journal', 'Successful attempt lacks a matching observed postcondition');
    }
    attempt.succeeded_at = requireIsoTimestamp(value.succeeded_at, 'succeeded_at');
  }
  return attempt;
}

function validatePhase(value: unknown): JournalPhase {
  if (!isRecord(value)) throw new GwsEaError('invalid_journal', 'Journal phase is invalid');
  assertExactKeys(value, ['attempts'], 'Journal phase');
  if (!Array.isArray(value.attempts)) throw new GwsEaError('invalid_journal', 'Journal attempts are invalid');
  const attempts = value.attempts.map(validateAttempt);
  const ids = new Set(attempts.map((attempt) => attempt.attempt_id));
  if (ids.size !== attempts.length) throw new GwsEaError('invalid_journal', 'Journal attempt IDs must be unique');
  for (const [index, attempt] of attempts.entries()) {
    if (attempt.succeeded_at && index !== attempts.length - 1) {
      throw new GwsEaError('invalid_journal', 'A successful attempt must be the final phase attempt');
    }
    if (index < attempts.length - 1 && attempt.observation?.matched !== false) {
      throw new GwsEaError('invalid_journal', 'A retry requires a negative reconciliation of the previous attempt');
    }
  }
  return { attempts };
}

function validateJournal(value: unknown, expectedInstanceId: string): ProvisionJournal {
  if (!isRecord(value)) throw new GwsEaError('invalid_journal', 'Provision journal is invalid');
  assertExactKeys(value, ['schema_version', 'instance_id', 'phases'], 'Provision journal');
  if (value.schema_version !== PROVISION_JOURNAL_SCHEMA_VERSION) {
    throw new GwsEaError('unsupported_journal', 'Provision journal schema version is unsupported');
  }
  if (value.instance_id !== expectedInstanceId) {
    throw new GwsEaError('journal_mismatch', 'Provision journal and registry instance IDs disagree');
  }
  if (!isRecord(value.phases)) throw new GwsEaError('invalid_journal', 'Provision journal phases are invalid');
  assertExactKeys(value.phases, PROVISION_PHASES, 'Provision journal phases');

  const phases = {} as Record<ProvisionPhase, JournalPhase>;
  let foundIncomplete = false;
  for (const phase of PROVISION_PHASES) {
    const parsed = validatePhase(value.phases[phase]);
    const succeeded = parsed.attempts.at(-1)?.succeeded_at !== undefined;
    if (foundIncomplete && parsed.attempts.length > 0) {
      throw new GwsEaError('invalid_journal', 'A later phase has state before its predecessor succeeded');
    }
    if (!succeeded) foundIncomplete = true;
    phases[phase] = parsed;
  }
  return {
    schema_version: PROVISION_JOURNAL_SCHEMA_VERSION,
    instance_id: expectedInstanceId,
    phases,
  };
}

function emptyJournal(instanceId: string): ProvisionJournal {
  const phases = {} as Record<ProvisionPhase, JournalPhase>;
  for (const phase of PROVISION_PHASES) phases[phase] = { attempts: [] };
  return { schema_version: PROVISION_JOURNAL_SCHEMA_VERSION, instance_id: instanceId, phases };
}

function assertActiveOperation(operation: InstanceOperation): void {
  if (!activeOperations.has(operation)) {
    throw new GwsEaError('operation_inactive', 'Instance operation lock is not active');
  }
}

export async function acquireInstanceOperation(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceOperation | null> {
  assertInstanceId(instanceId);
  await getInstanceReservation(paths, instanceId);
  await preparePrivateLocalDirectory(paths.instanceRoot(instanceId));
  const unlock = await processLock(paths.instanceLock(instanceId));
  if (!unlock) return null;
  let active = true;
  const operation: InstanceOperation = {
    instanceId,
    paths,
    [operationBrand]: true,
    release: () => {
      if (!active) return;
      active = false;
      activeOperations.delete(operation);
      unlock();
    },
  };
  activeOperations.add(operation);
  return operation;
}

export async function withInstanceOperation<T>(
  paths: ControlPlanePaths,
  instanceId: string,
  run: (operation: InstanceOperation) => Promise<T>,
): Promise<T | null> {
  const operation = await acquireInstanceOperation(paths, instanceId);
  if (!operation) return null;
  try {
    return await run(operation);
  } finally {
    operation.release();
  }
}

export function journalResourceKey(kind: string, value: string): string {
  if (!RESOURCE_KIND_PATTERN.test(kind)) throw new GwsEaError('invalid_resource_key', 'Resource key kind is invalid');
  if (!value || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_resource_key', 'Resource key value is invalid');
  }
  return `${kind}:${createHash('sha256').update(value).digest('hex')}`;
}

async function readJournalFile(paths: ControlPlanePaths, instanceId: string): Promise<ProvisionJournal> {
  const file = paths.journalFile(instanceId);
  try {
    await assertPrivateStateFile(file);
    const raw = await readJson<unknown>(file);
    return validateJournal(raw, instanceId);
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    if (isErrno(error, 'ENOENT')) throw error;
    throw new GwsEaError('invalid_journal', 'Provision journal cannot be parsed safely');
  }
}

export async function readProvisionJournal(paths: ControlPlanePaths, instanceId: string): Promise<ProvisionJournal> {
  assertInstanceId(instanceId);
  await getInstanceReservation(paths, instanceId);
  await assertPrivateLocalDirectory(paths.instanceRoot(instanceId));
  return readJournalFile(paths, instanceId);
}

export async function ensureProvisionJournal(operation: InstanceOperation): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  try {
    return await readJournalFile(operation.paths, operation.instanceId);
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  const journal = emptyJournal(operation.instanceId);
  await writePrivate(operation.paths.journalFile(operation.instanceId), journal);
  return journal;
}

export function firstIncompletePhase(journal: ProvisionJournal): ProvisionPhase | undefined {
  return PROVISION_PHASES.find((phase) => journal.phases[phase].attempts.at(-1)?.succeeded_at === undefined);
}

async function persistJournal(operation: InstanceOperation, journal: ProvisionJournal): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  const validated = validateJournal(journal, operation.instanceId);
  await writePrivate(operation.paths.journalFile(operation.instanceId), validated);
  return validated;
}

export async function beginPhase(
  operation: InstanceOperation,
  phase: ProvisionPhase,
  resourceKey: string,
): Promise<BeginPhaseResult> {
  assertActiveOperation(operation);
  validateResourceKey(resourceKey);
  const journal = await readJournalFile(operation.paths, operation.instanceId);
  const incomplete = firstIncompletePhase(journal);
  if (incomplete !== phase) {
    throw new GwsEaError('phase_order', `Cannot begin phase; first incomplete phase is ${incomplete ?? 'none'}`);
  }
  const attempts = journal.phases[phase].attempts;
  const previous = attempts.at(-1);
  if (previous) {
    if (previous.resource_key !== resourceKey) {
      throw new GwsEaError('resource_mismatch', 'Resume cannot change the phase resource key');
    }
    if (previous.observation?.matched !== false) {
      return { journal, attempt: previous, requires_reconciliation: true };
    }
  }
  const attempt: JournalAttempt = {
    attempt_id: randomUUID(),
    resource_key: resourceKey,
    intended_at: new Date().toISOString(),
  };
  attempts.push(attempt);
  const persisted = await persistJournal(operation, journal);
  return {
    journal: persisted,
    attempt: persisted.phases[phase].attempts.at(-1)!,
    requires_reconciliation: false,
  };
}

function currentAttempt(journal: ProvisionJournal, phase: ProvisionPhase, attemptId: string): JournalAttempt {
  const attempt = journal.phases[phase].attempts.at(-1);
  if (!attempt || attempt.attempt_id !== attemptId) {
    throw new GwsEaError('attempt_mismatch', 'Journal attempt is not the current phase attempt');
  }
  return attempt;
}

export async function observePhase(
  operation: InstanceOperation,
  phase: ProvisionPhase,
  attemptId: string,
  observation: PhaseObservationInput,
): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  const journal = await readJournalFile(operation.paths, operation.instanceId);
  if (firstIncompletePhase(journal) !== phase) {
    throw new GwsEaError('phase_order', 'Only the first incomplete phase may be observed');
  }
  const attempt = currentAttempt(journal, phase, attemptId);
  if (observation.matched && observation.resource_key !== attempt.resource_key) {
    throw new GwsEaError('resource_mismatch', 'Observed resource key does not match phase intent');
  }
  if (attempt.observation) {
    const same =
      attempt.observation.matched === observation.matched &&
      (!observation.matched || attempt.observation.resource_key === observation.resource_key);
    if (!same) throw new GwsEaError('observation_conflict', 'Phase already has a different observation');
    return journal;
  }
  attempt.observation = {
    matched: observation.matched,
    observed_at: new Date().toISOString(),
    ...(observation.matched ? { resource_key: observation.resource_key } : {}),
  };
  return persistJournal(operation, journal);
}

export async function commitPhaseSuccess(
  operation: InstanceOperation,
  phase: ProvisionPhase,
  attemptId: string,
): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  const journal = await readJournalFile(operation.paths, operation.instanceId);
  const attempt = currentAttempt(journal, phase, attemptId);
  if (attempt.succeeded_at) return journal;
  if (!attempt.observation?.matched || attempt.observation.resource_key !== attempt.resource_key) {
    throw new GwsEaError('postcondition_missing', 'Phase postcondition must be observed before success');
  }
  if (firstIncompletePhase(journal) !== phase) {
    throw new GwsEaError('phase_order', 'Only the first incomplete phase may commit success');
  }
  attempt.succeeded_at = new Date().toISOString();
  return persistJournal(operation, journal);
}

export async function recordPhaseFailure(
  operation: InstanceOperation,
  phase: ProvisionPhase,
  attemptId: string,
  code: string,
): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  if (!FAILURE_CODE_PATTERN.test(code)) throw new GwsEaError('invalid_failure', 'Failure code is invalid');
  const journal = await readJournalFile(operation.paths, operation.instanceId);
  if (firstIncompletePhase(journal) !== phase) {
    throw new GwsEaError('phase_order', 'Only the first incomplete phase may record failure');
  }
  const attempt = currentAttempt(journal, phase, attemptId);
  attempt.failure = { code, failed_at: new Date().toISOString() };
  return persistJournal(operation, journal);
}

export async function readRawJournalForDiagnostics(paths: ControlPlanePaths, instanceId: string): Promise<string> {
  assertInstanceId(instanceId);
  await assertPrivateStateFile(paths.journalFile(instanceId));
  return readFile(paths.journalFile(instanceId), 'utf8');
}
