import { isRecord } from '../../gws-ea/validation.js';
import { quoted } from '../approvals/request-text.js';
import type { CredentialKind } from './authentication-signatures.js';
import type { CredentialAttempt, CredentialAttemptPhase } from './credential-attempts.js';

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

/**
 * What the host did with a login someone changed or removed in 1Password while it was saving it.
 * to: main, delegator
 */
const LEFT = 'the host left it as it is.';
/** to: main, delegator */
const CHANGED_MEANWHILE = `the login was changed or removed in 1Password meanwhile, and ${LEFT}`;

/**
 * What 1Password holds for an attempt the host could not finish, in the
 * principal's words on the card (`mine`) and in the delegator's note
 * (`theirs`).
 */
/** to: main, delegator, principal */
function vaultLeft(
  attempt: Pick<CredentialAttempt, 'kind' | 'site' | 'settlement'>,
  phase: CredentialAttemptPhase,
): { readonly mine: string | undefined; readonly theirs: string } {
  const item = `"New password for ${attempt.site}"`;
  if (attempt.kind === 'signup')
    switch (phase) {
      case 'conflict':
        return {
          mine: undefined,
          theirs: `Its login was changed or removed in 1Password before the host finished saving it, and ${LEFT}`,
        };
      case 'confirmed':
        return {
          mine: `Its password is in my 1Password vault, in the login "${attempt.site}" that I couldn't finish saving.`,
          theirs: `Its password stays in the assistant's 1Password vault, in the login "${attempt.site}" the host could not finish saving.`,
        };
      default:
        return {
          mine: 'The password I generated for it is kept in my 1Password vault.',
          theirs: `Its password stays in the assistant's 1Password vault, in the login "${attempt.site}", which the host has not finished saving.`,
        };
    }
  if (phase === 'conflict')
    return {
      mine: `The new password is in my 1Password vault as its own item, ${item}.`,
      theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}; ${CHANGED_MEANWHILE}`,
    };
  if (phase !== 'confirmed')
    return {
      mine: 'Both the original and the new password are kept in my 1Password vault.',
      theirs:
        "Both the original and the new password stay in the assistant's 1Password vault; the login was not updated.",
    };
  switch (attempt.settlement) {
    case 'promoted':
      return {
        mine: `The item ${item} may still hold a copy of it and of the old password.`,
        theirs: `The login holds the new password; the item ${item} may still hold a copy of it and of the old password.`,
      };
    case 'kept':
      return {
        mine: `The new password is in my 1Password vault as its own item, ${item}, which may still hold the old password too.`,
        theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}, which may still hold the old password too; ${CHANGED_MEANWHILE}`,
      };
    case null:
      return {
        mine: `The new password is in my 1Password vault as its own item, ${item}, and the login may still have the old one.`,
        theirs: `The new password stays in the assistant's 1Password vault as its own item, ${item}; the login may still have the old one.`,
      };
  }
}

/**
 * What happened, as the principal reads it first on the card.
 * to: principal
 */
function situation(attempt: CredentialAttempt, account: string): string {
  if (attempt.kind === 'signup')
    switch (attempt.phase) {
      case 'conflict':
        return `The site created the account ${account}, but its login in my 1Password vault was changed or removed before I finished saving it, so I left it as it is.`;
      case 'confirmed':
        return `The site created the account ${account}, but I can't reach 1Password to finish saving its login.`;
      case 'awaiting_verification':
        return `I tried to create the account ${account}. The site asked to confirm it by email, which never completed, so I can't tell whether the account was created.`;
      default: {
        const evidence: unknown = parsedEvidence(attempt);
        const via = isRecord(evidence) ? evidence.via : undefined;
        return via === 'link' || via === 'code'
          ? `The site asked to confirm the account ${account} by email, and I used the ${via} it sent, but I can't tell whether the site accepted it.`
          : `I tried to create the account ${account}, but I can't tell whether the account was created.`;
      }
    }
  if (attempt.phase === 'conflict' || (attempt.phase === 'confirmed' && attempt.settlement === 'kept'))
    return `The site took a new password for ${account}, but its login in my 1Password vault was changed or removed while I was changing it, so I left the login as it is.`;
  if (attempt.phase === 'confirmed')
    return attempt.settlement === 'promoted'
      ? `The site took a new password for ${account}, and the login in my 1Password vault has it, but I can't reach 1Password to delete the separate item that held it.`
      : `The site took a new password for ${account}, but I can't reach 1Password to put it into the login.`;
  return `I tried to change the password of ${account}, but I can't tell whether the password changed.`;
}

/**
 * What a release the host could finish after all leaves, in words: the job's outcome with its vault state.
 * to: main, delegator
 */
function finishedWords(attempt: Pick<CredentialAttempt, 'kind' | 'site'>, vault: 'finalized' | 'conflict'): string {
  if (attempt.kind === 'signup')
    return vault === 'finalized'
      ? "the site created the account, and its login in the assistant's 1Password vault holds its password."
      : `the site created the account, but its login was changed or removed in 1Password before the host finished saving it, and ${LEFT}`;
  return vault === 'finalized'
    ? "the site took the new password, and the login in the assistant's 1Password vault now holds it."
    : `the site took the new password, which is in the assistant's 1Password vault as its own item, "New password for ${attempt.site}"; ${CHANGED_MEANWHILE}`;
}

/** to: principal */
export function releaseQuestion(attempt: CredentialAttempt): string {
  const account = `${quoted(attempt.username, 256)} on ${attempt.site}`;
  const uncertain = attempt.phase === 'unknown' || attempt.phase === 'awaiting_verification';
  const consequence =
    attempt.kind === 'signup'
      ? `If you release it, I stop waiting on it and free the site, and I change nothing more in 1Password.${uncertain ? ' Trying again could create a second account.' : ''}`
      : `If you release it, I stop waiting on it and free the site and the login, and I change nothing more in 1Password.${uncertain ? ' Trying again could change the password a second time.' : ''}`;
  return [situation(attempt, account), vaultLeft(attempt, attempt.phase).mine, consequence]
    .filter((sentence) => sentence !== undefined)
    .join('\n');
}

export function parsedEvidence(attempt: Pick<CredentialAttempt, 'evidence_json'>): unknown {
  return attempt.evidence_json === null ? undefined : JSON.parse(attempt.evidence_json);
}

/** to: main, delegator */
export function credentialReleaseRefused(reason: string): string {
  return `The credential attempt was not released: ${reason}`;
}
/** to: main, delegator */
export function credentialReleaseSettled(current: CredentialAttempt, result: 'finalized' | 'conflict'): string {
  return `The ${current.kind === 'signup' ? 'signup' : 'password change'} for ${current.username} on ${current.site} was not released: 1Password could be reached again, and the host finished it: ${finishedWords(current, result)}`;
}
/** to: main, delegator */
export function credentialReleased(current: CredentialAttempt, from: CredentialAttemptPhase): string {
  return `The principal released the ${current.kind === 'signup' ? 'signup' : 'password change'} for ${current.username} on ${current.site}. ${vaultLeft(current, from).theirs} The site is free again, and nothing in 1Password changed.`;
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
