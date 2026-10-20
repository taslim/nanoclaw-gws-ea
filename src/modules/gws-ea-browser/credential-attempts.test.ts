import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AutofillBehavior, ItemCategory, ItemFieldType, RateLimitExceededError, type Item } from '@1password/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';
import { CredentialAttempts, type CredentialAttempt, type CredentialPrepareResult } from './credential-attempts.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from './onepassword-policy.js';
import {
  browserConsentMigration,
  browserCredentialAttemptsMigration,
  browserCredentialConsentHoldMigration,
} from './migration.js';
import { BrowserVault } from './onepassword.js';
import { FakeOnePassword } from './onepassword-fixture.js';
import { writePrivateFile } from './paths.js';

const sdk = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock('@1password/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@1password/sdk')>()),
  createClient: sdk.create,
}));

const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const RUNTIME_ID = 'RUNTIMESERVICEACCOUNT00001';
const VAULT_ID = 'morganelleryvault000000001';
const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const TOKEN = 'ops_fixture-runtime-service-account-token';
const JOB = 'system:a2a:main:credential-job';
const OTHER_JOB = 'system:a2a:main:later-credential-job';
const ORIGIN = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';
const PRINCIPAL_PASSWORD = 'principal-chosen-password-1';

let directory: string;
let tokenFile: string;
let fake: FakeOnePassword;
let vault: BrowserVault;
let browserPolicyFile: string;
let onePasswordPolicyFile: string;
const output: string[] = [];

/** The operator's host policy; `enabled: false` is the published disable. */
async function writeHostPolicy(enabled: boolean): Promise<void> {
  await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
    schemaVersion: 2,
    enabled,
    accountId: ACCOUNT_ID,
    signInAddress: 'hale.1password.com',
    cliPath: '/opt/homebrew/bin/op',
    managementServiceAccountId: null,
  });
}

const newVault = (): BrowserVault => new BrowserVault({ browserPolicyFile, onePasswordPolicyFile });
const service = (options: { vault?: BrowserVault } = {}): CredentialAttempts =>
  new CredentialAttempts({ db: getDb(), vault: options.vault ?? vault });
const rows = (): Promise<CredentialAttempt[]> => getDb().all('SELECT * FROM gws_ea_browser_credential_attempts');
const phase = async (id: string): Promise<string | undefined> =>
  (await getDb().get<{ phase: string }>('SELECT phase FROM gws_ea_browser_credential_attempts WHERE id = ?', id))
    ?.phase;

function expectPrepared(result: { status: string; attempt?: CredentialAttempt }): CredentialAttempt {
  expect(result.status).toBe('prepared');
  if (!result.attempt) throw new Error('not prepared');
  return result.attempt;
}

/** A Login the principal saves in their assistant's vault themselves. */
function principalLogin(username = USERNAME, password = PRINCIPAL_PASSWORD): Item {
  return fake.store({
    category: ItemCategory.Login,
    vaultId: VAULT_ID,
    title: 'Shop',
    fields: [
      { id: 'username', title: 'username', fieldType: ItemFieldType.Text, value: username },
      { id: 'password', title: 'password', fieldType: ItemFieldType.Concealed, value: password },
    ],
    websites: [{ url: ORIGIN, label: 'website', autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
  });
}

/** Runs an authorized signup to the Login the host owns. */
async function ownedLogin(
  subject = service(),
  username = USERNAME,
): Promise<{ attempt: CredentialAttempt; itemId: string }> {
  const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username }));
  expect(await subject.save(attempt.id)).toMatchObject({ status: 'saved' });
  expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
  await subject.markAwaitingVerification(attempt.id);
  await subject.markConfirmed(attempt.id, { account_page: 'verified' });
  expect(await subject.finalize(attempt.id)).toMatchObject({ status: 'finalized' });
  const finalized = await subject.get(attempt.id);
  if (!finalized?.owned_item_id) throw new Error('not owned');
  return { attempt: finalized, itemId: finalized.owned_item_id };
}

async function handleFor(itemId: string, subject = vault): Promise<string> {
  await subject.refresh();
  const titles = await subject.itemsForOrigin(ORIGIN);
  const overview = fake.items.get(itemId);
  const match = titles.filter((item) => item.title === overview?.title);
  expect(match).toHaveLength(1);
  return match[0].item_handle;
}

/** A rotation on an owned Login, saved and disclosed into the change form. */
async function changedPassword(
  subject: CredentialAttempts,
  itemId: string,
): Promise<{ attempt: CredentialAttempt; candidateId: string; previous: string; next: string }> {
  const attempt = expectPrepared(
    await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: await handleFor(itemId) }),
  );
  expect(await subject.save(attempt.id)).toMatchObject({ status: 'saved' });
  const disclosed = await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
  if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
  const saved = await subject.get(attempt.id);
  if (!saved?.candidate_item_id || !disclosed.credential.currentPassword) throw new Error('no candidate');
  return {
    attempt: saved,
    candidateId: saved.candidate_item_id,
    previous: disclosed.credential.currentPassword,
    next: disclosed.credential.password,
  };
}

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'credential-attempts-')));
  const configRoot = path.join(directory, 'config');
  await mkdir(configRoot, { mode: 0o700 });
  onePasswordPolicyFile = onePasswordHostPaths(configRoot).policyFile;
  await writeHostPolicy(true);
  const instanceRoot = path.join(directory, INSTANCE_ID.slice(0, 8));
  await mkdir(instanceRoot, { mode: 0o700 });
  browserPolicyFile = path.join(instanceRoot, 'browser', 'policy.json');
  await writePrivateFile(
    path.join(instanceRoot, 'state', 'data', 'gws-ea', 'instance.json'),
    JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }),
  );
  const files = onePasswordInstancePaths(instanceRoot);
  tokenFile = files.runtimeTokenFile;
  await writeOnePasswordResources(files.resourceFile, {
    schemaVersion: 2,
    instanceId: INSTANCE_ID,
    accountId: ACCOUNT_ID,
    vault: { id: VAULT_ID, createdBy: { kind: 'operator' } },
    operatorGrant: null,
    runtimeServiceAccountId: RUNTIME_ID,
    retiredRuntimeServiceAccountIds: [],
  });
  await writePrivateFile(tokenFile, TOKEN);
  fake = new FakeOnePassword();
  sdk.create.mockReset();
  sdk.create.mockImplementation(async () => fake.client());
  vault = newVault();
  await runMigrations(await initTestDb());
  await browserCredentialAttemptsMigration.up(getDb());
  output.length = 0;
  for (const level of ['debug', 'info', 'warn', 'error'] as const)
    vi.spyOn(log, level).mockImplementation((message: string, data?: Record<string, unknown>) => {
      output.push(`${message} ${JSON.stringify(data ?? {})}`);
    });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  await closeDb();
  await rm(directory, { recursive: true, force: true });
});

