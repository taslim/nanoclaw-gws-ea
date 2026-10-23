import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { hasControlCharacters, isRecord, normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { ALLOW, DENY, HOLD, defineGuardedAction } from '../../guard/index.js';
import type { Session } from '../../types.js';
import { listPrincipalAddresses, principalApproverUserId } from '../gws-ea-profile/db.js';
import { requirePrincipalMessage, type PrincipalMessage } from '../gws-ea-profile/marks.js';
import { privateValuesGivenAwayInHtml, type PrivateValueReference } from '../gws-ea-privacy/outbound.js';
import {
  artifactDigest,
  getArtifact,
  getArtifactRequest,
  getArtifactRevision,
  type ArtifactActor,
  type ArtifactRevision,
} from './db.js';
import { artifactActor } from './policy.js';

export const ARTIFACT_SHARE_APPROVAL = 'artifact_share_private_values';
export interface ArtifactRecipient {
  readonly email: string;
  readonly name?: string;
}
export interface ArtifactPrincipalMark {
  readonly id: string;
  readonly messaging_group_id: string;
}
interface ShareBase {
  readonly artifact_id: string;
  readonly principal_message: ArtifactPrincipalMark;
}
interface Publication extends ShareBase {
  readonly revision: number;
  readonly expected_hash: string;
  readonly expires_at?: string | null;
  /** Main's judgment that this exact principal instruction explicitly permits these detected details. */
  readonly private_value_ids?: readonly string[];
}
interface Replacement {
  readonly share_id: string;
  readonly expected_generation: number;
}
export type ArtifactShareInput =
  | (Publication & { readonly operation: 'named_publish'; readonly recipients: readonly ArtifactRecipient[] })
  | (Publication & { readonly operation: 'public_publish' })
  | (Publication &
      Replacement & { readonly operation: 'named_replace'; readonly recipients: readonly ArtifactRecipient[] })
  | (Publication & Replacement & { readonly operation: 'public_replace' })
  | (ShareBase & Replacement & { readonly operation: 'revoke' });

function closed(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key))) throw invalidArgs('Unexpected artifact share field.');
}
function id(value: unknown): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/u.test(value))
    throw invalidArgs('A valid artifact share identifier is required.');
  return value;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1)
    throw invalidArgs('A positive revision or generation is required.');
  return value;
}
function mark(value: unknown): ArtifactPrincipalMark {
  if (!isRecord(value)) throw invalidArgs('Cite the principal_message.');
  closed(value, ['id', 'messaging_group_id']);
  return { id: id(value.id), messaging_group_id: id(value.messaging_group_id) };
}
export function parseArtifactShare(content: Record<string, unknown>): ArtifactShareInput {
  const operation = content.operation;
  if (!['named_publish', 'public_publish', 'named_replace', 'public_replace', 'revoke'].includes(String(operation)))
    throw invalidArgs('Choose a supported artifact share operation.');
  const replacement = operation === 'named_replace' || operation === 'public_replace' || operation === 'revoke';
  const named = operation === 'named_publish' || operation === 'named_replace';
  closed(content, [
    'action',
    'requestId',
    'operation',
    'artifact_id',
    'principal_message',
    ...(replacement ? ['share_id', 'expected_generation'] : []),
    ...(operation === 'revoke' ? [] : ['revision', 'expected_hash', 'expires_at', 'private_value_ids']),
    ...(named ? ['recipients'] : []),
  ]);
  const base = { artifact_id: id(content.artifact_id), principal_message: mark(content.principal_message) };
  if (operation === 'revoke')
    return {
      ...base,
      operation,
      share_id: id(content.share_id),
      expected_generation: integer(content.expected_generation),
    };
  if (typeof content.expected_hash !== 'string' || !/^[a-f0-9]{64}$/u.test(content.expected_hash))
    throw invalidArgs('expected_hash must be the saved source SHA-256 hash.');
  if (
    content.expires_at !== undefined &&
    content.expires_at !== null &&
    (typeof content.expires_at !== 'string' ||
      !Number.isFinite(Date.parse(content.expires_at)) ||
      new Date(content.expires_at).toISOString() !== content.expires_at)
  )
    throw invalidArgs('expires_at must be an ISO timestamp or null.');
  let privateIds: readonly string[] | undefined;
  if (content.private_value_ids !== undefined) {
    if (!Array.isArray(content.private_value_ids) || content.private_value_ids.length > 100)
      throw invalidArgs('private_value_ids must list up to 100 exact value references.');
    privateIds = [...new Set(content.private_value_ids.map(id))].sort();
  }
  const publication = {
    ...base,
    revision: integer(content.revision),
    expected_hash: content.expected_hash,
    ...(content.expires_at === undefined ? {} : { expires_at: content.expires_at as string | null }),
    ...(privateIds === undefined ? {} : { private_value_ids: privateIds }),
  };
  let recipients: ArtifactRecipient[] = [];
  if (named) {
    if (!Array.isArray(content.recipients) || content.recipients.length < 1 || content.recipients.length > 100)
      throw invalidArgs('Named sharing requires 1 to 100 exact email recipients.');
    recipients = content.recipients
      .map((recipient: unknown) => {
        if (!isRecord(recipient)) throw invalidArgs('Each recipient needs an exact email address.');
        closed(recipient, ['email', 'name']);
        const email = typeof recipient.email === 'string' ? normalizePrincipalEmail(recipient.email) : undefined;
        if (!email) throw invalidArgs('Each recipient needs an exact email address.');
        if (
          recipient.name !== undefined &&
          (typeof recipient.name !== 'string' ||
            !recipient.name.trim() ||
            recipient.name.length > 256 ||
            hasControlCharacters(recipient.name))
        )
          throw invalidArgs('A recipient name must be nonempty text of at most 256 characters.');
        return { email, ...(typeof recipient.name === 'string' ? { name: recipient.name } : {}) };
      })
      .sort((a, b) => a.email.localeCompare(b.email));
    if (new Set(recipients.map(({ email }) => email)).size !== recipients.length)
      throw invalidArgs('Name each exact email recipient once.');
  }
  switch (operation) {
    case 'named_publish':
      return { ...publication, operation, recipients };
    case 'public_publish':
      return { ...publication, operation };
    case 'named_replace':
      return {
        ...publication,
        operation,
        recipients,
        share_id: id(content.share_id),
        expected_generation: integer(content.expected_generation),
      };
    case 'public_replace':
      return {
        ...publication,
        operation,
        share_id: id(content.share_id),
        expected_generation: integer(content.expected_generation),
      };
    default:
      throw invalidArgs('Unsupported artifact share operation.');
  }
}
export interface ArtifactShareAuthority {
  readonly actor: ArtifactActor;
  readonly input: ArtifactShareInput;
  readonly revision?: ArtifactRevision;
  readonly scopeHash: string;
  readonly expiresAt: string | null;
  readonly privateValues: readonly PrivateValueReference[];
  readonly needsConfirmation: boolean;
  readonly principalMessage: PrincipalMessage;
}
/** Host-only identity of the exact native request that reserved a pending share. */
export interface ArtifactShareReservation {
  readonly requestId: string;
}
interface ShareState {
  readonly share_id: string;
  readonly kind: string;
  readonly generation: number;
  readonly state: string;
  readonly revision: number | null;
  readonly source_hash: string | null;
  readonly scope_hash: string | null;
  readonly expires_at: string | null;
}
/** Fresh structural authority; main remains the semantic judge of the cited instruction. No remote work. */
export async function authorizeArtifactShare(
  session: Session,
  input: ArtifactShareInput,
  reservation?: ArtifactShareReservation,
): Promise<ArtifactShareAuthority> {
  const actor = await artifactActor(session);
  if (!actor?.isMain) throw forbidden('Only canonical main may share artifacts under current capability policy.');
  const principalMessage = await requirePrincipalMessage(
    input.principal_message.id,
    input.principal_message.messaging_group_id,
  );
  const artifact = await getArtifact(actor, input.artifact_id);
  if (!artifact) throw forbidden('This artifact is unavailable.');
  let reserved: { shareId: string; generation: number; scopeHash: string } | undefined;
  if (reservation) {
    if (input.operation === 'revoke') throw forbidden('Revocation cannot use a publication reservation.');
    const request = await getArtifactRequest(actor, {
      requestId: reservation.requestId,
      action: 'share',
      fingerprint: artifactDigest(input),
    });
    if (!request || request.state !== 'pending') throw forbidden('This exact artifact share request is not pending.');
    const payload: unknown = JSON.parse(request.payload_json);
    if (
      !isRecord(payload) ||
      !isRecord(payload.input) ||
      artifactDigest(payload.input) !== artifactDigest(input) ||
      typeof payload.share_id !== 'string' ||
      typeof payload.generation !== 'number' ||
      typeof payload.scope_hash !== 'string' ||
      payload.generation !== ('expected_generation' in input ? input.expected_generation + 1 : 1) ||
      ('share_id' in input && payload.share_id !== input.share_id)
    )
      throw forbidden('The reserved artifact share does not match this exact request.');
    reserved = { shareId: payload.share_id, generation: payload.generation, scopeHash: payload.scope_hash };
  }
  let held: ShareState | undefined;
  const shareId = reserved?.shareId ?? ('share_id' in input ? input.share_id : undefined);
  if (shareId) {
    held = await getDb().get(
      'SELECT share_id,kind,generation,state,revision,source_hash,scope_hash,expires_at FROM gws_ea_artifact_shares WHERE artifact_id=? AND share_id=?',
      input.artifact_id,
      shareId,
    );
    const generation = reserved?.generation ?? ('expected_generation' in input ? input.expected_generation : undefined);
    if (!held || held.state === 'revoked' || held.generation !== generation || (reserved && held.state !== 'pending'))
      throw forbidden('This share changed or was revoked. Read its current generation before acting.');
    if (
      input.operation !== 'revoke' &&
      held.kind !== (input.operation === 'named_replace' || input.operation === 'named_publish' ? 'named' : 'public')
    )
      throw forbidden('The share audience kind does not match.');
  }
  const revision =
    input.operation === 'revoke' ? undefined : await getArtifactRevision(input.artifact_id, input.revision);
  if (input.operation !== 'revoke' && (!revision || revision.source_hash !== input.expected_hash))
    throw forbidden('The saved artifact revision or hash does not match.');
  const requestedExpiry = input.operation === 'revoke' ? null : (input.expires_at ?? null);
  const expiresAt =
    requestedExpiry === null
      ? artifact.expires_at
      : artifact.expires_at === null
        ? requestedExpiry
        : requestedExpiry < artifact.expires_at
          ? requestedExpiry
          : artifact.expires_at;
  if (expiresAt !== null && expiresAt <= new Date().toISOString()) throw forbidden('This share expiry has passed.');
  const principals = new Set((await listPrincipalAddresses()).map(({ email }) => email));
  const principalOnly = 'recipients' in input && input.recipients.every(({ email }) => principals.has(email));
  const privateValues =
    revision && !principalOnly ? await privateValuesGivenAwayInHtml(revision.html, revision.title) : [];
  const explicit = new Set(input.operation === 'revoke' ? [] : (input.private_value_ids ?? []));
  const needsConfirmation = privateValues.some(({ id: valueId }) => !explicit.has(valueId));
  const scopeHash = artifactDigest({
    actor,
    input,
    title: revision?.title ?? null,
    sourceHash: revision?.source_hash ?? null,
    artifactGeneration: artifact.generation,
    artifactExpiry: artifact.expires_at,
    expiresAt,
    privateValues,
    principalMessage,
  });
  if (
    reserved &&
    (!held ||
      held.scope_hash !== scopeHash ||
      reserved.scopeHash !== scopeHash ||
      held.revision !== revision?.revision ||
      held.source_hash !== revision?.source_hash ||
      held.expires_at !== expiresAt)
  )
    throw forbidden('The reserved artifact share authority changed.');
  if (reserved && 'recipients' in input) {
    const actual = (
      await getDb().all<{ email: string }>(
        'SELECT email FROM gws_ea_artifact_share_recipients WHERE share_id=? ORDER BY email',
        reserved.shareId,
      )
    ).map(({ email }) => email);
    if (artifactDigest(actual) !== artifactDigest(input.recipients.map(({ email }) => email).sort()))
      throw forbidden('The reserved artifact share recipients changed.');
  }
  return {
    actor,
    input,
    ...(revision ? { revision } : {}),
    scopeHash,
    expiresAt,
    privateValues,
    needsConfirmation,
    principalMessage,
  };
}
/** The durable share handler owns holds and reentry. A grant cannot override fresh denial. */
export const artifactShareAction = defineGuardedAction({
  action: 'gws_ea_artifacts.share',
  grantActionName: ARTIFACT_SHARE_APPROVAL,
  grantCoversRequest: (grant, input) => {
    try {
      const payload: unknown = JSON.parse(grant.payload);
      return (
        isRecord(payload) &&
        input.actor.kind === 'agent' &&
        grant.session_id === input.actor.sessionId &&
        typeof input.payload.scope_hash === 'string' &&
        payload.scope_hash === input.payload.scope_hash
      );
    } catch (error) {
      if (error instanceof SyntaxError) return false;
      throw error;
    }
  },
  decide: async ({ actor, payload }) => {
    if (actor.kind !== 'agent' || actor.sessionId === undefined)
      return DENY('Only canonical main may share artifacts.');
    const session = await getSession(actor.sessionId);
    if (!session || session.agent_group_id !== actor.agentGroupId || !isRecord(payload.input))
      return DENY('Artifact share session or input is invalid.');
    if (payload.reservation_request_id !== undefined && typeof payload.reservation_request_id !== 'string')
      return DENY('Invalid artifact share reservation.');
    const authorized = await authorizeArtifactShare(
      session,
      parseArtifactShare(payload.input),
      typeof payload.reservation_request_id === 'string' ? { requestId: payload.reservation_request_id } : undefined,
    );
    if (payload.scope_hash !== authorized.scopeHash) return DENY('Artifact share authority changed.');
    if (!authorized.needsConfirmation) return ALLOW('Exact principal instruction and current artifact audience.');
    const approver = await principalApproverUserId();
    if (!approver) return DENY('No current verified principal can confirm these private details.');
    return HOLD('The exact shared revision contains private details requiring principal confirmation.', approver);
  },
});
