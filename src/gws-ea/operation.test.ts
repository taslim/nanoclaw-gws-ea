import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireInstanceOperation, reserveInstance, type InstanceOperation } from './journal.js';
import {
  advanceOperation,
  beginOperation,
  commitOperationRelease,
  completeFollowUp,
  discardOperation,
  inspectOperation,
  liveCheckoutCommits,
  OPERATION_PHASES,
  readOperationRecord,
  recordOperationFacts,
  targetReservationView,
  type OperationFollowUp,
  type OperationIntent,
  type OperationPhase,
  type OperationRecord,
} from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { allocateInstanceId, getInstanceReservation, readRegistry, swapInstanceRelease } from './registry.js';
import type { InstanceReservation, InstanceReservationInput, ReleaseCoordinates } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const SOURCE = 'https://example.test/nanoclaw.git';
const FROM: ReleaseCoordinates = { source_remote: SOURCE, release_track: 'dogfood', deployed_commit: 'a'.repeat(40) };
const TO: ReleaseCoordinates = {
  source_remote: 'https://example.test/nanoclaw-prod.git',
  release_track: 'prod',
  deployed_commit: 'b'.repeat(40),
};
const NEWER: ReleaseCoordinates = { ...TO, deployed_commit: 'c'.repeat(40) };
const STOP = { at: '2026-09-28T10:00:00.000Z', graceful: true } as const;
const REBUILD: OperationFollowUp = { kind: 'rebuild_group_image', agent_group_id: 'ag-main' };
const CLEANUP: OperationFollowUp = { kind: 'delete_release', release: 'superseded_previous' };

/** Every command that takes the instance lock but neither continues nor reverts an update. */
const CONFLICTING = ['create', 'resume', 'start', 'stop', 'restart', 'ncl'] as const;

