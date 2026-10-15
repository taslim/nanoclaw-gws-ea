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
registerTools([cancelJob, relayCode, reservationGuarantee, reservationBounds], 'browser-delegate');
