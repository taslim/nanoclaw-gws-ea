import { getDomain } from 'tldts';
import { getDb } from '../../db/connection.js';
import { dkimAlignedToSite } from './authentication.js';
import type { ParsedMail } from './mime.js';

/** Three minutes covers at least two of the inbox's sixty-second polls. */
export const SIGN_IN_CLAIM_LIFETIME_MS = 180_000;
export interface SignInClaim {
  readonly id: string;
  readonly job_id: string;
  readonly source: 'assistant' | 'principal';
  readonly origin: string;
  readonly domain: string;
  readonly binding_json: string;
  readonly since_at: string;
  readonly expires_at: string;
  readonly state: 'waiting' | 'finished';
  readonly gmail_message_id: string | null;
}
export async function getSignInClaim(id: string): Promise<SignInClaim | undefined> {
  return getDb().get<SignInClaim>('SELECT * FROM gws_ea_browser_sign_in_claims WHERE id = ?', id);
}
export async function waitingSignInClaim(
  jobId: string,
  source: SignInClaim['source'],
): Promise<SignInClaim | undefined> {
  return getDb().get<SignInClaim>(
    'SELECT * FROM gws_ea_browser_sign_in_claims WHERE job_id = ? AND source = ? AND state = ? AND expires_at > ? ORDER BY since_at DESC LIMIT 1',
    jobId,
    source,
    'waiting',
    new Date().toISOString(),
  );
}
export async function createSignInClaim(input: {
  id: string;
  jobId: string;
  source: SignInClaim['source'];
  origin: string;
  binding: Readonly<Record<string, unknown>>;
  at?: Date;
}): Promise<SignInClaim> {
  const origin = new URL(input.origin);
  const domain = getDomain(origin.hostname, { allowPrivateDomains: true });
  if (origin.protocol !== 'https:' || origin.username || origin.password || !domain) throw new Error('origin_mismatch');
  const at = input.at ?? new Date();
  await getDb().transaction(async () => {
    await getDb().run(
      'UPDATE gws_ea_browser_sign_in_claims SET state = ? WHERE job_id = ? AND state = ?',
      'finished',
      input.jobId,
      'waiting',
    );
    await getDb().run(
      `INSERT INTO gws_ea_browser_sign_in_claims(id,job_id,source,origin,domain,binding_json,since_at,expires_at,state)
       VALUES(?,?,?,?,?,?,?,?,?)`,
      input.id,
      input.jobId,
      input.source,
      origin.origin,
      domain,
      JSON.stringify(input.binding),
      at.toISOString(),
      new Date(at.getTime() + SIGN_IN_CLAIM_LIFETIME_MS).toISOString(),
      'waiting',
    );
  });
  return (await getSignInClaim(input.id))!;
}

/** Both the inbox poll and the host reader use the same atomic reservation. Only one message can ever be withheld. */
export async function claimSignInMail(mail: ParsedMail, at = new Date(), claimId?: string): Promise<boolean> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_browser_sign_in_claims')) || !mail.receivedAt) return false;
  return db.transaction(async () => {
    const claims = await db.all<SignInClaim>(
      'SELECT * FROM gws_ea_browser_sign_in_claims WHERE source = ? AND expires_at > ? ORDER BY since_at,id',
      'assistant',
      at.toISOString(),
    );
    for (const claim of claims) {
      if (claimId !== undefined && claim.id !== claimId) continue;
      if (mail.receivedAt!.getTime() < Date.parse(claim.since_at) || !dkimAlignedToSite(mail.headers, claim.domain))
        continue;
      if (claim.gmail_message_id !== null) {
        if (claim.gmail_message_id === mail.id) return true;
        continue;
      }
      if (claim.state !== 'waiting') continue;
      const reserved = await db.run(
        'UPDATE gws_ea_browser_sign_in_claims SET gmail_message_id = ? WHERE id = ? AND state = ? AND gmail_message_id IS NULL',
        mail.id,
        claim.id,
        'waiting',
      );
      if (reserved.changes) return true;
    }
    return false;
  });
}
export async function finishSignInClaim(id: string): Promise<void> {
  await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET state = ? WHERE id = ?', 'finished', id);
}

/** Chrome handles cannot survive a restart. Keep the one reserved message hidden through its original expiry. */
export async function recoverSignInClaims(at = new Date()): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_browser_sign_in_claims'))) return;
  await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET state = ?', 'finished');
  await cleanupSignInClaims(at);
}
export async function cleanupSignInClaims(at = new Date()): Promise<void> {
  if (!(await getDb().hasTable('gws_ea_browser_sign_in_claims'))) return;
  await getDb().run('DELETE FROM gws_ea_browser_sign_in_claims WHERE expires_at <= ?', at.toISOString());
}
