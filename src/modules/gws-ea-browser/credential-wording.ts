import { quoted } from '../approvals/request-text.js';
import type { CredentialKind } from './authentication-signatures.js';
import type { CredentialAttempt } from './credential-types.js';

/** to: main, delegator */
const credentialAuthorityMessages = {
  accessRequired: 'Only an agent with browser access may delegate an account signup or password change.',
  unknownField: 'Unknown credential_authority field.',
  authorityRequired:
    'credential_authority needs the job thread, signup or change_password, the HTTPS site and the exact account username.',
  publicSite: 'The site must be a public HTTPS address.',
  liveJob: 'No live browser job of yours exists for that thread.',
  releaseAccess: 'Only an agent with browser access may ask the principal to release a credential attempt.',
  settled: 'That credential attempt is settled, or its own step settles it.',
  principalDecision: 'Only the principal may end an attempt whose outcome the host cannot establish.',
  releaseFields: 'release needs only the job thread and the credential authority it recorded.',
  jobRequired: 'No browser job of yours exists for that thread.',
  cannotAsk: 'The principal could not be asked right now.',
  principalOnly: 'The credential attempt was not released: only the principal can decide that.',
  settledFirst: 'The credential attempt was not released: another step settled it first.',
} as const;

export function credentialAuthorityMessage(kind: keyof typeof credentialAuthorityMessages): string {
  return credentialAuthorityMessages[kind];
}

/** to: browser */
const credentialFormMessages = {
  freshFields: 'Choose credential fields and the activation control from a fresh observation.',
  authorityAndFields:
    'Choose the credential authority recorded for this errand, submit, verify or reconcile, and fields from a fresh observation.',
  verificationPair: 'Name the verification code field together with the control that submits it, or neither.',
  fieldGroup:
    'Name each field once, with the new password beside any confirmation or current password, and the control that submits them.',
  newAccountOnly: 'Only a new account verifies its email.',
  noCurrentPassword: 'A signup has no current password to fill.',
  passwordFields: 'A password change fills the current and new password fields, never a username.',
  cannotBind: 'The host could not safely bind this form. Take a fresh observation.',
  verificationLink: 'The host refused an insecure or off-site verification link.',
} as const;

export function credentialFormMessage(kind: keyof typeof credentialFormMessages): string {
  return credentialFormMessages[kind];
}

/** to: principal */
export function releaseQuestion(attempt: CredentialAttempt): string {
  const account = `${quoted(attempt.username, 256)} on ${attempt.site}`;
  const action = attempt.kind === 'signup' ? `create the account ${account}` : `change the password of ${account}`;
  const verification =
    attempt.phase === 'awaiting_verification' ? ' The site asked to confirm it by email, which never completed.' : '';
  return `I tried to ${action}, but I can't tell whether the site accepted it.${verification}\nIf you release it, I stop waiting and discard the generated password. If the site took it, I can reset the password through my email. The site is free for another errand.`;
}

export function parsedEvidence(attempt: Pick<CredentialAttempt, 'evidence_json'>): unknown {
  return attempt.evidence_json === null ? undefined : JSON.parse(attempt.evidence_json);
}

/** to: main, delegator */
export function credentialReleaseRefused(reason: string): string {
  return `The credential attempt was not released: ${reason}`;
}
/** to: main, delegator */
export function credentialReleased(current: CredentialAttempt): string {
  return `The principal released the ${current.kind === 'signup' ? 'signup' : 'password change'} for ${current.username} on ${current.site}. The generated password was discarded.${current.kind === 'rotation' ? ' The saved login keeps its previous password.' : ''} If the site took the generated password, the assistant can reset it through its email. The site is free again.`;
}
/** to: principal */
export function credentialReleaseTitle(kind: CredentialKind): string {
  return kind === 'signup' ? 'Stop waiting on this account signup?' : 'Stop waiting on this password change?';
}
/** to: main, delegator */
export function credentialReleaseRejected(attempt: CredentialAttempt | undefined, reason: string | undefined): string {
  const errand = attempt
    ? `the ${attempt.kind === 'signup' ? 'account signup' : 'password change'} for "${attempt.username}" on ${attempt.site}`
    : 'that signup or password change';
  return `The principal chose to keep waiting on ${errand}${reason ? `: "${reason}"` : ''}. It stays as it is.`;
}

/** to: main */
export function orphanCredentialNotice(attempt: CredentialAttempt): string {
  return (
    `The browser errand for ${attempt.site}, account ${JSON.stringify(attempt.username)}, is unavailable. ` +
    `Its ${attempt.kind === 'signup' ? 'signup' : 'password change'} may have reached the site and still holds it. ` +
    `Ask the principal whether to keep waiting or release it. To request their release card, use credential_authority ` +
    `with operation "release", authority ${attempt.id}, and thread ${attempt.job_id}. ` +
    `Releasing discards the generated password; it does not undo a change the site may have accepted.`
  );
}
