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
const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import { credentialAuthorityRequest, executeCredentialForm, validateCredentialForm } from './credential-operations.js';
import { BrowserVault } from './onepassword.js';
import { FakeOnePassword, FIXTURE_VAULT_ID, writeVaultFixture } from './onepassword-fixture.js';
import type { BrowserExecutionContext } from './queue.js';

const ORIGIN = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';
const PRINCIPAL_USERNAME = 'remy.vance@example.com';

let directory: string;
let fake: FakeOnePassword;
let vault: BrowserVault;
let attempts: CredentialAttempts;
let main: Session;
let job: Session;

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'credential-operations-')));
  const files = await writeVaultFixture(directory);
  fake = new FakeOnePassword();
  sdk.create.mockReset();
  sdk.create.mockImplementation(async () => fake.client());
  vault = new BrowserVault(files);
  await runMigrations(await initTestDb());
  attempts = new CredentialAttempts({ db: getDb(), vault, automaticPromotion: false });
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

const editUsername = (value: string) => (item: Item) => ({
  ...item,
  fields: item.fields.map((field) => (field.id === 'username' ? { ...field, value } : field)),
});

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
    // One change per Login is open at a time, whichever errand asks.
    const other = (await resolveSystemSession('browser', 'system:a2a:main:other-errand')).session;
    expect(
      await credentialAuthorityRequest(
        { thread: other.thread_id, operation: 'change_password', site: ORIGIN, username: USERNAME },
        main,
        { attempts },
      ),
    ).toEqual({ status: 'busy' });
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

  it('accepts only an authority, fresh element refs and an activation control: never a value', () => {
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
    expect(
      validateCredentialForm({
        authority,
        username: ref(1),
        new_password: ref(2),
        accept_terms: ref(3),
        activate: ref(4),
      }),
    ).toMatchObject({ accept_terms: ref(3) });
    for (const content of [
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
  });

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

  it('reports a confirmed change that keeps both credentials while automatic promotion is off', async () => {
    await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    const id = String(recorded.authority);
    for (const fields of [{ username: ref(1) }, { username: ref(1), new_password: ref(2) }])
      await expect(run(id, fields).result).rejects.toMatchObject({ code: 'invalid-args' });
    expect(await attempts.save(id)).toMatchObject({ status: 'saved' });
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    await attempts.markAwaitingVerification(id);
    await attempts.markConfirmed(id, { signal: 'success_text' });
    const { page, result } = run(id);
    expect(await result).toEqual({ status: 'password_changed', vault: 'both_kept' });
    expect(page).not.toHaveBeenCalled();
    expect(await attempts.get(id)).toMatchObject({ phase: 'conflict', conflict_reason: 'promotion_disabled' });
  });

  it('never accepts a terms checkbox for a password change', async () => {
    await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    const { page, result } = run(String(recorded.authority), {
      current_password: ref(1),
      new_password: ref(2),
      accept_terms: ref(3),
    });
    await expect(result).rejects.toMatchObject({ code: 'invalid-args' });
    expect(page).not.toHaveBeenCalled();
  });

  describe('reconciliation', () => {
    const reconcile = (authority: string, given = attempts) => {
      const { context: execution, page } = context();
      return {
        page,
        result: executeCredentialForm(execution, { authority, operation: 'reconcile' }, { attempts: given }),
      };
    };

    /** A confirmed change that kept both credentials, as every change does while automatic promotion is off. */
    async function keptBoth(): Promise<{ id: string; itemId: string }> {
      const itemId = await assistantLogin();
      const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
      const id = String(recorded.authority);
      await attempts.save(id);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markAwaitingVerification(id);
      await attempts.markConfirmed(id, { signal: 'success_text' });
      expect(await attempts.finalize(id)).toMatchObject({ status: 'conflict', reason: 'promotion_disabled' });
      return { id, itemId };
    }

    it('finalizes from conflict once the original Login holds the new password, and keeps both until then', async () => {
      const { id, itemId } = await keptBoth();
      const first = reconcile(id);
      expect(await first.result).toEqual({ status: 'password_changed', vault: 'both_kept' });
      expect(await attempts.get(id)).toMatchObject({ phase: 'conflict' });
      const attempt = await attempts.get(id);
      const next = fake.value(attempt!.candidate_item_id!, 'password')!;
      fake.edit(itemId, (item) => ({
        ...item,
        fields: item.fields.map((field) => (field.id === 'password' ? { ...field, value: next } : field)),
      }));
      const second = reconcile(id);
      expect(await second.result).toEqual({ status: 'password_changed', vault: 'updated' });
      expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });
      for (const { page, result } of [first, second]) {
        expect(page).not.toHaveBeenCalled();
        expect(JSON.stringify(await result)).not.toContain(next);
      }
    });

    it("finalizes a conflict when main refreshes the vault after the principal's edit", async () => {
      const { id, itemId } = await keptBoth();
      const attempt = await attempts.get(id);
      const next = fake.value(attempt!.candidate_item_id!, 'password')!;
      expect(await attempts.reconcileConflicts()).toEqual({ finalized: 0 });
      fake.edit(itemId, (item) => ({
        ...item,
        fields: item.fields.map((field) => (field.id === 'password' ? { ...field, value: next } : field)),
      }));
      expect(await attempts.reconcileConflicts()).toEqual({ finalized: 1 });
      expect(await attempts.get(id)).toMatchObject({ phase: 'finalized' });
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
      const restarted = new CredentialAttempts({ db: getDb(), vault, automaticPromotion: false });
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
