import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDb } from '../../db/connection.js';
import { browserSignInAssistantOnlyMigration, browserSignInMigration } from '../gws-ea-browser/sign-in-migration.js';
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
function mail(id: string, offset = 10, signer = 'shop.example', to?: string) {
  return parseGmailMessage({
    id,
    threadId: id,
    internalDate: String(at.getTime() + offset),
    payload: {
      headers: [
        { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.d=${signer}` },
        { name: 'From', value: `login@${signer}` },
        ...(to === undefined ? [] : [{ name: 'To', value: to }]),
      ],
    },
  });
}
const input = {
  id: 'claim',
  jobId: 'job',
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
it('ignores mail before the claim and from foreign domains', async () => {
  await createSignInClaim(input);
  expect(await claimSignInMail(mail('old', -1), at)).toBeUndefined();
  expect(await claimSignInMail(mail('foreign', 1, 'evil.example'), at)).toBeUndefined();
});
it("keeps the assistant's claims and drops principal ones when principal relays retire", async () => {
  await createSignInClaim(input);
  await getDb().run(
    `INSERT INTO gws_ea_browser_sign_in_claims(id,job_id,source,origin,domain,binding_json,since_at,expires_at,state)
     VALUES('relay','job','principal','https://www.shop.example','shop.example','{}',?,?,'waiting')`,
    at.toISOString(),
    new Date(at.getTime() + 180_000).toISOString(),
  );
  await browserSignInAssistantOnlyMigration.up(getDb());
  expect(await getSignInClaim('claim')).toMatchObject({ state: 'waiting', domain: 'shop.example' });
  expect(await getSignInClaim('relay')).toBeUndefined();
  await expect(
    getDb().run(
      `INSERT INTO gws_ea_browser_sign_in_claims(id,job_id,source,origin,domain,binding_json,since_at,expires_at,state)
       VALUES('later','job','principal','https://www.shop.example','shop.example','{}',?,?,'waiting')`,
      at.toISOString(),
      at.toISOString(),
    ),
  ).rejects.toThrow(/CHECK/u);
  await createSignInClaim({ ...input, id: 'after' });
  expect(await claimSignInMail(mail('after'), at)).toMatchObject({ id: 'after' });
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
it("supersedes the job's earlier sign-in claim, never a signup's verification claim", async () => {
  await createSignInClaim({
    ...input,
    id: 'signup',
    binding: { attempt: 'attempt-1', username: 'morgan@example.com' },
  });
  await createSignInClaim({ ...input, id: 'first-sign-in', at: new Date(at.getTime() + 1) });
  await createSignInClaim({ ...input, id: 'second-sign-in', at: new Date(at.getTime() + 2) });
  expect((await getSignInClaim('first-sign-in'))?.state).toBe('finished');
  expect((await getSignInClaim('signup'))?.state).toBe('waiting');
  expect(await claimSignInMail(mail('verification', 10, 'shop.example', 'morgan@example.com'), at)).toMatchObject({
    id: 'signup',
  });
  expect(await claimSignInMail(mail('code', 20), at)).toMatchObject({ id: 'second-sign-in' });
});
it("binds a signup's verification claim to its account: mail to any other address keeps its ordinary routing", async () => {
  await createSignInClaim({ ...input, binding: { attempt: 'attempt-1', username: 'morgan.ellery@example.com' } });
  expect(await claimSignInMail(mail('unaddressed'), at)).toBeUndefined();
  expect(await claimSignInMail(mail('other', 10, 'shop.example', 'juno.hale@example.com'), at)).toBeUndefined();
  expect(
    await claimSignInMail(mail('bound', 20, 'shop.example', 'Morgan Ellery <Morgan.Ellery@example.com>'), at),
  ).toMatchObject({ id: 'claim', gmail_message_id: 'bound' });
});
