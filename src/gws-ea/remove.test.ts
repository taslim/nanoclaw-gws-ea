import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { runCli } from './cli.js';
import { acquireInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { readRegistry, reserveInstance, writeInstanceMarker } from './registry.js';
import { removeAssistant } from './remove.js';
import { allocateInstanceId } from './registry.js';
import type { InstanceReservationInput } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<{ paths: ControlPlanePaths; input: InstanceReservationInput }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-remove-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  const projectId = `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
  const input: InstanceReservationInput = {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 32_001, onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.test/webhook/gchat' },
      gcp_project_id: projectId,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
  await reserveInstance(paths, input);
  await mkdir(input.checkout_realpath, { recursive: true, mode: 0o700 });
  await writeInstanceMarker(paths, instanceId);
  return { paths, input };
}

describe('assistant removal', () => {
  it('tears down the exact GCP project, NanoClaw copy, OneCLI runtime, local state, then registry claim', async () => {
    const { paths, input } = await fixture();
    const calls: string[] = [];

    await removeAssistant(paths, input.instance_id, {
      deleteGcpProject: async (reservation) =>
        void calls.push(`gcp:${reservation.exclusive_resource_claims.gcp_project_id}`),
      uninstallNanoclaw: async (reservation) => void calls.push(`nanoclaw:${reservation.checkout_realpath}`),
      removeOnecli: async (reservation) =>
        void calls.push(`onecli:${reservation.exclusive_resource_claims.onecli_project}`),
      removeInstanceFiles: async (reservation) => void calls.push(`files:${reservation.instance_id}`),
    });

    expect(calls).toEqual([
      `nanoclaw:${input.checkout_realpath}`,
      `gcp:${input.exclusive_resource_claims.gcp_project_id}`,
      `onecli:${input.exclusive_resource_claims.onecli_project}`,
      `files:${input.instance_id}`,
    ]);
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('persists completed teardown phases and resumes without repeating destructive effects', async () => {
    const { paths, input } = await fixture();
    const deleteGcpProject = vi.fn(async () => undefined);
    const uninstallNanoclaw = vi.fn(async () => undefined);
    const removeOnecli = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce(undefined);
    const removeInstanceFiles = vi.fn(async () => undefined);
    const dependencies = { deleteGcpProject, uninstallNanoclaw, removeOnecli, removeInstanceFiles };

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toThrow(/docker unavailable/u);
    await removeAssistant(paths, input.instance_id, dependencies);

    expect(deleteGcpProject).toHaveBeenCalledTimes(1);
    expect(uninstallNanoclaw).toHaveBeenCalledTimes(1);
    expect(removeOnecli).toHaveBeenCalledTimes(2);
    expect(removeInstanceFiles).toHaveBeenCalledTimes(1);
    expect((await readRegistry(paths)).instances).toEqual({});
  });

  it('refuses removal before any effect when the immutable marker is missing', async () => {
    const { paths, input } = await fixture();
    await rm(paths.markerFile(input.instance_id));
    const deleteGcpProject = vi.fn(async () => undefined);

    await expect(
      removeAssistant(paths, input.instance_id, {
        deleteGcpProject,
        uninstallNanoclaw: async () => undefined,
        removeOnecli: async () => undefined,
        removeInstanceFiles: async () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'marker_missing' });
    expect(deleteGcpProject).not.toHaveBeenCalled();
  });

  it('blocks provisioning while a resumable removal receipt exists', async () => {
    const { paths, input } = await fixture();
    await expect(
      removeAssistant(paths, input.instance_id, {
        uninstallNanoclaw: async () => undefined,
        deleteGcpProject: async () => {
          throw new Error('cloud unavailable');
        },
        removeOnecli: async () => undefined,
        removeInstanceFiles: async () => undefined,
      }),
    ).rejects.toThrow(/cloud unavailable/u);

    await expect(acquireInstanceOperation(paths, input.instance_id)).rejects.toMatchObject({
      code: 'removal_in_progress',
    });
  });

  it('leaves a peer reservation untouched', async () => {
    const { paths, input } = await fixture();
    const peer = (await fixture()).input;
    const peerForSameRegistry: InstanceReservationInput = {
      ...peer,
      checkout_realpath: paths.checkoutRoot(peer.instance_id),
      allocated_ports: { nanoclaw_webhook: 42_001, onecli_app: 42_002, onecli_gateway: 42_003 },
      exclusive_resource_claims: {
        ...peer.exclusive_resource_claims,
        ingress: { mode: 'existing', endpoint_url: 'https://peer.example.test/webhook/gchat' },
        workspace_email: 'peer@example.test',
      },
    };
    await reserveInstance(paths, peerForSameRegistry);

    await removeAssistant(paths, input.instance_id, {
      uninstallNanoclaw: async () => undefined,
      deleteGcpProject: async () => undefined,
      removeOnecli: async () => undefined,
      removeInstanceFiles: async () => undefined,
    });

    expect((await readRegistry(paths)).instances).toEqual({ [peer.instance_id]: peerForSameRegistry });
  });

  it('previews removal and defaults to leaving the assistant unchanged', async () => {
    const { paths, input } = await fixture();
    const output: string[] = [];
    const remove = vi.fn(async () => undefined);

    const exitCode = await runCli(['remove', '--id', input.instance_id], {
      paths,
      stdout: (line) => output.push(line),
      stderr: () => undefined,
      removeAssistant: remove,
      confirmRemoval: async () => false,
    });

    expect(exitCode).toBe(0);
    expect(output).toContain(
      `Google Cloud project: ${input.exclusive_resource_claims.gcp_project_id} (operator@example.test)`,
    );
    expect(output).toContain('Removal cancelled. Nothing was changed.');
    expect(remove).not.toHaveBeenCalled();
  });

  it('supports an explicit non-interactive confirmation', async () => {
    const { paths, input } = await fixture();
    const remove = vi.fn(async () => undefined);
    const confirm = vi.fn(async () => {
      throw new Error('confirmation must be skipped');
    });

    expect(
      await runCli(['remove', '--id', input.instance_id, '--yes'], {
        paths,
        stdout: () => undefined,
        stderr: () => undefined,
        removeAssistant: remove,
        confirmRemoval: confirm,
      }),
    ).toBe(0);
    expect(confirm).not.toHaveBeenCalled();
    expect(remove).toHaveBeenCalledWith(paths, input.instance_id);
  });
});
