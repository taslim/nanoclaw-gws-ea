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

registerTools([cancelJob, relayCode], 'browser-delegate');