describe('saving before disclosure', () => {
  it('saves a pending signup Login and proves it retrievable before any insertion is allowed', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    expect(attempt).toMatchObject({ kind: 'signup', phase: 'preparing', site: 'shop.example', vault_id: VAULT_ID });
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toEqual({
      status: 'refused',
      reason: 'not_saved',
    });
    // The read that proves the save fails: the candidate exists, but nothing may be disclosed yet.
    fake.failNext('get', new Error('network'));
    expect(await subject.save(attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    const [candidateId] = fake.items.keys();
    expect(await subject.get(attempt.id)).toMatchObject({ phase: 'preparing', candidate_item_id: candidateId });
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'refused' });
    expect(await subject.save(attempt.id)).toEqual({ status: 'refused', reason: 'reconcile_first' });

    expect(await subject.reconcileSave(attempt.id)).toMatchObject({ status: 'saved' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    const candidate = fake.items.get(candidateId);
    expect(candidate).toMatchObject({
      category: ItemCategory.Login,
      tags: [`gws-ea-pending/${attempt.id}`],
      websites: [{ url: ORIGIN, autofillBehavior: AutofillBehavior.AnywhereOnWebsite }],
    });
    expect(fake.value(candidateId, 'username')).toBe(USERNAME);

    // Another job, or another site, cannot take it.
    expect(await subject.disclose(attempt.id, { jobId: 'system:a2a:main:other', origin: ORIGIN })).toEqual({
      status: 'refused',
      reason: 'wrong_job',
    });
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: 'https://shop.example.net' })).toEqual({
      status: 'refused',
      reason: 'origin_mismatch',
    });
    expect(await phase(attempt.id)).toBe('saved');
    const disclosed = await subject.disclose(attempt.id, { jobId: JOB, origin: 'https://www.shop.example' });
    expect(disclosed).toEqual({
      status: 'disclosed',
      credential: { username: USERNAME, password: fake.value(candidateId, 'password') },
    });
    expect(await subject.get(attempt.id)).toMatchObject({ phase: 'exposed', exposed_at: expect.any(String) });
  });

  it('reconciles a lost create response by its exact marker and never creates another item', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    fake.failNext('create', new Error('connection reset'), true);
    expect(await subject.save(attempt.id)).toEqual({ status: 'outcome_unknown' });
    expect(await subject.save(attempt.id)).toEqual({ status: 'refused', reason: 'reconcile_first' });
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'refused' });
    // A restart loses the generated value; the saved candidate is found again by its marker alone.
    const restarted = service({ vault: newVault() });
    expect(await restarted.unresolved()).toEqual([
      expect.objectContaining({ id: attempt.id, phase: 'preparing', save_started_at: expect.any(String) }),
    ]);
    expect(await restarted.reconcileSave(attempt.id)).toMatchObject({ status: 'saved' });
    expect(fake.items.size).toBe(1);
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(1);
    const [candidateId] = fake.items.keys();
    expect(await restarted.get(attempt.id)).toMatchObject({ phase: 'saved', candidate_item_id: candidateId });
    expect(await restarted.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({
      status: 'disclosed',
      credential: { password: fake.value(candidateId, 'password') },
    });

    const second = expectPrepared(
      await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: 'juno.hale@example.com' }),
    );
    fake.failNext('create', new Error('timeout'), true);
    expect(await subject.save(second.id)).toEqual({ status: 'outcome_unknown' });
    // A copy of the candidate made in the 1Password app carries the same marker.
    const [, copied] = fake.items.keys();
    fake.duplicate(copied, 'Copied candidate');
    expect(await subject.reconcileSave(second.id)).toEqual({ status: 'ambiguous' });
    expect(await subject.save(second.id)).toEqual({ status: 'refused', reason: 'reconcile_first' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(2);
    expect(await subject.get(second.id)).toMatchObject({ phase: 'preparing', candidate_item_id: null });
  });

  it('prevents disclosure on a write failure, rate limit or disable before the save; a late completion reconciles', async () => {
    vi.useFakeTimers();
    const subject = service();
    const disabled = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await rm(tokenFile);
    expect(await subject.save(disabled.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.disclose(disabled.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'refused' });
    expect(await subject.reconcileSave(disabled.id)).toEqual({ status: 'absent' });
    expect(fake.calls).toEqual([]);
    await writePrivateFile(tokenFile, TOKEN);
    const cancelled = async (): Promise<void> => {
      throw new Error('job cancelled');
    };
    await expect(subject.save(disabled.id, cancelled)).rejects.toThrow('job cancelled');
    expect(fake.calls).not.toContain('create');
    expect(await subject.get(disabled.id)).toMatchObject({ phase: 'preparing', save_started_at: null });

    // A 429 on the write is one bounded outcome; nothing else calls the provider until its backoff ends.
    fake.failNext('create', new RateLimitExceededError('daily limit reached'));
    expect(await subject.save(disabled.id)).toEqual({ status: 'rate_limited' });
    const spent = fake.calls.length;
    expect(await subject.reconcileSave(disabled.id)).toEqual({ status: 'rate_limited' });
    expect(await subject.disclose(disabled.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'refused' });
    expect(fake.calls).toHaveLength(spent);
    vi.advanceTimersByTime(60_001);
    expect(await subject.reconcileSave(disabled.id)).toEqual({ status: 'absent' });
    expect(fake.items.size).toBe(0);
    expect(await subject.abandon(disabled.id)).toMatchObject({ phase: 'rejected' });

    // A failed write that the provider completes later is found by its marker and becomes usable.
    const late = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    fake.failNext('create', new Error('gateway timeout'), 'later');
    expect(await subject.save(late.id)).toEqual({ status: 'outcome_unknown' });
    expect(await subject.reconcileSave(late.id)).toEqual({ status: 'absent' });
    expect(await subject.disclose(late.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'refused' });
    fake.landLate();
    expect(await subject.reconcileSave(late.id)).toMatchObject({ status: 'saved' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(2);
    expect(await subject.disclose(late.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
  });
  it('stops a disclosure in flight once the operator disables 1Password, keeping the saved candidate to resume', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    expect(await subject.save(attempt.id)).toMatchObject({ status: 'saved' });
    const [candidateId] = fake.items.keys();
    const calls = fake.calls.length;
    // The candidate's value is in this process's memory: nothing but the published intent can stop its disclosure.
    await writeHostPolicy(false);
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toEqual({
      status: 'vault_unavailable',
    });
    expect(fake.calls).toHaveLength(calls);
    expect(await subject.get(attempt.id)).toMatchObject({
      phase: 'saved',
      exposed_at: null,
      candidate_item_id: candidateId,
    });
    expect(await subject.unresolved()).toEqual([expect.objectContaining({ id: attempt.id })]);
    expect(fake.items.has(candidateId)).toBe(true);
    for (const value of fake.concealed()) expect(output.join('\n')).not.toContain(value);

    // Re-enabled, the same attempt resumes from its saved candidate.
    await writeHostPolicy(true);
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
  });
});

describe('suggestions and ownership', () => {
  it('keeps pending signup and rotation candidates out of ordinary suggestions until a Login is published', async () => {
    const subject = service();
    principalLogin();
    const titles = async (): Promise<string[]> => (await vault.itemsForOrigin(ORIGIN)).map((item) => item.title).sort();
    expect(await titles()).toEqual(['Shop']);
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(attempt.id);
    await vault.refresh();
    expect(await titles()).toEqual(['Shop']);
    await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    await subject.markAwaitingVerification(attempt.id);
    await subject.markConfirmed(attempt.id, { account_page: 'verified' });
    const listings = fake.calls.filter((call) => call === 'list').length;
    expect(await subject.finalize(attempt.id)).toMatchObject({ status: 'finalized' });
    // Finalizing checks the candidate is still active; publication drops the pending tag, and the next use lists again.
    expect(await titles()).toEqual(['Shop', 'shop.example']);
    expect(fake.calls.filter((call) => call === 'list')).toHaveLength(listings + 2);
    const finalized = await subject.get(attempt.id);
    expect(fake.items.get(finalized?.owned_item_id ?? '')?.tags).toEqual([]);

    await changedPassword(subject, finalized?.owned_item_id ?? '');
    await vault.refresh();
    expect(await titles()).toEqual(['Shop', 'shop.example']);
  });

  it('records ownership only when the host finalizes a Login; edits in 1Password never create or move it', async () => {
    const subject = service();
    const principal = principalLogin('remy.vance@example.com');
    const principalHandle = await handleFor(principal.id);
    expect(await subject.ownership(principalHandle, ORIGIN)).toEqual({ status: 'not_owned', reason: 'no_record' });
    expect(await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: principalHandle })).toEqual({
      status: 'not_owned',
    });

    const { itemId, attempt } = await ownedLogin(subject);
    expect(attempt).toMatchObject({ owned_item_id: itemId, username: USERNAME, site: 'shop.example' });
    const handle = await handleFor(itemId);
    expect(await subject.ownership(handle, ORIGIN)).toEqual({ status: 'owned' });
    expect(await subject.ownership(handle, 'https://shop.example.net')).toEqual({ status: 'origin_mismatch' });

    // The principal points the Login at their own account: refused before anything reaches a page.
    const username = (value: string) => (item: Item) => ({
      ...item,
      fields: item.fields.map((field) => (field.id === 'username' ? { ...field, value } : field)),
    });
    fake.edit(itemId, username('remy.vance@example.com'));
    expect(await subject.ownership(handle, ORIGIN)).toEqual({ status: 'not_owned', reason: 'changed' });
    const refused = expectPrepared(await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: handle }));
    const creates = fake.calls.filter((call) => call === 'create').length;
    expect(await subject.save(refused.id)).toEqual({ status: 'not_owned' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(creates);
    expect(await subject.abandon(refused.id)).toMatchObject({ phase: 'rejected' });

    // Changing it back restores the match: the record itself never moved.
    fake.edit(itemId, username(USERNAME));
    expect(await subject.ownership(handle, ORIGIN)).toEqual({ status: 'owned' });
    // A copy made in the app has the same username and site, and no record.
    const copy = fake.duplicate(itemId, 'Shop copy');
    expect(await subject.ownership(await handleFor(copy.id), ORIGIN)).toEqual({
      status: 'not_owned',
      reason: 'no_record',
    });
    // Moving the Login to another site ends the match too.
    fake.edit(itemId, (item) => ({
      ...item,
      websites: [{ url: 'https://shop.example.net', label: 'website', autofillBehavior: AutofillBehavior.ExactDomain }],
    }));
    expect(await subject.ownership(handle, ORIGIN)).toEqual({ status: 'not_owned', reason: 'changed' });
    expect((await rows()).filter((row) => row.owned_item_id !== null)).toEqual([
      expect.objectContaining({ id: attempt.id, owned_item_id: itemId }),
    ]);
  });
});

