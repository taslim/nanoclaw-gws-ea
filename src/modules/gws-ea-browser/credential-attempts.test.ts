import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AutofillBehavior,
  ItemCategory,
  ItemFieldType,
  ItemState,
  RateLimitExceededError,
  type Item,
  type ItemCreateParams,
  type ItemOverview,
} from '@1password/sdk';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { log } from '../../log.js';
import { CredentialAttempts, type CredentialAttempt } from './credential-attempts.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from './onepassword-policy.js';
import { BrowserVault } from './onepassword.js';
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
const ORIGIN = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';
const PRINCIPAL_PASSWORD = 'principal-chosen-password-1';

type Operation = 'vaults' | 'list' | 'get' | 'create' | 'put' | 'archive' | 'resolve';
interface Fault {
  readonly error: Error;
  readonly applied: boolean | 'later';
}
const fail = (): never => {
  throw new Error('no such item');
};

/**
 * The provider as the SDK presents it: item versions, the optimistic lock on
 * put, active listings, and faults that can land a write before failing, as a
 * lost response does.
 */
class FakeOnePassword {
  readonly items = new Map<string, Item>();
  readonly archived = new Set<string>();
  readonly calls: Operation[] = [];
  beforePut: (() => void) | undefined;
  private count = 0;
  private readonly faults = new Map<Operation, Fault>();
  private readonly late: ItemCreateParams[] = [];

  /** The next call fails; its write lands first (`true`), never (`false`), or once `landLate` runs. */
  failNext(operation: Operation, error: Error, applied: Fault['applied'] = false): void {
    this.faults.set(operation, { error, applied });
  }

  landLate(): void {
    for (const params of this.late.splice(0)) this.store(params);
  }

  private take(operation: Operation): Fault | undefined {
    this.calls.push(operation);
    const fault = this.faults.get(operation);
    this.faults.delete(operation);
    return fault;
  }

  store(params: ItemCreateParams): Item {
    this.count += 1;
    const at = new Date();
    const item: Item = {
      id: `fakeitem${String(this.count).padStart(18, '0')}`,
      title: params.title,
      category: params.category,
      vaultId: params.vaultId,
      fields: params.fields ?? [],
      sections: params.sections ?? [],
      notes: params.notes ?? '',
      tags: params.tags ?? [],
      websites: params.websites ?? [],
      version: 1,
      files: [],
      createdAt: at,
      updatedAt: at,
    };
    this.items.set(item.id, structuredClone(item));
    return item;
  }

  /** The 1Password app's "Duplicate": a new item with the same content, tags included. */
  duplicate(id: string, title: string): Item {
    const { category, vaultId, fields, sections, notes, tags, websites } = structuredClone(
      this.items.get(id) ?? fail(),
    );
    return this.store({ category, vaultId, title, fields, sections, notes, tags, websites });
  }

  /** A principal's edit in the 1Password app: a new version, whatever changed. */
  edit(id: string, change: (item: Item) => Item): void {
    const current = this.items.get(id);
    if (!current) throw new Error('no such item');
    this.items.set(id, { ...change(structuredClone(current)), id, version: current.version + 1 });
  }

  value(id: string, fieldId: string): string | undefined {
    return this.items.get(id)?.fields.find((field) => field.id === fieldId)?.value;
  }

  concealed(): string[] {
    return [...this.items.values()].flatMap((item) =>
      item.fields.filter((field) => field.fieldType === ItemFieldType.Concealed).map((field) => field.value),
    );
  }

