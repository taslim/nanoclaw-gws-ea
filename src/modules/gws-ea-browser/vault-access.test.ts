/**
 * Principal access to the assistant's 1Password vault (KTD4, R4-R6, R16):
 * only canonical main asks, through its real host request and guard; the
 * host binds the vault and account from its own records, shares only with
 * the principal's exact confirmed 1Password user, checks actual access
 * before and after any grant, and otherwise answers with the operator
 * handoff. A principal's explicit retry lists the vault again at once.
 */
import fs from 'node:fs';
import path from 'node:path';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const ROOT = await vi.hoisted(async () => {
  const { realpathSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(realpathSync(tmpdir()), 'browser-vault-access-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn().mockResolvedValue(true) }));
const sdk = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), vaults: vi.fn(), resolve: vi.fn() }));
vi.mock('@1password/sdk', () => ({
  createClient: sdk.create,
  RateLimitExceededError: class RateLimitExceededError extends Error {},
}));

import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { closeDb, createAgentGroup, createMessagingGroup, initTestDb, runMigrations } from '../../db/index.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { guard } from '../../guard/index.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { handleApprovalsResponse } from '../approvals/response-handler.js';
import { bindVerifiedPrincipalUser, listPrincipalAddresses, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { upsertUser } from '../permissions/db/users.js';
import './index.js';
import type { OnePasswordFailureReason, OnePasswordResult, ServiceAccountIdentity } from './onepassword-cli.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from './onepassword-policy.js';
import { BrowserVault } from './onepassword.js';
import { writePrivateFile } from './paths.js';
import type { OnePasswordUser } from './onepassword-cli.js';
import { registerVaultAccessDelivery, vaultAccessGuard, type VaultSharingProvider } from './vault-access.js';

const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const MANAGEMENT_ID = 'MANAGEMENTSERVICEACCOUNT01';
const RUNTIME_ID = 'RUNTIMESERVICEACCOUNT00001';
const VAULT_ID = 'morganelleryvault000000001';
const PRINCIPAL_USER_ID = 'MORGANELLERYUSER0000000001';
const ALTERNATE_USER_ID = 'MORGANPERSONALUSER00000001';
const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const RUNTIME_TOKEN = 'ops_fixture-runtime-service-account-token';
const MANAGEMENT_TOKEN = 'ops_fixture-management-service-account-token';
const SECRET = 'fixture-password-private';

const PRINCIPAL = 'gchat:users/morgan';
const DM = { channelType: 'gchat', platformId: 'gchat:spaces/morgan-dm' } as const;
const PRINCIPAL_EMAIL = 'morgan@example.test';
const WORK_EMAIL = 'morgan@work.example.test';
const ALTERNATE_EMAIL = 'morgan.ellery@personal.example.test';

type Operation = 'getUser' | 'listVaultUsers' | 'grantVaultAccess';

/** 1Password as the management service account sees it: its users, and who has direct access to the one vault. */
class FakeOnePassword implements VaultSharingProvider {
  readonly calls: Array<{ readonly operation: Operation; readonly identity: ServiceAccountIdentity; args: unknown }> =
    [];
  readonly users = new Map<string, OnePasswordUser>();
  readonly members = new Set<string>();
  readonly failures: Partial<Record<Operation, OnePasswordFailureReason[]>> = {};
  /** Whether a grant whose outcome is unknown took effect anyway. */
  unknownGrantTookEffect = false;

  fail(operation: Operation, ...reasons: OnePasswordFailureReason[]): void {
    this.failures[operation] = [...(this.failures[operation] ?? []), ...reasons];
  }

  private failure(operation: Operation): OnePasswordResult | undefined {
    const reason = this.failures[operation]?.shift();
    return reason === undefined ? undefined : { status: 'failed', reason };
  }

  count(operation: Operation): number {
    return this.calls.filter((call) => call.operation === operation).length;
  }

  async getUser(identity: ServiceAccountIdentity, email: string) {
    this.calls.push({ operation: 'getUser', identity, args: email });
    const failed = this.failure('getUser');
    if (failed?.status === 'failed') return failed;
    const user = this.users.get(email);
    return user ? ({ status: 'ok', user } as const) : ({ status: 'failed', reason: 'not_found' } as const);
  }

  async listVaultUsers(identity: ServiceAccountIdentity, vaultId: string) {
    this.calls.push({ operation: 'listVaultUsers', identity, args: vaultId });
    const failed = this.failure('listVaultUsers');
    if (failed?.status === 'failed') return failed;
    return vaultId === VAULT_ID
      ? ({ status: 'ok', userIds: [MANAGEMENT_ID, RUNTIME_ID, ...this.members] } as const)
      : ({ status: 'failed', reason: 'not_found' } as const);
  }

  async grantVaultAccess(
    identity: ServiceAccountIdentity,
    request: { readonly vaultId: string; readonly userId: string; readonly permissions: readonly string[] },
  ): Promise<OnePasswordResult> {
    this.calls.push({ operation: 'grantVaultAccess', identity, args: request });
    const failed = this.failure('grantVaultAccess');
    if (failed?.status === 'failed') {
      if (failed.reason === 'outcome_unknown' && this.unknownGrantTookEffect) this.members.add(request.userId);
      return failed;
    }
    this.members.add(request.userId);
    return { status: 'ok' };
  }
}

let onePassword: FakeOnePassword;
let vault: BrowserVault;
let onePasswordPolicyFile: string;
let browserPolicyFile: string;
let resourceFile: string;
let main: Session;
let browser: Session;
let external: Session;
let foreignMain: Session;
let sentCards: string[];
let requestNumber = 0;
let providerOpened: boolean;

const vaultRoot = path.join(ROOT, 'vault');
const instanceRoot = path.join(vaultRoot, INSTANCE_ID.slice(0, 8));

function member(email: string, userId: string, changes: Partial<OnePasswordUser> = {}): OnePasswordUser {
  return { userId, email, type: 'member', active: true, ...changes };
}

async function writeHostPolicy(managementServiceAccountId: string | null = MANAGEMENT_ID): Promise<void> {
  await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    cliPath: '/nonexistent-onepassword-cli/op',
    managementServiceAccountId,
  });
}

