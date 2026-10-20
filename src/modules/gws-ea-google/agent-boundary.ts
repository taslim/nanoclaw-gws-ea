/**
 * Google failures as an agent hears them (R25). A sign-in Google no longer
 * accepts, or one that never granted a service, is the operator's to fix:
 * the agent hears that, then what it can do meanwhile, in its own terms.
 * The error's own message names the service and the remedy, so it stays for
 * the operator's status and the host log.
 */
import {
  GoogleGrantRevokedError,
  GoogleNotSignedInError,
  GoogleScopeNotGrantedError,
  GoogleTokenError,
} from './tokens.js';

/** What every agent hears first; each boundary adds that agent's own next step. */
export const GOOGLE_CONNECTION_DOWN =
  "Your Google connection isn't working right now, and reconnecting it is the operator's job.";

/** True when only a new sign-in, which is the operator's, would let Google answer. */
export function isGoogleConnectionDown(error: unknown): boolean {
  return (
    error instanceof GoogleGrantRevokedError ||
    error instanceof GoogleScopeNotGrantedError ||
    error instanceof GoogleNotSignedInError ||
    (error instanceof GoogleTokenError && error.refused)
  );
}
