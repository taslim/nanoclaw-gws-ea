/**
 * The assistant's web alias as a test needs it recorded (KTD13, KTD14):
 * proposed, probed and verified through the profile's own compare-and-set,
 * as a probe's arrival records it.
 */
import { proposeAliasCandidate, recordAliasProbe, recordVerifiedAlias } from '../db.js';

const PROBE = '<alias-check.00000000000000000000000000000000@example.test>';

/** Record `address` as the assistant's verified web alias. */
export async function recordWebAlias(address: string): Promise<void> {
  const { candidate } = await proposeAliasCandidate(address);
  if (
    candidate === null ||
    !(await recordAliasProbe(candidate, PROBE)) ||
    !(await recordVerifiedAlias(candidate, PROBE))
  )
    throw new Error(`${address} was not recorded as the web alias`);
}
