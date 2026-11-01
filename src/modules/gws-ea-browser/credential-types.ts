import { isRecord } from '../../gws-ea/validation.js';

export type CredentialAttemptKind = 'signup' | 'rotation';
export type CredentialAttemptPhase =
  | 'saved'
  | 'exposed'
  | 'awaiting_verification'
  | 'unknown'
  | 'finalized'
  | 'rejected';
export const HELD_CREDENTIAL_PHASES = ['exposed', 'awaiting_verification', 'unknown'] as const;
export const RELEASABLE_PHASES: readonly CredentialAttemptPhase[] = ['unknown', 'awaiting_verification'];
interface CredentialAttemptRecord {
  readonly id: string;
  readonly job_id: string;
  readonly origin: string;
  readonly site: string;
  readonly username: string;
  readonly phase: CredentialAttemptPhase;
  readonly evidence_json: string | null;
  readonly owned_login_id: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly exposed_at: string | null;
  readonly finalized_at: string | null;
}
export type CredentialAttempt = CredentialAttemptRecord &
  (
    | { readonly kind: 'signup'; readonly source_login_id: null; readonly source_version: null }
    | { readonly kind: 'rotation'; readonly source_login_id: string; readonly source_version: number }
  );
export type CredentialEvidence = Readonly<Record<string, string | number | boolean | null>>;
export class CredentialAttemptError extends Error {
  constructor(readonly reason: 'not_found' | 'invalid_phase' | 'invalid_request') {
    super(reason);
  }
}
export function credentialEvidenceJson(evidence: CredentialEvidence): string {
  if (
    !isRecord(evidence) ||
    Object.keys(evidence).length > 16 ||
    Object.entries(evidence).some(
      ([key, value]) =>
        !/^[a-z][a-z0-9_]{0,63}$/u.test(key) ||
        /password|secret|token|credential|page_text/iu.test(key) ||
        !(
          value === null ||
          typeof value === 'boolean' ||
          (typeof value === 'number' && Number.isFinite(value)) ||
          (typeof value === 'string' && /^[a-z0-9][a-z0-9_:-]{0,199}$/iu.test(value))
        ),
    )
  )
    throw new CredentialAttemptError('invalid_request');
  return JSON.stringify(evidence);
}
