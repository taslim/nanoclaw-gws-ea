import { createBrowserQueue } from './index.js';
import fs from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutofillBehavior, ItemCategory, ItemFieldType, type Item } from '@1password/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-credential-operation-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));

import Database from 'better-sqlite3';

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { requestApproval, sweepExpiredApprovals } from '../approvals/index.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { addPrincipalAddress, bindVerifiedPrincipalUser } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import './index.js';
import { CONSENT_APPROVAL } from './consent-approval.js';
import { recordConsentStops } from './consent.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import {
  credentialAuthorityRequest,
  executeCredentialForm,
  recoverCredentialAttempts,
  registerCredentialAuthorityDelivery,
  settleConfirmedAttempts,
  settleRefusedSites,
  validateCredentialForm,
} from './credential-operations.js';
import { BrowserStore } from './db.js';
import { BrowserVault } from './onepassword.js';
import {
  FakeOnePassword,
  FIXTURE_TOKEN,
  FIXTURE_VAULT_ID,
  writeVaultFixture,
  type VaultFixtureFiles,
} from './onepassword-fixture.js';
import { writePrivateFile } from './paths.js';
import { BrowserQueue } from './queue.js';
import type { BrowserExecutionContext } from './actions.js';
import { openSignupVerification } from './sign-in-mail.js';

const ORIGIN = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';
const PRINCIPAL_USERNAME = 'remy.vance@example.com';

let directory: string;
let files: VaultFixtureFiles;
let fake: FakeOnePassword;
let vault: BrowserVault;
let attempts: CredentialAttempts;
let main: Session;
let job: Session;

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'credential-operations-')));
  files = await writeVaultFixture(directory);
  fake = new FakeOnePassword();
  sdk.create.mockReset();
  sdk.create.mockImplementation(async () => fake.client());
  vault = new BrowserVault(files);
  await runMigrations(await initTestDb());
  attempts = new CredentialAttempts({ db: getDb(), vault });
  for (const id of ['main', 'browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'main',
    'browser',
  );
  main = (await resolveSystemSession('main', 'system:task:principal')).session;
  job = (await resolveSystemSession('browser', 'system:a2a:main:credentials')).session;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  await rm(directory, { recursive: true, force: true });
});

const ask = (fields: Record<string, unknown>, caller: Session = main) =>
  credentialAuthorityRequest(
    { action: 'credential_authority', requestId: 'request', thread: job.thread_id, ...fields },
    caller,
    { attempts },
  );