describe('naming the account to change', () => {
  it('finds the Login the host saved for a site and username from local records, never a principal-added one', async () => {
    const subject = service();
    expect(await subject.ownedHandle(ORIGIN, USERNAME)).toEqual({ status: 'not_owned' });
    principalLogin(USERNAME);
    expect(await subject.ownedHandle(ORIGIN, USERNAME)).toEqual({ status: 'not_owned' });
    const { itemId } = await ownedLogin(subject);
    const reads = fake.calls.filter((call) => call === 'get').length;
    const found = await subject.ownedHandle(ORIGIN, USERNAME);
    expect(found).toEqual({ status: 'found', itemHandle: await handleFor(itemId) });
    // The record names the account: no fresh read is spent finding it.
    expect(fake.calls.filter((call) => call === 'get')).toHaveLength(reads);
    expect(await subject.ownedHandle(ORIGIN, 'remy.vance@example.com')).toEqual({ status: 'not_owned' });
    expect(await subject.ownedHandle('https://shop.example.net', USERNAME)).toEqual({ status: 'not_owned' });
    await rm(tokenFile);
    expect(await service({ vault: newVault() }).ownedHandle(ORIGIN, USERNAME)).toEqual({ status: 'vault_unavailable' });
  });
});

describe('password changes', () => {
  /** A change the website confirmed, not yet written into 1Password. */
  async function confirmedChange(
    subject: CredentialAttempts,
    itemId: string,
  ): Promise<{ attempt: CredentialAttempt; candidateId: string; previous: string; next: string }> {
    const change = await changedPassword(subject, itemId);
    await subject.markAwaitingVerification(change.attempt.id);
    await subject.markConfirmed(change.attempt.id, { account_page: 'password_changed' });
    return change;
  }
  /** Every item in the vault, archived or not, with a field holding `value`. */
  const holders = (value: string): string[] =>
    [...fake.items.values()]
      .filter((item) => item.fields.some((field) => field.value === value))
      .map((item) => item.id);
  const previousPasswordFields = (): number =>
    [...fake.items.values()].flatMap((item) => item.fields).filter((field) => field.id === 'previous-password').length;
  const puts = (): number => fake.calls.filter((call) => call === 'put').length;
  const setField =
    (id: string, value: string) =>
    (item: Item): Item => ({
      ...item,
      fields: item.fields.map((field) => (field.id === id ? { ...field, value } : field)),
    });
  /** The principal saves the Login between the host's fresh read and its write, `times` writes in a row. */
  function racing(itemId: string, times: number): void {
    let left = times;
    const edit = (): void => {
      fake.edit(itemId, (item) => ({ ...item, notes: `${item.notes}edit ${left};` }));
      left -= 1;
      fake.beforePut = left > 0 ? edit : undefined;
    };
    fake.beforePut = edit;
  }

  it('writes a confirmed change into the original Login and keeps neither the candidate nor the old password', async () => {
    const subject = new CredentialAttempts({ db: getDb(), vault });
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    expect(fake.value(change.candidateId, 'previous-password')).toBe(change.previous);

    expect(await subject.finalize(change.attempt.id)).toMatchObject({
      status: 'finalized',
      attempt: { phase: 'finalized', owned_item_id: itemId, conflict_reason: null },
    });
    expect(holders(change.next)).toEqual([itemId]);
    expect(holders(change.previous)).toEqual([]);
    expect(fake.items.has(change.candidateId)).toBe(false);
    expect(previousPasswordFields()).toBe(0);
    expect(await subject.ownership(await handleFor(itemId), ORIGIN)).toEqual({ status: 'owned' });
    expect(await subject.unresolved()).toEqual([]);
  });

  it('keeps both credentials while a change is uncertain, discloses no value, and settles it after a restart (AE4)', async () => {
    const results: unknown[] = [];
    const errors: unknown[] = [];
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const previous = fake.value(itemId, 'password');
    const change = await changedPassword(subject, itemId);
    expect(change.previous).toBe(previous);
    expect(change.next).not.toBe(previous);
    results.push(await subject.markUnknown(change.attempt.id, { website: 'timed_out' }));

    // The site may hold either password, so 1Password keeps both.
    expect(fake.value(itemId, 'password')).toBe(previous);
    expect(fake.items.get(change.candidateId)).toMatchObject({
      category: ItemCategory.Password,
      websites: [],
      tags: [`gws-ea-pending/${change.attempt.id}`],
    });
    expect(fake.value(change.candidateId, 'password')).toBe(change.next);
    expect(fake.value(change.candidateId, 'previous-password')).toBe(previous);
    // An uncertain change is neither promoted nor abandoned: only reconciliation can resolve it.
    results.push(await subject.finalize(change.attempt.id));
    expect(results.at(-1)).toEqual({ status: 'refused', reason: 'not_confirmed' });
    await subject.abandon(change.attempt.id).catch((error: unknown) => errors.push(error));

    // A restart keeps only the durable references, and they name exactly these items.
    const restarted = service({ vault: newVault() });
    const unresolved = await restarted.unresolved();
    results.push(unresolved);
    expect(unresolved).toEqual([
      expect.objectContaining({
        id: change.attempt.id,
        phase: 'unknown',
        source_item_id: itemId,
        source_version: expect.any(Number),
        candidate_item_id: change.candidateId,
      }),
    ]);
    results.push(await restarted.markConfirmed(change.attempt.id, { account_page: 'password_changed' }));
    await restarted.markUnknown(change.attempt.id).catch((error: unknown) => errors.push(error));
    results.push(await restarted.finalize(change.attempt.id));
    expect(holders(change.next)).toEqual([itemId]);
    expect(fake.items.has(change.candidateId)).toBe(false);
    expect(await restarted.get(change.attempt.id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });

    expect(errors.map((error) => (error instanceof Error ? error.message : error))).toEqual([
      'invalid_phase',
      'invalid_phase',
    ]);
    const surfaces = JSON.stringify([await rows(), results, errors.map(String), output]);
    for (const secret of [change.previous, change.next]) expect(surfaces).not.toContain(secret);
  });

  it("keeps the principal's other edits to the Login made during the change", async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.edit(itemId, (item) => ({
      ...item,
      title: 'Shop (household)',
      notes: 'Shared with the household',
      sections: [{ id: 'extra', title: 'Extra' }],
      fields: [
        ...item.fields,
        { id: 'member', title: 'member number', sectionId: 'extra', fieldType: ItemFieldType.Text, value: '0042' },
      ],
      tags: ['household'],
    }));
    const before = structuredClone(fake.items.get(itemId));
    if (!before) throw new Error('missing');
    expect(await subject.finalize(change.attempt.id)).toMatchObject({
      status: 'finalized',
      attempt: { phase: 'finalized', owned_item_id: itemId },
    });
    expect(fake.items.get(itemId)).toEqual({
      ...before,
      fields: before.fields.map((field) => (field.id === 'password' ? { ...field, value: change.next } : field)),
      version: before.version + 1,
      updatedAt: expect.any(Date),
    });
    expect(fake.items.has(change.candidateId)).toBe(false);
    expect(await subject.ownership(await handleFor(itemId), ORIGIN)).toEqual({ status: 'owned' });
  });

  it.each<[string, (item: Item) => Item]>([
    ['username', setField('username', 'remy.vance@example.com')],
    [
      'site',
      (item) => ({
        ...item,
        websites: [
          { url: 'https://shop.example.net', label: 'website', autofillBehavior: AutofillBehavior.ExactDomain },
        ],
      }),
    ],
  ])(
    'never overwrites a %s the principal changed during the change; the new password stays in its own item',
    async (_field, edit) => {
      const subject = service();
      const { itemId } = await ownedLogin(subject);
      const change = await confirmedChange(subject, itemId);
      fake.edit(itemId, edit);
      const edited = structuredClone(fake.items.get(itemId));
      expect(await subject.finalize(change.attempt.id)).toMatchObject({
        status: 'conflict',
        reason: 'ownership_mismatch',
        attempt: { phase: 'conflict', conflict_reason: 'ownership_mismatch', owned_item_id: null },
      });
      expect(fake.items.get(itemId)).toEqual(edited);
      expect(holders(change.next)).toEqual([change.candidateId]);
      expect(fake.value(change.candidateId, 'account')).toBe(USERNAME);
      expect(previousPasswordFields()).toBe(0);
      // A conflict is settled: finalizing again answers it and writes nothing, and only the principal's release ends it.
      const calls = fake.calls.length;
      expect(await subject.finalize(change.attempt.id)).toMatchObject({
        status: 'conflict',
        reason: 'ownership_mismatch',
      });
      expect(fake.calls).toHaveLength(calls);
      expect(await subject.release(change.attempt.id, 'approval-released')).toMatchObject({
        status: 'released',
        from: 'conflict',
        attempt: { phase: 'rejected' },
      });
      expect(holders(change.next)).toEqual([change.candidateId]);
    },
  );

  it.each<[string, (itemId: string) => void, 'login_removed' | 'password_changed', boolean]>([
    ['deleted the Login', (itemId) => void fake.items.delete(itemId), 'login_removed', false],
    ['archived the Login', (itemId) => void fake.archived.add(itemId), 'login_removed', true],
    [
      'set its password',
      (itemId) => fake.edit(itemId, setField('password', PRINCIPAL_PASSWORD)),
      'password_changed',
      false,
    ],
  ])(
    'keeps the new password in its own item when the principal %s during the change',
    async (_case, edit, reason, archived) => {
      const subject = service();
      const { itemId } = await ownedLogin(subject);
      const change = await confirmedChange(subject, itemId);
      edit(itemId);
      const original = structuredClone(fake.items.get(itemId));
      expect(await subject.finalize(change.attempt.id)).toMatchObject({
        status: 'conflict',
        reason,
        attempt: { phase: 'conflict', conflict_reason: reason },
      });
      // The only copy of the password the site now has stays; the one it replaced is gone from the host's item.
      expect(holders(change.next)).toEqual([change.candidateId]);
      expect(previousPasswordFields()).toBe(0);
      // The principal's own item is left exactly as they made it: an archived Login keeps whatever it held.
      expect(fake.items.get(itemId)).toEqual(original);
      expect(holders(change.previous)).toEqual(archived ? [itemId] : []);
      if (reason === 'password_changed')
        expect(
          await subject.prepareRotation({ jobId: OTHER_JOB, origin: ORIGIN, itemHandle: await handleFor(itemId) }),
        ).toEqual({ status: 'busy' });
    },
  );

  it('retries a version race on the freshest Login, keeping every racing edit, and settles', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    const writes = puts();
    racing(itemId, 2);
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(puts()).toBe(writes + 3);
    expect(fake.items.get(itemId)).toMatchObject({ notes: 'edit 2;edit 1;' });
    expect(holders(change.next)).toEqual([itemId]);
    expect(fake.items.has(change.candidateId)).toBe(false);
  });

  it('leaves a change confirmed when the race persists, then settles it on the next finalize', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    const writes = puts();
    racing(itemId, 5);
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    // Bounded: three refused writes, then the Login and both credentials stay as they were.
    expect(puts()).toBe(writes + 3);
    expect(await phase(change.attempt.id)).toBe('confirmed');
    expect(fake.value(itemId, 'password')).toBe(change.previous);
    expect(fake.value(change.candidateId, 'password')).toBe(change.next);
    fake.beforePut = undefined;
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(fake.items.get(itemId)).toMatchObject({ notes: 'edit 5;edit 4;edit 3;' });
    expect(holders(change.next)).toEqual([itemId]);
    expect(previousPasswordFields()).toBe(0);
  });

  it('bounds a rate-limited update to one outcome until its backoff ends', async () => {
    vi.useFakeTimers();
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.failNext('put', new RateLimitExceededError('daily limit reached'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'rate_limited' });
    const spent = fake.calls.length;
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'rate_limited' });
    expect(fake.calls).toHaveLength(spent);
    expect(await phase(change.attempt.id)).toBe('confirmed');
    vi.advanceTimersByTime(60_001);
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(holders(change.next)).toEqual([itemId]);
  });

  it('keeps a change confirmed until its candidate is gone, and never writes the Login twice', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.failNext('delete', new Error('network'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.get(change.attempt.id)).toMatchObject({ phase: 'confirmed', settlement: 'promoted' });
    expect(fake.value(itemId, 'password')).toBe(change.next);
    expect(fake.items.has(change.candidateId)).toBe(true);
    const writes = puts();

    // After a restart, the next finalize finds the Login already updated; a removal whose answer is lost still counts.
    fake.failNext('delete', new Error('connection reset'), true);
    const restarted = service({ vault: newVault() });
    expect(await restarted.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(puts()).toBe(writes);
    expect(fake.items.has(change.candidateId)).toBe(false);
    expect(holders(change.next)).toEqual([itemId]);
    expect(previousPasswordFields()).toBe(0);
  });

  it('resumes a promoted change whose candidate removal landed while the vault could not be listed', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    // The delete lands but its answer is lost, and the listing that would show it gone fails too.
    fake.failNext('delete', new Error('connection reset'), true);
    fake.beforePut = () => fake.failNext('list', new Error('network'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.get(change.attempt.id)).toMatchObject({ phase: 'confirmed', settlement: 'promoted' });
    expect(fake.items.has(change.candidateId)).toBe(false);

    // A new process remembers nothing, and the candidate it would read is gone: the recorded settlement resumes.
    const restarted = service({ vault: newVault() });
    expect(await restarted.finalize(change.attempt.id)).toMatchObject({
      status: 'finalized',
      attempt: { phase: 'finalized', owned_item_id: itemId },
    });
    expect(holders(change.next)).toEqual([itemId]);
    expect(previousPasswordFields()).toBe(0);
  });

  it('resumes a kept change whose previous-password removal landed with its answer lost', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.edit(itemId, setField('username', 'remy.vance@example.com'));
    fake.failNext('put', new Error('connection reset'), true);
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.get(change.attempt.id)).toMatchObject({
      phase: 'confirmed',
      settlement: 'kept',
      conflict_reason: 'ownership_mismatch',
    });
    expect(previousPasswordFields()).toBe(0);

    // The candidate no longer matches what an undecided pass reads; the recorded settlement still ends it.
    const restarted = service({ vault: newVault() });
    expect(await restarted.finalize(change.attempt.id)).toMatchObject({
      status: 'conflict',
      reason: 'ownership_mismatch',
      attempt: { phase: 'conflict' },
    });
    expect(holders(change.next)).toEqual([change.candidateId]);
  });

  it('recognizes a promotion whose write landed with its answer lost, after a restart', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    // The write lands, its answer is lost, and the fresh read after it fails as well.
    fake.failNext('put', new Error('connection reset'), true);
    fake.beforePut = () => fake.failNext('get', new Error('network'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.get(change.attempt.id)).toMatchObject({ phase: 'confirmed', settlement: null });
    expect(fake.value(itemId, 'password')).toBe(change.next);

    const restarted = service({ vault: newVault() });
    const writes = puts();
    expect(await restarted.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(puts()).toBe(writes);
    expect(fake.items.has(change.candidateId)).toBe(false);
    expect(holders(change.next)).toEqual([itemId]);
  });

  it('treats a failed read of a Login the vault still lists as a vault failure, never as its removal', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.failNext('get', new Error('network'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'vault_unavailable' });
    expect(await subject.get(change.attempt.id)).toMatchObject({ phase: 'confirmed', settlement: null });
    expect(fake.value(change.candidateId, 'previous-password')).toBe(change.previous);
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(holders(change.next)).toEqual([itemId]);

    // A signup's saved login read the same way stays confirmed, unpublished, for its next finalize.
    const signup = expectPrepared(
      await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: 'juno.hale@example.com' }),
    );
    await subject.save(signup.id);
    await subject.disclose(signup.id, { jobId: JOB, origin: ORIGIN });
    await subject.markAwaitingVerification(signup.id);
    await subject.markConfirmed(signup.id, { account_page: 'verified' });
    fake.failNext('get', new Error('network'));
    expect(await subject.finalize(signup.id)).toEqual({ status: 'vault_unavailable' });
    expect(await phase(signup.id)).toBe('confirmed');
    expect(await subject.finalize(signup.id)).toMatchObject({ status: 'finalized' });
  });

  it('stops at a rate-limited candidate removal without listing, then finishes after the backoff', async () => {
    vi.useFakeTimers();
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await confirmedChange(subject, itemId);
    fake.failNext('delete', new RateLimitExceededError('daily limit reached'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'rate_limited' });
    // Nothing is listed after the refused delete: a rate limit stands without spending another request.
    expect(fake.calls.at(-1)).toBe('delete');
    expect(await subject.get(change.attempt.id)).toMatchObject({ phase: 'confirmed', settlement: 'promoted' });
    vi.advanceTimersByTime(60_001);
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(fake.items.has(change.candidateId)).toBe(false);
  });

  it.each<[string, (itemId: string) => void]>([
    ['deleted', (itemId) => void fake.items.delete(itemId)],
    ['archived', (itemId) => void fake.archived.add(itemId)],
  ])('refuses a change before anything reaches the site once its Login is %s', async (_how, remove) => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const handle = await handleFor(itemId);
    const beforeSave = expectPrepared(
      await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: handle }),
    );
    remove(itemId);
    const creates = fake.calls.filter((call) => call === 'create').length;
    expect(await subject.save(beforeSave.id)).toEqual({ status: 'not_owned' });
    expect(fake.calls.filter((call) => call === 'create')).toHaveLength(creates);
    await subject.abandon(beforeSave.id);

    // Removed after its candidate was saved: nothing is disclosed.
    const restored = await ownedLogin(subject, 'juno.hale@example.com');
    fake.edit(restored.itemId, (item) => ({ ...item, title: 'Shop (Juno)' }));
    const afterSave = expectPrepared(
      await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: await handleFor(restored.itemId) }),
    );
    expect(await subject.save(afterSave.id)).toMatchObject({ status: 'saved' });
    remove(restored.itemId);
    expect(await subject.disclose(afterSave.id, { jobId: JOB, origin: ORIGIN })).toEqual({
      status: 'refused',
      reason: 'not_owned',
    });
    expect(await phase(afterSave.id)).toBe('saved');
  });

  it.each<[string, (itemId: string) => void]>([
    ['deleted', (itemId) => void fake.items.delete(itemId)],
    ['archived', (itemId) => void fake.archived.add(itemId)],
  ])('leaves a signup whose saved login was %s before it was published as removed', async (_how, remove) => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(attempt.id);
    await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    await subject.markAwaitingVerification(attempt.id);
    await subject.markConfirmed(attempt.id, { account_page: 'verified' });
    const candidateId = (await subject.get(attempt.id))?.candidate_item_id;
    if (!candidateId) throw new Error('no candidate');
    remove(candidateId);
    expect(await subject.finalize(attempt.id)).toMatchObject({
      status: 'conflict',
      reason: 'login_removed',
      attempt: { phase: 'conflict', owned_item_id: null },
    });
  });

  it('lets a later job take over a change another job saved but never disclosed, whose late disclosure then loses', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const handle = await handleFor(itemId);
    const idle = expectPrepared(await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: handle }));
    expect(await subject.save(idle.id)).toMatchObject({ status: 'saved' });
    const candidateId = (await subject.get(idle.id))?.candidate_item_id;
    if (!candidateId) throw new Error('no candidate');

    // The later job takes over while the earlier one is between its checks and its compare-and-set.
    const takeover: Promise<CredentialPrepareResult>[] = [];
    const racingPrepare = async (): Promise<void> => {
      if (takeover.length === 0)
        takeover.push(subject.prepareRotation({ jobId: OTHER_JOB, origin: ORIGIN, itemHandle: handle }));
      await takeover[0];
    };
    expect(await subject.disclose(idle.id, { jobId: JOB, origin: ORIGIN }, racingPrepare)).toEqual({
      status: 'refused',
      reason: 'not_saved',
    });
    expect(takeover).toHaveLength(1);
    const next = expectPrepared(await takeover[0]);
    expect(next).toMatchObject({ job_id: OTHER_JOB, phase: 'preparing', source_item_id: itemId });
    expect(await phase(idle.id)).toBe('rejected');
    expect(fake.items.has(candidateId)).toBe(false);
    expect(await subject.unresolved()).toEqual([expect.objectContaining({ id: next.id })]);
  });

  it('answers busy to every other job while a change may have reached the site', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await changedPassword(subject, itemId);
    const other = async (): Promise<CredentialPrepareResult> =>
      subject.prepareRotation({ jobId: OTHER_JOB, origin: ORIGIN, itemHandle: await handleFor(itemId) });
    expect(await other()).toEqual({ status: 'busy' });
    await subject.markAwaitingVerification(change.attempt.id);
    expect(await other()).toEqual({ status: 'busy' });
    await subject.markUnknown(change.attempt.id);
    expect(await other()).toEqual({ status: 'busy' });
    await subject.markConfirmed(change.attempt.id, { account_page: 'password_changed' });
    expect(await other()).toEqual({ status: 'busy' });
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(await other()).toMatchObject({ status: 'prepared' });
  });
});

