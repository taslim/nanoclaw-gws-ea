import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { browserSignInMigration } from '../gws-ea-browser/sign-in-migration.js';
import {
  claimSignInMail,
  createSignInClaim,
  getSignInClaim,
  finishSignInClaim,
  recoverSignInClaims,
} from './claims.js';
import { parseGmailMessage } from './mime.js';
import { gwsEaInboxMigration } from './migration.js';
import { registerMigration } from '../../db/migrations/index.js';

registerMigration(gwsEaInboxMigration);

const at = new Date('2026-10-15T20:00:00.000Z');
function mail(id: string, offset = 10, signer = 'shop.example') {
  return parseGmailMessage({
    id,
    threadId: id,
    internalDate: String(at.getTime() + offset),
    payload: {
      headers: [
        { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.d=${signer}` },
        { name: 'From', value: `login@${signer}` },
      ],
    },
  });
}
const input = {
  id: 'claim',
  jobId: 'job',
  source: 'assistant' as const,
  origin: 'https://www.shop.example',
  binding: { frame: 0, field: 'e1', generation: 1 },
  at,
};
beforeEach(async () => {
  await runMigrations(await initTestDb());
  await browserSignInMigration.up(getDb());
});
afterEach(async () => {
  await closeDb();
});

it('reserves one message atomically before a tool turn and retains only that message until the fixed expiry', async () => {
  const claim = await createSignInClaim(input);
  const matches = await Promise.all([claimSignInMail(mail('first'), at), claimSignInMail(mail('second'), at)]);
  expect(matches.filter(Boolean)).toHaveLength(1);
  expect((await getSignInClaim(claim.id))?.gmail_message_id).toBe('first');
  expect(await claimSignInMail(mail('first'), at)).toBeDefined();
  await finishSignInClaim(claim.id);
  expect(await claimSignInMail(mail('first'), at)).toBeDefined();
  expect(await claimSignInMail(mail('second'), at)).toBeUndefined();
  expect(await claimSignInMail(mail('first'), new Date(at.getTime() + 180_001))).toBeUndefined();
});
it('ignores mail before the claim, foreign domains and principal-mail claims', async () => {
  await createSignInClaim(input);
  expect(await claimSignInMail(mail('old', -1), at)).toBeUndefined();
  expect(await claimSignInMail(mail('foreign', 1, 'evil.example'), at)).toBeUndefined();
  await finishSignInClaim('claim');
  await createSignInClaim({ ...input, id: 'principal', source: 'principal' });
  expect(await claimSignInMail(mail('new'), at)).toBeUndefined();
});
it('recovers without a live field binding while preserving a message already withheld from routing', async () => {
  await createSignInClaim(input);
  await claimSignInMail(mail('first'), at);
  await recoverSignInClaims(at);
  expect((await getSignInClaim('claim'))?.state).toBe('finished');
  expect(await claimSignInMail(mail('first'), at)).toBeDefined();
  expect(await claimSignInMail(mail('second'), at)).toBeUndefined();
  expect(JSON.stringify(await getSignInClaim('claim'))).not.toContain('code');
});