/** Main's request and the principal's confirmation, on this fixture's records and 1Password; null is a host that cannot share. */
function register(provider: VaultSharingProvider | null = onePassword): void {
  registerVaultAccessDelivery({
    vault,
    onePasswordPolicyFile: () => onePasswordPolicyFile,
    openProvider: async () => {
      providerOpened = true;
      return provider ?? undefined;
    },
  });
}

async function ask(fields: Record<string, unknown>, caller: Session = main): Promise<ResponseFrame> {
  const handler = getDeliveryAction('vault_access');
  expect(handler).toBeDefined();
  const requestId = `vault-access-${++requestNumber}`;
  await handler!({ action: 'vault_access', requestId, ...fields }, caller);
  const row = await withExistingMailboxSession(
    caller.agent_group_id,
    caller.id,
    (mailbox) => mailbox.getInboundMessages([`action-resp-${requestId}`])[0],
  );
  if (!row) throw new Error('No host answer');
  return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
}

function answer(frame: ResponseFrame): Record<string, unknown> {
  if (!frame.ok) throw new Error(`Refused: ${frame.error.message}`);
  return frame.data as Record<string, unknown>;
}

async function pendingApprovals(): Promise<PendingApproval[]> {
  return getDb().all<PendingApproval>('SELECT * FROM pending_approvals ORDER BY created_at');
}

async function click(approval: PendingApproval, value: 'approve' | 'reject', userId = PRINCIPAL): Promise<void> {
  await handleApprovalsResponse({
    questionId: approval.approval_id,
    value,
    userId,
    channelType: DM.channelType,
    platformId: DM.platformId,
    threadId: null,
  });
}