describe('phases', () => {
  /** The consent stops a job's passes recorded, one per wording, each in the state the principal left it. */
  async function consentStops(...statuses: string[]): Promise<string[]> {
    await getDb().exec(
      `CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY); INSERT INTO gws_ea_browser_jobs VALUES('${JOB}');`,
    );
    await browserConsentMigration.up(getDb());
    const ids: string[] = [];
    for (const [index, status] of statuses.entries()) {
      const id = `00000000-0000-4000-8000-00000000000${index}`;
      await getDb().run(
        "INSERT INTO gws_ea_browser_consent_stops(id,job_id,site,origin,wording,kind,form_fingerprint,status,created_at) VALUES(?,?,'shop.example',?,?,'agreement','join-form',?,?)",
        id,
        JOB,
        ORIGIN,
        `Wording ${index}`,
        status,
        new Date().toISOString(),
      );
      ids.push(id);
    }
    return ids;
  }
  const evidenceOf = async (id: string): Promise<unknown> =>
    JSON.parse(
      (await getDb().get<{ evidence_json: string }>(
        'SELECT evidence_json FROM gws_ea_browser_credential_attempts WHERE id = ?',
        id,
      ))!.evidence_json,
    );

  it('copies every attempt as it was when the consent hold joins the phases, then holds and ends one by its own stops', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(attempt.id);
    const before = await rows();
    await browserCredentialConsentHoldMigration.up(getDb());
    expect(await rows()).toEqual(before);
    const [first, second, unrelated] = await consentStops('requested', 'open', 'requested');
    await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    expect(await subject.markAwaitingConsent(attempt.id, { signal: 'consent' }, [first])).toMatchObject({
      phase: 'awaiting_consent',
    });
    expect(await evidenceOf(attempt.id)).toEqual({ signal: 'consent', held: true, stops: first });
    // The same authority discloses its one candidate again for the fill after the grant, which is no longer
    // provably unsubmitted.
    expect(await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
    expect(await phase(attempt.id)).toBe('exposed');
    expect(await evidenceOf(attempt.id)).toEqual({ stops: first });
    // Held again before the principal answered: it waits on both the earlier card and the new stop.
    await subject.markAwaitingConsent(attempt.id, { signal: 'consent' }, [second]);
    expect(await evidenceOf(attempt.id)).toEqual({ signal: 'consent', held: true, stops: `${first} ${second}` });
    expect(await subject.endConsentHolds(JOB, unrelated)).toEqual([]);
    expect(await subject.endConsentHolds(OTHER_JOB, first)).toEqual([]);
    expect(await subject.endConsentHolds(JOB, first)).toEqual([attempt.id]);
    expect(await phase(attempt.id)).toBe('unknown');
    await expect(
      getDb().run("UPDATE gws_ea_browser_credential_attempts SET phase = 'held' WHERE id = ?", attempt.id),
    ).rejects.toThrow();
  });

  it('never holds a fill again once the principal declined a stop it waited on', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(attempt.id);
    await browserCredentialConsentHoldMigration.up(getDb());
    const [first, second] = await consentStops('requested', 'open');
    await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    await subject.markAwaitingConsent(attempt.id, { signal: 'consent' }, [first]);
    await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    // The card was declined while the form was being filled again: no end of the hold would follow.
    await getDb().run("UPDATE gws_ea_browser_consent_stops SET status = 'rejected' WHERE id = ?", first);
    expect(await subject.markAwaitingConsent(attempt.id, { signal: 'consent' }, [second])).toBeUndefined();
    expect(await phase(attempt.id)).toBe('exposed');
  });

  it('moves only along the diagram and records flat evidence that never carries a value', async () => {
    const subject = service();
    const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(attempt.id);
    const disclosed = await subject.disclose(attempt.id, { jobId: JOB, origin: ORIGIN });
    if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
    await expect(subject.markConfirmed(attempt.id, { account_page: 'verified' })).rejects.toMatchObject({
      reason: 'invalid_phase',
    });
    await expect(subject.abandon(attempt.id)).rejects.toMatchObject({ reason: 'invalid_phase' });
    await subject.markAwaitingVerification(attempt.id);
    await expect(
      subject.markConfirmed(attempt.id, { page_text: `saved ${disclosed.credential.password}` }),
    ).rejects.toMatchObject({ reason: 'invalid_request', message: 'invalid_request' });
    expect(await phase(attempt.id)).toBe('awaiting_verification');
    expect(await subject.markRejected(attempt.id, { website: 'password_policy' })).toMatchObject({
      phase: 'rejected',
      evidence_json: JSON.stringify({ website: 'password_policy' }),
    });
    expect(await subject.finalize(attempt.id)).toEqual({ status: 'refused', reason: 'not_confirmed' });

    // An attempt abandoned before any disclosure deletes its unused candidate.
    const unused = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(unused.id);
    const saved = await subject.get(unused.id);
    expect(await subject.abandon(unused.id)).toMatchObject({ phase: 'rejected' });
    expect(fake.items.has(saved?.candidate_item_id ?? '')).toBe(false);
    expect(await subject.unresolved()).toEqual([]);
    await expect(
      subject.prepareSignup({ jobId: JOB, origin: 'http://accounts.shop.example', username: USERNAME }),
    ).rejects.toMatchObject({ reason: 'invalid_request' });
    await expect(subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: 'a\nb' })).rejects.toMatchObject({
      reason: 'invalid_request',
    });
  });
});
