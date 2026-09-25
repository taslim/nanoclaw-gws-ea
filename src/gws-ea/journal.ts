/**
 * The provision journal (KTD4): the minimal durable record of one instance's
 * provisioning. It is created together with the reservation, so a missing
 * journal means nothing started, and every later write replaces it atomically
 * under the instance operation lock.
 *
 * Readers ignore unknown fields. A journal from before schema 3, or from a
 * launcher with a different step contract, is refused with guidance to remove
 * and recreate the assistant: pre-release instances are disposable.
 */
import { lstat } from 'node:fs/promises';
import path from 'node:path';

import { readJson, writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { assertPrivateStateFile, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import type { PrincipalCandidate } from './principal.js';
import { parsePrincipalCandidate } from './principal-selection.js';
import { redact } from './redact.js';
import { assertInstanceId, getInstanceReservation } from './registry.js';
import { removePrivateFile } from './secrets.js';
import { GwsEaError, PROVISION_STEPS, type ProvisionStepId } from './types.js';
import { hasControlCharacters, isRecord, requireString } from './validation.js';

export const PROVISION_JOURNAL_SCHEMA_VERSION = 3 as const;

/**
 * The step contract this launcher provisions under. Bump it when a launcher
 * can no longer continue a journal an earlier launcher started: the steps,
 * their order, or what a completed step promises changed.
 */
export const LAUNCHER_CONTRACT_VERSION = 1 as const;

export interface JournalStep {
  readonly started_at: string;
  readonly completed_at?: string;
}

/** Human decisions supplied on re-entry. */
export interface JournalDecisions {
  /** `--chat-configured`: the operator finished the Google Chat app configuration. */
  readonly chat_configuration_confirmed_at?: string;
  /** The principal conversation, fixed once chosen. */
  readonly principal?: PrincipalCandidate;
}

export interface JournalError {
  readonly step: ProvisionStepId;
  readonly code: string;
  readonly message: string;
  readonly at: string;
  /** The failed step's raw log, or the run's progress log. */
  readonly log?: string;
}

export interface ProvisionJournal {
  readonly schema_version: typeof PROVISION_JOURNAL_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly launcher_contract_version: typeof LAUNCHER_CONTRACT_VERSION;
  /** When provisioning began: only principal messages after it count. */
  readonly started_at: string;
  readonly steps: Readonly<Partial<Record<ProvisionStepId, JournalStep>>>;
  readonly decisions: JournalDecisions;
  /** `provision_gcp` lifted the project's key-creation policy, so removal restores it (KTD5). */
  readonly key_policy_lifted: boolean;
  readonly last_error?: JournalError;
}

const operationBrand: unique symbol = Symbol('gws-ea-instance-operation');
const activeOperations = new WeakSet<object>();

export interface InstanceOperation {
  readonly instanceId: string;
  readonly paths: ControlPlanePaths;
  readonly [operationBrand]: true;
  release(): void;
}

function recreate(instanceId: string): string {
  return `Remove it with gws-ea remove --id ${instanceId}, then create it again.`;
}

function invalid(message: string): GwsEaError {
  return new GwsEaError('invalid_journal', message);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string') throw invalid(`Provision journal ${label} is invalid`);
  const parsed = new Date(value);
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw invalid(`Provision journal ${label} is invalid`);
  }
  return value;
}

function text(value: unknown, label: string): string {
  return requireString(value, `Provision journal ${label}`, 'invalid_journal', 4_096);
}

function parseSteps(value: unknown): ProvisionJournal['steps'] {
  if (!isRecord(value)) throw invalid('Provision journal steps are invalid');
  const steps: Partial<Record<ProvisionStepId, JournalStep>> = {};
  for (const id of PROVISION_STEPS) {
    const step = value[id];
    if (step === undefined) continue;
    if (!isRecord(step)) throw invalid(`Provision journal step ${id} is invalid`);
    steps[id] = {
      started_at: timestamp(step.started_at, `${id} start`),
      ...(step.completed_at === undefined ? {} : { completed_at: timestamp(step.completed_at, `${id} completion`) }),
    };
  }
  return steps;
}

function parseDecisions(value: unknown): JournalDecisions {
  if (!isRecord(value)) throw invalid('Provision journal decisions are invalid');
  return {
    ...(value.chat_configuration_confirmed_at === undefined
      ? {}
      : { chat_configuration_confirmed_at: timestamp(value.chat_configuration_confirmed_at, 'Chat confirmation') }),
    ...(value.principal === undefined ? {} : { principal: parsePrincipalCandidate(value.principal) }),
  };
}

function parseError(value: unknown): JournalError {
  if (!isRecord(value) || !PROVISION_STEPS.includes(value.step as ProvisionStepId)) {
    throw invalid('Provision journal last error is invalid');
  }
  return {
    step: value.step as ProvisionStepId,
    code: text(value.code, 'error code'),
    message: text(value.message, 'error message'),
    at: timestamp(value.at, 'error time'),
    ...(value.log === undefined ? {} : { log: text(value.log, 'error log') }),
  };
}

function parseJournal(value: unknown, instanceId: string): ProvisionJournal {
  if (!isRecord(value)) throw invalid('Provision journal is invalid');
  if (value.schema_version !== PROVISION_JOURNAL_SCHEMA_VERSION) {
    throw new GwsEaError(
      'unsupported_journal',
      `This assistant was set up by an earlier gws-ea and cannot be continued. ${recreate(instanceId)}`,
    );
  }
  if (value.instance_id !== instanceId) {
    throw new GwsEaError('journal_mismatch', 'Provision journal and registry instance IDs disagree');
  }
  if (value.launcher_contract_version !== LAUNCHER_CONTRACT_VERSION) {
    throw new GwsEaError(
      'incompatible_launcher',
      `This assistant was set up by a gws-ea launcher with a different step contract ` +
        `(${String(value.launcher_contract_version)}; this launcher uses ${LAUNCHER_CONTRACT_VERSION}). ${recreate(instanceId)}`,
    );
  }
  if (typeof value.key_policy_lifted !== 'boolean') throw invalid('Provision journal key policy fact is invalid');
  return {
    schema_version: PROVISION_JOURNAL_SCHEMA_VERSION,
    instance_id: instanceId,
    launcher_contract_version: LAUNCHER_CONTRACT_VERSION,
    started_at: timestamp(value.started_at, 'start'),
    steps: parseSteps(value.steps),
    decisions: parseDecisions(value.decisions),
    key_policy_lifted: value.key_policy_lifted,
    ...(value.last_error === undefined ? {} : { last_error: parseError(value.last_error) }),
  };
}

/**
 * Write a new journal for a reservation about to be published; the registry
 * calls this under its machine lock, before the reservation becomes visible.
 */
export async function createProvisionJournal(paths: ControlPlanePaths, instanceId: string): Promise<ProvisionJournal> {
  assertInstanceId(instanceId);
  await preparePrivateDirectory(paths.instanceRoot(instanceId));
  const file = paths.journalFile(instanceId);
  const exists = await lstat(file).then(
    () => true,
    (error: unknown) => {
      if (isErrno(error, 'ENOENT')) return false;
      throw error;
    },
  );
  if (exists) throw new GwsEaError('instance_state_exists', 'A provision journal already exists for this instance');
  const journal: ProvisionJournal = {
    schema_version: PROVISION_JOURNAL_SCHEMA_VERSION,
    instance_id: instanceId,
    launcher_contract_version: LAUNCHER_CONTRACT_VERSION,
    started_at: new Date().toISOString(),
    steps: {},
    decisions: {},
    key_policy_lifted: false,
  };
  await writePrivate(file, journal);
  return journal;
}

/** Discard the journal of a reservation that was never published. */
export async function discardProvisionJournal(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  assertInstanceId(instanceId);
  await removePrivateFile(paths.journalFile(instanceId));
}

export async function readProvisionJournal(paths: ControlPlanePaths, instanceId: string): Promise<ProvisionJournal> {
  assertInstanceId(instanceId);
  const file = paths.journalFile(instanceId);
  let raw: unknown;
  try {
    await assertPrivateStateFile(file);
    raw = await readJson<unknown>(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new GwsEaError(
        'journal_missing',
        `This assistant has no provision journal, so gws-ea cannot tell what was set up. ${recreate(instanceId)}`,
      );
    }
    if (error instanceof GwsEaError) throw error;
    throw invalid('Provision journal cannot be parsed safely');
  }
  return parseJournal(raw, instanceId);
}

function assertActiveOperation(operation: InstanceOperation): void {
  if (!activeOperations.has(operation)) {
    throw new GwsEaError('operation_inactive', 'Instance operation lock is not active');
  }
}

async function updateProvisionJournal(
  operation: InstanceOperation,
  change: (journal: ProvisionJournal) => ProvisionJournal,
): Promise<ProvisionJournal> {
  assertActiveOperation(operation);
  const next = change(await readProvisionJournal(operation.paths, operation.instanceId));
  await writePrivate(operation.paths.journalFile(operation.instanceId), next);
  return next;
}

/** Record a step's first start; a resumed step keeps its original start. */
export function recordStepStarted(operation: InstanceOperation, step: ProvisionStepId): Promise<ProvisionJournal> {
  return updateProvisionJournal(operation, (journal) =>
    journal.steps[step]
      ? journal
      : { ...journal, steps: { ...journal.steps, [step]: { started_at: new Date().toISOString() } } },
  );
}

export function recordStepCompleted(operation: InstanceOperation, step: ProvisionStepId): Promise<ProvisionJournal> {
  return updateProvisionJournal(operation, (journal) => {
    const now = new Date().toISOString();
    const { last_error: lastError, ...rest } = journal;
    return {
      ...rest,
      ...(lastError && lastError.step !== step ? { last_error: lastError } : {}),
      steps: { ...journal.steps, [step]: { started_at: journal.steps[step]?.started_at ?? now, completed_at: now } },
    };
  });
}

/** One bounded line, so a recorded failure always reads back. */
function singleLine(value: string): string {
  const printable = [...value].map((character) => (hasControlCharacters(character) ? ' ' : character)).join('');
  return printable.replace(/\s+/gu, ' ').trim().slice(0, 1_000) || 'unknown';
}

/** Record why a step stopped; only a GWS-EA error's own message is kept, redacted. */
export function recordStepFailure(
  operation: InstanceOperation,
  step: ProvisionStepId,
  error: unknown,
  log: string | undefined,
): Promise<ProvisionJournal> {
  const known = error instanceof GwsEaError;
  const failure: JournalError = {
    step,
    code: singleLine(known ? error.code : 'unexpected'),
    message: singleLine(known ? redact(error.message) : 'Unexpected control-plane failure.'),
    at: new Date().toISOString(),
    ...(log ? { log: singleLine(log) } : {}),
  };
  return updateProvisionJournal(operation, (journal) => ({ ...journal, last_error: failure }));
}

export function recordChatConfigurationConfirmed(operation: InstanceOperation): Promise<ProvisionJournal> {
  return updateProvisionJournal(operation, (journal) =>
    journal.decisions.chat_configuration_confirmed_at
      ? journal
      : {
          ...journal,
          decisions: { ...journal.decisions, chat_configuration_confirmed_at: new Date().toISOString() },
        },
  );
}

/** Fix the principal conversation; a different later choice is refused. */
export function recordPrincipalSelection(
  operation: InstanceOperation,
  candidate: PrincipalCandidate,
): Promise<ProvisionJournal> {
  const selected = parsePrincipalCandidate(candidate);
  return updateProvisionJournal(operation, (journal) => {
    const existing = journal.decisions.principal;
    if (existing && JSON.stringify(existing) !== JSON.stringify(selected)) {
      throw new GwsEaError(
        'principal_selection_mismatch',
        'The principal selection is already fixed for this instance',
      );
    }
    return existing ? journal : { ...journal, decisions: { ...journal.decisions, principal: selected } };
  });
}

export function recordKeyPolicyLifted(operation: InstanceOperation, lifted: boolean): Promise<ProvisionJournal> {
  return updateProvisionJournal(operation, (journal) => ({ ...journal, key_policy_lifted: lifted }));
}

export async function acquireInstanceOperation(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<InstanceOperation | null> {
  assertInstanceId(instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const unlock = await processLock(paths.instanceLock(instanceId));
  if (!unlock) return null;
  try {
    try {
      await assertPrivateStateFile(paths.removalFile(instanceId));
      throw new GwsEaError('removal_in_progress', 'Assistant removal is in progress; provisioning cannot resume');
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error;
    }
    await getInstanceReservation(paths, instanceId);
    await preparePrivateDirectory(paths.instanceRoot(instanceId));
  } catch (error) {
    unlock();
    throw error;
  }
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