/** What the host told main as a system note. */
function notes(session: Session): string[] {
  const file = inboundDbPath(session.agent_group_id, session.id);
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
}

function expectNoSecrets(value: unknown): void {
  const text = JSON.stringify(value);
  for (const secret of [RUNTIME_TOKEN, MANAGEMENT_TOKEN, SECRET, RUNTIME_ID, MANAGEMENT_ID])
    expect(text).not.toContain(secret);
}

beforeEach(async () => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(vaultRoot, { recursive: true, mode: 0o700 });
  await runMigrations(await initTestDb());
  sentCards = [];
  setDeliveryAdapter({
    async deliver(_channelType, _platformId, _threadId, _kind, content) {
      sentCards.push(content);
      return 'platform-message';
    },
  });

  // The assistant's provisioned records, as U2 writes them.
  const configRoot = path.join(vaultRoot, 'config');
  fs.mkdirSync(configRoot, { mode: 0o700 });
  const hostPaths = onePasswordHostPaths(configRoot);
  onePasswordPolicyFile = hostPaths.policyFile;
  await writeHostPolicy();
  await writePrivateFile(hostPaths.managementTokenFile, MANAGEMENT_TOKEN);
  fs.mkdirSync(instanceRoot, { mode: 0o700 });
  browserPolicyFile = path.join(instanceRoot, 'browser', 'policy.json');
  await writePrivateFile(
    path.join(instanceRoot, 'state', 'data', 'gws-ea', 'instance.json'),
    JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }),
  );
  const files = onePasswordInstancePaths(instanceRoot);
  resourceFile = files.resourceFile;
  await writeOnePasswordResources(resourceFile, {
    schemaVersion: 1,
    instanceId: INSTANCE_ID,
    accountId: ACCOUNT_ID,
    vault: { id: VAULT_ID, createdBy: { kind: 'management_service_account', serviceAccountId: MANAGEMENT_ID } },
    operatorGrant: null,
    runtimeServiceAccountId: RUNTIME_ID,
  });
  await writePrivateFile(files.runtimeTokenFile, RUNTIME_TOKEN);
  vault = new BrowserVault({ browserPolicyFile, onePasswordPolicyFile });
  vi.clearAllMocks();
  sdk.create.mockResolvedValue({
    vaults: { list: sdk.vaults },
    items: { list: sdk.list },
    secrets: { resolve: sdk.resolve },
  });
  sdk.vaults.mockResolvedValue([{ id: VAULT_ID }]);
  sdk.list.mockResolvedValue([]);
  sdk.resolve.mockResolvedValue(SECRET);

  onePassword = new FakeOnePassword();
  onePassword.users.set(PRINCIPAL_EMAIL, member(PRINCIPAL_EMAIL, PRINCIPAL_USER_ID));
  providerOpened = false;
  register();

  const at = new Date().toISOString();
  for (const id of ['va-main', 'va-browser', 'va-external', 'va-foreign'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: at });
  await createMessagingGroup({
    id: 'mg-morgan-dm',
    channel_type: DM.channelType,
    platform_id: DM.platformId,
    name: 'Morgan',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: at,
  });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Juno',
    assistantWorkspaceEmail: 'juno@assistant.example.test',
    principalDisplayName: 'Morgan Ellery',
    principalTimezone: 'Europe/London',
    mainAgentGroupId: 'va-main',
    principalEmails: [PRINCIPAL_EMAIL],
  });
  await getDb().run(
    'UPDATE gws_ea_profile SET browser_agent_group_id = ?, external_email_agent_group_id = ? WHERE singleton = 1',
    'va-browser',
    'va-external',
  );
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: at });
  await bindVerifiedPrincipalUser(PRINCIPAL, at);
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-morgan-dm',
    resolved_at: at,
  });
  main = (await resolveSession('va-main', 'mg-morgan-dm', null, 'agent-shared')).session;
  browser = (await resolveSystemSession('va-browser', 'system:a2a:va-main:errand')).session;
  external = (await resolveSystemSession('va-external', 'system:a2a:va-external:thread')).session;
  foreignMain = (await resolveSession('va-foreign', 'mg-morgan-dm', null, 'shared')).session;
});

afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  delete process.env.GWS_EA_ONEPASSWORD_POLICY_FILE;
  // Leave the delivery action as the browser module registers it.
  registerVaultAccessDelivery();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

describe('sharing with the principal', () => {
  it("grants only the principal's exact confirmed user view and edit on the recorded vault, then verifies access (AE2)", async () => {
    const data = answer(await ask({ operation: 'share' }));
    expect(data).toEqual({ status: 'shared', email: PRINCIPAL_EMAIL, account_id: ACCOUNT_ID, vault_id: VAULT_ID });
    expect(onePassword.calls.map((call) => call.operation)).toEqual([
      'getUser',
      'listVaultUsers',
      'grantVaultAccess',
      'listVaultUsers',
    ]);
    const [grant] = onePassword.calls.filter((call) => call.operation === 'grantVaultAccess');
    expect(grant?.args).toEqual({
      vaultId: VAULT_ID,
      userId: PRINCIPAL_USER_ID,
      permissions: ['allow_viewing', 'allow_editing'],
    });
    // Only the host management service account shares; the runtime account never does.
    for (const call of onePassword.calls)
      expect(call.identity).toEqual({
        kind: 'service_account',
        accountId: ACCOUNT_ID,
        tokenFile: onePasswordHostPaths(path.join(vaultRoot, 'config')).managementTokenFile,
      });
    expectNoSecrets(data);
  });

  it('answers a repeated request with verified access and grants nothing again', async () => {
    answer(await ask({ operation: 'share' }));
    expect(answer(await ask({ operation: 'share', email: 'Morgan@Example.test' }))).toMatchObject({
      status: 'shared',
      email: PRINCIPAL_EMAIL,
    });
    expect(onePassword.count('grantVaultAccess')).toBe(1);
  });

  it('checks actual access after an unknown grant outcome, and before any repeat grant', async () => {
    onePassword.fail('grantVaultAccess', 'outcome_unknown');
    const first = answer(await ask({ operation: 'share' }));
    expect(first).toMatchObject({ status: 'operator_needed', reason: 'unconfirmed' });
    expect(first.operator_message).toEqual(expect.stringContaining(VAULT_ID));
    expect(onePassword.calls.at(-1)?.operation).toBe('listVaultUsers');

    // The unknown grant had in fact taken effect: the retry sees it and grants nothing.
    onePassword.members.add(PRINCIPAL_USER_ID);
    expect(answer(await ask({ operation: 'share' }))).toMatchObject({ status: 'shared' });
    expect(onePassword.count('grantVaultAccess')).toBe(1);
  });

  it('reports verified access when an unknown grant outcome took effect', async () => {
    onePassword.fail('grantVaultAccess', 'outcome_unknown');
    onePassword.unknownGrantTookEffect = true;
    expect(answer(await ask({ operation: 'share' }))).toMatchObject({ status: 'shared' });
    expect(onePassword.count('grantVaultAccess')).toBe(1);
  });

  it('asks which address when the principal has several, and never guesses', async () => {
    await getDb().run('INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?)', WORK_EMAIL, 'x');
    const refused = await ask({ operation: 'share' });
    expect(refused).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(onePassword.calls).toEqual([]);
    expect(answer(await ask({ operation: 'share', email: WORK_EMAIL }))).toMatchObject({
      status: 'operator_needed',
      reason: 'not_a_member',
      email: WORK_EMAIL,
    });
  });

  it('returns a bounded rate-limited outcome and retries nothing', async () => {
    onePassword.fail('getUser', 'rate_limited');
    expect(answer(await ask({ operation: 'share' }))).toEqual({ status: 'rate_limited' });
    expect(onePassword.calls.map((call) => call.operation)).toEqual(['getUser']);
  });

  it('reports the vault unavailable, spending no request, until the assistant is provisioned', async () => {
    fs.rmSync(resourceFile);
    expect(answer(await ask({ operation: 'share' }))).toEqual({ status: 'vault_unavailable' });
    expect(providerOpened).toBe(false);
  });
});

