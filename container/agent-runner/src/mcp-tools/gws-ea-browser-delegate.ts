/** Canonical main's native host requests; no code enters the browser job's conversation. */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

const THREAD = {
  type: 'string',
  description: 'The exact browser job thread returned when you delegated the errand.',
} as const;
export const cancelJob = requestTool({
  name: 'cancel_job',
  description:
    'Cancel a browser job at the host, releasing its work and leases. Returns cancelled, already_cancelled or in_progress. A commit already in progress finishes and reports before cancellation completes. After a timeout, use request_status or repeat this cancellation; a repeat changes nothing twice.',
  properties: { thread: THREAD },
  required: ['thread'],
  additionalProperties: false,
  repeatable: true,
  timeoutMs: 120_000,
});
export const relayCode = requestTool({
  name: 'relay_code',
  description:
    'Relay a principal-provided sign-in code directly to the host for this job. Name the recorded site when asking the principal; never send the code in a message to browser. The host fills only its recorded field and origin. Returns code_filled, origin_mismatch or no_wait. After a timeout, use request_status before anything else; do not repeat because the first call may still act.',
  properties: {
    thread: THREAD,
    code: { type: 'string', description: 'The sign-in code the principal relayed for this recorded site.' },
  },
  required: ['thread', 'code'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: 120_000,
});

export const reservationGuarantee = requestTool({
  name: 'reservation_guarantee',
  description:
    'Read, propose or revoke the principal’s optional standing permission for reservation cancellation/no-show fees. Propose requires an explicit currency and maximum TOTAL per reservation, as an exact decimal string. Only a principal approval activates permission. Nothing is due at booking; holds, deposits, prepayments, trials and subscriptions always need separate approval. No amount or currency is assumed. Revocation stops every uncommitted child authority. After a timeout use request_status before retrying a proposal.',
  properties: {
    operation: { type: 'string', enum: ['read', 'propose', 'revoke'] },
    currency: { type: 'string', pattern: '^[A-Z]{3}$' },
    max_total: { type: 'string', pattern: '^\\d+(?:\\.\\d{1,3})?$' },
  },
  required: ['operation'],
  additionalProperties: false,
  oneOf: [
    {
      properties: { operation: { enum: ['read', 'revoke'] } },
      not: { anyOf: [{ required: ['currency'] }, { required: ['max_total'] }] },
    },
    { properties: { operation: { const: 'propose' } }, required: ['currency', 'max_total'] },
  ],
  prepare(fields) {
    if (fields.operation === 'read' || fields.operation === 'revoke')
      return fields.currency === undefined && fields.max_total === undefined
        ? fields
        : 'Only propose takes currency and max_total.';
    if (
      fields.operation !== 'propose' ||
      typeof fields.currency !== 'string' ||
      !/^[A-Z]{3}$/u.test(fields.currency) ||
      typeof fields.max_total !== 'string' ||
      !/^\d+(?:\.\d{1,3})?$/u.test(fields.max_total)
    )
      return 'Propose requires an explicit currency and maximum total decimal amount.';
    return fields;
  },
  repeatable: false,
  timeoutMs: 120_000,
});
export const reservationBounds = requestTool({
  name: 'reservation_bounds',
  description:
    'Record the principal’s delegated venue, party size and time window for one direct reservation errand. Use the exact browser thread before asking it to commit under an existing standing guarantee. The browser cannot set or widen these bounds. This tool grants no financial permission; absent bounds require the usual principal purchase approval. One errand can use a standing guarantee for at most one booking. Repeating identical bounds is safe; changed bounds need a new errand after authority exists.',
  properties: {
    thread: THREAD,
    venue_id: { type: 'string', minLength: 1, maxLength: 256 },
    party_size: { type: 'integer', minimum: 1 },
    window_start: {
      type: 'string',
      description: 'Earliest delegated reservation start as an ISO timestamp with timezone.',
    },
    window_end: {
      type: 'string',
      description: 'Latest delegated reservation start as an ISO timestamp with timezone.',
    },
  },
  required: ['thread', 'venue_id', 'party_size', 'window_start', 'window_end'],
  additionalProperties: false,
  repeatable: true,
  timeoutMs: 120_000,
});
export const credentialAuthority = requestTool({
  name: 'credential_authority',
  description:
    "Record the principal's delegation of one account signup, or one password change, for a browser job's exact thread, site and account username, before the job submits it. The host generates and saves the password in the assistant's 1Password vault; no password passes through you. change_password applies only to a login the assistant created or saved itself and nobody has since edited. Returns recorded with the authority id to send the job, not_owned with reason no_record or changed, busy when an earlier signup or change of that account is still open or unsettled, alias_unavailable when a signup needs the assistant's web address and none is set up yet, vault_unavailable or rate_limited. Repeating the same request returns the same authority. " +
    "release, with the job's thread and the authority it recorded, asks the principal directly to end an attempt the job could not settle (its outcome unknown, or its email verification never completed), one whose login was left as edited in 1Password, or one still pending because 1Password is out of reach. For a pending one the host first tries to finish it, and if it can, answers with the job's outcome instead (account_created or password_changed with its vault state). Otherwise it returns awaiting_principal, or not_releasable when the attempt is settled or its own step settles it; the principal's decision reaches you as a note. Release changes nothing in 1Password.",
  properties: {
    thread: THREAD,
    operation: { type: 'string', enum: ['signup', 'change_password', 'release'] },
    site: { type: 'string', description: 'The HTTPS address of the site the account belongs to.' },
    username: { type: 'string', description: 'The exact account username or email on that site.' },
    authority: { type: 'string', description: 'For release: the credential authority id this job recorded.' },
  },
  required: ['thread', 'operation'],
  additionalProperties: false,
  oneOf: [
    {
      properties: { operation: { enum: ['signup', 'change_password'] } },
      required: ['site', 'username'],
      not: { required: ['authority'] },
    },
    {
      properties: { operation: { const: 'release' } },
      required: ['authority'],
      not: { anyOf: [{ required: ['site'] }, { required: ['username'] }] },
    },
  ],
  prepare(fields) {
    if (fields.operation === 'release')
      return fields.authority === undefined || fields.site !== undefined || fields.username !== undefined
        ? 'release takes only the job thread and the authority it recorded.'
        : fields;
    return fields.site === undefined || fields.username === undefined || fields.authority !== undefined
      ? 'signup and change_password take the job thread, the site and the exact account username.'
      : fields;
  },
  repeatable: true,
  timeoutMs: 120_000,
});
export const vaultAccess = requestTool({
  name: 'vault_access',
  description:
    "Share the assistant's 1Password vault with the principal, or check it again after they add or change a login. share gives view and edit access to the principal's 1Password account under their only email address, or under email: one of their addresses, or another email their 1Password account uses, which first waits for the principal to confirm it. It returns shared once 1Password shows their access, with link, which opens their 1Password account on the web, and vault_name, the vault's exact name there: give the principal both. It may instead return awaiting_principal, operator_needed with a reason (not_a_member, not_confirmed, refused, host_cannot_share or unconfirmed) and an operator_message for the principal to forward exactly as written, rate_limited or vault_unavailable. refresh lists the vault's logins again now and returns usable, rate_limited or vault_unavailable. Repeating either is safe: the host reads actual access before it grants anything.",
  properties: {
    operation: { type: 'string', enum: ['share', 'refresh'] },
    email: {
      type: 'string',
      description:
        "For share only: the email the principal's 1Password account uses. Omit it when they have a single address.",
    },
  },
  required: ['operation'],
  additionalProperties: false,
  oneOf: [
    { properties: { operation: { const: 'share' } } },
    { properties: { operation: { const: 'refresh' } }, not: { required: ['email'] } },
  ],
  prepare(fields) {
    if (fields.operation === 'refresh') return fields.email === undefined ? fields : 'Only share takes an email.';
    if (fields.operation !== 'share') return 'operation must be share or refresh.';
    return fields.email === undefined || typeof fields.email === 'string' ? fields : 'email must be one email address.';
  },
  repeatable: true,
  timeoutMs: 120_000,
});
export const consentGrants = requestTool({
  name: 'consent_grants',
  description:
    "Read or withdraw the principal's standing agreements to wording beyond a site's own terms, each one they approved for one site and exact wording. list returns listed with each grant's grant_id, site, origin, wording and approved_at, optionally for one site. withdraw, with a grant_id from list, ends one the principal asked to withdraw: from then on that wording waits for the principal's decision again. Returns withdrawn or not_found. Repeating either is safe.",
  properties: {
    operation: { type: 'string', enum: ['list', 'withdraw'] },
    grant_id: { type: 'string', description: 'For withdraw: the grant_id list returned.' },
    site: { type: 'string', description: "For list: only this site's grants, as a domain or an address." },
  },
  required: ['operation'],
  additionalProperties: false,
  oneOf: [
    { properties: { operation: { const: 'list' } }, not: { required: ['grant_id'] } },
    { properties: { operation: { const: 'withdraw' } }, required: ['grant_id'], not: { required: ['site'] } },
  ],
  prepare(fields) {
    if (fields.operation === 'list')
      return fields.grant_id === undefined ? fields : 'list takes only an optional site.';
    if (fields.operation !== 'withdraw') return 'operation must be list or withdraw.';
    return typeof fields.grant_id === 'string' && fields.site === undefined
      ? fields
      : 'withdraw takes only the grant_id list returned.';
  },
  repeatable: true,
  timeoutMs: 120_000,
});
registerTools(
  [cancelJob, relayCode, reservationGuarantee, reservationBounds, vaultAccess, credentialAuthority, consentGrants],
  'browser-delegate',
);
