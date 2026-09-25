import type { PrincipalCandidate } from './principal.js';
import { GwsEaError } from './types.js';
import { hasControlCharacters, isRecord } from './validation.js';

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

/**
 * Read the principal conversation the operator selected, as the provision
 * journal records it. Unknown fields are ignored; known ones must be exact.
 */
export function parsePrincipalCandidate(value: unknown): PrincipalCandidate {
  if (!isRecord(value)) throw new GwsEaError('invalid_principal_selection', 'Principal candidate is invalid');
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
