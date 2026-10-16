import { randomUUID } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { processLock } from '../community-portal/process-lock.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import {
  enableOnePassword,
  inspectOnePasswordCapability,
  onePasswordCapabilityLines,
  onePasswordEnableNextActions,
  onePasswordNextActions,
  onePasswordReleaseCompatibility,
  ONEPASSWORD_CONTRACT,
  provisionAssistantVault,
  type OnePasswordDependencies,
  type OnePasswordEnableRequest,
} from './onepassword.js';
import { runCli } from './cli.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  createInstanceRuntimeConfig,
  persistInstanceRuntime,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import { ACCOUNT_ID, FakeOnePassword, OP, OPERATOR_USER_ID, OTHER_ACCOUNT_ID } from './testing/onepassword-fixture.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError } from './types.js';

const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

let root: string;
let paths: ControlPlanePaths;
let provider: FakeOnePassword;
let nextPort = 35_000;

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onepassword-')));
  // Custom control-plane roots, as an operator's environment can name them.
  paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'operator-config'),
    stateRoot: path.join(root, 'operator-state'),
  });
  provider = new FakeOnePassword();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function dependencies(overrides: Partial<OnePasswordDependencies> = {}): OnePasswordDependencies {
  return {
    cli: provider.cli(),
    upsertEnvVars,
    ...overrides,
  };
}