/** A Login the principal saved in the assistant's vault themselves. */
function principalLogin(username = USERNAME): Item {
  return fake.store({
    category: ItemCategory.Login,
    vaultId: FIXTURE_VAULT_ID,
    title: 'Shop',
    fields: [
      { id: 'username', title: 'username', fieldType: ItemFieldType.Text, value: username },
      { id: 'password', title: 'password', fieldType: ItemFieldType.Concealed, value: 'principal-chosen-password' },
    ],
    websites: [{ url: ORIGIN, label: 'website', autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
  });
}

/** The Login a finished signup saved: the only kind of Login whose password the assistant may change (R18). */
async function assistantLogin(): Promise<string> {
  const recorded = await ask({ operation: 'signup', site: `${ORIGIN}/join`, username: USERNAME });
  const id = String(recorded.authority);
  expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
  expect(await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
  await attempts.markAwaitingVerification(id);
  await attempts.markConfirmed(id, { signal: 'success_text' });
  const finalized = await attempts.finalize(id);
  if (finalized.status !== 'finalized' || !finalized.attempt.owned_item_id) throw new Error('not finalized');
  await vault.refresh();
  return finalized.attempt.owned_item_id;
}

const editField = (id: string, value: string) => (item: Item) => ({
  ...item,
  fields: item.fields.map((field) => (field.id === id ? { ...field, value } : field)),
});
const editUsername = (value: string) => editField('username', value);

/** A job context for steps that must never touch the page. */
function context(): { context: BrowserExecutionContext; page: ReturnType<typeof vi.fn> } {
  const page = vi.fn(async () => {
    throw new Error('the page must not be touched');
  });
  return {
    page,
    context: {
      job: { id: job.thread_id },
      page,
      assertActive: async () => undefined,
      remaining: () => 60_000,
    } as unknown as BrowserExecutionContext,
  };
}

describe("main's credential authority", () => {
  it('records a signup for one job, site and account, repeats safely, and spends no provider request', async () => {
    const recorded = await ask({ operation: 'signup', site: `${ORIGIN}/join?ref=home`, username: USERNAME });
    expect(recorded).toEqual({
      status: 'recorded',
      authority: expect.any(String),
      operation: 'signup',
      thread: job.thread_id,
      site: 'shop.example',
      username: USERNAME,
    });
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toEqual(recorded);
    expect(fake.calls).toEqual([]);
    expect(await attempts.get(String(recorded.authority))).toMatchObject({
      kind: 'signup',
      job_id: job.thread_id,
      origin: ORIGIN,
      phase: 'preparing',
    });
    const other = await ask({ operation: 'signup', site: ORIGIN, username: 'juno.hale@example.com' });
    expect(other.authority).not.toBe(recorded.authority);
  });

  it('covers AE7: refuses a change on a principal-added, edited or missing Login before any page insertion', async () => {
    const before = await getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts');
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
      reason: 'no_record',
    });
    principalLogin();
    await vault.refresh();
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
      reason: 'no_record',
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_credential_attempts')).toEqual(before);

    const itemId = await assistantLogin();
    fake.edit(itemId, editUsername(PRINCIPAL_USERNAME));
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
      reason: 'changed',
    });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: PRINCIPAL_USERNAME })).toEqual({
      status: 'not_owned',
      reason: 'no_record',
    });
    fake.edit(itemId, (item) => ({
      ...editUsername(USERNAME)(item),
      websites: [{ url: 'https://shop.example.net', label: 'website', autofillBehavior: AutofillBehavior.ExactDomain }],
    }));
    await vault.refresh();
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
      reason: 'no_record',
    });
    expect(
      (await getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts')).filter(
        (attempt) => attempt.kind === 'rotation',
      ),
    ).toEqual([]);
  });

  it('never records a second signup for an account whose first may have reached the site', async () => {
    const first = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
    expect(await attempts.save(first)).toMatchObject({ status: 'saved' });
    await attempts.disclose(first, { jobId: job.thread_id!, origin: ORIGIN });
    await attempts.markUnknown(first, { signal: 'interrupted' });
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
    const other = (await resolveSystemSession('browser', 'system:a2a:main:other-errand')).session;
    expect(
      await credentialAuthorityRequest(
        { thread: other.thread_id, operation: 'signup', site: `${ORIGIN}/join`, username: USERNAME },
        main,
        { attempts },
      ),
    ).toEqual({ status: 'busy' });
    expect(await ask({ operation: 'signup', site: ORIGIN, username: 'juno.hale@example.com' })).toMatchObject({
      status: 'recorded',
    });
    await attempts.markRejected(first, { signal: 'reconciled' });
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toMatchObject({ status: 'recorded' });
  });

  it('records no new authority on a job whose cancellation is waiting for an unresolved change', async () => {
    await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
    await getDb().run('UPDATE gws_ea_browser_jobs SET cancel_requested = 1 WHERE id = ?', job.thread_id);
    await expect(ask({ operation: 'signup', site: ORIGIN, username: 'juno.hale@example.com' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('records a change on an unedited assistant-created Login, bound to that Login, and repeats safely', async () => {
    const itemId = await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    expect(recorded).toMatchObject({ status: 'recorded', operation: 'change_password', username: USERNAME });
    expect(await attempts.get(String(recorded.authority))).toMatchObject({
      kind: 'rotation',
      source_item_id: itemId,
      phase: 'preparing',
    });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual(recorded);
    // One change per Login is open at a time: a later errand takes over one that disclosed nothing,
    // and one that may have reached the site keeps the Login busy for every other errand.
    const other = (await resolveSystemSession('browser', 'system:a2a:main:other-errand')).session;
    const taken = await credentialAuthorityRequest(
      { thread: other.thread_id, operation: 'change_password', site: ORIGIN, username: USERNAME },
      main,
      { attempts },
    );
    expect(taken).toMatchObject({ status: 'recorded', operation: 'change_password', username: USERNAME });
    expect(await attempts.get(String(recorded.authority))).toMatchObject({ phase: 'rejected' });
    await getDb().run(
      `UPDATE gws_ea_browser_credential_attempts SET phase = 'exposed' WHERE id = ?`,
      String(taken.authority),
    );
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
  });

  it('is main-only, needs a live job and an HTTPS site, and offers no other account-security change', async () => {
    await expect(ask({ operation: 'signup', site: ORIGIN, username: USERNAME }, job)).rejects.toMatchObject({
      code: 'forbidden',
    });
    await expect(
      credentialAuthorityRequest(
        { thread: 'system:a2a:main:missing', operation: 'signup', site: ORIGIN, username: USERNAME },
        main,
        { attempts },
      ),
    ).rejects.toMatchObject({ code: 'forbidden' });
    for (const fields of [
      { operation: 'signup', site: 'http://accounts.shop.example', username: USERNAME },
      { operation: 'change_email', site: ORIGIN, username: USERNAME },
      { operation: 'change_two_factor', site: ORIGIN, username: USERNAME },
      { operation: 'signup', site: ORIGIN, username: ' padded ' },
      { operation: 'signup', site: ORIGIN, username: USERNAME, password: 'chosen-by-the-model' },
    ])
      await expect(ask(fields)).rejects.toMatchObject({ code: 'invalid-args' });
  });
});

describe('the browser credential request', () => {
  const ref = (n: number) => ({ ref: `e${n}`, generation: 3 });

  it('accepts only an authority, fresh element refs and an activation control: never a value', async () => {
    const authority = '6f1d2c3b-4a5e-4f60-8a7b-9c0d1e2f3a4b';
    expect(
      validateCredentialForm({
        authority,
        username: ref(1),
        new_password: ref(2),
        confirmation: ref(3),
        activate: ref(4),
      }),
    ).toEqual({ authority, username: ref(1), new_password: ref(2), confirmation: ref(3), activate: ref(4) });
    expect(validateCredentialForm({ authority, operation: 'reconcile' })).toEqual({
      authority,
      operation: 'reconcile',
    });
    expect(validateCredentialForm({ authority, operation: 'verify' })).toEqual({ authority, operation: 'verify' });
    expect(validateCredentialForm({ authority, operation: 'verify', code_field: ref(5), activate: ref(6) })).toEqual({
      authority,
      operation: 'verify',
      code_field: ref(5),
      activate: ref(6),
    });
    for (const content of [
      // The host makes every checkbox choice; the agent never names a terms box.
      { authority, username: ref(1), new_password: ref(2), accept_terms: ref(3), activate: ref(4) },
      { authority, operation: 'reconcile', activate: ref(4) },
      { authority, operation: 'reconcile', new_password: ref(2), activate: ref(4) },
      { authority, operation: 'verify', code_field: ref(5) },
      { authority, operation: 'verify', activate: ref(6) },
      { authority, operation: 'verify', new_password: ref(2), activate: ref(4) },
      { authority, operation: 'verify', accept_terms: ref(3) },
      { authority, operation: 'retry', new_password: ref(2), activate: ref(4) },
      { authority, new_password: ref(2), accept_terms: ref(2), activate: ref(4) },
      { authority, new_password: ref(2), code_field: ref(5), activate: ref(4) },
      { authority, activate: ref(4) },
      { authority, new_password: ref(2) },
      { authority, confirmation: ref(3), activate: ref(4) },
      { authority, current_password: ref(1), activate: ref(4) },
      { authority, new_password: ref(2), confirmation: ref(2), activate: ref(4) },
      { authority, new_password: ref(2), activate: ref(2) },
      { authority, new_password: ref(2), activate: ref(4), password: 'model-chosen' },
      { authority, new_password: { ...ref(2), value: 'model-chosen' }, activate: ref(4) },
      { authority: 'op://vault/item', new_password: ref(2), activate: ref(4) },
    ])
      expect(() => validateCredentialForm(content)).toThrow();
    const { context: execution, page } = context();
    await expect(
      executeCredentialForm(
        execution,
        { authority, new_password: ref(2), accept_terms: ref(3), activate: ref(4) },
        { attempts },
      ),
    ).rejects.toMatchObject({ code: 'invalid-args' });
    expect(page).not.toHaveBeenCalled();
  });

  const run = (authority: string, fields: Record<string, unknown> = { new_password: ref(2) }) => {
    const { context: execution, page } = context();
    return {
      page,
      result: executeCredentialForm(execution, { authority, ...fields, activate: ref(4) }, { attempts }),
    };
  };

  it("refuses another job's authority and settled attempts without touching the page or repeating a submission", async () => {
    const recorded = await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
    const id = String(recorded.authority);
    const foreign = await attempts.prepareSignup({
      jobId: 'system:a2a:main:other',
      origin: ORIGIN,
      username: USERNAME,
    });
    if (foreign.status !== 'prepared') throw new Error(foreign.status);
    const { page: untouched, result: refused } = run(foreign.attempt.id);
    expect(await refused).toEqual({ status: 'refused', reason: 'no_authority' });
    expect(untouched).not.toHaveBeenCalled();
    await expect(run(id, { current_password: ref(1), new_password: ref(2) }).result).rejects.toMatchObject({
      code: 'invalid-args',
    });

    expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    const phases: Array<[() => Promise<unknown>, Record<string, unknown>]> = [
      [async () => undefined, { status: 'outcome_unknown' }],
      [() => attempts.markAwaitingVerification(id), { status: 'verification_requested' }],
      [() => attempts.markUnknown(id), { status: 'outcome_unknown' }],
      [() => attempts.markConfirmed(id, { signal: 'success_text' }), { status: 'account_created', vault: 'saved' }],
      [async () => undefined, { status: 'account_created', vault: 'saved' }],
    ];
    for (const [move, expected] of phases) {
      await move();
      const { page, result } = run(id);
      expect(await result).toEqual(expected);
      expect(page).not.toHaveBeenCalled();
    }
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized' });

    const second = await ask({ operation: 'signup', site: ORIGIN, username: 'juno.hale@example.com' });
    await attempts.abandon(String(second.authority));
    expect(await run(String(second.authority)).result).toEqual({ status: 'refused', reason: 'no_authority' });
  });

  it('reports a confirmed change written into the original login, its candidate gone', async () => {
    const itemId = await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    const id = String(recorded.authority);
    for (const fields of [{ username: ref(1) }, { username: ref(1), new_password: ref(2) }])
      await expect(run(id, fields).result).rejects.toMatchObject({ code: 'invalid-args' });
    expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
    const disclosed = await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
    const candidateId = (await attempts.get(id))?.candidate_item_id;
    await attempts.markAwaitingVerification(id);
    await attempts.markConfirmed(id, { signal: 'success_text' });
    const { page, result } = run(id);
    expect(await result).toEqual({ status: 'password_changed', vault: 'updated' });
    expect(page).not.toHaveBeenCalled();
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
    expect(fake.value(itemId, 'password')).toBe(disclosed.credential.password);
    expect(fake.items.has(candidateId ?? '')).toBe(false);
  });

  it("answers not_watched from verify when the signup's email has no wait, and leaves it for the principal's release", async () => {
    const id = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
    await attempts.save(id);
    // No inbox here, so the wait the submission opens before disclosure could not be opened.
    expect(
      await openSignupVerification({
        jobId: job.thread_id!,
        claimId: 'signup-request',
        attemptId: id,
        origin: ORIGIN,
        username: USERNAME,
      }),
    ).toBe(false);
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    await attempts.markAwaitingVerification(id);
    const { context: execution, page } = context();
    expect(await executeCredentialForm(execution, { authority: id, operation: 'verify' }, { attempts })).toEqual({
      status: 'not_watched',
    });
    expect(page).not.toHaveBeenCalled();
    expect(await attempts.get(id)).toMatchObject({ phase: 'awaiting_verification' });
  });

  describe('reconciliation', () => {
    const reconcile = (authority: string, given = attempts) => {
      const { context: execution, page } = context();
      return {
        page,
        result: executeCredentialForm(execution, { authority, operation: 'reconcile' }, { attempts: given }),
      };
    };

    it('reports a change whose login was edited in 1Password meanwhile as left as edited, and writes nothing more', async () => {
      const itemId = await assistantLogin();
      const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
      const id = String(recorded.authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markAwaitingVerification(id);
      await attempts.markConfirmed(id, { signal: 'success_text' });
      fake.edit(itemId, editUsername(PRINCIPAL_USERNAME));
      const first = reconcile(id);
      expect(await first.result).toEqual({ status: 'password_changed', vault: 'left_as_edited' });
      const attempt = await attempts.get(id);
      expect(attempt).toMatchObject({ phase: 'conflict', conflict_reason: 'ownership_mismatch' });
      const next = fake.value(attempt!.candidate_item_id!, 'password')!;
      const writes = fake.calls.length;
      const second = reconcile(id);
      expect(await second.result).toEqual({ status: 'password_changed', vault: 'left_as_edited' });
      expect(fake.calls).toHaveLength(writes);
      for (const { page, result } of [first, second]) {
        expect(page).not.toHaveBeenCalled();
        expect(JSON.stringify(await result)).not.toContain(next);
      }
    });

    it.each<[string, (itemId: string) => void]>([
      ['username', (itemId) => fake.edit(itemId, editUsername(PRINCIPAL_USERNAME))],
      [
        'site',
        (itemId) =>
          fake.edit(itemId, (item) => ({
            ...item,
            websites: [
              { url: 'https://shop.example.net', label: 'website', autofillBehavior: AutofillBehavior.ExactDomain },
            ],
          })),
      ],
      ['password', (itemId) => fake.edit(itemId, editField('password', 'principal-chosen-password-1'))],
      ['deletion', (itemId) => void fake.items.delete(itemId)],
    ])("leaves the Login as edited when a %s edit lands between the host's read and its write", async (_edit, edit) => {
      const itemId = await assistantLogin();
      const id = String((await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markAwaitingVerification(id);
      await attempts.markConfirmed(id, { signal: 'success_text' });
      const candidateId = (await attempts.get(id))?.candidate_item_id ?? '';
      const next = fake.value(candidateId, 'password');
      let edited: Item | undefined;
      fake.beforePut = () => {
        edit(itemId);
        edited = structuredClone(fake.items.get(itemId));
      };
      // The stale write proves nothing: the fresh read after it finds the edit, and the host writes no more.
      expect(await reconcile(id).result).toEqual({ status: 'password_changed', vault: 'left_as_edited' });
      expect(fake.items.get(itemId)).toEqual(edited);
      expect(fake.value(itemId, 'password')).not.toBe(next);
      expect(fake.value(candidateId, 'password')).toBe(next);
      expect(fake.value(candidateId, 'previous-password')).toBeUndefined();
    });

    it('finishes a confirmed change whose vault update was cut short', async () => {
      const itemId = await assistantLogin();
      const id = String((await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markAwaitingVerification(id);
      await attempts.markConfirmed(id, { signal: 'success_text' });
      fake.failNext('put', new Error('network'));
      expect(await attempts.finalize(id)).toEqual({ status: 'vault_unavailable' });
      const { page, result } = reconcile(id);
      expect(await result).toEqual({ status: 'password_changed', vault: 'updated' });
      expect(page).not.toHaveBeenCalled();
      expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
    });

    it('finalizes a confirmed attempt whose vault update was cut short', async () => {
      const recorded = await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
      const id = String(recorded.authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markAwaitingVerification(id);
      await attempts.markConfirmed(id, { signal: 'success_text' });
      const { page, result } = reconcile(id);
      expect(await result).toEqual({ status: 'account_created', vault: 'saved' });
      expect(page).not.toHaveBeenCalled();
    });

    it('stays inconclusive from unknown without host evidence, never deciding from the page alone after a restart', async () => {
      const recorded = await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
      const id = String(recorded.authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markUnknown(id, { signal: 'interrupted' });
      const restarted = new CredentialAttempts({ db: getDb(), vault });
      const { page, result } = reconcile(id, restarted);
      expect(await result).toEqual({ status: 'inconclusive' });
      expect(page).not.toHaveBeenCalled();
      expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
      expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    });

    it('reports an attempt nothing was disclosed for as having nothing to reconcile', async () => {
      const recorded = await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
      const { page, result } = reconcile(String(recorded.authority));
      expect(await result).toEqual({ status: 'refused', reason: 'not_disclosed' });
      expect(page).not.toHaveBeenCalled();
    });
  });
});

describe('restart recovery', () => {
  it('makes an attempt a stopped host left exposed unknown, with no request left to settle it', async () => {
    const exposed = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
    await attempts.save(exposed);
    await attempts.disclose(exposed, { jobId: job.thread_id!, origin: ORIGIN });
    const waiting = String(
      (await ask({ operation: 'signup', site: ORIGIN, username: 'juno.hale@example.com' })).authority,
    );
    await attempts.save(waiting);
    await attempts.disclose(waiting, { jobId: job.thread_id!, origin: ORIGIN });
    await attempts.markAwaitingVerification(waiting);
    expect(await getDb().all('SELECT id FROM gws_ea_browser_requests')).toEqual([]);
    await recoverCredentialAttempts(attempts);
    const recovered = await attempts.get(exposed);
    expect(recovered).toMatchObject({ phase: 'unknown' });
    expect(JSON.parse(recovered!.evidence_json!)).toMatchObject({ signal: 'interrupted' });
    // Only an exposed attempt had nothing to settle it; a verification wait keeps its own step.
    expect(await attempts.get(waiting)).toMatchObject({ phase: 'awaiting_verification' });
  });
});

describe("the principal's release of an attempt the host cannot settle", () => {
  const PRINCIPAL = 'gchat:principal-morgan';
  const DM = { channelType: 'gchat', platformId: 'gchat:dm:principal-morgan' };
  let cards: string[];
  let closed: string[];
  let queue: BrowserQueue;

  beforeEach(async () => {
    cards = [];
    closed = [];
    setDeliveryAdapter({
      async deliver(_channelType, _platformId, _threadId, _kind, content) {
        cards.push(content);
        return 'platform-message';
      },
    });
    const at = new Date().toISOString();
    await createMessagingGroup({
      id: 'mg-principal-dm',
      channel_type: DM.channelType,
      platform_id: DM.platformId,
      name: 'Morgan',
      is_group: 0,
      unknown_sender_policy: 'strict',
      created_at: at,
    });
    await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: at });
    await bindVerifiedPrincipalUser(PRINCIPAL, at);
    await upsertUserDm({
      user_id: PRINCIPAL,
      channel_type: 'gchat',
      messaging_group_id: 'mg-principal-dm',
      resolved_at: at,
    });
    queue = createBrowserQueue(new BrowserStore(), {
      pageForJob: async () => {
        throw new Error('A release never opens a page');
      },
      connection: async () => {
        throw new Error('A release never launches Chrome');
      },
      closeJob: async (jobId: string) => {
        closed.push(jobId);
      },
      onDisconnected: () => () => undefined,
    });
    registerCredentialAuthorityDelivery(() => queue, { attempts });
  });

  const release = (authority: string, caller: Session = main) =>
    credentialAuthorityRequest(
      { action: 'credential_authority', requestId: 'release', thread: job.thread_id, operation: 'release', authority },
      caller,
      { attempts },
    );
  const pending = () =>
    getDb().all<PendingApproval>("SELECT * FROM pending_approvals WHERE action = 'browser_credential_release'");
  const click = async (value: 'approve' | 'reject'): Promise<void> => {
    const [approval] = await pending();
    if (!approval) throw new Error('No card');
    await handleApprovalsResponse({
      questionId: approval.approval_id,
      value,
      userId: PRINCIPAL,
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });
  };
  /** What the host told main as a system note. */
  const notes = (): string[] => {
    const file = inboundDbPath(main.agent_group_id, main.id);
    if (!fs.existsSync(file)) return [];
    const db = new Database(file, { readonly: true });
    try {
      return (db.prepare('SELECT content FROM messages_in ORDER BY seq').all() as Array<{ content: string }>)
        .map((row) => JSON.parse(row.content) as { sender?: string; text?: string })
        .filter((content) => content.sender === 'system')
        .map((content) => content.text ?? '');
    } finally {
      db.close();
    }
  };
  const holdSite = () =>
    getDb().run(
      "INSERT INTO gws_ea_browser_site_leases VALUES ('shop.example', ?, 'active', ?)",
      job.thread_id,
      new Date().toISOString(),
    );
  const lease = () =>
    getDb().get<{ job_id: string }>("SELECT job_id FROM gws_ea_browser_site_leases WHERE site = 'shop.example'");
  /** 1Password as the principal sees it: every item, version and field, and nothing archived. */
  const vaultState = () => JSON.stringify([[...fake.items.entries()], [...fake.archived]]);

  /** A signup the website may or may not have taken. */
  async function disclosedSignup(username = USERNAME): Promise<string> {
    const id = String((await ask({ operation: 'signup', site: ORIGIN, username })).authority);
    expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    return id;
  }
  /** A change on the assistant's own Login that the website may or may not have taken. */
  async function disclosedChange(): Promise<{ id: string; itemId: string }> {
    const itemId = await assistantLogin();
    const id = String((await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).authority);
    expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    return { id, itemId };
  }

  it('refuses attempts that are settled or never reached the site, other jobs, and every caller but main', async () => {
    const preparing = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    await attempts.save(preparing);
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    await attempts.disclose(preparing, { jobId: job.thread_id!, origin: ORIGIN });
    // Exposed is still in flight: its own step settles it.
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    await attempts.markAwaitingVerification(preparing);
    await attempts.markConfirmed(preparing, { signal: 'success_text' });
    // A confirmed attempt 1Password can still finish is settled, never released.
    expect(await release(preparing)).toEqual({ status: 'account_created', vault: 'saved' });
    expect(await attempts.get(preparing)).toMatchObject({ phase: 'finalized' });
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    const other = await attempts.prepareSignup({ jobId: 'system:a2a:main:other', origin: ORIGIN, username: USERNAME });
    if (other.status !== 'prepared') throw new Error(other.status);
    expect(await release(other.attempt.id)).toEqual({ status: 'not_releasable' });
    const unknown = await disclosedSignup('juno.hale@example.com');
    await attempts.markUnknown(unknown, { signal: 'interrupted' });
    await expect(release(unknown, job)).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      credentialAuthorityRequest(
        { thread: job.thread_id, operation: 'release', authority: unknown, site: ORIGIN },
        main,
        { attempts },
      ),
    ).rejects.toMatchObject({ code: 'invalid-args' });
    expect(await pending()).toEqual([]);
    expect(cards).toEqual([]);
  });

  it('asks the principal plainly, once, and a rejection leaves the change unresolved and its site held', async () => {
    const { id } = await disclosedChange();
    await attempts.markUnknown(id, { signal: 'interrupted' });
    await holdSite();
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    expect(await pending()).toHaveLength(1);
    expect(cards).toHaveLength(1);
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain("I can't tell whether the password changed");
    expect(card.question).toContain('Both the original and the new password are kept in my 1Password vault');
    await click('reject');
    const declined = notes().at(-1) ?? '';
    expect(declined).toContain(`The principal chose to keep waiting on the password change for "${USERNAME}"`);
    expect(declined).not.toMatch(/admin|browser_credential_release|appr-/u);
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
  });

  /** A signup whose filled form waits on the principal's card for a wording on the site (KTD11). */
  async function heldForConsent(): Promise<{ id: string; approvalId: string }> {
    const id = await disclosedSignup();
    await attempts.markAwaitingConsent(id, { signal: 'consent', held: true });
    await holdSite();
    const [stop] = await recordConsentStops(
      { jobId: job.thread_id!, db: getDb() },
      {
        site: 'shop.example',
        origin: ORIGIN,
        fingerprint: 'join-form',
        items: [{ id: 0, wording: 'I have read and accept the liability waiver', kind: 'agreement' }],
      },
    );
    await getDb().run("UPDATE gws_ea_browser_consent_stops SET status = 'requested' WHERE id = ?", stop.stop_id);
    const approvalId = await requestApproval({
      session: job,
      agentName: 'browser',
      action: CONSENT_APPROVAL,
      payload: { stopId: stop.stop_id, jobId: job.thread_id },
      title: 'Agree to this on shop.example?',
      question: 'shop.example asks me to agree to this: "I have read and accept the liability waiver"',
      approverUserId: PRINCIPAL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!approvalId) throw new Error('No consent card');
    return { id, approvalId };
  }

  it.each([
    [
      'declines',
      async (approvalId: string) =>
        handleApprovalsResponse({
          questionId: approvalId,
          value: 'reject',
          userId: PRINCIPAL,
          channelType: DM.channelType,
          platformId: DM.platformId,
          threadId: null,
        }),
    ],
    [
      'lets lapse',
      async () => {
        await getDb().run("UPDATE pending_approvals SET expires_at = '2026-01-01T00:00:00.000Z'");
        await sweepExpiredApprovals();
      },
    ],
  ] as const)(
    'leaves a held signup unknown when the principal %s its consent card, for the release path to end',
    async (_case, decide) => {
      const { id, approvalId } = await heldForConsent();
      expect(await release(id)).toEqual({ status: 'not_releasable' });
      await decide(approvalId);
      expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
      expect(await lease()).toEqual({ job_id: job.thread_id });
      expect(await release(id)).toEqual({ status: 'awaiting_principal' });
      // The host never submitted the form, and the card says so.
      const question = (JSON.parse(cards.at(-1) ?? '{}') as { question?: string }).question ?? '';
      expect(question).toContain(
        `I filled in the signup for "${USERNAME}" on shop.example, but the site needed an agreement you didn't give, so I never submitted it.`,
      );
      expect(question).not.toContain('Trying again could');
      await click('approve');
      expect(await attempts.get(id)).toMatchObject({ phase: 'rejected' });
      expect(await lease()).toBeUndefined();
    },
  );

  it('ends a held signup as unknown when its job is cancelled, keeping the site for the release', async () => {
    const { id } = await heldForConsent();
    const { cancelBrowserJob } = await import('./cancel.js');
    expect(await cancelBrowserJob(job.thread_id!)).toMatchObject({ status: 'in_progress' });
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
  });

  it('on approval ends the attempt as the principal released it, lifts its site, completes the cancellation and frees the account, leaving 1Password untouched', async () => {
    const id = await disclosedSignup();
    await attempts.markAwaitingVerification(id);
    await holdSite();
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
    const { cancelBrowserJob } = await import('./cancel.js');
    expect(await cancelBrowserJob(job.thread_id!)).toMatchObject({ status: 'in_progress' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    expect((JSON.parse(cards[0]) as { question: string }).question).toContain(
      "I can't tell whether the account was created",
    );
    // Asking changes nothing: only the principal's decision does.
    expect(await attempts.get(id)).toMatchObject({ phase: 'awaiting_verification' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
    const before = vaultState();
    const calls = fake.calls.length;
    await click('approve');
    const released = await attempts.get(id);
    expect(released).toMatchObject({ phase: 'rejected', owned_item_id: null, finalized_at: null });
    expect(JSON.parse(released!.evidence_json!)).toMatchObject({ release: 'principal' });
    expect(await lease()).toBeUndefined();
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.thread_id)).toEqual({
      cancelled: 1,
    });
    expect(closed).toContain(job.thread_id);
    // Nothing in 1Password was read, archived, published or changed: the candidate stays where the principal can see it.
    expect(fake.calls).toHaveLength(calls);
    expect(vaultState()).toBe(before);
    expect(fake.items.get(released!.candidate_item_id!)?.tags).toContain(`gws-ea-pending/${id}`);
    expect(notes().at(-1)).toContain('released');
    // The account is no longer busy: a new errand may sign up for it.
    const next = (await resolveSystemSession('browser', 'system:a2a:main:next-errand')).session;
    expect(
      await credentialAuthorityRequest(
        { thread: next.thread_id, operation: 'signup', site: ORIGIN, username: USERNAME },
        main,
        { attempts },
      ),
    ).toMatchObject({ status: 'recorded' });
  });

  it('releases a change whose login the principal edited meanwhile, so the login can be changed again', async () => {
    const { id, itemId } = await disclosedChange();
    await attempts.markAwaitingVerification(id);
    await attempts.markConfirmed(id, { signal: 'success_text' });
    fake.edit(itemId, editField('password', 'principal-chosen-password-1'));
    expect(await attempts.finalize(id)).toMatchObject({ status: 'conflict', reason: 'password_changed' });
    const candidateId = (await attempts.get(id))?.candidate_item_id ?? '';
    const next = fake.value(candidateId, 'password');
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain('was changed or removed while I was changing it');
    expect(card.question).toContain('"New password for shop.example"');
    expect(card.question).not.toContain('Both the original and the new password');
    await click('approve');
    expect(await attempts.get(id)).toMatchObject({ phase: 'rejected', owned_item_id: null });
    expect(fake.value(itemId, 'password')).toBe('principal-chosen-password-1');
    expect(fake.value(candidateId, 'password')).toBe(next);
    expect(notes().at(-1)).toContain('"New password for shop.example"');
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toMatchObject({
      status: 'recorded',
    });
  });

  /** A change the website confirmed on the assistant's own Login, whose vault update has not run. */
  async function confirmedChange(): Promise<{ id: string; itemId: string; candidateId: string }> {
    const { id, itemId } = await disclosedChange();
    await attempts.markAwaitingVerification(id);
    await attempts.markConfirmed(id, { signal: 'success_text' });
    return { id, itemId, candidateId: (await attempts.get(id))?.candidate_item_id ?? '' };
  }
  const releaseWithQueue = (authority: string) =>
    credentialAuthorityRequest(
      { action: 'credential_authority', requestId: 'release', thread: job.thread_id, operation: 'release', authority },
      main,
      { attempts, queue: () => queue },
    );

  it('settles a confirmed change instead of asking, while 1Password can finish it, and frees its site', async () => {
    const { id, itemId, candidateId } = await confirmedChange();
    await holdSite();
    expect(await releaseWithQueue(id)).toEqual({ status: 'password_changed', vault: 'updated' });
    expect(await pending()).toEqual([]);
    expect(cards).toEqual([]);
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
    expect(fake.items.has(candidateId)).toBe(false);
    expect(await lease()).toBeUndefined();
  });

  it("releases a confirmed change 1Password can't be reached to finish, saying what the vault still holds", async () => {
    const { id, itemId, candidateId } = await confirmedChange();
    const old = fake.value(itemId, 'password');
    const next = fake.value(candidateId, 'password');
    await holdSite();
    await rm(files.tokenFile);
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain("I can't reach 1Password to put it into the login");
    expect(card.question).toContain('"New password for shop.example", and the login may still have the old one');
    expect(card.question).not.toContain('Trying again');
    expect(await lease()).toEqual({ job_id: job.thread_id });
    await click('approve');
    const released = await attempts.get(id);
    expect(released).toMatchObject({ phase: 'rejected', owned_item_id: null, settlement: null });
    expect(JSON.parse(released!.evidence_json!)).toMatchObject({ release: 'principal', released_from: 'confirmed' });
    expect(await lease()).toBeUndefined();
    expect(notes().at(-1)).toContain(
      'The new password stays in the assistant\'s 1Password vault as its own item, "New password for shop.example"; the login may still have the old one.',
    );
    // Releasing touched nothing in 1Password.
    expect(fake.value(itemId, 'password')).toBe(old);
    expect(fake.value(candidateId, 'password')).toBe(next);
  });

  it('finishes a confirmed change at approval when 1Password is back, instead of releasing it', async () => {
    const { id, itemId } = await confirmedChange();
    await holdSite();
    await rm(files.tokenFile);
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    await writePrivateFile(files.tokenFile, FIXTURE_TOKEN);
    await click('approve');
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
    expect(await lease()).toBeUndefined();
    expect(notes().at(-1)).toContain('was not released: 1Password could be reached again');
    expect(notes().at(-1)).toContain('password_changed, vault updated');
  });

  it('describes a promoted change it cannot finish by what is left: the login has it, the separate item may too', async () => {
    const { id } = await confirmedChange();
    fake.failNext('delete', new Error('network'));
    fake.beforePut = () => fake.failNext('list', new Error('network'));
    expect(await attempts.finalize(id)).toEqual({ status: 'vault_unavailable' });
    await rm(files.tokenFile);
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain('and the login in my 1Password vault has it');
    expect(card.question).toContain(
      '"New password for shop.example" may still hold a copy of it and of the old password',
    );
  });

  it('settles a stuck confirmed change at browser start without its job, and frees its site', async () => {
    const { id, itemId } = await confirmedChange();
    await rm(files.tokenFile);
    expect(await attempts.finalize(id)).toEqual({ status: 'vault_unavailable' });
    await holdSite();
    // Still out of reach at the next start: the pass spends nothing more and leaves it held.
    await settleConfirmedAttempts(queue, undefined, attempts);
    expect(await attempts.get(id)).toMatchObject({ phase: 'confirmed' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
    await writePrivateFile(files.tokenFile, FIXTURE_TOKEN);
    await settleConfirmedAttempts(queue, undefined, attempts);
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
    expect(await lease()).toBeUndefined();
  });

  it('settles the confirmed change holding a site another job was refused', async () => {
    const { id } = await confirmedChange();
    await rm(files.tokenFile);
    expect(await attempts.finalize(id)).toEqual({ status: 'vault_unavailable' });
    await writePrivateFile(files.tokenFile, FIXTURE_TOKEN);
    await holdSite();
    const other = (await resolveSystemSession('browser', 'system:a2a:main:other-errand')).session;
    // A job waiting on another site spends nothing on this one.
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_waiters (site, job_id, requested_at) VALUES ('other.example', ?, ?)",
      other.thread_id,
      new Date().toISOString(),
    );
    const calls = fake.calls.length;
    await settleRefusedSites(queue, other.thread_id!, attempts);
    expect(fake.calls).toHaveLength(calls);
    expect(await attempts.get(id)).toMatchObject({ phase: 'confirmed' });
    await getDb().run(
      "INSERT INTO gws_ea_browser_site_waiters (site, job_id, requested_at) VALUES ('shop.example', ?, ?)",
      other.thread_id,
      new Date().toISOString(),
    );
    await settleRefusedSites(queue, other.thread_id!, attempts);
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized' });
    expect(await lease()).toBeUndefined();
  });

  it('tells the principal a signup whose emailed confirmation the host used is unknown, not unconfirmed', async () => {
    const id = await disclosedSignup();
    await attempts.markAwaitingVerification(id);
    await attempts.markUnknown(id, { signal: 'none', activation: 'activated', via: 'code' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain(
      `The site asked to confirm the account "${USERNAME}" on shop.example by email, and I used the code it sent, but I can't tell whether the site accepted it.`,
    );
    expect(card.question).not.toContain('never completed');
  });

  it('reports, asks and releases a signup whose login was edited before the host finished saving it', async () => {
    const id = await disclosedSignup();
    await attempts.markAwaitingVerification(id);
    await attempts.markConfirmed(id, { signal: 'success_text' });
    const candidateId = (await attempts.get(id))?.candidate_item_id ?? '';
    fake.edit(candidateId, editUsername(PRINCIPAL_USERNAME));
    const { context: execution, page } = context();
    expect(await executeCredentialForm(execution, { authority: id, operation: 'reconcile' }, { attempts })).toEqual({
      status: 'account_created',
      vault: 'left_as_edited',
    });
    expect(page).not.toHaveBeenCalled();
    expect(await attempts.get(id)).toMatchObject({ phase: 'conflict', conflict_reason: 'ownership_mismatch' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain(
      'its login in my 1Password vault was changed or removed before I finished saving it, so I left it as it is',
    );
    expect(card.question).not.toContain('Trying again');
    await click('approve');
    expect(await attempts.get(id)).toMatchObject({ phase: 'rejected', owned_item_id: null });
    expect(notes().at(-1)).toContain(
      'Its login was changed in 1Password before the host finished saving it, and stays as it was changed.',
    );
    expect(fake.value(candidateId, 'username')).toBe(PRINCIPAL_USERNAME);
  });
});

describe("a signup's account email (KTD14; R20, R23, R25)", () => {
  const recordedAttempts = () => getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts');

  beforeEach(async () => {
    await getDb().run(
      'UPDATE gws_ea_profile SET assistant_display_name = ?, assistant_workspace_email = ? WHERE singleton = 1',
      'Juno',
      'juno@corp.example',
    );
  });

  it("answers alias_unavailable for one under the assistant's own address until an alias is recorded, then refuses it naming the alias, and records one only under the alias", async () => {
    for (const username of ['juno@corp.example', 'Juno+Shop@corp.example'])
      expect(await ask({ operation: 'signup', site: ORIGIN, username }), username).toEqual({
        status: 'alias_unavailable',
      });
    expect(await recordedAttempts()).toEqual([]);
    await recordWebAlias('onuj@corp.example');
    await expect(ask({ operation: 'signup', site: ORIGIN, username: 'juno@corp.example' })).rejects.toMatchObject({
      code: 'invalid-args',
      message: expect.stringContaining('onuj@corp.example'),
    });
    expect(await recordedAttempts()).toEqual([]);
    expect(await ask({ operation: 'signup', site: ORIGIN, username: 'onuj+shop@corp.example' })).toMatchObject({
      status: 'recorded',
      username: 'onuj+shop@corp.example',
    });
  });

  it("refuses one under the principal's address in any spelling: the assistant never opens an account in their name", async () => {
    await addPrincipalAddress('morgan@principal.example');
    await recordWebAlias('onuj@corp.example');
    await expect(
      ask({ operation: 'signup', site: ORIGIN, username: 'Morgan+shop@principal.example' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/1Password/u) });
    expect(await recordedAttempts()).toEqual([]);
  });
});
