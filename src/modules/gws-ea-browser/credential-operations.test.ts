import * as loginStoreModule from './login-store.js';
import { createBrowserQueue } from './index.js';
import fs from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
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
import Database from 'better-sqlite3';

import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getAgentGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../../db/index.js';
import { setDeliveryAdapter } from '../../delivery.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
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
  validateCredentialForm,
} from './credential-operations.js';
import { BrowserStore } from './db.js';
import { testLoginStore } from './testing/login-store.js';
import type { SavedLogin } from './login-store.js';
import { BrowserQueue } from './queue.js';
import type { BrowserExecutionContext } from './actions.js';
import { openSignupVerification } from './sign-in-mail.js';
import { givenAddressStop } from './web-address.js';

const ORIGIN = 'https://accounts.shop.example';
const USERNAME = 'morgan.ellery@example.com';
const PRINCIPAL_USERNAME = 'remy.vance@example.com';

let directory: string;
let fixture: ReturnType<typeof testLoginStore>;
let attempts: CredentialAttempts;
let main: Session;
let job: Session;

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'credential-operations-')));
  fixture = testLoginStore(path.join(directory, 'browser'));
  vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(fixture.store);
  await runMigrations(await initTestDb());
  attempts = new CredentialAttempts({ db: getDb(), store: fixture.store });
  for (const id of ['main', 'browser'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1`,
    'main',
    'browser',
  );
  await recordWebAlias(USERNAME);
  main = (await resolveSystemSession('main', 'system:task:principal')).session;
  job = (await resolveSystemSession('browser', 'system:a2a:main:credentials')).session;
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.useRealTimers();
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

async function principalLogin(username = USERNAME): Promise<SavedLogin> {
  return fixture.store.create({ site: ORIGIN, username, title: 'Shop', password: 'principal-chosen-password' });
}

/** The assistant's account after a completed signup. */
async function assistantLogin(): Promise<string> {
  const recorded = await ask({ operation: 'signup', site: `${ORIGIN}/join`, username: USERNAME });
  const id = String(recorded.authority);
  expect(await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN })).toMatchObject({ status: 'disclosed' });
  await attempts.markAwaitingVerification(id);
  const finalized = await attempts.confirm(id, { signal: 'success_text' });
  if (finalized.status !== 'finalized' || !finalized.attempt.owned_login_id) throw new Error('not finalized');
  return finalized.attempt.owned_login_id;
}

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
  it('obtains the exact web address for a fresh guest form and signup before any saved login exists', async () => {
    await getDb().run('UPDATE gws_ea_profile SET assistant_alias = NULL WHERE singleton = 1');
    const email = 'onuj@web.example';
    await recordWebAlias(email);
    expect(await fixture.store.all()).toEqual([]);
    const websiteEmail = async (id: string): Promise<string> => {
      const group = await getAgentGroup(id);
      if (!group) throw new Error('Missing browser identity fixture group');
      const identity = (await getRequiredProjectDocSections(group)).find(
        (section) => section.name === 'Assistant Identity',
      )?.body;
      const address = /web address is `([^`]+)`/u.exec(identity ?? '')?.[1];
      if (address === undefined) throw new Error('The host did not supply a web address');
      return address;
    };

    const guestEmail = await websiteEmail('browser');
    expect(guestEmail).toBe(email);
    expect(await givenAddressStop([guestEmail])).toBeUndefined();
    const signupEmail = await websiteEmail('main');
    expect(await ask({ operation: 'signup', site: ORIGIN, username: signupEmail })).toMatchObject({
      status: 'recorded',
      username: email,
    });
    expect(await fixture.store.all()).toEqual([]);
  });

  it('records a signup for one job, site and account, repeats safely, with its pending password saved', async () => {
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
    expect(await attempts.get(String(recorded.authority))).toMatchObject({
      kind: 'signup',
      job_id: job.thread_id,
      origin: ORIGIN,
      phase: 'saved',
    });
    const other = await ask({ operation: 'signup', site: ORIGIN, username: 'juno_eats' });
    expect(other.authority).not.toBe(recorded.authority);
  });

  it('records a password change for an assistant account the principal added under an alias spelling', async () => {
    await getDb().run('UPDATE gws_ea_profile SET assistant_alias = NULL WHERE singleton = 1');
    await recordWebAlias('onuj@corp.example');
    const username = 'Onuj+Shop@corp.example';
    const login = await principalLogin(username);
    const [choice] = await fixture.store.forOrigin(ORIGIN);
    expect(await attempts.accountForLogin(choice!)).toBe('assistant');

    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username });

    expect(recorded).toMatchObject({ status: 'recorded', operation: 'change_password', username });
    expect(await attempts.get(String(recorded.authority))).toMatchObject({
      kind: 'rotation',
      source_login_id: login.id,
      username,
    });
    expect(
      await attempts.disclose(String(recorded.authority), { jobId: job.thread_id!, origin: ORIGIN }),
    ).toMatchObject({
      status: 'disclosed',
      credential: { username },
    });
  });

  it('refuses a change on a principal, edited or missing Login before any page insertion', async () => {
    const before = await getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts');
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
    });
    const principal = await principalLogin(PRINCIPAL_USERNAME);
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
    });
    expect(await getDb().all('SELECT * FROM gws_ea_browser_credential_attempts')).toEqual(before);

    await fixture.store.remove(principal.id, principal.version);
    const itemId = await assistantLogin();
    await fixture.store.update(itemId, (await fixture.store.get(itemId)).version, {
      username: PRINCIPAL_USERNAME,
      password: '',
    });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
    });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: PRINCIPAL_USERNAME })).toEqual({
      status: 'not_owned',
    });
    await fixture.store.update(itemId, (await fixture.store.get(itemId)).version, {
      username: USERNAME,
      site: 'https://shop.example.net',
      password: '',
    });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({
      status: 'not_owned',
    });
    expect(
      (await getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts')).filter(
        (attempt) => attempt.kind === 'rotation',
      ),
    ).toEqual([]);
  });

  it('never records a second signup for an account whose first may have reached the site', async () => {
    const first = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
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
    expect(await ask({ operation: 'signup', site: ORIGIN, username: 'juno_eats' })).toMatchObject({
      status: 'recorded',
    });
    await attempts.markRejected(first, { signal: 'reconciled' });
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toMatchObject({ status: 'recorded' });
  });

  it('records no new authority on a job whose cancellation is waiting for an unresolved change', async () => {
    await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
    await getDb().run('UPDATE gws_ea_browser_jobs SET cancel_requested = 1 WHERE id = ?', job.thread_id);
    await expect(ask({ operation: 'signup', site: ORIGIN, username: 'juno_eats' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('records a change on an unedited assistant-created Login, bound to that Login, and repeats safely', async () => {
    const itemId = await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    expect(recorded).toMatchObject({ status: 'recorded', operation: 'change_password', username: USERNAME });
    expect(await attempts.get(String(recorded.authority))).toMatchObject({
      kind: 'rotation',
      source_login_id: itemId,
      phase: 'saved',
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

    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    const phases: Array<[() => Promise<unknown>, Record<string, unknown>]> = [
      [async () => undefined, { status: 'outcome_unknown' }],
      [() => attempts.markAwaitingVerification(id), { status: 'verification_requested' }],
      [() => attempts.markUnknown(id), { status: 'outcome_unknown' }],
      [() => attempts.confirm(id, { signal: 'success_text' }), { status: 'account_created' }],
      [async () => undefined, { status: 'account_created' }],
    ];
    for (const [move, expected] of phases) {
      await move();
      const { page, result } = run(id);
      expect(await result).toEqual(expected);
      expect(page).not.toHaveBeenCalled();
    }
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized' });

    const second = await ask({ operation: 'signup', site: ORIGIN, username: 'juno_eats' });
    await attempts.abandon(String(second.authority));
    expect(await run(String(second.authority)).result).toEqual({ status: 'refused', reason: 'no_authority' });
  });

  it('reports a confirmed change written into the original login, its password gone', async () => {
    const itemId = await assistantLogin();
    const recorded = await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME });
    const id = String(recorded.authority);
    for (const fields of [{ username: ref(1) }, { username: ref(1), new_password: ref(2) }])
      await expect(run(id, fields).result).rejects.toMatchObject({ code: 'invalid-args' });
    const disclosed = await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    if (disclosed.status !== 'disclosed') throw new Error(disclosed.status);
    await attempts.markAwaitingVerification(id);
    await attempts.confirm(id, { signal: 'success_text' });
    const { page, result } = run(id);
    expect(await result).toEqual({ status: 'password_changed' });
    expect(page).not.toHaveBeenCalled();
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_login_id: itemId });
    expect(await fixture.store.secret(itemId, 'password', ORIGIN)).toBe(disclosed.credential.password);
    expect(await fixture.store.hasPending(id)).toBe(false);
  });

  it("answers not_watched from verify when the signup's email has no wait, and leaves it for the principal's release", async () => {
    const id = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
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

    it('stays inconclusive from unknown without host evidence, never deciding from the page alone after a restart', async () => {
      const recorded = await ask({ operation: 'signup', site: ORIGIN, username: USERNAME });
      const id = String(recorded.authority);
      await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
      await attempts.markUnknown(id, { signal: 'interrupted' });
      const restarted = new CredentialAttempts({ db: getDb(), store: fixture.store });
      const { page, result } = reconcile(id, restarted);
      expect(await result).toEqual({ status: 'inconclusive' });
      expect(page).not.toHaveBeenCalled();
      expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
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
    await attempts.disclose(exposed, { jobId: job.thread_id!, origin: ORIGIN });
    const waiting = String((await ask({ operation: 'signup', site: ORIGIN, username: 'juno_eats' })).authority);
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
      withActivity: <T>(operation: () => Promise<T>): Promise<T> => operation(),
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
  const holdSite = (at = new Date().toISOString()) =>
    getDb().run("INSERT INTO gws_ea_browser_site_leases VALUES ('shop.example', ?, 'active', ?)", job.thread_id, at);
  const lease = () =>
    getDb().get<{ job_id: string }>("SELECT job_id FROM gws_ea_browser_site_leases WHERE site = 'shop.example'");
  /** A signup the website may or may not have taken. */
  async function disclosedSignup(username = USERNAME): Promise<string> {
    const id = String((await ask({ operation: 'signup', site: ORIGIN, username })).authority);
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    return id;
  }
  /** A change on the assistant's own Login that the website may or may not have taken. */
  async function disclosedChange(): Promise<{ id: string; itemId: string }> {
    const itemId = await assistantLogin();
    const id = String((await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).authority);
    await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN });
    return { id, itemId };
  }

  it('refuses attempts that are settled or never reached the site, other jobs, and every caller but main', async () => {
    const preparing = String((await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).authority);
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    await attempts.disclose(preparing, { jobId: job.thread_id!, origin: ORIGIN });
    // Exposed is still in flight: its own step settles it.
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    await attempts.markAwaitingVerification(preparing);
    await attempts.confirm(preparing, { signal: 'success_text' });
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    expect(await attempts.get(preparing)).toMatchObject({ phase: 'finalized' });
    expect(await release(preparing)).toEqual({ status: 'not_releasable' });
    const other = await attempts.prepareSignup({ jobId: 'system:a2a:main:other', origin: ORIGIN, username: USERNAME });
    if (other.status !== 'prepared') throw new Error(other.status);
    expect(await release(other.attempt.id)).toEqual({ status: 'not_releasable' });
    const unknown = await disclosedSignup('juno_eats');
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
    expect(card.question).toContain("I can't tell whether the site accepted it");
    expect(card.question).toContain('discard the generated password');
    expect(card.question).toContain('reset the password through my email');
    await click('reject');
    const declined = notes().at(-1) ?? '';
    expect(declined).toContain(`The principal chose to keep waiting on the password change for "${USERNAME}"`);
    expect(declined).not.toMatch(/admin|browser_credential_release|appr-/u);
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
    expect(await ask({ operation: 'change_password', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
  });

  const WAIVER = 'I have read and accept the liability waiver';
  /** A stop of this job's consent pass for one wording, recorded under the page's site, its card out to the principal. */
  async function consentCard(
    site: string,
    wording: string,
    fingerprint: string,
  ): Promise<{ stopId: string; approvalId: string }> {
    const [stop] = await recordConsentStops(
      { jobId: job.thread_id!, db: getDb() },
      { site, origin: ORIGIN, fingerprint, items: [{ id: 0, wording, kind: 'agreement' }] },
    );
    await getDb().run("UPDATE gws_ea_browser_consent_stops SET status = 'requested' WHERE id = ?", stop.stop_id);
    const approvalId = await requestApproval({
      session: job,
      agentName: 'browser',
      action: CONSENT_APPROVAL,
      payload: { stopId: stop.stop_id, jobId: job.thread_id },
      title: `Agree to this on ${site}?`,
      question: `${site} asks me to agree to this: "${wording}"`,
      approverUserId: PRINCIPAL,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    if (!approvalId || !stop.stop_id) throw new Error('No consent card');
    return { stopId: stop.stop_id, approvalId };
  }
  /** A disclosed signup stays uncertain while the principal decides a wording on the page's site. */
  async function uncertainAfterConsent(site = 'shop.example'): Promise<{ id: string; approvalId: string }> {
    const id = await disclosedSignup();
    await holdSite();
    const { stopId, approvalId } = await consentCard(site, WAIVER, 'join-form');
    expect(await attempts.markUnknown(id, { signal: 'consent', stops: stopId, held: true })).toMatchObject({
      phase: 'unknown',
    });
    return { id, approvalId };
  }
  const decline = (approvalId: string) =>
    handleApprovalsResponse({
      questionId: approvalId,
      value: 'reject',
      userId: PRINCIPAL,
      channelType: DM.channelType,
      platformId: DM.platformId,
      threadId: null,
    });

  it.each([
    ['declines', decline],
    [
      'lets lapse',
      async () => {
        await getDb().run("UPDATE pending_approvals SET expires_at = '2026-01-01T00:00:00.000Z'");
        await sweepExpiredApprovals();
      },
    ],
  ] as const)(
    'keeps a signup uncertain when the principal %s its consent card, with a truthful release warning',
    async (_case, decide) => {
      const { id, approvalId } = await uncertainAfterConsent();
      await decide(approvalId);
      expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
      expect(await lease()).toEqual({ job_id: job.thread_id });
      expect(await release(id)).toEqual({ status: 'awaiting_principal' });
      // Even an old held marker cannot prove that an input callback never submitted.
      const question = (JSON.parse(cards.at(-1) ?? '{}') as { question?: string }).question ?? '';
      expect(question).toContain(
        `I tried to create the account "${USERNAME}" on shop.example, but I can't tell whether the site accepted it.`,
      );
      expect(question).toContain('discard the generated password');
      expect(question).not.toContain('never submitted');
      await click('approve');
      expect(await attempts.get(id)).toMatchObject({ phase: 'rejected' });
      expect(await lease()).toBeUndefined();
    },
  );

  it('keeps a framed signup uncertain when the card on its parent site is declined', async () => {
    // A signup form another site embeds: the stop names the page's site, the attempt its own form's.
    const { id, approvalId } = await uncertainAfterConsent('parent.example');
    await decline(approvalId);
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
  });

  it('keeps an exposed signup uncertain across decisions on its own and other consent stops', async () => {
    const id = await disclosedSignup();
    await holdSite();
    const [own] = await recordConsentStops(
      { jobId: job.thread_id!, db: getDb() },
      {
        site: 'shop.example',
        origin: ORIGIN,
        fingerprint: 'join-form',
        items: [{ id: 0, wording: WAIVER, kind: 'agreement' }],
      },
    );
    await getDb().run("UPDATE gws_ea_browser_consent_stops SET status = 'approved' WHERE id = ?", own.stop_id);
    await attempts.markUnknown(id, { signal: 'consent', stops: own.stop_id! });
    const other = await consentCard('shop.example', 'I agree to share my details with travel partners', 'offers-form');
    await decline(other.approvalId);
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
  });

  it('does not redisclose a password after a consent grant, and warns that a new attempt may duplicate it', async () => {
    const { id } = await uncertainAfterConsent();
    const password = await fixture.store.disclosePending(id);
    expect(await attempts.disclose(id, { jobId: job.thread_id!, origin: ORIGIN })).toEqual({
      status: 'refused',
      reason: 'not_saved',
    });
    expect(await fixture.store.disclosePending(id)).toBe(password);
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const question = (JSON.parse(cards.at(-1) ?? '{}') as { question?: string }).question ?? '';
    expect(question).toContain('discard the generated password');
  });

  it('keeps an uncertain signup and its site when its job is cancelled, until an informed release', async () => {
    const { id } = await uncertainAfterConsent();
    const { cancelBrowserJob } = await import('./cancel.js');
    expect(await cancelBrowserJob(job.thread_id!)).toMatchObject({ status: 'in_progress' });
    expect(await attempts.get(id)).toMatchObject({ phase: 'unknown' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
  });

  it('finishes an already committed change on approval without reporting a discarded password or holding its site', async () => {
    const { id, itemId } = await disclosedChange();
    const password = await fixture.store.disclosePending(id);
    await attempts.markUnknown(id, { signal: 'interrupted' });
    await holdSite();
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const run = getDb().run.bind(getDb());
    const interrupted = vi.spyOn(getDb(), 'run').mockImplementation(async (sql, ...parameters) => {
      if (sql.includes("SET phase = 'finalized'")) throw new Error('Central write interrupted');
      return run(sql, ...parameters);
    });
    await expect(attempts.confirm(id, { signal: 'late_response' })).rejects.toThrow('Central write interrupted');
    interrupted.mockRestore();
    fixture.setUnavailable(true);
    await click('approve');
    expect(await attempts.get(id)).toMatchObject({ phase: 'finalized', owned_login_id: itemId });
    expect(await lease()).toBeUndefined();
    expect(notes().at(-1)).toContain('was not released: another step settled it first');
    expect(notes().at(-1)).not.toContain('discarded');
    fixture.setUnavailable(false);
    expect(await fixture.store.secret(itemId, 'password', ORIGIN)).toBe(password);
  });

  it('on approval ends the attempt as the principal released it, lifts its site, completes the cancellation and frees the account, discarding the generated password', async () => {
    const id = await disclosedSignup();
    await attempts.markAwaitingVerification(id);
    await holdSite();
    expect(await ask({ operation: 'signup', site: ORIGIN, username: USERNAME })).toEqual({ status: 'busy' });
    const { cancelBrowserJob } = await import('./cancel.js');
    expect(await cancelBrowserJob(job.thread_id!)).toMatchObject({ status: 'in_progress' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    expect((JSON.parse(cards[0]) as { question: string }).question).toContain(
      "I can't tell whether the site accepted it",
    );
    // Asking changes nothing: only the principal's decision does.
    expect(await attempts.get(id)).toMatchObject({ phase: 'awaiting_verification' });
    expect(await lease()).toEqual({ job_id: job.thread_id });
    await click('approve');
    const released = await attempts.get(id);
    expect(released).toMatchObject({ phase: 'rejected', owned_login_id: null, finalized_at: null });
    expect(JSON.parse(released!.evidence_json!)).toMatchObject({ release: 'principal' });
    expect(await lease()).toBeUndefined();
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.thread_id)).toEqual({
      cancelled: 1,
    });
    expect(closed).toContain(job.thread_id);
    expect(await fixture.store.hasPending(id)).toBe(false);
    expect(notes().at(-1)).toContain('generated password was discarded');
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

  it('tells the principal a signup whose emailed confirmation the host used is unknown, not unconfirmed', async () => {
    const id = await disclosedSignup();
    await attempts.markAwaitingVerification(id);
    await attempts.markUnknown(id, { signal: 'none', activation: 'activated', via: 'code' });
    expect(await release(id)).toEqual({ status: 'awaiting_principal' });
    const card = JSON.parse(cards[0]) as { question: string };
    expect(card.question).toContain("I can't tell whether the site accepted it");
    expect(card.question).not.toContain('never completed');
  });
});

describe("a signup's account email", () => {
  const recordedAttempts = () => getDb().all<CredentialAttempt>('SELECT * FROM gws_ea_browser_credential_attempts');

  beforeEach(async () => {
    await getDb().run(
      `UPDATE gws_ea_profile SET assistant_alias = NULL, assistant_first_name = ?, assistant_workspace_email = ? WHERE singleton = 1`,
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
      code: 'forbidden',
      message: expect.stringContaining('onuj@corp.example'),
    });
    expect(await recordedAttempts()).toEqual([]);
    expect(await ask({ operation: 'signup', site: ORIGIN, username: 'onuj+shop@corp.example' })).toMatchObject({
      status: 'recorded',
      username: 'onuj+shop@corp.example',
    });
  });

  it('refuses third-party email signups and permits a non-email username', async () => {
    await recordWebAlias('onuj@corp.example');
    await expect(ask({ operation: 'signup', site: ORIGIN, username: 'someone@example.org' })).rejects.toMatchObject({
      code: 'forbidden',
    });
    expect(await recordedAttempts()).toEqual([]);
    expect(await ask({ operation: 'signup', site: ORIGIN, username: 'onuj_eats' })).toMatchObject({
      status: 'recorded',
      username: 'onuj_eats',
    });
  });

  it.each(['Onuj+shop@gmail.com', 'O.n.u.j@gmail.com', 'O.N.U.J+SHOP@GMAIL.COM'])(
    'accepts the alias spelling %s for signup',
    async (username) => {
      await recordWebAlias('onuj@gmail.com');
      expect(await ask({ operation: 'signup', site: ORIGIN, username })).toMatchObject({
        status: 'recorded',
        username,
      });
    },
  );

  it("refuses one under the principal's address in any spelling: the assistant never opens an account in their name", async () => {
    await addPrincipalAddress('morgan@principal.example');
    await recordWebAlias('onuj@corp.example');
    await expect(
      ask({ operation: 'signup', site: ORIGIN, username: 'Morgan+shop@principal.example' }),
    ).rejects.toMatchObject({ code: 'forbidden', message: expect.stringMatching(/saved logins/u) });
    expect(await recordedAttempts()).toEqual([]);
  });
});
