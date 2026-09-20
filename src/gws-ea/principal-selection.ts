import { isErrno } from '../community-portal/errors.js';
import type { ControlPlanePaths } from './paths.js';
import type { PrincipalCandidate } from './principal.js';
import { readOwnerOnlyFile, writeOwnerOnlyFileExclusive } from './secrets.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

const SCHEMA_VERSION = 1 as const;

export interface PrincipalSelectionReceipt {
  readonly schema_version: typeof SCHEMA_VERSION;
  readonly instance_id: string;
  readonly adapter_instance: string;
  readonly provisioning_started_at: string;
  readonly candidate: PrincipalCandidate;
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function identifier(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 512 || hasControlCharacters(value)) {
    throw new GwsEaError('invalid_principal_selection', `${label} is invalid`);
  }
  return value;
}

function timestamp(value: unknown, label: string): string {
  const parsed = typeof value === 'string' ? new Date(value) : undefined;
  if (!parsed || !Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new GwsEaError('invalid_principal_selection', `${label} is invalid`);
  }
  return value as string;
}

function candidate(value: unknown): PrincipalCandidate {
  if (
    !isRecord(value) ||
    !exactKeys(value, [
      'messagingGroupId',
      'platformId',
      'userId',
      'senderName',
      'authenticatedMessageId',
      'authenticatedMessageAt',
    ])
  ) {
    throw new GwsEaError('invalid_principal_selection', 'Principal candidate is invalid');
  }
  const senderName = value.senderName;
  if (
    senderName !== null &&
    (typeof senderName !== 'string' || senderName.length > 120 || hasControlCharacters(senderName))
  ) {
    throw new GwsEaError('invalid_principal_selection', 'Principal display name is invalid');
  }
  const userId = identifier(value.userId, 'User ID');
  if (!userId.startsWith('gchat:')) {
    throw new GwsEaError('invalid_principal_selection', 'Principal user ID is not a Google Chat identity');
  }
  return {
    messagingGroupId: identifier(value.messagingGroupId, 'Messaging group ID'),
    platformId: identifier(value.platformId, 'Platform ID'),
    userId,
    senderName,
    authenticatedMessageId: identifier(value.authenticatedMessageId, 'Authenticated message ID'),
    authenticatedMessageAt: timestamp(value.authenticatedMessageAt, 'Authenticated message time'),
  };
}

function validate(
  value: unknown,
  expected: { readonly instanceId: string; readonly adapterInstance: string; readonly provisioningStartedAt: string },
): PrincipalSelectionReceipt {
  if (
    !isRecord(value) ||
    !exactKeys(value, ['schema_version', 'instance_id', 'adapter_instance', 'provisioning_started_at', 'candidate'])
  ) {
    throw new GwsEaError('invalid_principal_selection', 'Principal selection receipt is invalid');
  }
  if (
    value.schema_version !== SCHEMA_VERSION ||
    value.instance_id !== expected.instanceId ||
    value.adapter_instance !== expected.adapterInstance ||
    value.provisioning_started_at !== expected.provisioningStartedAt
  ) {
    throw new GwsEaError('principal_selection_mismatch', 'Principal selection does not match this instance');
  }
  return {
    schema_version: SCHEMA_VERSION,
    instance_id: expected.instanceId,
    adapter_instance: expected.adapterInstance,
    provisioning_started_at: timestamp(value.provisioning_started_at, 'Provisioning start'),
    candidate: candidate(value.candidate),
  };
}

export async function loadPrincipalSelection(
  paths: ControlPlanePaths,
  instanceId: string,
  adapterInstance: string,
  provisioningStartedAt: string,
): Promise<PrincipalSelectionReceipt | undefined> {
  try {
    const value = JSON.parse(await readOwnerOnlyFile(paths.principalSelectionFile(instanceId))) as unknown;
    return validate(value, { instanceId, adapterInstance, provisioningStartedAt });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (error instanceof SyntaxError) {
      throw new GwsEaError('invalid_principal_selection', 'Principal selection receipt is invalid JSON');
    }
    throw error;
  }
}

export async function persistPrincipalSelection(
  paths: ControlPlanePaths,
  instanceId: string,
  adapterInstance: string,
  provisioningStartedAt: string,
  selected: PrincipalCandidate,
): Promise<PrincipalCandidate> {
  const existing = await loadPrincipalSelection(paths, instanceId, adapterInstance, provisioningStartedAt);
  if (existing) {
    if (JSON.stringify(existing.candidate) !== JSON.stringify(selected)) {
      throw new GwsEaError(
        'principal_selection_mismatch',
        'The principal selection is already fixed for this instance',
      );
    }
    return existing.candidate;
  }
  const receipt: PrincipalSelectionReceipt = {
    schema_version: SCHEMA_VERSION,
    instance_id: instanceId,
    adapter_instance: adapterInstance,
    provisioning_started_at: provisioningStartedAt,
    candidate: selected,
  };
  try {
    await writeOwnerOnlyFileExclusive(
      paths.principalSelectionFile(instanceId),
      `${JSON.stringify(receipt, null, 2)}\n`,
    );
    return selected;
  } catch (error) {
    if (!isErrno(error, 'EEXIST')) throw error;
    const raced = await loadPrincipalSelection(paths, instanceId, adapterInstance, provisioningStartedAt);
    if (!raced || JSON.stringify(raced.candidate) !== JSON.stringify(selected)) {
      throw new GwsEaError(
        'principal_selection_mismatch',
        'The principal selection is already fixed for this instance',
      );
    }
    return raced.candidate;
  }
}