/** A created assistant whose service is stopped; `compatible` releases carry the 1Password contract marker. */
async function assistant(
  options: { readonly compatible?: boolean; readonly email?: string } = {},
): Promise<InstanceRuntimeConfig> {
  const instanceId = randomUUID();
  const port = (nextPort += 2);
  const reservation = await reserveInstance(paths, {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/ea.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: port, onecli_gateway: port + 1 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: 'operator@example.test',
      workspace_email: options.email ?? `aya.${instanceId.slice(0, 8)}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const release = paths.instanceLayout(instanceId).release('aaaaaaaa');
  await mkdir(path.join(release, 'src/gws-ea'), { recursive: true, mode: 0o700 });
  if (options.compatible ?? true)
    await writeFile(
      path.join(release, 'src/gws-ea/onepassword-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, contract: ONEPASSWORD_CONTRACT }),
    );
  await symlink('aaaaaaaa', paths.checkoutRoot(instanceId));
  const onecli = createOnecliRuntimeLayout({
    instanceId,
    instanceRoot: paths.instanceRoot(instanceId),
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: port,
    gatewayPort: port + 1,
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  const runtime = createInstanceRuntimeConfig(paths, reservation, onecli, {
    nodePath: process.execPath,
    homeDirectory: root,
    selectedProvider: 'claude',
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  // Created before 1Password existed on this host: no host policy locator is bound yet.
  await persistInstanceRuntime(runtime, upsertEnvVars);
  return runtime;
}

async function enable(
  overrides: Partial<OnePasswordDependencies> = {},
  request: OnePasswordEnableRequest = { accountId: ACCOUNT_ID },
) {
  return enableOnePassword(paths, request, dependencies(overrides));
}

async function resourcesOf(runtime: InstanceRuntimeConfig) {
  const read = await readOnePasswordResources(onePasswordInstancePaths(runtime.instance_root).resourceFile, {
    instanceId: runtime.instance_id,
  });
  return read.status === 'ready' ? read.resources : undefined;
}

async function runtimeToken(runtime: InstanceRuntimeConfig): Promise<string> {
  return (await readFile(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile, 'utf8')).trim();
}

async function exists(file: string): Promise<boolean> {
  return lstat(file).then(
    () => true,
    () => false,
  );
}

describe('1Password release compatibility', () => {
  it('ships the contract marker with this release and reads a missing marker as unsupported', async () => {
    expect(await onePasswordReleaseCompatibility(CONTROL_PLANE_ROOT)).toBe('compatible');
    expect(await onePasswordReleaseCompatibility(path.join(root, 'no-release'))).toBe('unsupported');
    const malformed = path.join(root, 'malformed');
    await mkdir(path.join(malformed, 'src/gws-ea'), { recursive: true });
    await writeFile(path.join(malformed, 'src/gws-ea/onepassword-compatibility.json'), '{');
    expect(await onePasswordReleaseCompatibility(malformed)).toBe('unknown');
  });
});

describe('enabling 1Password for existing and future assistants (AE1)', () => {
  it('gives two stopped assistants and a later creation distinct vaults and tokens, and a retry creates nothing', async () => {
    const first = await assistant();
    const second = await assistant();

    const enabled = await enable();

    expect(enabled.account_id).toBe(ACCOUNT_ID);
    expect(enabled.assistants.map((entry) => [entry.instance_id, entry.outcome, entry.changed])).toEqual(
      [first, second]
        .map((runtime) => [runtime.instance_id, 'ready', true])
        .sort(([left], [right]) => String(left).localeCompare(String(right))),
    );
    // One management account creates vaults; each assistant has its own vault and runtime account.
    const management = [...provider.serviceAccounts.values()].filter((account) => account.access === 'create_vaults');
    expect(management).toHaveLength(1);
    expect(enabled.management_service_account_id).toBe(management[0].id);
    expect(provider.vaults.size).toBe(2);
    const records = [await resourcesOf(first), await resourcesOf(second)];
    expect(new Set(records.map((record) => record?.vault.id)).size).toBe(2);
    expect(new Set(records.map((record) => record?.runtimeServiceAccountId)).size).toBe(2);
    for (const [index, runtime] of [first, second].entries()) {
      const record = records[index]!;
      const vault = provider.vaults.get(record.vault.id)!;
      expect(vault.creator).toBe(management[0].id);
      expect(vault.name).toBe(`Assistant aya.${runtime.instance_id.slice(0, 8)}@example.test`);
      // The operator manages the vault the management account created, which minting needs.
      expect(vault.grants.get(OPERATOR_USER_ID)).toBe('allow_managing');
      expect(record).toEqual({
        schemaVersion: 1,
        instanceId: runtime.instance_id,
        accountId: ACCOUNT_ID,
        vault: { id: vault.id, createdBy: { kind: 'management_service_account', serviceAccountId: management[0].id } },
        operatorGrant: { userId: OPERATOR_USER_ID, permissions: ['allow_managing'] },
        runtimeServiceAccountId: record.runtimeServiceAccountId,
      });
      const runtimeAccount = provider.serviceAccounts.get(record.runtimeServiceAccountId!)!;
      expect(runtimeAccount.access).toBe(vault.id);
      expect(await runtimeToken(runtime)).toBe(runtimeAccount.token);
      const tokenFile = onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile;
      expect((await stat(tokenFile)).mode & 0o777).toBe(0o600);
      expect((await stat(path.dirname(tokenFile))).mode & 0o777).toBe(0o700);
      // The host finds the shared policy through its locator, under these custom roots.
      expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
        `GWS_EA_ONEPASSWORD_POLICY_FILE=${onePasswordHostPaths(paths.configRoot).policyFile}\n`,
      );
      // No Chrome or service: the browser's own switch stays untouched.
      expect(await exists(path.join(runtime.instance_root, 'browser'))).toBe(false);
    }
    const hostPaths = onePasswordHostPaths(paths.configRoot);
    expect(await readOnePasswordHostPolicy(hostPaths.policyFile)).toEqual({
      status: 'ready',
      paths: hostPaths,
      policy: { schemaVersion: 1, accountId: ACCOUNT_ID, cliPath: OP, managementServiceAccountId: management[0].id },
    });
    expect((await readFile(hostPaths.managementTokenFile, 'utf8')).trim()).toBe(management[0].token);
    expect((await stat(hostPaths.managementTokenFile)).mode & 0o777).toBe(0o600);
    // Only the 1Password CLI ran.
    expect(provider.calls.every((call) => call.command === OP)).toBe(true);

    // A retry observes everything recorded and creates nothing again.
    const accounts = provider.serviceAccounts.size;
    const callsBefore = provider.calls.length;
    const again = await enable();
    expect(again.assistants.map((entry) => [entry.outcome, entry.changed])).toEqual([
      ['ready', false],
      ['ready', false],
    ]);
    expect(provider.vaults.size).toBe(2);
    expect(provider.serviceAccounts.size).toBe(accounts);
    // A ready assistant costs no request: only the operator and management identities are verified.
    expect(provider.calls.slice(callsBefore).map((call) => call.args.slice(0, 1).join(' '))).toEqual([
      'whoami',
      'whoami',
    ]);

    // A third assistant inherits provisioning during its operator-led creation.
    const third = await assistant();
    const created = await withInstanceOperation(paths, third.instance_id, (operation) =>
      provisionAssistantVault(operation, dependencies()),
    );
    expect(created).toMatchObject({ instance_id: third.instance_id, outcome: 'ready', changed: true });
    const thirdRecord = await resourcesOf(third);
    expect(provider.vaults.size).toBe(3);
    expect(records.map((record) => record?.vault.id)).not.toContain(thirdRecord?.vault.id);
    expect(await runtimeToken(third)).not.toBe(await runtimeToken(first));
    const resumed = await withInstanceOperation(paths, third.instance_id, (operation) =>
      provisionAssistantVault(operation, dependencies()),
    );
    expect(resumed).toMatchObject({ outcome: 'ready', changed: false });
    expect(provider.vaults.size).toBe(3);

    // No token reaches a result.
    const serialized = JSON.stringify([enabled, again, created, resumed]);
    for (const token of provider.tokens) expect(serialized).not.toContain(token);
  });

  it('does nothing at creation while 1Password is not enabled on this host', async () => {
    const runtime = await assistant();
    const result = await withInstanceOperation(paths, runtime.instance_id, (operation) =>
      provisionAssistantVault(operation, dependencies()),
    );
    expect(result).toBeUndefined();
    expect(provider.calls).toEqual([]);
    expect(await exists(onePasswordInstancePaths(runtime.instance_root).resourceFile)).toBe(false);
  });

  it('reports an incompatible release and an unfinished creation, leaving both untouched', async () => {
    const compatible = await assistant();
    const old = await assistant({ compatible: false });
    const unfinishedId = randomUUID();
    const unfinished = await reserveInstance(paths, {
      instance_id: unfinishedId,
      release_track: 'dogfood',
      source_remote: 'https://example.test/ea.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { onecli_app: 36_100, onecli_gateway: 36_101 },
      exclusive_resource_claims: {
        ...deriveGcpClaims(unfinishedId),
        gcp_account: 'operator@example.test',
        workspace_email: 'remy@example.test',
        onecli_project: `gws-ea-${unfinishedId.replaceAll('-', '')}`,
      },
    });

    const enabled = await enable();

    const outcome = (id: string) => enabled.assistants.find((entry) => entry.instance_id === id);
    expect(outcome(compatible.instance_id)).toMatchObject({ outcome: 'ready' });
    expect(outcome(old.instance_id)).toMatchObject({
      outcome: 'skipped',
      reason: 'release_unsupported',
      changed: false,
    });
    expect(outcome(unfinished.instance_id)).toMatchObject({ outcome: 'skipped', reason: 'not_created' });
    expect(provider.vaults.size).toBe(1);
    expect(await exists(onePasswordInstancePaths(old.instance_root).resourceFile)).toBe(false);
    expect(await readFile(path.join(old.state_root, '.env'), 'utf8')).not.toContain('GWS_EA_ONEPASSWORD_POLICY_FILE');
    expect(onePasswordEnableNextActions(enabled)).toEqual(
      expect.arrayContaining([
        { kind: 'command', argv: ['gws-ea', 'update', '--id', old.instance_id] },
        { kind: 'command', argv: ['gws-ea', 'resume', '--id', unfinished.instance_id] },
      ]),
    );
  });

  it('keeps the first assistant ready when sign-in expires during the second, and resumes only what is incomplete', async () => {
    const [first, second] = [await assistant(), await assistant()].sort((left, right) =>
      left.instance_id.localeCompare(right.instance_id),
    );
    // The operator's desktop session ends right after the first runtime account is minted.
    provider.after = (args) => {
      if (args[0] === 'service-account' && args[1] === 'create' && args.includes('--vault')) provider.signedIn = false;
    };

    const partial = await enable();

    expect(partial.assistants.map((entry) => [entry.instance_id, entry.outcome, entry.reason])).toEqual([
      [first.instance_id, 'ready', null],
      [second.instance_id, 'pending', 'sign_in_required'],
    ]);
    // The second vault exists and is recorded; only its runtime account is missing.
    expect((await resourcesOf(second))?.runtimeServiceAccountId).toBeNull();
    expect(provider.vaults.size).toBe(2);
    expect(onePasswordEnableNextActions(partial)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'capabilities', 'enable', 'onepassword'],
    });

    provider.after = undefined;
    provider.signedIn = true;
    const firstRecord = await resourcesOf(first);
    const callsBefore = provider.calls.length;
    const resumed = await enable(undefined, {});
    expect(resumed.assistants.map((entry) => entry.outcome)).toEqual(['ready', 'ready']);
    expect(provider.vaults.size).toBe(2);
    expect(await resourcesOf(first)).toEqual(firstRecord);
    // Nothing touched the first assistant's resources; the second got only its runtime account.
    const resumedCalls = provider.calls.slice(callsBefore).map((call) => call.args.join(' '));
    expect(resumedCalls.filter((call) => call.includes(firstRecord!.vault.id))).toEqual([]);
    expect(resumedCalls.filter((call) => call.startsWith('vault create'))).toEqual([]);
    expect(resumedCalls.filter((call) => call.startsWith('service-account create'))).toHaveLength(1);
  });

  it('pauses on a busy assistant and finishes it on a retry', async () => {
    const [free, busy] = [await assistant(), await assistant()].sort((left, right) =>
      left.instance_id.localeCompare(right.instance_id),
    );
    await mkdir(path.dirname(paths.instanceLock(busy.instance_id)), { recursive: true, mode: 0o700 });
    const release = await processLock(paths.instanceLock(busy.instance_id));
    if (!release) throw new Error('The lock was not free');
    let blocked;
    try {
      blocked = await enable();
    } finally {
      release();
    }
    expect(blocked.assistants.map((entry) => [entry.instance_id, entry.outcome, entry.reason])).toEqual([
      [free.instance_id, 'ready', null],
      [busy.instance_id, 'pending', 'instance_busy'],
    ]);
    expect(await exists(onePasswordInstancePaths(busy.instance_root).resourceFile)).toBe(false);
    expect((await enable()).assistants.map((entry) => entry.outcome)).toEqual(['ready', 'ready']);
  });

  it("stops spending requests once 1Password's limit is spent, leaving the rest for a later retry", async () => {
    await assistant();
    await assistant();
    provider.before = (args) =>
      args[0] === 'vault' && args[1] === 'create'
        ? { exitCode: 1, stderr: "[ERROR] (429) Too Many Requests: You've reached the maximum number of requests" }
        : undefined;
    const limited = await enable();
    expect(limited.assistants.map((entry) => [entry.outcome, entry.reason])).toEqual([
      ['pending', 'rate_limited'],
      ['pending', 'rate_limited'],
    ]);
    // One refused creation, and no request at all for the second assistant.
    expect(provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'create')).toHaveLength(1);

    provider.before = undefined;
    expect((await enable()).assistants.map((entry) => entry.outcome)).toEqual(['ready', 'ready']);
    expect(provider.vaults.size).toBe(2);
  });

  it('refuses a second enable while one holds the host', async () => {
    await mkdir(paths.configRoot, { recursive: true, mode: 0o700 });
    const release = await processLock(path.join(paths.configRoot, 'onepassword.lock'));
    if (!release) throw new Error('The lock was not free');
    try {
      await expect(enable()).rejects.toMatchObject({ code: 'onepassword_busy' });
    } finally {
      release();
    }
    expect(provider.serviceAccounts.size).toBe(0);
  });
});

describe('recovering an interrupted enable', () => {
  it('reuses a vault recorded before a crash, and never creates a second', async () => {
    const runtime = await assistant();
    // This process dies after the vault was recorded, while granting the operator its management rights.
    provider.after = (args) => {
      if (args.join(' ').startsWith('vault user grant')) throw new Error('The process was killed');
    };
    await expect(enable()).rejects.toThrow('The process was killed');
    const recorded = await resourcesOf(runtime);
    expect(recorded).toMatchObject({ operatorGrant: null, runtimeServiceAccountId: null });

    provider.after = undefined;
    const resumed = await enable();
    expect(resumed.assistants[0]).toMatchObject({ outcome: 'ready', vault_id: recorded?.vault.id });
    expect(provider.vaults.size).toBe(1);
  });

  it('pauses on a vault creation whose outcome is unknown until the operator clears it', async () => {
    const runtime = await assistant();
    // The provider created the vault, but the call was cut off before its answer arrived.
    provider.after = (args) => {
      if (args[0] === 'vault' && args[1] === 'create') {
        provider.after = undefined;
        throw new GwsEaError('command_timeout', 'Command timed out after 60.0s');
      }
    };
    const unproven = await enable();
    expect(unproven.assistants[0]).toMatchObject({ outcome: 'pending', reason: 'vault_creation_unproven' });
    expect(unproven.assistants[0].message).toContain(`Assistant aya.${runtime.instance_id.slice(0, 8)}@example.test`);
    expect(onePasswordEnableNextActions(unproven)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'capabilities', 'enable', 'onepassword', '--discard-unproven', runtime.instance_id],
    });

    // A retry never creates another vault while the first may exist.
    expect((await enable()).assistants[0]).toMatchObject({ reason: 'vault_creation_unproven' });
    expect(provider.vaults.size).toBe(1);

    // The operator deletes the stray vault in 1Password, then clears the attempt.
    provider.vaults.clear();
    const cleared = await enableOnePassword(
      paths,
      { accountId: ACCOUNT_ID, discardUnproven: runtime.instance_id },
      dependencies(),
    );
    expect(cleared.assistants[0]).toMatchObject({ outcome: 'ready' });
    expect(provider.vaults.size).toBe(1);
  });

  it('recovers a runtime token captured before a crash without minting another', async () => {
    const runtime = await assistant();
    // The token was captured; this process died verifying it.
    let crashed = false;
    provider.before = (args) => {
      if (!crashed && args.join(' ') === 'whoami --format json' && provider.serviceAccounts.size === 2) {
        crashed = true;
        throw new Error('The process was killed');
      }
      return undefined;
    };
    await expect(enable()).rejects.toThrow('The process was killed');
    expect((await resourcesOf(runtime))?.runtimeServiceAccountId).toBeNull();

    provider.before = undefined;
    const resumed = await enable();
    expect(resumed.assistants[0]).toMatchObject({ outcome: 'ready' });
    expect(provider.serviceAccounts.size).toBe(2);
    expect((await resourcesOf(runtime))?.runtimeServiceAccountId).toBe(
      [...provider.serviceAccounts.values()].find((account) => account.access !== 'create_vaults')?.id,
    );
  });

  it('pauses on a runtime account whose creation is unproven, never minting again until the operator revokes it', async () => {
    const runtime = await assistant();
    provider.after = (args) => {
      if (args[0] === 'service-account' && args.includes('--vault')) {
        provider.after = undefined;
        throw new GwsEaError('command_timeout', 'Command timed out after 120.0s');
      }
    };
    const unproven = await enable();
    expect(unproven.assistants[0]).toMatchObject({ outcome: 'pending', reason: 'service_account_creation_unproven' });
    expect(provider.serviceAccounts.size).toBe(2);
    expect((await enable()).assistants[0]).toMatchObject({ reason: 'service_account_creation_unproven' });
    expect(provider.serviceAccounts.size).toBe(2);

    // The operator revokes the unproven account on 1Password.com, then clears the attempt.
    const stray = [...provider.serviceAccounts.values()].find((account) => account.access !== 'create_vaults')!;
    provider.serviceAccounts.delete(stray.id);
    const cleared = await enableOnePassword(
      paths,
      { accountId: ACCOUNT_ID, discardUnproven: runtime.instance_id },
      dependencies(),
    );
    expect(cleared.assistants[0]).toMatchObject({ outcome: 'ready' });
    expect(provider.serviceAccounts.size).toBe(2);
  });

  it('pauses on an unproven management account and recovers once the operator clears it', async () => {
    await assistant();
    provider.after = (args) => {
      if (args.includes('--can-create-vaults')) {
        provider.after = undefined;
        throw new GwsEaError('command_timeout', 'Command timed out after 120.0s');
      }
    };
    await expect(enable()).rejects.toMatchObject({ code: 'onepassword_management_unproven' });
    await expect(enable()).rejects.toMatchObject({ code: 'onepassword_management_unproven' });
    expect(provider.serviceAccounts.size).toBe(1);
    expect(await exists(onePasswordHostPaths(paths.configRoot).policyFile)).toBe(false);

    provider.serviceAccounts.clear();
    const cleared = await enableOnePassword(
      paths,
      { accountId: ACCOUNT_ID, discardUnproven: 'management' },
      dependencies(),
    );
    expect(cleared.assistants[0]).toMatchObject({ outcome: 'ready' });
    expect(provider.serviceAccounts.size).toBe(2);
  });

  it('keeps a minted token it could not verify, offering a retry and, failing that, the discard', async () => {
    const runtime = await assistant();
    provider.before = (args) =>
      args[0] === 'vault' && args[1] === 'get'
        ? { exitCode: 1, stderr: '[ERROR] the service could not answer' }
        : undefined;
    const unverified = await enable();
    expect(unverified.assistants[0]).toMatchObject({ outcome: 'pending', reason: 'runtime_unverified' });
    expect(onePasswordEnableNextActions(unverified)).toEqual(
      expect.arrayContaining([
        { kind: 'command', argv: ['gws-ea', 'capabilities', 'enable', 'onepassword'] },
        {
          kind: 'command',
          argv: ['gws-ea', 'capabilities', 'enable', 'onepassword', '--discard-unproven', runtime.instance_id],
        },
      ]),
    );
    provider.before = undefined;
    const accounts = provider.serviceAccounts.size;
    expect((await enable()).assistants[0]).toMatchObject({ outcome: 'ready' });
    // The kept token was verified, never minted again.
    expect(provider.serviceAccounts.size).toBe(accounts);
  });

  it('refuses a captured management token from another account until the operator clears it', async () => {
    await assistant();
    // An earlier enable captured a management token, but this host's policy was never written.
    const hostPaths = onePasswordHostPaths(paths.configRoot);
    await mkdir(hostPaths.directory, { recursive: true, mode: 0o700 });
    await writeFile(hostPaths.managementTokenFile, 'ops_from_another_account_0000000000\n', { mode: 0o600 });
    provider.before = (args) =>
      args.join(' ') === 'whoami --format json'
        ? {
            stdout: JSON.stringify({
              account_uuid: OTHER_ACCOUNT_ID,
              user_uuid: OPERATOR_USER_ID,
              user_type: 'SERVICE_ACCOUNT',
            }),
          }
        : undefined;
    await expect(enable()).rejects.toMatchObject({ code: 'onepassword_management_unproven' });
    provider.before = undefined;
    const cleared = await enableOnePassword(
      paths,
      { accountId: ACCOUNT_ID, discardUnproven: 'management' },
      dependencies(),
    );
    expect(cleared.assistants[0]).toMatchObject({ outcome: 'ready' });
  });

  it('refuses to discard an attempt that is not unproven', async () => {
    const runtime = await assistant();
    await enable();
    await expect(
      enableOnePassword(paths, { discardUnproven: runtime.instance_id }, dependencies()),
    ).rejects.toMatchObject({ code: 'onepassword_nothing_unproven' });
    await expect(enableOnePassword(paths, { discardUnproven: 'management' }, dependencies())).rejects.toMatchObject({
      code: 'onepassword_nothing_unproven',
    });
    expect((await resourcesOf(runtime))?.runtimeServiceAccountId).not.toBeNull();
  });
});

describe('choosing the 1Password account', () => {
  it('requires an explicit account without a prompt, naming each one the operator holds', async () => {
    await assistant();
    const error = await enable(undefined, {}).catch((caught: unknown) => caught);
    expect(error).toMatchObject({
      code: 'onepassword_account_required',
      details: { accounts: [ACCOUNT_ID], account_labels: ['morgan@example.test on hale.1password.com'] },
    });
    expect(provider.vaults.size).toBe(0);
  });

  it('asks a terminal operator to choose, and keeps that account', async () => {
    await assistant();
    const offered: string[] = [];
    const enabled = await enable(
      {
        chooseAccount: async (accounts) => {
          offered.push(...accounts.map((account) => account.accountId));
          return accounts[0].accountId;
        },
      },
      {},
    );
    expect(offered).toEqual([ACCOUNT_ID]);
    expect(enabled.account_id).toBe(ACCOUNT_ID);
    await expect(enable(undefined, { accountId: OTHER_ACCOUNT_ID })).rejects.toMatchObject({
      code: 'onepassword_account_mismatch',
    });
  });

  it('pauses for the desktop sign-in before anything is created', async () => {
    await assistant();
    provider.signedIn = false;
    await expect(enable()).rejects.toMatchObject({ code: 'onepassword_sign_in_required' });
    expect(provider.serviceAccounts.size).toBe(0);
    expect(await exists(onePasswordHostPaths(paths.configRoot).policyFile)).toBe(false);
  });

  it('refuses a missing or outdated CLI before anything else', async () => {
    await expect(
      enableOnePassword(paths, { accountId: ACCOUNT_ID }, dependencies({ cli: { searchPath: root } })),
    ).rejects.toMatchObject({ code: 'onepassword_cli_missing' });
    await expect(
      enableOnePassword(
        paths,
        { accountId: ACCOUNT_ID },
        dependencies({
          cli: {
            resolve: async () => OP,
            runCommand: async () => ({ stdout: '2.28.0\n', stderr: '', exitCode: 0 }),
          },
        }),
      ),
    ).rejects.toMatchObject({ code: 'onepassword_cli_too_old' });
    await expect(readdir(paths.configRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe('1Password readiness (AE8)', () => {
  it('shows recorded facts without a provider request', async () => {
    const runtime = await assistant();
    const before = await inspectOnePasswordCapability(paths, dependencies());
    expect(before).toMatchObject({ activation: { status: 'disabled' }, quota: { status: 'not_checked' } });
    expect(before.assistants).toEqual([
      expect.objectContaining({
        instance_id: runtime.instance_id,
        compatibility: 'compatible',
        provisioning: 'absent',
      }),
    ]);
    expect(onePasswordNextActions(before, false)).toEqual([
      { kind: 'command', argv: ['gws-ea', 'capabilities', 'enable', 'onepassword'] },
    ]);

    await enable();
    const calls = provider.calls.length;
    const shown = await inspectOnePasswordCapability(paths, dependencies());
    expect(provider.calls.length).toBe(calls);
    expect(shown.assistants[0]).toMatchObject({
      provisioning: 'ready',
      runtime_token: 'present',
      access: { status: 'not_checked' },
      write: 'untested',
    });
  });

  it('names the account type, its daily limit, every assistant sharing it and the current usage', async () => {
    const runtimes = [await assistant(), await assistant(), await assistant()];
    await enable();
    const used = provider.used;

    const checked = await inspectOnePasswordCapability(paths, { ...dependencies(), check: true });

    const ids = runtimes.map((runtime) => runtime.instance_id).sort();
    expect(checked.quota).toEqual({
      status: 'observed',
      account_type: 'families',
      sharing_assistant_ids: ids,
      // The check's own requests up to the usage lookup count too.
      daily: { limit: 1000, used: used + 3, remaining: 1000 - used - 3 },
      hourly_per_token: { read: 1000, write: 100 },
      reason: null,
    });
    expect(checked.management).toMatchObject({ status: 'verified', token: 'present' });
    for (const assistantReadiness of checked.assistants)
      expect(assistantReadiness).toMatchObject({
        provisioning: 'ready',
        access: { status: 'verified', reason: null },
        recorded_grants: {
          operator: { user_id: OPERATOR_USER_ID, permissions: ['allow_managing'] },
          runtime: ['read_items', 'write_items'],
        },
        write: 'untested',
      });
    const lines = onePasswordCapabilityLines(checked, true, 'America/Los_Angeles').join('\n');
    expect(lines).toContain('Account type: families');
    expect(lines).toContain(`Daily requests: ${used + 3} of 1000 used`);
    expect(lines).toContain(`Shared by: ${ids.join(', ')}`);
    expect(lines).toContain('Write: untested');
    expect(JSON.stringify(checked)).not.toMatch(/ops_/u);
  });

  it('reports a failed usage lookup as unknown, never as zero', async () => {
    await assistant();
    await enable();
    provider.rateLimitFails = true;
    const checked = await inspectOnePasswordCapability(paths, { ...dependencies(), check: true });
    expect(checked.quota).toMatchObject({ status: 'unknown', daily: null, hourly_per_token: null });
    expect(checked.quota.reason).toContain('unknown');
    expect(onePasswordCapabilityLines(checked, false).join('\n')).toContain('Daily requests: unknown');
  });

  it("stops checking once 1Password's limit is spent, reporting the rest as not checked", async () => {
    await assistant();
    await assistant();
    await enable();
    const calls = provider.calls.length;
    provider.before = (args) =>
      args.join(' ') === 'whoami --format json'
        ? { exitCode: 1, stderr: '[ERROR] (429) Too Many Requests' }
        : undefined;
    const checked = await inspectOnePasswordCapability(paths, { ...dependencies(), check: true });
    expect(checked.management).toMatchObject({ status: 'failed' });
    expect(checked.quota).toMatchObject({ status: 'unknown', daily: null });
    expect(checked.assistants.map((entry) => entry.access.status)).toEqual(['not_checked', 'not_checked']);
    // The first refusal ends the check's requests.
    expect(provider.calls.length - calls).toBe(1);
  });

  it('reports usage as unknown when the recorded CLI is gone', async () => {
    await assistant();
    await enable();
    const checked = await inspectOnePasswordCapability(paths, {
      check: true,
      cli: { ...provider.cli(), resolve: async () => Promise.reject(new GwsEaError('executable_not_found', 'gone')) },
    });
    expect(checked.cli).toMatchObject({ status: 'unavailable' });
    expect(checked.quota).toMatchObject({ status: 'unknown', daily: null });
    expect(onePasswordNextActions(checked, true)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'capabilities', 'enable', 'onepassword'],
    });
  });

  it('reports a revoked runtime account as failed access', async () => {
    const runtime = await assistant();
    await enable();
    const record = await resourcesOf(runtime);
    provider.serviceAccounts.delete(record!.runtimeServiceAccountId!);
    const checked = await inspectOnePasswordCapability(paths, { ...dependencies(), check: true });
    expect(checked.assistants[0]).toMatchObject({ provisioning: 'ready', access: { status: 'failed' } });
  });
});

describe('the native 1Password capability commands', () => {
  async function run(args: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(args, {
      paths,
      environment: { PATH: '/usr/bin:/bin' },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      onePassword: dependencies().cli,
      upsertEnvVars,
    });
    return { code, stdout: stdout.join('\n'), stderr: stderr.join('\n') };
  }

  /** Every file under `directory`, as text. */
  async function treeText(directory: string): Promise<string> {
    const entries = await readdir(directory, { recursive: true, withFileTypes: true });
    const files = entries.filter((entry) => entry.isFile());
    return (await Promise.all(files.map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')))).join(
      '\n',
    );
  }

  it('enables, checks and lists through the published result contracts, with no token in any output or log', async () => {
    const runtime = await assistant();

    const enabled = await run(['capabilities', 'enable', 'onepassword', '--account', ACCOUNT_ID, '--json']);
    expect(enabled.code).toBe(0);
    const result = JSON.parse(enabled.stdout) as Record<string, unknown>;
    expectResultContract('capabilities enable onepassword', result);
    expect(result).toMatchObject({
      outcome: 'succeeded',
      changed: true,
      data: { account_id: ACCOUNT_ID, assistants: [{ instance_id: runtime.instance_id, outcome: 'ready' }] },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'capabilities', 'check', 'onepassword'] }],
    });

    const checked = await run(['capabilities', 'check', 'onepassword', '--json']);
    expect(checked.code).toBe(0);
    expectResultContract('capabilities check onepassword', JSON.parse(checked.stdout));
    const listed = await run(['capabilities', 'list', '--json']);
    expectResultContract('capabilities list', JSON.parse(listed.stdout));
    expect(JSON.parse(listed.stdout)).toMatchObject({
      data: { capabilities: [{ name: 'voice' }, { name: 'browser' }, { name: 'onepassword', activation: 'enabled' }] },
    });
    const human = await run(['capabilities', 'check', 'onepassword']);
    expect(human.stdout).toContain('Account type: families');

    const again = await run(['capabilities', 'enable', 'onepassword', '--json']);
    expect(JSON.parse(again.stdout)).toMatchObject({ outcome: 'succeeded', changed: false });

    const everything = [enabled, checked, listed, human, again]
      .map((output) => output.stdout + output.stderr)
      .join('\n');
    const logs = await treeText(paths.logsRoot);
    expect(provider.tokens).toHaveLength(2);
    for (const token of provider.tokens) {
      expect(everything).not.toContain(token);
      expect(logs).not.toContain(token);
    }
  });

  it('pauses a partial enable with exit 10 and the step that continues it', async () => {
    await assistant();
    provider.after = (args) => {
      if (args[0] === 'service-account' && args.includes('--vault')) provider.signedIn = false;
    };
    await assistant();
    const partial = await run(['capabilities', 'enable', 'onepassword', '--account', ACCOUNT_ID, '--json']);
    expect(partial.code).toBe(10);
    const result = JSON.parse(partial.stdout) as { next_actions: unknown[] };
    expectResultContract('capabilities enable onepassword', result);
    expect(result).toMatchObject({ outcome: 'paused', changed: true });
    expect(result.next_actions).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'capabilities', 'enable', 'onepassword'],
    });
  });

  it('pauses for an explicit account without prompting, offering one command per account', async () => {
    await assistant();
    const paused = await run(['capabilities', 'enable', 'onepassword', '--json']);
    expect(paused.code).toBe(10);
    const result = JSON.parse(paused.stdout) as Record<string, unknown>;
    expectResultContract('capabilities enable onepassword', result);
    expect(result).toMatchObject({
      outcome: 'paused',
      changed: false,
      error: { code: 'onepassword_account_required' },
    });
    expect(result.next_actions).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'capabilities', 'enable', 'onepassword', '--account', ACCOUNT_ID],
    });
    const invalid = await run(['capabilities', 'enable', 'onepassword', '--account', 'hale.1password.com']);
    expect(invalid.code).toBe(2);
  });

  it('reports a missing CLI as a failure naming the installation, before any state changes', async () => {
    const stdout: string[] = [];
    const code = await runCli(['capabilities', 'enable', 'onepassword', '--account', ACCOUNT_ID, '--json'], {
      paths,
      environment: { PATH: root },
      stdout: (line) => stdout.push(line),
      stderr: () => undefined,
      upsertEnvVars,
    });
    expect(code).toBe(1);
    const result = JSON.parse(stdout.join('\n')) as Record<string, unknown>;
    expectResultContract('capabilities enable onepassword', result);
    expect(result).toMatchObject({ outcome: 'failed', changed: false, error: { code: 'onepassword_cli_missing' } });
    expect(await exists(onePasswordHostPaths(paths.configRoot).directory)).toBe(false);
  });
});