  client(): unknown {
    return {
      vaults: {
        list: async () => {
          this.take('vaults');
          return [{ id: VAULT_ID }];
        },
      },
      items: {
        create: async (params: ItemCreateParams) => {
          const fault = this.take('create');
          if (fault?.applied === true) this.store(params);
          if (fault?.applied === 'later') this.late.push(structuredClone(params));
          if (fault) throw fault.error;
          return this.store(params);
        },
        get: async (vaultId: string, itemId: string) => {
          const fault = this.take('get');
          if (fault) throw fault.error;
          const item = this.items.get(itemId);
          if (!item || item.vaultId !== vaultId || this.archived.has(itemId)) throw new Error('item not found');
          return structuredClone(item);
        },
        put: async (item: Item) => {
          const fault = this.take('put');
          const edit = this.beforePut;
          this.beforePut = undefined;
          edit?.();
          if (fault && fault.applied !== true) throw fault.error;
          const current = this.items.get(item.id);
          if (!current || current.version !== item.version) throw new Error('item version is out of date');
          const next: Item = { ...structuredClone(item), version: current.version + 1, updatedAt: new Date() };
          this.items.set(item.id, next);
          if (fault) throw fault.error;
          return structuredClone(next);
        },
        list: async (vaultId: string) => {
          this.take('list');
          return [...this.items.values()]
            .filter((item) => item.vaultId === vaultId && !this.archived.has(item.id))
            .map(
              (item): ItemOverview => ({
                id: item.id,
                title: item.title,
                category: item.category,
                vaultId: item.vaultId,
                websites: item.websites,
                tags: item.tags,
                createdAt: item.createdAt,
                updatedAt: item.updatedAt,
                state: ItemState.Active,
              }),
            );
        },
        archive: async (_vaultId: string, itemId: string) => {
          const fault = this.take('archive');
          if (fault) throw fault.error;
          this.archived.add(itemId);
        },
      },
      secrets: {
        resolve: async (reference: string) => {
          this.take('resolve');
          const [, , , itemId, field] = reference.split('/');
          return this.value(itemId, field) ?? '';
        },
      },
    };
  }
}

let directory: string;
let tokenFile: string;
let fake: FakeOnePassword;
let vault: BrowserVault;
let browserPolicyFile: string;
let onePasswordPolicyFile: string;
const output: string[] = [];

const newVault = (): BrowserVault => new BrowserVault({ browserPolicyFile, onePasswordPolicyFile });
const service = (options: { automaticPromotion?: boolean; vault?: BrowserVault } = {}): CredentialAttempts =>
  new CredentialAttempts({ db: getDb(), vault: options.vault ?? vault, automaticPromotion: true, ...options });
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
async function ownedLogin(subject = service()): Promise<{ attempt: CredentialAttempt; itemId: string }> {
  const attempt = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
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
  await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    cliPath: '/opt/homebrew/bin/op',
    managementServiceAccountId: null,
  });
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
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    accountId: ACCOUNT_ID,
    vault: { id: VAULT_ID, createdBy: { kind: 'operator' } },
    operatorGrant: null,
    runtimeServiceAccountId: RUNTIME_ID,
  });
  await writePrivateFile(tokenFile, TOKEN);
  fake = new FakeOnePassword();
  sdk.create.mockReset();
  sdk.create.mockImplementation(async () => fake.client());
  vault = newVault();
  await runMigrations(await initTestDb());
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
    // Publication drops the pending tag and lists the vault once more on next use.
    expect(await titles()).toEqual(['Shop', 'shop.example']);
    expect(fake.calls.filter((call) => call === 'list')).toHaveLength(listings + 1);
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