describe('the operator handoff', () => {
  function expectForwardable(data: Record<string, unknown>, email: string): string {
    expect(data.status).toBe('operator_needed');
    const message = data.operator_message;
    if (typeof message !== 'string') throw new Error('No operator message');
    for (const fact of ['Juno', 'juno@assistant.example.test', ACCOUNT_ID, VAULT_ID, email])
      expect(message).toContain(fact);
    // It asks for what the operator must do; it never tells the principal an invitation is coming.
    expect(message).not.toMatch(
      /invitation (?:is|was|has been) sent|will (?:be )?invite|you(?:'ll| will) (?:get|receive)/iu,
    );
    expect(message).not.toMatch(/gws-ea|\bop\b|--/u);
    expectNoSecrets(data);
    return message;
  }

  it.each<[string, (fake: FakeOnePassword) => void, string, RegExp]>([
    ['a person who is not in the account', (fake) => fake.users.clear(), 'not_a_member', /added and confirmed/u],
    [
      'an invited guest who is not confirmed yet',
      (fake) =>
        fake.users.set(PRINCIPAL_EMAIL, member(PRINCIPAL_EMAIL, PRINCIPAL_USER_ID, { type: 'guest', active: false })),
      'not_confirmed',
      /confirmed/u,
    ],
    [
      'a guest who already uses another vault',
      (fake) => {
        fake.users.set(PRINCIPAL_EMAIL, member(PRINCIPAL_EMAIL, PRINCIPAL_USER_ID, { type: 'guest' }));
        fake.fail('grantVaultAccess', 'forbidden');
      },
      'refused',
      /guest can use only one vault/u,
    ],
    [
      'an Individual account, which cannot share',
      (fake) => fake.fail('grantVaultAccess', 'forbidden'),
      'refused',
      /Individual account/u,
    ],
    [
      'missing management authority',
      (fake) => fake.fail('getUser', 'token_unavailable'),
      'host_cannot_share',
      /shared in 1Password directly/u,
    ],
    [
      'a management account 1Password refuses',
      (fake) => fake.fail('listVaultUsers', 'forbidden'),
      'host_cannot_share',
      /shared in 1Password directly/u,
    ],
    [
      'a lookup 1Password did not complete',
      (fake) => fake.fail('getUser', 'failed'),
      'unconfirmed',
      /couldn't confirm/u,
    ],
  ])('gives %s the complete forwardable message', async (_case, arrange, reason, why) => {
    arrange(onePassword);
    const data = answer(await ask({ operation: 'share' }));
    expect(data).toMatchObject({ reason, email: PRINCIPAL_EMAIL });
    expect(expectForwardable(data, PRINCIPAL_EMAIL)).toMatch(why);
  });

  it('hands off without any provider request when this host has no management service account', async () => {
    await writeHostPolicy(null);
    const data = answer(await ask({ operation: 'share' }));
    expect(data).toMatchObject({ reason: 'host_cannot_share' });
    expectForwardable(data, PRINCIPAL_EMAIL);
    expect(providerOpened).toBe(false);
  });

  it('hands off when the provider operations sharing needs are not available', async () => {
    register(null);
    const data = answer(await ask({ operation: 'share' }));
    expect(data).toMatchObject({ reason: 'host_cannot_share' });
    expectForwardable(data, PRINCIPAL_EMAIL);
  });

  it('never treats a user 1Password resolved to another email as the principal', async () => {
    onePassword.users.set(PRINCIPAL_EMAIL, member('remy.vance@example.test', PRINCIPAL_USER_ID));
    expect(answer(await ask({ operation: 'share' }))).toMatchObject({ reason: 'not_a_member' });
    expect(onePassword.count('grantVaultAccess')).toBe(0);
  });

  it('as wired by the browser module, hands off when the recorded CLI cannot open', async () => {
    registerVaultAccessDelivery();
    process.env.GWS_EA_BROWSER_POLICY_FILE = browserPolicyFile;
    process.env.GWS_EA_ONEPASSWORD_POLICY_FILE = onePasswordPolicyFile;
    const data = answer(await ask({ operation: 'share' }));
    expect(data).toMatchObject({ status: 'operator_needed', reason: 'host_cannot_share' });
    expectForwardable(data, PRINCIPAL_EMAIL);
  });
});

describe('who may ask, and for whom', () => {
  it('refuses browser, external-email and foreign-main sessions at the host guard', async () => {
    for (const caller of [browser, external, foreignMain]) {
      const frame = await ask({ operation: 'share' }, caller);
      expect(frame).toMatchObject({ ok: false, error: { code: 'forbidden' } });
      expect(await ask({ operation: 'refresh' }, caller)).toMatchObject({ ok: false });
    }
    expect(onePassword.calls).toEqual([]);
    expect(sdk.create).not.toHaveBeenCalled();
    expect(
      await guard(vaultAccessGuard, { actor: { kind: 'agent', agentGroupId: 'va-main' }, payload: {} }),
    ).toMatchObject({ effect: 'allow' });
    for (const agentGroupId of ['va-browser', 'va-external', 'va-foreign'])
      expect(await guard(vaultAccessGuard, { actor: { kind: 'agent', agentGroupId }, payload: {} })).toMatchObject({
        effect: 'deny',
      });
  });

  it('refuses a caller-chosen vault, account, permission or command', async () => {
    for (const extra of [
      { vault_id: 'remyvancevault000000000002' },
      { account_id: 'REMYVANCEACCOUNT0000000002' },
      { permissions: ['allow_managing'] },
      { command: 'vault delete' },
      { user_id: PRINCIPAL_USER_ID },
    ])
      expect(await ask({ operation: 'share', ...extra })).toMatchObject({
        ok: false,
        error: { code: 'invalid-args' },
      });
    for (const fields of [
      { operation: 'refresh', email: PRINCIPAL_EMAIL },
      { operation: 'grant' },
      { operation: 'share', email: '--account=other' },
      { operation: 'share', email: 'not an email' },
    ])
      expect(await ask(fields)).toMatchObject({ ok: false, error: { code: 'invalid-args' } });
    expect(onePassword.calls).toEqual([]);
  });

  it("refuses the assistant's own address as the principal's 1Password email", async () => {
    expect(await ask({ operation: 'share', email: 'Juno+vault@assistant.example.test' })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await pendingApprovals()).toEqual([]);
  });

  it('holds a page-supplied recipient for the principal, who can refuse it, and shares nothing meanwhile', async () => {
    const data = answer(await ask({ operation: 'share', email: 'helper@attacker.example.test' }));
    expect(data).toEqual({ status: 'awaiting_principal', email: 'helper@attacker.example.test' });
    expect(onePassword.calls).toEqual([]);
    const [approval] = await pendingApprovals();
    expect(approval).toMatchObject({
      action: 'browser_vault_email',
      approver_user_id: PRINCIPAL,
      payload: JSON.stringify({ email: 'helper@attacker.example.test' }),
    });
    const [card] = sentCards;
    expect(JSON.parse(card!) as { question: string }).toMatchObject({
      question: expect.stringContaining('helper@attacker.example.test'),
    });
    // Asking again waits on the same request rather than sending another.
    expect(answer(await ask({ operation: 'share', email: 'helper@attacker.example.test' }))).toMatchObject({
      status: 'awaiting_principal',
    });
    expect(await pendingApprovals()).toHaveLength(1);

    await click(approval!, 'reject');
    expect(await pendingApprovals()).toEqual([]);
    expect(onePassword.calls).toEqual([]);
  });

  it("binds a principal-confirmed alternate 1Password email without changing the principal's addresses", async () => {
    onePassword.users.set(ALTERNATE_EMAIL, member(ALTERNATE_EMAIL, ALTERNATE_USER_ID));
    const before = await listPrincipalAddresses();
    expect(answer(await ask({ operation: 'share', email: ALTERNATE_EMAIL }))).toMatchObject({
      status: 'awaiting_principal',
    });
    const [approval] = await pendingApprovals();

    // Nobody but the named principal can confirm it.
    await click(approval!, 'approve', 'gchat:users/remy');
    expect(onePassword.calls).toEqual([]);

    await click(approval!, 'approve');
    expect(onePassword.calls.find((call) => call.operation === 'grantVaultAccess')?.args).toMatchObject({
      vaultId: VAULT_ID,
      userId: ALTERNATE_USER_ID,
    });
    expect(notes(main).at(-1)).toMatch(new RegExp(`${ALTERNATE_EMAIL.replaceAll('.', '\\.')}.*shared`, 'u'));
    expect(await listPrincipalAddresses()).toEqual(before);
    expect(await getDb().all('SELECT email FROM gws_ea_principal_addresses')).toEqual([{ email: PRINCIPAL_EMAIL }]);
    expectNoSecrets(notes(main));
  });

  it("gives main the operator's message when a confirmed alternate email cannot be shared", async () => {
    await ask({ operation: 'share', email: ALTERNATE_EMAIL });
    const [approval] = await pendingApprovals();
    await click(approval!, 'approve');
    const note = notes(main).at(-1) ?? '';
    expect(note).toContain('exactly as written');
    for (const fact of [ACCOUNT_ID, VAULT_ID, ALTERNATE_EMAIL]) expect(note).toContain(fact);
    expect(onePassword.count('grantVaultAccess')).toBe(0);
  });
});

describe("the principal's retry after adding a login (AE6)", () => {
  const login = {
    id: 'item1',
    vaultId: VAULT_ID,
    title: 'Shop login',
    category: 'Login',
    state: 'active',
    websites: [{ url: 'https://shop.example', label: '', autofillBehavior: 'AnywhereOnWebsite' }],
  };

  it('lists the vault again on an explicit retry, without waiting for the metadata cache', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      expect(await vault.itemsForOrigin('https://shop.example')).toEqual([]);
      // The principal adds a login in 1Password; nothing re-lists the vault on its own.
      sdk.list.mockResolvedValue([login]);
      expect(await vault.itemsForOrigin('https://shop.example')).toEqual([]);

      const data = answer(await ask({ operation: 'refresh' }));
      expect(data).toEqual({ status: 'usable' });
      expect(await vault.itemsForOrigin('https://shop.example')).toEqual([
        { title: 'Shop login', item_handle: expect.stringMatching(/^vault_/u) },
      ]);
      expect(sdk.list).toHaveBeenCalledTimes(2);
      expect(sdk.resolve).not.toHaveBeenCalled();
      expectNoSecrets(data);
      expect(JSON.stringify(data)).not.toContain('item1');
    } finally {
      vi.useRealTimers();
    }
  });

  it('reports a spent request limit or an unusable vault, without secrets', async () => {
    const { RateLimitExceededError } = await import('@1password/sdk');
    sdk.list.mockRejectedValueOnce(new RateLimitExceededError('limited'));
    expect(answer(await ask({ operation: 'refresh' }))).toEqual({ status: 'rate_limited' });
    fs.rmSync(resourceFile);
    expect(answer(await ask({ operation: 'refresh' }))).toEqual({ status: 'vault_unavailable' });
  });
});
