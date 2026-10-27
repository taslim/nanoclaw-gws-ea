import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectorDefinition } from './connectors.js';
import { runCli } from './cli.js';
import { resolveControlPlanePaths } from './paths.js';
import { expectResultContract } from './testing/result-contract.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { reserveInstance } from './journal.js';
import { ONEPASSWORD_CONTRACT } from './onepassword.js';
import { FakeOnePassword } from './testing/onepassword-fixture.js';
import { persistTestRuntime } from './testing/runtime-fixture.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it.each(['list', 'show'] as const)(
  'keeps connectors %s available when one assistant runtime is malformed and 1Password was never installed',
  async (command) => {
    const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'connector-local-runtime-')));
    roots.push(root);
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    const ids = [randomUUID(), randomUUID()] as const;
    for (const [index, id] of ids.entries()) {
      const reservation = await reserveInstance(paths, {
        instance_id: id,
        release_track: 'dogfood',
        source_remote: 'https://example.test/repo.git',
        deployed_commit: 'a'.repeat(40),
        allocated_ports: { onecli_app: 3201 + index * 2, onecli_gateway: 3202 + index * 2 },
        exclusive_resource_claims: {
          ...deriveGcpClaims(id),
          gcp_account: 'operator@example.test',
          workspace_email: `${id}@example.test`,
          onecli_project: `gws-ea-${id.replaceAll('-', '')}`,
        },
      });
      const runtime = await persistTestRuntime(paths, reservation);
      await mkdir(path.join(runtime.checkout_root, 'src/gws-ea'), { recursive: true });
      await writeFile(
        path.join(runtime.checkout_root, 'src/gws-ea/onepassword-compatibility.json'),
        JSON.stringify({ schemaVersion: 1, contract: ONEPASSWORD_CONTRACT }),
      );
    }
    const malformedId = ids[1];
    await writeFile(paths.runtimeFile(malformedId), '{');
    const provider = new FakeOnePassword();
    const runCommand = vi.fn(provider.runCommand);
    const output: string[] = [];
    const argv = ['connectors', command, ...(command === 'show' ? ['onepassword'] : []), '--json'];

    expect(
      await runCli(argv, {
        paths,
        environment: { PATH: '/usr/bin:/bin' },
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        onePassword: { ...provider.cli(), runCommand },
      }),
    ).toBe(0);

    const result: unknown = JSON.parse(output.join('\n'));
    expectResultContract(command === 'list' ? 'connectors list' : 'connectors show onepassword', result);
    const onePassword = {
      name: 'onepassword',
      setup: 'not_installed',
      assistants: expect.arrayContaining([
        expect.objectContaining({ instance_id: ids[0], compatibility: 'compatible' }),
        expect.objectContaining({
          instance_id: malformedId,
          compatibility: 'unknown',
          readiness: { checked: false, status: 'not_checked' },
          next_actions: [{ kind: 'command', argv: ['gws-ea', 'status', '--id', malformedId] }],
        }),
      ]),
    };
    expect(result).toMatchObject({
      outcome: 'succeeded',
      data:
        command === 'list'
          ? {
              connectors: expect.arrayContaining([
                expect.objectContaining({ name: 'voice' }),
                expect.objectContaining(onePassword),
                expect.objectContaining({ name: 'web' }),
              ]),
            }
          : onePassword,
    });
    if (command === 'list') {
      const names = (result as { data: { connectors: { name: string }[] } }).data.connectors.map(({ name }) => name);
      expect(names).toEqual(['voice', 'onepassword', 'web']);
    }
    expect(runCommand).not.toHaveBeenCalled();
  },
);
it('dispatches 1Password uninstall through the catalog and validates its preview result', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-dispatch-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const uninstall = vi.spyOn(connectorDefinition('onepassword'), 'uninstall').mockResolvedValue({
    name: 'onepassword',
    scope: 'host',
    outcome: 'paused',
    changed: false,
    preview: {
      account_id: null,
      management_service_account_id: null,
      management_creation_unproven: false,
      vaults: [],
    },
    assistants: [],
    receipt_file: null,
    revoke_service_account_ids: [],
    reason: 'Confirm deletion first.',
  });
  const output: string[] = [];
  expect(
    await runCli(['connectors', 'uninstall', 'onepassword', '--json'], {
      paths,
      environment: { PATH: '/usr/bin:/bin' },
      stdout: (line) => output.push(line),
      stderr: () => undefined,
    }),
  ).toBe(10);
  expect(uninstall).toHaveBeenCalledOnce();
  expect(uninstall.mock.calls[0][0]).toMatchObject({ paths, deleteVaults: false });
  const result = JSON.parse(output.join('\n'));
  expectResultContract('connectors uninstall onepassword', result);
  expect(result).toMatchObject({ outcome: 'paused', changed: false, data: { preview: { vaults: [] } } });
});

it('forwards the approved terminal preview to the catalog uninstall handler', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-confirmation-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const uninstall = vi.spyOn(connectorDefinition('onepassword'), 'uninstall').mockResolvedValue({
    name: 'onepassword',
    scope: 'host',
    outcome: 'completed',
    changed: false,
    preview: {
      account_id: null,
      management_service_account_id: null,
      management_creation_unproven: false,
      vaults: [],
    },
    assistants: [],
    receipt_file: null,
    revoke_service_account_ids: [],
    reason: null,
  });
  const confirm = vi.fn(async (_preview: import('./onepassword-uninstall.js').OnePasswordUninstallPreview) => true);
  expect(
    await runCli(['connectors', 'uninstall', 'onepassword'], {
      paths,
      environment: { PATH: '/usr/bin:/bin' },
      stdout: () => undefined,
      stderr: () => undefined,
      confirmOnePasswordUninstall: confirm,
    }),
  ).toBe(0);
  expect(confirm).toHaveBeenCalledOnce();
  expect(uninstall).toHaveBeenCalledOnce();
  expect(uninstall.mock.calls[0][0]).toMatchObject({ deleteVaults: true, confirmedPreview: confirm.mock.calls[0][0] });
});

it('reports changed terminal previews and offers fresh confirmation', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-preview-retry-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  vi.spyOn(connectorDefinition('onepassword'), 'uninstall').mockResolvedValue({
    name: 'onepassword',
    scope: 'host',
    outcome: 'paused',
    changed: false,
    preview: { account_id: null, management_service_account_id: null, management_creation_unproven: false, vaults: [] },
    assistants: [],
    receipt_file: null,
    revoke_service_account_ids: [],
    reason: 'The vault set changed after the confirmed preview. Review the fresh preview.',
  });
  const output: string[] = [];
  expect(
    await runCli(['connectors', 'uninstall', 'onepassword'], {
      paths,
      environment: { PATH: '/usr/bin:/bin' },
      stdout: (line) => output.push(line),
      stderr: () => undefined,
      confirmOnePasswordUninstall: async () => true,
    }),
  ).toBe(10);
  expect(output.join('\n')).toContain('The vault set changed after the confirmed preview.');
  expect(output).toContain('Next: gws-ea connectors uninstall onepassword');
  expect(output.join('\n')).not.toContain('--delete-vaults');
});