function reservation(paths: ControlPlanePaths, port: number): InstanceReservationInput {
  const instanceId = allocateInstanceId();
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    ...FROM,
    allocated_ports: { nanoclaw_webhook: port, onecli_app: port + 1, onecli_gateway: port + 2 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: `https://a${port}.example.test/webhook/gchat` },
      gcp_project_id: `operation-${port}`,
      gcp_account: 'operator@example.test',
      gchat_service_account: `gws-ea-chat@operation-${port}.iam.gserviceaccount.com`,
      workspace_email: `assistant-${port}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-operation-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

async function fixture(): Promise<{ paths: ControlPlanePaths; instanceId: string }> {
  const paths = await testPaths();
  const input = await reserveInstance(paths, reservation(paths, 35_001));
  return { paths, instanceId: input.instance_id };
}

async function held(paths: ControlPlanePaths, instanceId: string, intent: OperationIntent): Promise<InstanceOperation> {
  const operation = await acquireInstanceOperation(paths, instanceId, intent);
  if (!operation) throw new Error('The test instance operation was busy');
  return operation;
}

/** Drive an update from `FROM` to `TO` through the record's API up to `phase`. */
async function updateTo(
  paths: ControlPlanePaths,
  instanceId: string,
  phase: OperationPhase,
  followUps: readonly OperationFollowUp[] = [REBUILD],
): Promise<void> {
  const operation = await held(paths, instanceId, { command: 'update', target: TO });
  try {
    await beginOperation(operation, { kind: 'update', from: FROM, to: TO, follow_ups: followUps });
    for (const next of OPERATION_PHASES.slice(1, OPERATION_PHASES.indexOf(phase) + 1)) {
      if (next === 'recorded') await commitOperationRelease(operation);
      else await advanceOperation(operation, next, next === 'stopped' ? { stop: STOP } : {});
    }
  } finally {
    operation.release();
  }
}

async function rawRecord(paths: ControlPlanePaths, instanceId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.operationFile(instanceId), 'utf8')) as Record<string, unknown>;
}

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

describe('operation record', () => {
  it('begins at staged in its own owner-only file, committed through the registry', async () => {
    const { paths, instanceId } = await fixture();
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      const record = await beginOperation(operation, { kind: 'update', from: FROM, to: TO, follow_ups: [REBUILD] });

      expect(record).toEqual({
        schema_version: 1,
        instance_id: instanceId,
        kind: 'update',
        commit_point: 'registry',
        from: FROM,
        to: TO,
        phase: 'staged',
        started_at: expect.any(String),
        updated_at: record.started_at,
        images: [],
        follow_ups: [REBUILD],
      });
      expect(paths.operationFile(instanceId)).toBe(path.join(paths.instanceRoot(instanceId), 'operation.json'));
      expect((await stat(paths.operationFile(instanceId))).mode & 0o777).toBe(0o600);
      await expect(readOperationRecord(paths, instanceId)).resolves.toEqual(record);
    } finally {
      operation.release();
    }
  });

  it('reads back ignoring unknown fields, and refuses a record it cannot interpret', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'stopped');
    const raw = await rawRecord(paths, instanceId);
    await writeFile(
      paths.operationFile(instanceId),
      JSON.stringify({ ...raw, future_fact: true, stop: { ...STOP, signal: 'SIGTERM' } }),
      { mode: 0o600 },
    );
    const read = await readOperationRecord(paths, instanceId);
    expect(read).toMatchObject({ phase: 'stopped', stop: STOP });
    expect(read).not.toHaveProperty('future_fact');

    await writeFile(paths.operationFile(instanceId), JSON.stringify({ ...raw, schema_version: 2 }), { mode: 0o600 });
    const unsupported = await readOperationRecord(paths, instanceId).catch((error: unknown) => error);
    expect(unsupported).toMatchObject({ code: 'unsupported_operation' });
    expect((unsupported as Error).message).toContain(`gws-ea remove --id ${instanceId}`);

    await writeFile(paths.operationFile(instanceId), JSON.stringify({ ...raw, instance_id: allocateInstanceId() }), {
      mode: 0o600,
    });
    await expect(readOperationRecord(paths, instanceId)).rejects.toMatchObject({ code: 'invalid_operation' });
    await writeFile(paths.operationFile(instanceId), '{torn', { mode: 0o600 });
    await expect(readOperationRecord(paths, instanceId)).rejects.toMatchObject({ code: 'invalid_operation' });
    await rm(paths.operationFile(instanceId));
    await expect(readOperationRecord(paths, instanceId)).resolves.toBeUndefined();
  });

  it('moves phases only forward, except reversing the renames from swapping back to stopped', async () => {
    const { paths, instanceId } = await fixture();
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await beginOperation(operation, { kind: 'update', from: FROM, to: TO });
      await expect(advanceOperation(operation, 'stopped')).rejects.toMatchObject({ code: 'invalid_operation' });
      const stopped = await advanceOperation(operation, 'stopped', { stop: STOP });
      expect(stopped).toMatchObject({ phase: 'stopped', stop: STOP });
      await expect(advanceOperation(operation, 'staged')).rejects.toMatchObject({ code: 'operation_phase_regression' });

      const restopped = { at: '2026-09-28T10:05:00.000Z', graceful: false };
      expect(await advanceOperation(operation, 'stopped', { stop: restopped })).toMatchObject({ stop: restopped });
      await advanceOperation(operation, 'swapping');
      expect(await advanceOperation(operation, 'stopped')).toMatchObject({ phase: 'stopped' });
      await advanceOperation(operation, 'swapping');
      await advanceOperation(operation, 'swapped');
      await expect(advanceOperation(operation, 'stopped')).rejects.toMatchObject({
        code: 'operation_phase_regression',
      });

      const manifest = { central_migrations: ['001-initial'], session_tables: { messages_in: ['id', 'on_wake'] } };
      const images = [
        {
          tag: 'nanoclaw-agent-v2-x:latest',
          image_id: `sha256:${'f'.repeat(64)}`,
          displaced_image_id: `sha256:${'e'.repeat(64)}`,
        },
        { tag: 'nanoclaw-agent-v2-x:previous', image_id: `sha256:${'e'.repeat(64)}`, displaced_image_id: null },
      ];
      const facts = await recordOperationFacts(operation, { manifest, images });
      expect(facts).toMatchObject({ phase: 'swapped', manifest, images });
      await expect(readOperationRecord(paths, instanceId)).resolves.toMatchObject({ images });
      await expect(
        recordOperationFacts(operation, { images: [{ ...images[0]!, image_id: 'latest' }] }),
      ).rejects.toMatchObject({ code: 'invalid_operation' });
      await expect(advanceOperation(operation, 'recorded')).rejects.toMatchObject({ code: 'operation_phase' });
      await expect(commitOperationRelease(operation)).rejects.toMatchObject({ code: 'operation_phase' });
    } finally {
      operation.release();
    }
    await expect(advanceOperation(operation, 'started')).rejects.toMatchObject({ code: 'operation_inactive' });
    expect((await readOperationRecord(paths, instanceId))?.phase).toBe('swapped');
  });

  it('begins only from the release the registry names, toward a different commit, with no other record', async () => {
    const { paths, instanceId } = await fixture();
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await expect(beginOperation(operation, { kind: 'update', from: NEWER, to: TO })).rejects.toMatchObject({
        code: 'reservation_mismatch',
      });
      await expect(
        beginOperation(operation, { kind: 'update', from: FROM, to: { ...TO, deployed_commit: FROM.deployed_commit } }),
      ).rejects.toMatchObject({ code: 'invalid_operation' });
      await beginOperation(operation, { kind: 'update', from: FROM, to: TO });
      await expect(beginOperation(operation, { kind: 'update', from: FROM, to: NEWER })).rejects.toMatchObject({
        code: 'operation_in_progress',
      });
    } finally {
      operation.release();
    }
    expect(await exists(paths.operationFile(instanceId))).toBe(true);
    expect((await getInstanceReservation(paths, instanceId)).deployed_commit).toBe(FROM.deployed_commit);
  });

  it('reverts an update that was never recorded with a rollback committed by its record, not the registry', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'stopped');
    const early = await held(paths, instanceId, { command: 'rollback' });
    try {
      await expect(beginOperation(early, { kind: 'rollback', from: TO, to: FROM })).rejects.toMatchObject({
        code: 'operation_in_progress',
      });
      // Before any rename, reverting is discarding the staging.
      await discardOperation(early);
    } finally {
      early.release();
    }
    expect(await readOperationRecord(paths, instanceId)).toBeUndefined();

    await updateTo(paths, instanceId, 'started');
    const before = await readFile(paths.registryFile, 'utf8');
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      await expect(discardOperation(operation)).rejects.toMatchObject({ code: 'operation_in_progress' });
      const reverting = await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM });
      expect(reverting).toMatchObject({
        kind: 'rollback',
        commit_point: 'record',
        phase: 'staged',
        from: TO,
        to: FROM,
      });
      await advanceOperation(operation, 'stopped', { stop: STOP });
      for (const phase of ['swapping', 'swapped', 'started', 'verified'] as const) {
        await advanceOperation(operation, phase);
      }
      expect(await commitOperationRelease(operation)).toBeUndefined();
    } finally {
      operation.release();
    }
    expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
    expect(await readOperationRecord(paths, instanceId)).toBeUndefined();
  });

  it('records through the registry compare-and-swap, moving only the release, and keeps pending follow-ups', async () => {
    const { paths, instanceId } = await fixture();
    const before = await getInstanceReservation(paths, instanceId);
    await updateTo(paths, instanceId, 'recorded', [REBUILD, CLEANUP]);

    expect(await getInstanceReservation(paths, instanceId)).toEqual({ ...before, ...TO });
    const recorded = await readOperationRecord(paths, instanceId);
    expect(recorded).toMatchObject({ phase: 'recorded', follow_ups: [REBUILD, CLEANUP] });

    const operation = await held(paths, instanceId, { command: 'start' });
    try {
      await expect(advanceOperation(operation, 'verified')).rejects.toMatchObject({ code: 'operation_phase' });
      expect(await commitOperationRelease(operation)).toMatchObject({ phase: 'recorded' });
      expect(await completeFollowUp(operation, { release: 'superseded_previous', kind: 'delete_release' })).toEqual({
        ...recorded,
        follow_ups: [REBUILD],
        updated_at: expect.any(String),
      });
      expect(await completeFollowUp(operation, REBUILD)).toBeUndefined();
    } finally {
      operation.release();
    }
    expect(await exists(paths.operationFile(instanceId))).toBe(false);
  });

  it('deletes the record when it is recorded with nothing left to follow up', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'recorded', []);

    expect(await exists(paths.operationFile(instanceId))).toBe(false);
    expect((await getInstanceReservation(paths, instanceId)).deployed_commit).toBe(TO.deployed_commit);
  });
});

describe('operation gate', () => {
  it('refuses every conflicting command from staged through verified, naming the commands that continue or revert', async () => {
    const { paths, instanceId } = await fixture();
    for (const phase of OPERATION_PHASES.slice(0, -1)) {
      await rm(paths.operationFile(instanceId), { force: true });
      await updateTo(paths, instanceId, phase);
      for (const command of CONFLICTING) {
        const refusal = await acquireInstanceOperation(paths, instanceId, { command }).catch((error: unknown) => error);
        expect(refusal, `${command} at ${phase}`).toMatchObject({ code: 'operation_in_progress' });
        expect((refusal as Error).message).toContain(`(${phase})`);
        expect((refusal as Error).message).toContain(`gws-ea update --id ${instanceId}`);
        expect((refusal as Error).message).toContain(`gws-ea rollback --id ${instanceId}`);
      }
      const moved = await acquireInstanceOperation(paths, instanceId, { command: 'update', target: NEWER }).catch(
        (error: unknown) => error,
      );
      expect(moved).toMatchObject({ code: 'operation_in_progress' });
      expect((moved as Error).message).toContain(`from the gws-ea at ${TO.deployed_commit.slice(0, 12)}`);

      // The refusal released the lock; the commands that continue and revert are admitted.
      for (const intent of [{ command: 'update', target: TO }, { command: 'rollback' }] as const) {
        (await held(paths, instanceId, intent)).release();
      }
    }
  });

  it('names only rollback for an unfinished rollback, and refuses an update meanwhile', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'swapped');
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM });
    } finally {
      operation.release();
    }

    for (const intent of [{ command: 'start' }, { command: 'update', target: TO }] as const) {
      const refusal = await acquireInstanceOperation(paths, instanceId, intent).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'operation_in_progress' });
      expect((refusal as Error).message).toContain(`Continue it with gws-ea rollback --id ${instanceId}.`);
      expect((refusal as Error).message).not.toContain('gws-ea update');
    }
    (await held(paths, instanceId, { command: 'rollback' })).release();
  });

  it('treats a crash after the registry compare-and-swap as recorded, so rerunning update finishes', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'verified', [REBUILD]);
    // The commit point ran, then the process died before writing `recorded`.
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await swapInstanceRelease(paths, instanceId, FROM, TO);
      expect((await getInstanceReservation(paths, instanceId)).deployed_commit).toBe(TO.deployed_commit);
    } finally {
      operation.release();
    }
    expect((await readOperationRecord(paths, instanceId))?.phase).toBe('verified');
    expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toMatchObject({
      state: 'recorded',
      record: { phase: 'recorded', follow_ups: [REBUILD] },
    });

    const rerun = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      expect(await readOperationRecord(paths, instanceId)).toMatchObject({ phase: 'recorded', follow_ups: [REBUILD] });
      expect(await completeFollowUp(rerun, REBUILD)).toBeUndefined();
    } finally {
      rerun.release();
    }
    expect(await exists(paths.operationFile(instanceId))).toBe(false);
  });

  it('releases the gate at recorded: every command runs while follow-ups are pending', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'recorded', [REBUILD]);

    const intents: readonly OperationIntent[] = [
      ...CONFLICTING.map((command) => ({ command })),
      { command: 'update', target: TO },
      { command: 'update', target: NEWER },
      { command: 'rollback' },
    ];
    for (const intent of intents) (await held(paths, instanceId, intent)).release();
    expect(await readOperationRecord(paths, instanceId)).toMatchObject({ phase: 'recorded', follow_ups: [REBUILD] });
  });

  it('refuses every command while the record cannot be read', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'swapped');
    await writeFile(paths.operationFile(instanceId), '{torn', { mode: 0o600 });

    for (const intent of [{ command: 'start' }, { command: 'rollback' }] as const) {
      await expect(acquireInstanceOperation(paths, instanceId, intent)).rejects.toMatchObject({
        code: 'invalid_operation',
      });
    }
  });

  it('gives a second concurrent update of the same assistant the busy outcome', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'stopped');
    const first = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await expect(acquireInstanceOperation(paths, instanceId, { command: 'update', target: TO })).resolves.toBeNull();
    } finally {
      first.release();
    }
  });

  it("never lets one assistant's record block a command on another", async () => {
    const paths = await testPaths();
    const a = (await reserveInstance(paths, reservation(paths, 35_101))).instance_id;
    const b = (await reserveInstance(paths, reservation(paths, 35_201))).instance_id;
    await updateTo(paths, a, 'swapped');

    const intents: readonly OperationIntent[] = [
      ...CONFLICTING.map((command) => ({ command })),
      { command: 'update', target: TO },
      { command: 'rollback' },
    ];
    for (const intent of intents) (await held(paths, b, intent)).release();
    expect(await inspectOperation(paths, await getInstanceReservation(paths, b))).toEqual({
      state: 'none',
      abandonedStaging: false,
    });
    await expect(acquireInstanceOperation(paths, a, { command: 'start' })).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
  });
});

describe('operation inspection for list and status', () => {
  it('shows the phase and the named commands without the lock, while another command holds it', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'stopped');
    const holder = await held(paths, instanceId, { command: 'rollback' });
    try {
      expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toEqual({
        state: 'open',
        record: expect.objectContaining({ kind: 'update', phase: 'stopped', to: TO, stop: STOP }),
        next: { continueWith: `gws-ea update --id ${instanceId}`, revertWith: `gws-ea rollback --id ${instanceId}` },
      });
    } finally {
      holder.release();
    }
  });

  it('reports staging left with no open record, and a record it cannot read, without throwing', async () => {
    const { paths, instanceId } = await fixture();
    const reserved = await getInstanceReservation(paths, instanceId);
    expect(await inspectOperation(paths, reserved)).toEqual({ state: 'none', abandonedStaging: false });

    await mkdir(paths.releaseCheckoutRoot(instanceId, 'next'), { recursive: true, mode: 0o700 });
    expect(await inspectOperation(paths, reserved)).toEqual({ state: 'none', abandonedStaging: true });

    await updateTo(paths, instanceId, 'staged');
    expect(await inspectOperation(paths, reserved)).toMatchObject({ state: 'open', record: { phase: 'staged' } });

    await writeFile(paths.operationFile(instanceId), JSON.stringify({ schema_version: 9 }), { mode: 0o600 });
    expect(await inspectOperation(paths, reserved)).toMatchObject({
      state: 'unreadable',
      code: 'unsupported_operation',
    });
  });
});

describe('target reservation view and live checkout agreement (KTD17)', () => {
  it('accepts the recorded release, then the target from swapping on, never another commit', async () => {
    const { paths, instanceId } = await fixture();
    const reserved = await getInstanceReservation(paths, instanceId);
    expect(liveCheckoutCommits(reserved, undefined)).toEqual([FROM.deployed_commit]);

    const expected: Readonly<Record<Exclude<OperationPhase, 'recorded'>, readonly string[]>> = {
      staged: [FROM.deployed_commit],
      stopped: [FROM.deployed_commit],
      swapping: [FROM.deployed_commit, TO.deployed_commit],
      swapped: [FROM.deployed_commit, TO.deployed_commit],
      started: [FROM.deployed_commit, TO.deployed_commit],
      verified: [FROM.deployed_commit, TO.deployed_commit],
    };
    const base: OperationRecord = {
      schema_version: 1,
      instance_id: instanceId,
      kind: 'update',
      commit_point: 'registry',
      from: FROM,
      to: TO,
      phase: 'staged',
      started_at: STOP.at,
      updated_at: STOP.at,
      images: [],
      follow_ups: [],
    };
    for (const [phase, commits] of Object.entries(expected)) {
      expect(liveCheckoutCommits(reserved, { ...base, phase: phase as OperationPhase })).toEqual(commits);
    }
    // A rollback reverting an unrecorded update starts from the target the registry never named.
    const reverting: OperationRecord = { ...base, kind: 'rollback', commit_point: 'record', from: TO, to: FROM };
    expect(liveCheckoutCommits(reserved, reverting)).toEqual([FROM.deployed_commit, TO.deployed_commit]);
    expect(liveCheckoutCommits(reserved, { ...reverting, phase: 'swapped' })).toEqual([FROM.deployed_commit]);

    const view: InstanceReservation = targetReservationView(reserved, base);
    expect(view).toEqual({ ...reserved, ...TO });
    expect((await readRegistry(paths)).instances[instanceId]).toEqual(reserved);
    expect(() => targetReservationView(reserved, { ...base, instance_id: allocateInstanceId() })).toThrow(
      expect.objectContaining({ code: 'operation_mismatch' }),
    );
  });
});
