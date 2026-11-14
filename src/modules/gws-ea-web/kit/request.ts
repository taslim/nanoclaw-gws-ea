import type { IncomingMessage, ServerResponse } from 'node:http';
import { isRecord } from '../../../gws-ea/validation.js';
import { isPrincipalWebIdentity, type WebIdentity } from '../access.js';
import { refuse, sendUnavailable } from './headers.js';

export const MAX_SUBMISSION_BYTES = 16 * 1024;

/** Refused with the same empty not-found as any other refusal. */
export class InvalidSubmission extends Error {}

/** The principal's verified address, for a page that records who acted; undefined for anyone else. */
export async function principalEmail(
  request: IncomingMessage,
  hostname: string,
  identity: WebIdentity,
): Promise<string | undefined> {
  if (request.headers.host !== hostname) return undefined;
  const email = await identity(request);
  return (await isPrincipalWebIdentity(email)) ? email : undefined;
}

/** Checked afresh by each page, in addition to the web module's own gate, before anything is read. */
export async function isPrincipalRequest(
  request: IncomingMessage,
  hostname: string,
  identity: WebIdentity,
): Promise<boolean> {
  return (await principalEmail(request, hostname, identity)) !== undefined;
}

/**
 * Serves one request; a failure after the response began cuts the connection, a malformed submission gets the
 * ordinary refusal, and anything else answers unavailable.
 */
export function handle(response: ServerResponse, serve: () => Promise<void>): void {
  void serve().catch((error: unknown) => {
    if (response.headersSent) response.destroy();
    else if (error instanceof InvalidSubmission) refuse(response);
    else sendUnavailable(response);
  });
}

/**
 * A change comes only from the page itself: a same-origin fetch of a bounded JSON body. JSON cannot be sent
 * cross-site without a preflight, and the exact Origin stands in for browsers that omit Sec-Fetch-Site.
 */
export function sameOriginJson(request: IncomingMessage, hostname: string): boolean {
  const site = request.headers['sec-fetch-site'];
  const length = request.headers['content-length'];
  return (
    (site === undefined ? request.headers.origin === `https://${hostname}` : site === 'same-origin') &&
    typeof request.headers['content-type'] === 'string' &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type']) &&
    (length === undefined || (/^\d+$/u.test(length) && Number(length) <= MAX_SUBMISSION_BYTES))
  );
}

export async function readSubmission(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  // Stop at the byte cap without destroying the socket before its closed response is sent.
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    const value: unknown = chunk;
    if (!(value instanceof Uint8Array)) throw new InvalidSubmission();
    size += value.byteLength;
    if (size > MAX_SUBMISSION_BYTES) throw new InvalidSubmission();
    chunks.push(Buffer.from(value));
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, size)));
  } catch (_error) {
    throw new InvalidSubmission();
  }
  if (!isRecord(parsed)) throw new InvalidSubmission();
  return parsed;
}
