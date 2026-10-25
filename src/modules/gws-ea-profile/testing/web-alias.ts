/** Record an operator-confirmed web alias through the profile's native setup operations. */
import { confirmAliasCandidate, proposeAliasCandidate } from '../db.js';

export async function recordWebAlias(address: string): Promise<void> {
  const { candidate } = await proposeAliasCandidate(address);
  if (candidate === null || !(await confirmAliasCandidate(candidate)))
    throw new Error(`${address} was not recorded as the web alias`);
}
