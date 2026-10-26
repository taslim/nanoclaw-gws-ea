import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { processLock } from '../community-portal/process-lock.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { inspectConnector } from './connector-inspection.js';
import type { InteractivePrompts } from './events.js';
import { captureOnePasswordCleanup } from './onepassword-removal.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { readRegistry } from './registry.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import {
  installOnePassword,
  inspectOnePasswordCapability,
  onePasswordEnabled,
  onePasswordCapabilityLines,
  onePasswordInstallNextActions,
  onePasswordCapabilityNextActions,
  onePasswordRecovery,
  onePasswordReleaseCompatibility,
  ONEPASSWORD_CONTRACT,
  provisionAssistantVault,
  type OnePasswordDependencies,
  type OnePasswordInstallRequest,
} from './onepassword.js';
import {
  inspectOnePasswordUninstall,
  onePasswordUninstallFile,
  previewOnePasswordUninstall,
  uninstallOnePassword,
} from './onepassword-uninstall.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  createInstanceRuntimeConfig,
  persistInstanceRuntime,
  type InstanceRuntimeConfig,
  type UpsertEnvVars,
} from './service.js';
import {
  ACCOUNT_ID,
  FakeOnePassword,
  OP,
  OPERATOR_USER_ID,
  OTHER_ACCOUNT_ID,
  providerId,
} from './testing/onepassword-fixture.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError } from './types.js';
import * as secrets from './secrets.js';

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
  vi.restoreAllMocks();
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
  request: OnePasswordInstallRequest = { accountId: ACCOUNT_ID },
) {
  return installOnePassword(paths, request, dependencies(overrides));
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

describe('1Password marker validation', () => {
  it.each([
    { marker: {}, expected: 'unknown' },
    { marker: { schemaVersion: 1, contract: 42 }, expected: 'unknown' },
    { marker: { schemaVersion: 1, contract: 'gws-ea-onepassword-vault-2' }, expected: 'unsupported' },
    { marker: { schemaVersion: 2, contract: ONEPASSWORD_CONTRACT }, expected: 'unsupported' },
  ])('distinguishes a malformed marker from a valid unsupported marker: $marker', async ({ marker, expected }) => {
    const release = path.join(root, 'marker-release');
    await mkdir(path.join(release, 'src/gws-ea'), { recursive: true });
    await writeFile(path.join(release, 'src/gws-ea/onepassword-compatibility.json'), JSON.stringify(marker));
    expect(await onePasswordReleaseCompatibility(release)).toBe(expected);
  });
});

describe('installing 1Password for existing and future assistants', () => {
  it('leaves a new vault pending without touching the operator sign-in when no terminal is present', async () => {
    await enable();
    const runtime = await assistant();
    provider.calls.length = 0;
    const result = await withInstanceOperation(paths, runtime.instance_id, (operation) =>
      provisionAssistantVault(operation, {
        ...dependencies(),
        operatorTerminal: false,
        cli: {
          ...provider.cli(),
          runCommand: async () => {
            throw new Error('op must not run without an operator terminal');
          },
        },
      }),
    );
    expect(result).toMatchObject({ outcome: 'pending', reason: 'operator_sign_in_needed' });
    expect(provider.calls).toEqual([]);
    expect(provider.vaults.size).toBe(0);
  });

  it('leaves provisioning pending while the connector host lock is held', async () => {
    await enable();
    const runtime = await assistant();
    const release = await processLock(path.join(paths.configRoot, 'onepassword.lock'));
    if (!release) throw new Error('The test did not acquire the host lock');
    provider.calls.length = 0;
    try {
      const result = await withInstanceOperation(paths, runtime.instance_id, (operation) =>
        provisionAssistantVault(operation, dependencies()),
      );
      expect(result).toMatchObject({ outcome: 'pending', reason: 'onepassword_busy', changed: false });
      expect(provider.calls).toEqual([]);
    } finally {
      release();
    }
  });

  it('keeps existing ready bindings without an operator terminal and shares a rate limit across hooks', async () => {
    const ready = await assistant();
    await enable();
    const record = await resourcesOf(ready);
    const neverOpens = {
      ...provider.cli(),
      runCommand: async () => {
        throw new Error('A ready binding must not launch op');
      },
    };
    const alreadyReady = await withInstanceOperation(paths, ready.instance_id, (operation) =>
      provisionAssistantVault(operation, { ...dependencies(), operatorTerminal: false, cli: neverOpens }),
    );
    expect(alreadyReady).toMatchObject({ outcome: 'ready', vault_id: record?.vault.id, changed: false });
    const first = await assistant();
    const second = await assistant();
    const state = { limited: false };
    provider.before = () => ({ exitCode: 1, stderr: '[ERROR] (429) Too Many Requests' });
    const limited = await withInstanceOperation(paths, first.instance_id, (operation) =>
      provisionAssistantVault(operation, { ...dependencies(), operatorTerminal: true, rateLimitState: state }),
    );
    expect(limited).toMatchObject({ outcome: 'pending', reason: 'rate_limited' });
    expect(state.limited).toBe(true);
    provider.calls.length = 0;
    const skipped = await withInstanceOperation(paths, second.instance_id, (operation) =>
      provisionAssistantVault(operation, {
        ...dependencies(),
        operatorTerminal: true,
        rateLimitState: state,
        cli: neverOpens,
      }),
    );
    expect(skipped).toMatchObject({ outcome: 'pending', reason: 'rate_limited', changed: false });
    expect(provider.calls).toEqual([]);
  });

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
      expect(vault.grants.get(OPERATOR_USER_ID)).toBe('allow_viewing,allow_editing,allow_managing');
      expect(record).toEqual({
        schemaVersion: 2,
        instanceId: runtime.instance_id,
        accountId: ACCOUNT_ID,
        vault: { id: vault.id, createdBy: { kind: 'management_service_account', serviceAccountId: management[0].id } },
        operatorGrant: { userId: OPERATOR_USER_ID, permissions: ['allow_viewing', 'allow_editing', 'allow_managing'] },
        runtimeServiceAccountId: record.runtimeServiceAccountId,
        retiredRuntimeServiceAccountIds: [],
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
      policy: {
        schemaVersion: 2,
        enabled: true,
        accountId: ACCOUNT_ID,
        // As the 1Password app lists the account: where its members open it on the web.
        signInAddress: 'hale.1password.com',
        cliPath: OP,
        managementServiceAccountId: management[0].id,
      },
    });
    expect((await readFile(hostPaths.managementTokenFile, 'utf8')).trim()).toBe(management[0].token);
    expect((await stat(hostPaths.managementTokenFile)).mode & 0o777).toBe(0o600);
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
    // A ready assistant costs no request: the app's own account list gives the sign-in address again, and only the
    // operator and management identities are verified.
    expect(provider.calls.slice(callsBefore).map((call) => call.args.slice(0, 2).join(' '))).toEqual([
      'account list',
      'whoami --format',
      'whoami --format',
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
    expect(onePasswordInstallNextActions(enabled)).toEqual(
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
    expect(onePasswordInstallNextActions(partial)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', 'onepassword'],
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
    expect(onePasswordInstallNextActions(unproven)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', 'onepassword', '--discard-unproven', runtime.instance_id],
    });

    // A retry never creates another vault while the first may exist.
    expect((await enable()).assistants[0]).toMatchObject({ reason: 'vault_creation_unproven' });
    expect(provider.vaults.size).toBe(1);

    // The operator deletes the stray vault in 1Password, then clears the attempt.
    provider.vaults.clear();
    const cleared = await installOnePassword(
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
    const cleared = await installOnePassword(
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
    const cleared = await installOnePassword(
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
    expect(onePasswordInstallNextActions(unverified)).toEqual(
      expect.arrayContaining([
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
        {
          kind: 'command',
          argv: ['gws-ea', 'connectors', 'install', 'onepassword', '--discard-unproven', runtime.instance_id],
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
    const cleared = await installOnePassword(
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
      installOnePassword(paths, { discardUnproven: runtime.instance_id }, dependencies()),
    ).rejects.toMatchObject({ code: 'onepassword_nothing_unproven' });
    await expect(installOnePassword(paths, { discardUnproven: 'management' }, dependencies())).rejects.toMatchObject({
      code: 'onepassword_nothing_unproven',
    });
    expect((await resourcesOf(runtime))?.runtimeServiceAccountId).not.toBeNull();
  });
});

describe('pausing on an assistant record enable cannot build on', () => {
  it('pauses on a recorded runtime account whose token is gone, never minting a replacement over it', async () => {
    const runtime = await assistant();
    await enable();
    const recorded = await resourcesOf(runtime);
    const accounts = provider.serviceAccounts.size;
    // The token was lost after its account was recorded, as a crash or a restored backup can leave it.
    await rm(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile);

    const paused = await enable();

    expect(paused.assistants[0]).toMatchObject({
      outcome: 'pending',
      reason: 'runtime_token_unavailable',
      runtime_service_account_id: recorded?.runtimeServiceAccountId,
    });
    expect(paused.assistants[0].message).toContain(String(recorded?.runtimeServiceAccountId));
    expect(provider.serviceAccounts.size).toBe(accounts);
    expect(await resourcesOf(runtime)).toEqual(recorded);
  });

  it('never adopts a recorded vault that another management account created', async () => {
    const runtime = await assistant();
    const vaultId = providerId('VAULT', 90);
    const creator = providerId('MANAGEMENTOLD', 2);
    provider.vaults.set(vaultId, { id: vaultId, name: 'Assistant', creator, grants: new Map(), items: 0 });
    const record = {
      schemaVersion: 2,
      instanceId: runtime.instance_id,
      accountId: ACCOUNT_ID,
      vault: { id: vaultId, createdBy: { kind: 'management_service_account', serviceAccountId: creator } },
      operatorGrant: null,
      runtimeServiceAccountId: null,
      retiredRuntimeServiceAccountIds: [],
    } as const;
    await writeOnePasswordResources(onePasswordInstancePaths(runtime.instance_root).resourceFile, record);

    const paused = await enable();

    expect(paused.assistants[0]).toMatchObject({ outcome: 'pending', reason: 'vault_not_owned', vault_id: vaultId });
    // Nothing is granted on it and no runtime account is minted for it.
    expect(provider.vaults.get(vaultId)?.grants.size).toBe(0);
    expect([...provider.serviceAccounts.values()].map((account) => account.access)).toEqual(['create_vaults']);
    expect(await resourcesOf(runtime)).toEqual(record);
  });

  it('pauses on a record it cannot read, creating nothing for it', async () => {
    const runtime = await assistant();
    const { resourceFile } = onePasswordInstancePaths(runtime.instance_root);
    await writeFile(resourceFile, '{"schemaVersion": 2,', { mode: 0o600 });

    const paused = await enable();

    expect(paused.assistants[0]).toMatchObject({ outcome: 'pending', reason: 'resources_invalid', vault_id: null });
    expect(paused.assistants[0].message).toContain(resourceFile);
    expect(provider.vaults.size).toBe(0);
    expect(await readFile(resourceFile, 'utf8')).toBe('{"schemaVersion": 2,');
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

  it('records the sign-in address the app lists for exactly that account, and refuses any other', async () => {
    await assistant();
    const hostPaths = onePasswordHostPaths(paths.configRoot);
    // An account the app does not hold, or one it lists without a 1Password sign-in address, creates nothing.
    await expect(enable(undefined, { accountId: OTHER_ACCOUNT_ID })).rejects.toMatchObject({
      code: 'onepassword_account_unknown',
    });
    provider.accounts[0].url = 'hale.example.test';
    await expect(enable()).rejects.toMatchObject({ code: 'onepassword_provider_failed' });
    expect(provider.serviceAccounts.size).toBe(0);
    expect(await exists(hostPaths.policyFile)).toBe(false);

    provider.accounts[0].url = 'https://Hale.1Password.com/';
    await enable();
    expect(await readOnePasswordHostPolicy(hostPaths.policyFile)).toMatchObject({
      status: 'ready',
      policy: { accountId: ACCOUNT_ID, signInAddress: 'hale.1password.com' },
    });
    // A rerun re-reads it for the recorded account, so a changed team address is recorded too.
    provider.accounts[0].url = 'hale-family.1password.com';
    await enable(undefined, {});
    expect(await readOnePasswordHostPolicy(hostPaths.policyFile)).toMatchObject({
      policy: { accountId: ACCOUNT_ID, signInAddress: 'hale-family.1password.com' },
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
      installOnePassword(paths, { accountId: ACCOUNT_ID }, dependencies({ cli: { searchPath: root } })),
    ).rejects.toMatchObject({ code: 'onepassword_cli_missing' });
    await expect(
      installOnePassword(
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

describe('management-account ownership during repair', () => {
  it('names an expired management account and never substitutes a new creator for existing vaults', async () => {
    await assistant();
    await assistant();
    const installed = await enable();
    const management = installed.management_service_account_id;
    const host = onePasswordHostPaths(paths.configRoot);
    const before = await readFile(host.policyFile, 'utf8');
    provider.serviceAccounts.delete(management);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const error = await enable(undefined, {}).catch((caught: unknown) => caught);
      expect(error).toMatchObject({ code: 'onepassword_management_unavailable' });
      const message = error instanceof Error ? error.message : '';
      expect(message).toContain(management);
      expect(message).toContain(host.managementTokenFile);
      expect(onePasswordRecovery(error)).toContainEqual({ kind: 'external', instruction: message });
    }
    expect([...provider.serviceAccounts.values()].filter((account) => account.access === 'create_vaults')).toEqual([]);
    expect(provider.serviceAccounts.size).toBe(2);
    expect(provider.vaults.size).toBe(2);
    expect(await readFile(host.policyFile, 'utf8')).toBe(before);
    expect([...provider.vaults.values()].every((vault) => vault.creator === management)).toBe(true);
  });
});

describe('1Password readiness', () => {
  it.each([false, true])('keeps a malformed runtime local to its assistant when installed=%s', async (installed) => {
    const healthy = await assistant();
    const malformed = await assistant();
    if (installed) await enable();
    await writeFile(paths.runtimeFile(malformed.instance_id), '{');
    const cli = { ...provider.cli(), runCommand: vi.fn(provider.runCommand) };

    const observation = await inspectOnePasswordCapability(paths, { cli });

    expect(observation.assistants).toHaveLength(2);
    expect(observation.assistants.find(({ instance_id }) => instance_id === healthy.instance_id)).toMatchObject({
      compatibility: 'compatible',
      provisioning: installed ? 'ready' : 'absent',
    });
    expect(observation.assistants.find(({ instance_id }) => instance_id === malformed.instance_id)).toMatchObject({
      compatibility: 'unknown',
      access: { status: 'not_checked' },
      reason: expect.stringContaining('runtime'),
    });
    const connector = await inspectConnector(paths, 'onepassword', { onePassword: cli });
    expect(connector.assistants.find(({ instance_id }) => instance_id === malformed.instance_id)).toMatchObject({
      compatibility: 'unknown',
      readiness: { checked: false, status: 'not_checked' },
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'status', '--id', malformed.instance_id] }],
    });
    expect(cli.runCommand).not.toHaveBeenCalled();
  });

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
    expect(onePasswordCapabilityNextActions(before, false)).toEqual([
      { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
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
          operator: { user_id: OPERATOR_USER_ID, permissions: ['allow_viewing', 'allow_editing', 'allow_managing'] },
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

  it('checks only selected reachable runtime accounts while preserving the management check', async () => {
    const selected = await assistant();
    const stopped = await assistant();
    await enable();
    provider.calls.length = 0;
    const filtered = await inspectOnePasswordCapability(paths, {
      ...dependencies(),
      check: true,
      instanceId: selected.instance_id,
      checkAssistantIds: [],
    });
    expect(filtered.assistants).toEqual([
      expect.objectContaining({ instance_id: selected.instance_id, access: { status: 'not_checked', reason: null } }),
    ]);
    expect(filtered.management.status).toBe('verified');
    expect(provider.serviceAccountCalls().some((args) => args[0] === 'vault')).toBe(false);
    const records = [await resourcesOf(selected), await resourcesOf(stopped)];
    provider.calls.length = 0;
    const reachable = await inspectOnePasswordCapability(paths, {
      ...dependencies(),
      check: true,
      checkAssistantIds: [selected.instance_id],
    });
    expect(reachable.assistants.find((entry) => entry.instance_id === selected.instance_id)?.access.status).toBe(
      'verified',
    );
    expect(reachable.assistants.find((entry) => entry.instance_id === stopped.instance_id)?.access.status).toBe(
      'not_checked',
    );
    expect(
      provider
        .serviceAccountCalls()
        .filter((args) => args[0] === 'vault')
        .map((args) => args[2]),
    ).toEqual([records[0]?.vault.id]);
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
    expect(onePasswordCapabilityNextActions(checked, true)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', 'onepassword'],
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

describe('the native 1Password connector commands', () => {
  const unexpectedPrompt = async (): Promise<never> => {
    throw new Error('An unrelated provisioning prompt was reached');
  };
  const prompts: InteractivePrompts = {
    providerCredential: unexpectedPrompt,
    googleCloudSignIn: unexpectedPrompt,
    googleAccount: unexpectedPrompt,
    googleWorkspaceSignIn: unexpectedPrompt,
    attendPause: unexpectedPrompt,
  };
  let runCli: (typeof import('./cli.js'))['runCli'];
  beforeEach(async () => {
    ({ runCli } = await import('./cli.js'));
  });
  async function run(args: readonly string[]) {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(args, {
      paths,
      environment: { PATH: '/usr/bin:/bin' },
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      onePassword: dependencies().cli,
      prompts,
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

  it('installs from a terminal, checks and lists through the published contracts, with no token in output or logs', async () => {
    await assistant();
    const installed = await run(['connectors', 'install', 'onepassword', '--account', ACCOUNT_ID]);
    expect(installed.code).toBe(0);
    expect(installed.stdout).toContain('install completed');
    const checked = await run(['connectors', 'check', 'onepassword', '--json']);
    expect(checked.code).toBe(0);
    expectResultContract('connectors check onepassword', JSON.parse(checked.stdout));
    const listed = await run(['connectors', 'list', '--json']);
    expectResultContract('connectors list', JSON.parse(listed.stdout));
    expect(JSON.parse(listed.stdout)).toMatchObject({
      data: {
        connectors: [
          { name: 'voice' },
          { name: 'onepassword', setup: 'installed', readiness: { status: 'not_checked', checked: false } },
          { name: 'artifacts' },
        ],
      },
    });
    const human = await run(['connectors', 'check', 'onepassword']);
    expect(human.stdout).toContain('Account type: families');
    const again = await run(['connectors', 'install', 'onepassword']);
    expect(again.code).toBe(0);
    const everything = [installed, checked, listed, human, again]
      .map((output) => output.stdout + output.stderr)
      .join('\n');
    const logs = await treeText(paths.logsRoot);
    expect(provider.tokens).toHaveLength(2);
    for (const token of provider.tokens) {
      expect(everything).not.toContain(token);
      expect(logs).not.toContain(token);
    }
  });

  it('pauses a partially provisioned terminal install with the command that continues it', async () => {
    await assistant();
    await assistant();
    provider.after = (args) => {
      if (args[0] === 'service-account' && args.includes('--vault')) provider.signedIn = false;
    };
    const partial = await run(['connectors', 'install', 'onepassword', '--account', ACCOUNT_ID]);
    expect(partial.code).toBe(10);
    expect(partial.stdout + partial.stderr).toContain('connectors install onepassword');
    expect(provider.vaults.size).toBe(2);
  });

  it('pauses noninteractive install before calling op and preserves its structured continuation', async () => {
    await assistant();
    const paused = await run(['connectors', 'install', 'onepassword', '--account', ACCOUNT_ID, '--json']);
    expect(paused.code).toBe(10);
    const result: unknown = JSON.parse(paused.stdout);
    expectResultContract('connectors install onepassword', result);
    expect(result).toMatchObject({
      outcome: 'paused',
      changed: false,
      error: { code: 'onepassword_operator_sign_in_needed' },
      next_actions: expect.arrayContaining([
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
      ]),
    });
    expect(provider.calls).toEqual([]);
    const invalid = await run(['connectors', 'install', 'onepassword', '--account', 'hale.1password.com']);
    expect(invalid.code).toBe(2);
  });

  it('reports a missing CLI before any domain state changes', async () => {
    const stdout: string[] = [];
    const stderr: string[] = [];
    const code = await runCli(['connectors', 'install', 'onepassword', '--account', ACCOUNT_ID], {
      paths,
      environment: { PATH: root },
      prompts,
      stdout: (line) => stdout.push(line),
      stderr: (line) => stderr.push(line),
      upsertEnvVars,
    });
    expect(code).toBe(1);
    expect(stdout.join('\n') + stderr.join('\n')).toContain('1Password CLI');
    expect(await onePasswordEnabled(paths)).toBe(false);
    expect(await exists(onePasswordHostPaths(paths.configRoot).policyFile)).toBe(false);
  });
});

describe('host-wide 1Password uninstall', () => {
  const uninstall = (deleteVaults = true) =>
    uninstallOnePassword(
      paths,
      { deleteVaults },
      { cli: provider.cli(), ncl: async () => ({ credentialAttempts: 2 }) },
    );

  it('previews a nonempty vault without creating a receipt or changing files and provider records', async () => {
    const runtime = await assistant();
    await enable();
    const resources = await resourcesOf(runtime);
    if (!resources) throw new Error('not provisioned');
    provider.vaults.get(resources.vault.id)!.items = 3;
    const host = onePasswordHostPaths(paths.configRoot);
    const files = onePasswordInstancePaths(runtime.instance_root);
    const before = await Promise.all(
      [host.policyFile, host.managementTokenFile, files.resourceFile, files.runtimeTokenFile].map((file) =>
        readFile(file, 'utf8'),
      ),
    );
    const result = await uninstall(false);
    expect(result).toMatchObject({
      outcome: 'paused',
      changed: false,
      receipt_file: null,
      preview: { vaults: [{ vault_id: resources.vault.id, item_count: 3, credential_attempts: 2 }] },
    });
    expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
    expect(
      await Promise.all(
        [host.policyFile, host.managementTokenFile, files.resourceFile, files.runtimeTokenFile].map((file) =>
          readFile(file, 'utf8'),
        ),
      ),
    ).toEqual(before);
    expect(provider.vaults.has(resources.vault.id)).toBe(true);
    expect(provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'delete')).toEqual([]);
  });

  it.each(['before the uninstall call', 'during the uninstall preview'] as const)(
    'requires a fresh confirmation when an owned vault is registered %s',
    async (registration) => {
      const first = await assistant();
      await enable();
      const confirmedPreview = await previewOnePasswordUninstall(paths, { cli: provider.cli() });
      expect(confirmedPreview.vaults.map(({ instance_id }) => instance_id)).toEqual([first.instance_id]);
      let second: InstanceRuntimeConfig | undefined;
      let protectedFiles: string[] = [];
      let before: string[] = [];
      const register = async (): Promise<void> => {
        second = await assistant();
        const provisioned = await withInstanceOperation(paths, second.instance_id, (operation) =>
          provisionAssistantVault(operation, dependencies()),
        );
        expect(provisioned?.outcome).toBe('ready');
        const host = onePasswordHostPaths(paths.configRoot);
        protectedFiles = [
          host.policyFile,
          host.managementTokenFile,
          ...[first, second].flatMap((runtime) => {
            const files = onePasswordInstancePaths(runtime.instance_root);
            return [files.resourceFile, files.runtimeTokenFile];
          }),
        ];
        before = await Promise.all(protectedFiles.map((file) => readFile(file, 'utf8')));
      };
      if (registration === 'before the uninstall call') await register();
      // A separately read terminal preview is the approval, even when deletion was confirmed as a boolean too.
      const request = { deleteVaults: true, confirmedPreview };
      const result = await uninstallOnePassword(paths, request, {
        cli: provider.cli(),
        ncl: async () => {
          if (!second) await register();
          return { credentialAttempts: 2 };
        },
      });
      expect(result).toMatchObject({ outcome: 'paused', changed: false, receipt_file: null });
      if (!second) throw new Error('The concurrent assistant was not registered');
      expect(result.preview.vaults.map(({ instance_id }) => instance_id).sort()).toEqual(
        [first.instance_id, second.instance_id].sort(),
      );
      expect(await Promise.all(protectedFiles.map((file) => readFile(file, 'utf8')))).toEqual(before);
      expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
      expect(provider.vaults.size).toBe(2);
      expect(provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'delete')).toEqual([]);
      const freshConfirmation = { confirmedPreview: result.preview };
      expect(await uninstallOnePassword(paths, freshConfirmation, { cli: provider.cli() })).toMatchObject({
        outcome: 'completed',
        changed: true,
      });
      expect(provider.vaults.size).toBe(0);
    },
  );

  it('requires a fresh confirmation when the same vault becomes eligible for deletion', async () => {
    const runtime = await assistant();
    await enable();
    const resources = await resourcesOf(runtime);
    if (!resources) throw new Error('not provisioned');
    const files = onePasswordInstancePaths(runtime.instance_root);
    await writeOnePasswordResources(files.resourceFile, {
      ...resources,
      vault: { ...resources.vault, createdBy: { kind: 'operator' } },
    });
    const confirmedPreview = await previewOnePasswordUninstall(paths, { cli: provider.cli() });
    expect(confirmedPreview.vaults[0]).toMatchObject({ owned: false, vault: 'retain' });
    await writeOnePasswordResources(files.resourceFile, resources);
    const request = { deleteVaults: true, confirmedPreview };
    const result = await uninstallOnePassword(paths, request, { cli: provider.cli() });
    expect(result).toMatchObject({
      outcome: 'paused',
      changed: false,
      receipt_file: null,
      preview: { vaults: [{ vault_id: resources.vault.id, owned: true, vault: 'delete' }] },
    });
    expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
    expect(await onePasswordEnabled(paths)).toBe(true);
    expect(await exists(files.runtimeTokenFile)).toBe(true);
    expect(provider.vaults.has(resources.vault.id)).toBe(true);
  });

  it.each(['account', 'management account', 'vault'] as const)(
    'requires a fresh confirmation when the %s identity changes',
    async (identity) => {
      const runtime = await assistant();
      await enable();
      const resources = await resourcesOf(runtime);
      if (!resources) throw new Error('not provisioned');
      const confirmedPreview = await previewOnePasswordUninstall(paths, { cli: provider.cli() });
      const files = onePasswordInstancePaths(runtime.instance_root);
      const host = onePasswordHostPaths(paths.configRoot);
      const policy = await readOnePasswordHostPolicy(host.policyFile);
      if (policy.status !== 'ready') throw new Error('No host policy');
      if (identity === 'vault') {
        const previous = provider.vaults.get(resources.vault.id);
        if (!previous) throw new Error('No provider vault');
        const id = providerId('REPLACEMENTVAULT', 99);
        provider.vaults.set(id, { ...previous, id });
        await writeOnePasswordResources(files.resourceFile, { ...resources, vault: { ...resources.vault, id } });
      } else {
        await writeOnePasswordHostPolicy(host.policyFile, {
          ...policy.policy,
          ...(identity === 'account'
            ? { accountId: OTHER_ACCOUNT_ID }
            : { managementServiceAccountId: providerId('REPLACEMENTMANAGEMENT', 99) }),
        });
      }
      const protectedFiles = [host.policyFile, host.managementTokenFile, files.resourceFile, files.runtimeTokenFile];
      const before = await Promise.all(protectedFiles.map((file) => readFile(file, 'utf8')));
      const request = { deleteVaults: true, confirmedPreview };
      const result = await uninstallOnePassword(paths, request, { cli: provider.cli() });
      expect(result).toMatchObject({ outcome: 'paused', changed: false, receipt_file: null });
      expect(await Promise.all(protectedFiles.map((file) => readFile(file, 'utf8')))).toEqual(before);
      expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
      expect(provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'delete')).toEqual([]);
    },
  );

  it('keeps explicit --delete-vaults authorization for an owned vault registered during the preview', async () => {
    await assistant();
    await enable();
    let registered = false;
    const result = await uninstallOnePassword(
      paths,
      { deleteVaults: true },
      {
        cli: provider.cli(),
        ncl: async () => {
          if (!registered) {
            registered = true;
            const second = await assistant();
            const provisioned = await withInstanceOperation(paths, second.instance_id, (operation) =>
              provisionAssistantVault(operation, dependencies()),
            );
            expect(provisioned?.outcome).toBe('ready');
          }
          return { credentialAttempts: 0 };
        },
      },
    );
    expect(result).toMatchObject({ outcome: 'completed', changed: true });
    expect(result.assistants).toHaveLength(2);
    expect(provider.vaults.size).toBe(0);
  });

  it('shares a rate limit through the fresh preview without changing the newly discovered vaults', async () => {
    await assistant();
    await enable();
    const confirmedPreview = await previewOnePasswordUninstall(paths, { cli: provider.cli() });
    const state = { limited: false };
    let previews = 0;
    let limited = false;
    const result = await uninstallOnePassword(
      paths,
      { confirmedPreview },
      {
        cli: {
          ...provider.cli(),
          runCommand: async (command) => {
            if (limited) throw new Error('Provider work continued after the fresh preview was rate limited');
            if (previews > 1 && command.args[0] === 'whoami') {
              limited = true;
              return { stdout: '', stderr: '[ERROR] (429) Too Many Requests', exitCode: 1 };
            }
            return provider.runCommand(command);
          },
        },
        rateLimitState: state,
        ncl: async () => {
          previews += 1;
          if (previews === 1) {
            const second = await assistant();
            const provisioned = await withInstanceOperation(paths, second.instance_id, (operation) =>
              provisionAssistantVault(operation, dependencies()),
            );
            expect(provisioned?.outcome).toBe('ready');
          }
          return { credentialAttempts: 0 };
        },
      },
    );
    expect(result).toMatchObject({ outcome: 'paused', changed: false, receipt_file: null });
    expect(result.preview.vaults).toHaveLength(2);
    expect(result.preview.vaults.every(({ item_count }) => item_count === null)).toBe(true);
    expect(state.limited).toBe(true);
    expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
    expect(await onePasswordEnabled(paths)).toBe(true);
    expect(provider.vaults.size).toBe(2);
  });

  it('deletes owned vaults before their tokens, keeps every revocation, and handles another install generation', async () => {
    const first = await assistant();
    const second = await assistant();
    const installed = await enable();
    const host = onePasswordHostPaths(paths.configRoot);
    const expectedRevocations = [
      installed.management_service_account_id,
      ...installed.assistants.map((entry) => entry.runtime_service_account_id),
    ].sort();
    const tokenByVault = new Map<string, string>();
    for (const runtime of [first, second]) {
      const record = await resourcesOf(runtime);
      if (!record) throw new Error('not provisioned');
      tokenByVault.set(record.vault.id, onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile);
    }
    const result = await uninstallOnePassword(
      paths,
      { deleteVaults: true },
      {
        cli: {
          ...provider.cli(),
          runCommand: async (command) => {
            if (command.args[0] === 'vault' && command.args[1] === 'delete') {
              expect(await onePasswordEnabled(paths)).toBe(false);
              expect(await exists(host.managementTokenFile)).toBe(true);
              expect(await exists(tokenByVault.get(command.args[2])!)).toBe(true);
            }
            return provider.runCommand(command);
          },
        },
        ncl: async () => ({ credentialAttempts: 0 }),
      },
    );
    expect(result).toMatchObject({ outcome: 'completed', changed: true });
    expect(result.assistants.map((entry) => entry.vault)).toEqual(['deleted', 'deleted']);
    expect([...result.revoke_service_account_ids].sort()).toEqual(expectedRevocations);
    expect(provider.vaults.size).toBe(0);
    for (const runtime of [first, second]) {
      const files = onePasswordInstancePaths(runtime.instance_root);
      expect(await exists(files.runtimeTokenFile)).toBe(false);
      expect(await exists(files.resourceFile)).toBe(false);
    }
    expect(await exists(host.managementTokenFile)).toBe(false);
    expect(await exists(host.policyFile)).toBe(false);
    expect((await inspectOnePasswordUninstall(paths)).status).toBe('completed');
    provider.before = undefined;
    const reinstalled = await enable();
    expect(reinstalled.assistants.every((entry) => entry.outcome === 'ready')).toBe(true);
    const again = await uninstall();
    expect(again.outcome).toBe('completed');
    expect(provider.vaults.size).toBe(0);
    expect(again.revoke_service_account_ids).toEqual(expect.arrayContaining(expectedRevocations));
    expect(again.revoke_service_account_ids).toHaveLength(6);
    expect(await uninstallOnePassword(paths, { abandon: true }, { cli: provider.cli() })).toMatchObject({
      outcome: 'completed',
      receipt_file: null,
    });
    expect((await inspectOnePasswordUninstall(paths)).status).toBe('absent');
  });

  it('resumes after an interrupted confirmed deletion without deleting that vault twice', async () => {
    await assistant();
    await assistant();
    await enable();
    provider.calls.length = 0;
    provider.after = (args) => {
      if (args[0] === 'vault' && args[1] === 'delete') {
        provider.after = undefined;
        throw new GwsEaError('test_interrupted', 'The process stopped after the provider deleted the vault');
      }
    };
    await expect(uninstall()).rejects.toMatchObject({ code: 'test_interrupted' });
    expect(provider.vaults.size).toBe(1);
    expect((await inspectOnePasswordUninstall(paths)).incomplete).toBe(true);
    const blockedInstall = await enable().catch((error: unknown) => error);
    expect(blockedInstall).toMatchObject({ code: 'onepassword_uninstall_incomplete' });
    expect(onePasswordRecovery(blockedInstall)).toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'uninstall', 'onepassword'],
    });
    expect(await uninstall()).toMatchObject({ outcome: 'completed' });
    const deletions = provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'delete');
    expect(deletions).toHaveLength(2);
    expect(new Set(deletions.map((call) => call.args[2])).size).toBe(2);
  });

  it('stops every provider request after a deletion is rate limited and resumes next run', async () => {
    const runtime = await assistant();
    await enable();
    let limited = false;
    provider.before = (args) => {
      if (limited) throw new Error('Provider work continued after the account rate limit');
      if (args[0] === 'vault' && args[1] === 'delete') {
        limited = true;
        return { exitCode: 1, stderr: '[ERROR] (429) Too Many Requests' };
      }
      return undefined;
    };
    expect(await uninstall()).toMatchObject({ outcome: 'paused', reason: expect.stringContaining('rate limited') });
    expect(await exists(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile)).toBe(true);
    provider.before = undefined;
    expect(await uninstall()).toMatchObject({ outcome: 'completed' });
  });

  it('retains a foreign-owned vault and completes without using a replacement management identity', async () => {
    const runtime = await assistant();
    await enable();
    const resources = await resourcesOf(runtime);
    if (!resources) throw new Error('not provisioned');
    await writeOnePasswordResources(onePasswordInstancePaths(runtime.instance_root).resourceFile, {
      ...resources,
      vault: { ...resources.vault, createdBy: { kind: 'operator' } },
    });
    const result = await uninstall();
    expect(result).toMatchObject({
      outcome: 'completed',
      assistants: [{ vault: 'retained', vault_id: resources.vault.id }],
    });
    expect(provider.vaults.has(resources.vault.id)).toBe(true);
  });

  it('preserves an unproven vault for manual cleanup and keeps reinstall fenced until acknowledged', async () => {
    await assistant();
    provider.after = (args) => {
      if (args[0] === 'vault' && args[1] === 'create') {
        provider.after = undefined;
        throw new GwsEaError('command_timeout', 'Command timed out');
      }
    };
    await enable();
    const result = await uninstall();
    expect(result).toMatchObject({
      outcome: 'completed',
      assistants: [{ vault: 'unrecorded', unproven: [{ kind: 'vault' }] }],
    });
    expect(provider.vaults.size).toBe(1);
    expect((await inspectOnePasswordUninstall(paths)).incomplete).toBe(true);
    const blockedInstall = await enable().catch((error: unknown) => error);
    expect(blockedInstall).toMatchObject({ code: 'onepassword_uninstall_incomplete' });
    const abandon = {
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'uninstall', 'onepassword', '--abandon'],
    };
    expect(onePasswordRecovery(blockedInstall)).toContainEqual(abandon);
    const observation = await inspectConnector(paths, 'onepassword');
    expect(observation.next_actions).toContainEqual(abandon);
    expect(observation.next_actions).not.toContainEqual({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'uninstall', 'onepassword'],
    });
    expect(onePasswordRecovery(blockedInstall)[0]).toMatchObject({
      kind: 'external',
      instruction: expect.stringContaining('manual cleanup'),
    });
    await uninstallOnePassword(paths, { abandon: true }, { cli: provider.cli() });
    expect((await inspectOnePasswordUninstall(paths)).status).toBe('absent');
  });

  it('stops preview provider work after a 429 and changes nothing even with deletion confirmed', async () => {
    await assistant();
    await assistant();
    await enable();
    let limited = false;
    provider.before = () => {
      if (limited) throw new Error('A second request followed the rate limit');
      limited = true;
      return { exitCode: 1, stderr: '[ERROR] (429) Too Many Requests' };
    };
    const result = await uninstall();
    expect(result).toMatchObject({ outcome: 'paused', changed: false, receipt_file: null });
    expect(await onePasswordEnabled(paths)).toBe(true);
    expect(provider.vaults.size).toBe(2);
  });

  it('records an unverified management token and retains its vault for manual cleanup', async () => {
    const runtime = await assistant();
    const installed = await enable();
    await rm(onePasswordHostPaths(paths.configRoot).managementTokenFile);
    const result = await uninstall();
    expect(result).toMatchObject({
      outcome: 'completed',
      assistants: [{ vault: 'retained', unproven: [{ kind: 'service_account', name: 'GWS-EA management' }] }],
    });
    expect(result.revoke_service_account_ids).toContain(installed.management_service_account_id);
    expect(provider.vaults.size).toBe(1);
    expect(await exists(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile)).toBe(false);
  });

  it.each(['unsafe mode', 'temporary read failure'] as const)(
    'pauses uninstall for a management token with %s and deletes its vault after repair',
    async (failure) => {
      const runtime = await assistant();
      await enable();
      const resources = await resourcesOf(runtime);
      if (!resources) throw new Error('not provisioned');
      const host = onePasswordHostPaths(paths.configRoot);
      const files = onePasswordInstancePaths(runtime.instance_root);
      const readOwnerOnlyFile = secrets.readOwnerOnlyFile;
      const fault =
        failure === 'temporary read failure'
          ? vi.spyOn(secrets, 'readOwnerOnlyFile').mockImplementation(async (file) => {
              if (file === host.managementTokenFile)
                throw Object.assign(new Error('Too many open files'), { code: 'EMFILE' });
              return readOwnerOnlyFile(file);
            })
          : undefined;
      if (failure === 'unsafe mode') await chmod(host.managementTokenFile, 0o644);

      const paused = await uninstall();

      expect(paused).toMatchObject({ outcome: 'paused' });
      expect(provider.vaults.has(resources.vault.id)).toBe(true);
      for (const file of [host.managementTokenFile, host.policyFile, files.resourceFile, files.runtimeTokenFile])
        expect(await exists(file)).toBe(true);
      const receipt = await inspectOnePasswordUninstall(paths);
      expect(receipt.receipt?.completed).toBe(false);
      expect(receipt.receipt?.assistants[runtime.instance_id].cleanup.vault).toBeUndefined();
      expect(receipt.receipt?.assistants[runtime.instance_id].cleanup.unproven).not.toContainEqual({
        kind: 'service_account',
        name: 'GWS-EA management',
      });

      fault?.mockRestore();
      if (failure === 'unsafe mode') await chmod(host.managementTokenFile, 0o600);
      expect(await uninstall()).toMatchObject({
        outcome: 'completed',
        assistants: [{ vault: 'deleted', vault_id: resources.vault.id }],
      });
      expect(provider.vaults.has(resources.vault.id)).toBe(false);
      expect(await exists(host.managementTokenFile)).toBe(false);
      expect(provider.calls.filter((call) => call.args[0] === 'vault' && call.args[1] === 'delete')).toHaveLength(1);
    },
  );

  it('keeps the name of a captured but unverified runtime account after removing its token', async () => {
    const runtime = await assistant();
    provider.before = (args) => {
      if (args.join(' ') === 'whoami --format json' && provider.serviceAccounts.size === 2)
        throw new Error('The process stopped while verifying the runtime token');
      return undefined;
    };
    await expect(enable()).rejects.toThrow('The process stopped');
    provider.before = undefined;
    const result = await uninstall();
    expect(result).toMatchObject({
      outcome: 'completed',
      assistants: [
        {
          vault: 'deleted',
          runtime_token: 'deleted',
          unproven: [
            {
              kind: 'service_account',
              name: `GWS-EA ${runtime.instance_id.slice(0, 8)} aya.${runtime.instance_id.slice(0, 8)}@example.test`,
            },
          ],
        },
      ],
    });
    expect(await exists(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile)).toBe(false);
    const receipt = await inspectOnePasswordUninstall(paths);
    expect(receipt.status).toBe('completed');
    expect(receipt.receipt?.assistants[runtime.instance_id].cleanup.unproven).toEqual(result.assistants[0].unproven);
    expect(provider.serviceAccounts.size).toBe(2);
  });

  it.each(['revoke-only', 'abandoned'] as const)(
    'refuses unsettled removal but permits a %s receipt',
    async (settled) => {
      const runtime = await assistant();
      await enable();
      const captured = await captureOnePasswordCleanup(
        paths,
        (await readRegistry(paths)).instances[runtime.instance_id],
        'delete',
      );
      if (captured.status !== 'captured') throw new Error('not captured');
      await mkdir(paths.removalRoot, { recursive: true, mode: 0o700 });
      const removal = paths.removalFile(runtime.instance_id);
      await writeFile(removal, JSON.stringify({ onepassword: captured.cleanup }), { mode: 0o600 });
      await expect(uninstall()).rejects.toMatchObject({ code: 'onepassword_removal_pending' });
      expect(await onePasswordEnabled(paths)).toBe(true);
      expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
      await writeFile(
        removal,
        JSON.stringify(
          settled === 'abandoned'
            ? {
                onepassword: captured.cleanup,
                abandoned: {
                  onepassword: { at: new Date().toISOString(), evidence: 'The operator accepted manual cleanup' },
                },
              }
            : {
                onepassword: {
                  ...captured.cleanup,
                  vault: { outcome: 'deleted', item_count: 0, reason: 'Verified gone', at: new Date().toISOString() },
                },
              },
        ),
        { mode: 0o600 },
      );
      expect(await uninstall()).toMatchObject({ outcome: 'completed' });
    },
  );

  it('refuses a busy assistant before publishing stopped or creating a receipt', async () => {
    const runtime = await assistant();
    await enable();
    const release = await processLock(paths.instanceLock(runtime.instance_id));
    if (!release) throw new Error('No lock');
    try {
      await expect(uninstall()).rejects.toMatchObject({ code: 'instance_busy' });
      expect(await onePasswordEnabled(paths)).toBe(true);
      expect(await exists(onePasswordUninstallFile(paths))).toBe(false);
      expect(provider.vaults.size).toBe(1);
    } finally {
      release();
    }
  });
});
