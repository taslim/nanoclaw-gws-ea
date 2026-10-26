import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import { connectorDefinition } from './connectors.js';
import { runCli } from './cli.js';
import { resolveControlPlanePaths } from './paths.js';
import { expectResultContract } from './testing/result-contract.js';
const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
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