describe('password changes', () => {
  it('keeps both credentials after an uncertain change, discloses no value, and recovers exact references after a restart (AE4)', async () => {
    const results: unknown[] = [];
    const errors: unknown[] = [];
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const previous = fake.value(itemId, 'password');
    const change = await changedPassword(subject, itemId);
    expect(change.previous).toBe(previous);
    expect(change.next).not.toBe(previous);
    results.push(await subject.markUnknown(change.attempt.id, { website: 'timed_out' }));

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
    expect(fake.value(itemId, 'password')).toBe(change.next);
    expect(fake.archived.has(change.candidateId)).toBe(true);
    expect(await restarted.get(change.attempt.id)).toMatchObject({ phase: 'finalized', owned_item_id: itemId });

    expect(errors.map((error) => (error instanceof Error ? error.message : error))).toEqual([
      'invalid_phase',
      'invalid_phase',
    ]);
    const surfaces = JSON.stringify([await rows(), results, errors.map(String), output]);
    expect(fake.concealed().length).toBeGreaterThanOrEqual(3);
    for (const secret of fake.concealed()) expect(surfaces).not.toContain(secret);
  });

  it('preserves the principal’s unrelated edits on promotion and reports a conflict when they changed the password', async () => {
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await changedPassword(subject, itemId);
    await subject.markAwaitingVerification(change.attempt.id);
    await subject.markConfirmed(change.attempt.id, { account_page: 'password_changed' });
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
    expect(await subject.ownership(await handleFor(itemId), ORIGIN)).toEqual({ status: 'owned' });

    const second = await changedPassword(subject, itemId);
    await subject.markAwaitingVerification(second.attempt.id);
    await subject.markConfirmed(second.attempt.id, { account_page: 'password_changed' });
    fake.edit(itemId, (item) => ({
      ...item,
      fields: item.fields.map((field) => (field.id === 'password' ? { ...field, value: PRINCIPAL_PASSWORD } : field)),
    }));
    const puts = fake.calls.filter((call) => call === 'put').length;
    expect(await subject.finalize(second.attempt.id)).toMatchObject({
      status: 'conflict',
      reason: 'password_changed',
      attempt: { phase: 'conflict', conflict_reason: 'password_changed' },
    });
    expect(fake.calls.filter((call) => call === 'put')).toHaveLength(puts);
    expect(fake.value(itemId, 'password')).toBe(PRINCIPAL_PASSWORD);
    expect(fake.value(second.candidateId, 'password')).toBe(second.next);
    expect(fake.archived.has(second.candidateId)).toBe(false);
    expect(await subject.prepareRotation({ jobId: JOB, origin: ORIGIN, itemHandle: await handleFor(itemId) })).toEqual({
      status: 'busy',
    });
  });

  it('bounds a rate-limited update, reports a racing edit as a conflict, and promotes on explicit reconciliation', async () => {
    vi.useFakeTimers();
    const subject = service();
    const { itemId } = await ownedLogin(subject);
    const change = await changedPassword(subject, itemId);
    await subject.markAwaitingVerification(change.attempt.id);
    await subject.markConfirmed(change.attempt.id, { account_page: 'password_changed' });

    fake.failNext('put', new RateLimitExceededError('daily limit reached'));
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'rate_limited' });
    const spent = fake.calls.length;
    expect(await subject.finalize(change.attempt.id)).toEqual({ status: 'rate_limited' });
    expect(fake.calls).toHaveLength(spent);
    expect(await phase(change.attempt.id)).toBe('confirmed');
    vi.advanceTimersByTime(60_001);

    // The principal saves a note between the host's read and its update: the version check refuses the stale write.
    fake.beforePut = () => fake.edit(itemId, (item) => ({ ...item, notes: 'Edited during the update' }));
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'conflict', reason: 'concurrent_edit' });
    expect(fake.value(itemId, 'password')).toBe(change.previous);
    expect(fake.archived.has(change.candidateId)).toBe(false);
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(fake.items.get(itemId)).toMatchObject({ notes: 'Edited during the update' });
    expect(fake.value(itemId, 'password')).toBe(change.next);
  });

  it('leaves the original Login to the principal while automatic promotion is disabled, its default', async () => {
    const subject = new CredentialAttempts({ db: getDb(), vault });
    const { itemId } = await ownedLogin(subject);
    const change = await changedPassword(subject, itemId);
    await subject.markAwaitingVerification(change.attempt.id);
    await subject.markConfirmed(change.attempt.id, { account_page: 'password_changed' });
    const puts = fake.calls.filter((call) => call === 'put').length;
    expect(await subject.finalize(change.attempt.id)).toMatchObject({
      status: 'conflict',
      reason: 'promotion_disabled',
    });
    expect(fake.value(itemId, 'password')).toBe(change.previous);
    // The principal copies the new password into their Login; reconciliation confirms it without writing.
    fake.edit(itemId, (item) => ({
      ...item,
      fields: item.fields.map((field) => (field.id === 'password' ? { ...field, value: change.next } : field)),
    }));
    expect(await subject.finalize(change.attempt.id)).toMatchObject({ status: 'finalized' });
    expect(fake.calls.filter((call) => call === 'put')).toHaveLength(puts);
  });
});

describe('phases', () => {
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

    // An attempt abandoned before any disclosure retires its unused candidate.
    const unused = expectPrepared(await subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: USERNAME }));
    await subject.save(unused.id);
    const saved = await subject.get(unused.id);
    expect(await subject.abandon(unused.id)).toMatchObject({ phase: 'rejected' });
    expect(fake.archived.has(saved?.candidate_item_id ?? '')).toBe(true);
    expect(await subject.unresolved()).toEqual([]);
    await expect(
      subject.prepareSignup({ jobId: JOB, origin: 'http://accounts.shop.example', username: USERNAME }),
    ).rejects.toMatchObject({ reason: 'invalid_request' });
    await expect(subject.prepareSignup({ jobId: JOB, origin: ORIGIN, username: 'a\nb' })).rejects.toMatchObject({
      reason: 'invalid_request',
    });
  });
});
