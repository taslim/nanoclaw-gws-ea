import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { acquireInstanceOperation, reserveInstance, type InstanceOperation } from './journal.js';
import {
  advanceOperation,
  beginOperation,
  beginOperationReturn,
  closeOperationFailed,
  commitOperationRelease,
  completeFollowUp,
  discardOperation,
  inspectOperation,
  liveCheckoutCommits,
  OPERATION_PHASES,
  readOperationRecord,
  readRollbackPoint,
  recordOperationFacts,
  type OperationFollowUp,
  type OperationIntent,
  type OperationPhase,
} from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import { getInstanceReservation, swapInstanceRelease } from './registry.js';
import type { InstanceReservationInput, ReleaseCoordinates } from './types.js';

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
const MANIFEST = { central_migrations: ['001-initial'], session_tables: { 'inbound.messages_in': ['id'] } };
const REBUILD: OperationFollowUp = { kind: 'rebuild_group_image', agent_group_id: 'ag-main' };
const PRUNE: OperationFollowUp = { kind: 'prune' };

/** Every command that takes the instance lock but neither continues nor reverts an update. */
const CONFLICTING = ['create', 'resume', 'start', 'stop', 'restart', 'ncl'] as const;

function reservation(port: number): InstanceReservationInput {
  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
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
  const input = await reserveInstance(paths, reservation(35_001));
  return { paths, instanceId: input.instance_id };
}

async function held(paths: ControlPlanePaths, instanceId: string, intent: OperationIntent): Promise<InstanceOperation> {
  const operation = await acquireInstanceOperation(paths, instanceId, intent);
  if (!operation) throw new Error('The test instance operation was busy');
  return operation;
}

/** Drive an operation through the record's API up to `phase`, planning `followUps` as it is verified. */
async function drive(
  operation: InstanceOperation,
  phase: OperationPhase,
  followUps: readonly OperationFollowUp[],
  facts: { readonly mode?: 'code_only' | 'snapshot' } = {},
): Promise<void> {
  for (const next of OPERATION_PHASES.slice(1, OPERATION_PHASES.indexOf(phase) + 1)) {
    if (next === 'committed') await commitOperationRelease(operation);
    else if (next === 'fenced') await advanceOperation(operation, next, { stop: STOP, manifest: MANIFEST });
    else if (next === 'snapshotted') await advanceOperation(operation, next, facts);
    else if (next === 'verified') await advanceOperation(operation, next, { follow_ups: followUps });
    else await advanceOperation(operation, next);
  }
}

/** Drive an update from `FROM` to `TO` through the record's API up to `phase`. */
async function updateTo(
  paths: ControlPlanePaths,
  instanceId: string,
  phase: OperationPhase,
  followUps: readonly OperationFollowUp[] = [REBUILD, PRUNE],
): Promise<void> {
  const operation = await held(paths, instanceId, { command: 'update', target: TO });
  try {
    await beginOperation(operation, { kind: 'update', from: FROM, to: TO, manifest: MANIFEST });
    await drive(operation, phase, followUps);
  } finally {
    operation.release();
  }
}

async function rawRecord(paths: ControlPlanePaths, instanceId: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(paths.operationFile(instanceId), 'utf8')) as Record<string, unknown>;
}

describe('operation record', () => {
  it('begins at staged in its own owner-only file, committed through the registry', async () => {
    const { paths, instanceId } = await fixture();
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      const record = await beginOperation(operation, { kind: 'update', from: FROM, to: TO, manifest: MANIFEST });

      expect(record).toEqual({
        schema_version: 2,
        instance_id: instanceId,
        kind: 'update',
        commit_point: 'registry',
        from: FROM,
        to: TO,
        phase: 'staged',
        started_at: expect.any(String),
        updated_at: record.started_at,
        manifest: MANIFEST,
        follow_ups: [],
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
    await updateTo(paths, instanceId, 'fenced');
    const raw = await rawRecord(paths, instanceId);
    await writeFile(
      paths.operationFile(instanceId),
      JSON.stringify({ ...raw, future_fact: true, stop: { ...STOP, signal: 'SIGTERM' } }),
      { mode: 0o600 },
    );
    const read = await readOperationRecord(paths, instanceId);
    expect(read).toMatchObject({ phase: 'fenced', stop: STOP });
    expect(read).not.toHaveProperty('future_fact');

    // A record the swap's gws-ea wrote, which this one does not read.
    await writeFile(paths.operationFile(instanceId), JSON.stringify({ ...raw, schema_version: 1 }), { mode: 0o600 });
    const unsupported = await readOperationRecord(paths, instanceId).catch((error: unknown) => error);
    expect(unsupported).toMatchObject({ code: 'unsupported_operation' });
    expect((unsupported as Error).message).toContain(`gws-ea remove --id ${instanceId}`);

    await writeFile(paths.operationFile(instanceId), JSON.stringify({ ...raw, instance_id: randomUUID() }), {
      mode: 0o600,
    });
    await expect(readOperationRecord(paths, instanceId)).rejects.toMatchObject({ code: 'invalid_operation' });
    await writeFile(paths.operationFile(instanceId), JSON.stringify({ ...raw, stop: undefined }), { mode: 0o600 });
    await expect(readOperationRecord(paths, instanceId)).rejects.toMatchObject({ code: 'invalid_operation' });
    await writeFile(paths.operationFile(instanceId), '{torn', { mode: 0o600 });
    await expect(readOperationRecord(paths, instanceId)).rejects.toMatchObject({ code: 'invalid_operation' });
    await rm(paths.operationFile(instanceId));
    await expect(readOperationRecord(paths, instanceId)).resolves.toBeUndefined();
  });

  it('moves phases only forward, re-entering one with fresh facts, and commits only once verified', async () => {
    const { paths, instanceId } = await fixture();
    const operation = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await beginOperation(operation, { kind: 'update', from: FROM, to: TO });
      await expect(advanceOperation(operation, 'fenced')).rejects.toMatchObject({ code: 'invalid_operation' });
      expect(await advanceOperation(operation, 'fenced', { stop: STOP })).toMatchObject({
        phase: 'fenced',
        stop: STOP,
      });
      await expect(advanceOperation(operation, 'staged')).rejects.toMatchObject({ code: 'operation_phase_regression' });
      const refenced = { at: '2026-09-28T10:05:00.000Z', graceful: false };
      expect(await recordOperationFacts(operation, { stop: refenced })).toMatchObject({
        phase: 'fenced',
        stop: refenced,
      });
      await advanceOperation(operation, 'snapshotted');
      await advanceOperation(operation, 'switched');
      await expect(advanceOperation(operation, 'fenced')).rejects.toMatchObject({ code: 'operation_phase_regression' });
      await expect(commitOperationRelease(operation)).rejects.toMatchObject({ code: 'operation_phase' });
      await expect(
        recordOperationFacts(operation, { follow_ups: [{ kind: 'reclaim_image', image_id: 'latest' }] }),
      ).rejects.toMatchObject({ code: 'invalid_operation' });
    } finally {
      operation.release();
    }
    await expect(advanceOperation(operation, 'started')).rejects.toMatchObject({ code: 'operation_inactive' });
    expect((await readOperationRecord(paths, instanceId))?.phase).toBe('switched');
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
    expect((await getInstanceReservation(paths, instanceId)).deployed_commit).toBe(FROM.deployed_commit);
  });

  it('commits an update through the registry compare-and-swap, leaving the release it left to roll back to', async () => {
    const { paths, instanceId } = await fixture();
    const before = await getInstanceReservation(paths, instanceId);
    await updateTo(paths, instanceId, 'committed');

    expect(await getInstanceReservation(paths, instanceId)).toEqual({ ...before, ...TO });
    const committed = await readOperationRecord(paths, instanceId);
    expect(committed).toMatchObject({ phase: 'committed', follow_ups: [REBUILD, PRUNE] });
    expect(await readRollbackPoint(paths, instanceId)).toEqual({
      release: FROM,
      snapshot: committed!.started_at.replace(/[-:.]/gu, ''),
      manifest: MANIFEST,
      taken_at: STOP.at,
    });
    expect((await stat(paths.rollbackPointFile(instanceId))).mode & 0o777).toBe(0o600);

    const operation = await held(paths, instanceId, { command: 'start' });
    try {
      expect(await commitOperationRelease(operation)).toMatchObject({ phase: 'committed' });
      expect(await completeFollowUp(operation, PRUNE)).toEqual({
        ...committed,
        follow_ups: [REBUILD],
        updated_at: expect.any(String),
      });
      expect(await completeFollowUp(operation, REBUILD)).toBeUndefined();
    } finally {
      operation.release();
    }
    await expect(stat(paths.operationFile(instanceId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('commits a rollback through the registry, leaving nothing to roll back to', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'committed', []);
    expect(await readRollbackPoint(paths, instanceId)).toBeDefined();
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM });
      await drive(operation, 'committed', [], { mode: 'code_only' });
    } finally {
      operation.release();
    }

    expect((await getInstanceReservation(paths, instanceId)).deployed_commit).toBe(FROM.deployed_commit);
    expect(await readRollbackPoint(paths, instanceId)).toBeUndefined();
    expect(await readOperationRecord(paths, instanceId)).toBeUndefined();
  });

  it('reverts an update whose release may have started with a rollback committed by its record, keeping its start', async () => {
    const { paths, instanceId } = await fixture();
    // An earlier update committed, leaving FROM to roll back to; the next one, to NEWER, is reverted.
    await updateTo(paths, instanceId, 'committed', []);
    const point = await readRollbackPoint(paths, instanceId);
    expect(point?.release).toEqual(FROM);
    const update = await held(paths, instanceId, { command: 'update', target: NEWER });
    try {
      await beginOperation(update, { kind: 'update', from: TO, to: NEWER, manifest: MANIFEST });
      await drive(update, 'snapshotted', []);
    } finally {
      update.release();
    }
    const early = await held(paths, instanceId, { command: 'rollback' });
    try {
      await expect(beginOperation(early, { kind: 'rollback', from: NEWER, to: TO })).rejects.toMatchObject({
        code: 'operation_in_progress',
      });
    } finally {
      early.release();
    }

    const resumed = await held(paths, instanceId, { command: 'update', target: NEWER });
    try {
      // Switched, the live link may name its release, which a reboot can start.
      await advanceOperation(resumed, 'switched');
    } finally {
      resumed.release();
    }
    const started = (await readOperationRecord(paths, instanceId))!.started_at;
    const before = await readFile(paths.registryFile, 'utf8');
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      expect(await beginOperation(operation, { kind: 'rollback', from: NEWER, to: TO })).toMatchObject({
        kind: 'rollback',
        commit_point: 'record',
        phase: 'staged',
        started_at: started,
      });
      await drive(operation, 'committed', [PRUNE], { mode: 'snapshot' });
    } finally {
      operation.release();
    }
    expect(await readFile(paths.registryFile, 'utf8')).toBe(before);
    expect(await readOperationRecord(paths, instanceId)).toMatchObject({ phase: 'committed', kind: 'rollback' });
    // The rollback point stays as the earlier update left it: the reverted update never committed.
    expect(await readRollbackPoint(paths, instanceId)).toEqual(point);
  });

  it('carries the follow-ups of a committed update a rollback takes over, and gives them back if it ends uncommitted', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'committed', [REBUILD, PRUNE]);
    const committed = await readOperationRecord(paths, instanceId);
    const updating = await acquireInstanceOperation(paths, instanceId, { command: 'update', target: NEWER });
    try {
      await expect(beginOperation(updating!, { kind: 'update', from: TO, to: NEWER })).rejects.toMatchObject({
        code: 'operation_follow_ups_pending',
      });
    } finally {
      updating?.release();
    }
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      expect(await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM })).toMatchObject({
        kind: 'rollback',
        follow_ups: [REBUILD, PRUNE],
      });
      await advanceOperation(operation, 'fenced', { stop: STOP, manifest: MANIFEST });
      await discardOperation(operation);
    } finally {
      operation.release();
    }

    expect(await readOperationRecord(paths, instanceId)).toEqual({
      ...committed,
      started_at: expect.any(String),
      updated_at: expect.any(String),
      stop: undefined,
      manifest: undefined,
    });
  });

  it('goes back once a rollback fails, and closes it for fix-forward when going back fails too', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'committed', []);
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM });
      await drive(operation, 'switched', [], { mode: 'snapshot' });
      expect(await beginOperationReturn(operation)).toMatchObject({ returning: true, phase: 'switched' });
      await expect(advanceOperation(operation, 'started')).rejects.toMatchObject({ code: 'operation_phase' });
      expect(await closeOperationFailed(operation)).toMatchObject({ closed: 'failed', phase: 'switched' });
      expect(await readOperationRecord(paths, instanceId)).not.toHaveProperty('returning');
    } finally {
      operation.release();
    }
    const refusal = await acquireInstanceOperation(paths, instanceId, { command: 'rollback' }).catch(
      (error: unknown) => error,
    );
    expect((refusal as Error).message).toContain('failed, and so did returning to the release it left (switched)');
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
    await updateTo(paths, instanceId, 'committed', []);
    const operation = await held(paths, instanceId, { command: 'rollback' });
    try {
      await beginOperation(operation, { kind: 'rollback', from: TO, to: FROM });
    } finally {
      operation.release();
    }

    for (const intent of [{ command: 'start' }, { command: 'update', target: NEWER }] as const) {
      const refusal = await acquireInstanceOperation(paths, instanceId, intent).catch((error: unknown) => error);
      expect(refusal).toMatchObject({ code: 'operation_in_progress' });
      expect((refusal as Error).message).toContain(`Continue it with gws-ea rollback --id ${instanceId}.`);
      expect((refusal as Error).message).not.toContain('gws-ea update');
    }
    (await held(paths, instanceId, { command: 'rollback' })).release();
  });

  it('admits only an update to another release once closed for fix-forward, which supersedes it', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'started');
    const failing = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await closeOperationFailed(failing);
    } finally {
      failing.release();
    }

    for (const intent of [{ command: 'start' }, { command: 'rollback' }, { command: 'update', target: TO }] as const) {
      const refusal = await acquireInstanceOperation(paths, instanceId, intent).catch((error: unknown) => error);
      expect(refusal, intent.command).toMatchObject({ code: 'operation_failed' });
      // An update closed for fix-forward never tried to go back, and says so.
      expect((refusal as Error).message).toContain('failed and left no release to return to (started)');
      expect((refusal as Error).message).toContain(
        `update it to a newer release with gws-ea update --id ${instanceId}`,
      );
    }
    expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toMatchObject({
      state: 'failed',
      next: { continueWith: `gws-ea update --id ${instanceId}` },
    });
    const superseding = await held(paths, instanceId, { command: 'update', target: NEWER });
    try {
      expect(await beginOperation(superseding, { kind: 'update', from: FROM, to: NEWER })).toMatchObject({
        phase: 'staged',
        to: NEWER,
        no_rollback_target: true,
      });
      expect(await readOperationRecord(paths, instanceId)).not.toHaveProperty('closed');
      // Open with no release to return to, it may be superseded again, but never reverted.
      await drive(superseding, 'fenced', []);
    } finally {
      superseding.release();
    }
    (await held(paths, instanceId, { command: 'update', target: TO })).release();
    expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toMatchObject({
      state: 'open',
      next: { continueWith: `gws-ea update --id ${instanceId}` },
    });
  });

  it('treats a crash after the registry compare-and-swap as committed, settling its rollback point', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'verified', [REBUILD]);
    // The commit point ran, then the process died before writing `committed`.
    await swapInstanceRelease(paths, instanceId, FROM, TO);
    expect((await readOperationRecord(paths, instanceId))?.phase).toBe('verified');
    expect(await readRollbackPoint(paths, instanceId)).toBeUndefined();
    expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toMatchObject({
      state: 'committed',
      record: { phase: 'committed', follow_ups: [REBUILD] },
    });

    const rerun = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      expect(await readOperationRecord(paths, instanceId)).toMatchObject({ phase: 'committed', follow_ups: [REBUILD] });
      expect((await readRollbackPoint(paths, instanceId))?.release).toEqual(FROM);
      expect(await completeFollowUp(rerun, REBUILD)).toBeUndefined();
    } finally {
      rerun.release();
    }
  });

  it('releases the gate once committed: every command runs while follow-ups are pending', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'committed', [REBUILD]);

    const intents: readonly OperationIntent[] = [
      ...CONFLICTING.map((command) => ({ command })),
      { command: 'update', target: TO },
      { command: 'update', target: NEWER },
      { command: 'rollback' },
    ];
    for (const intent of intents) (await held(paths, instanceId, intent)).release();
    expect(await readOperationRecord(paths, instanceId)).toMatchObject({ phase: 'committed', follow_ups: [REBUILD] });
  });

  it('refuses every command while the record cannot be read', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'switched');
    await writeFile(paths.operationFile(instanceId), '{torn', { mode: 0o600 });

    for (const intent of [{ command: 'start' }, { command: 'rollback' }] as const) {
      await expect(acquireInstanceOperation(paths, instanceId, intent)).rejects.toMatchObject({
        code: 'invalid_operation',
      });
    }
  });

  it('gives a second concurrent update of the same assistant the busy outcome', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'fenced');
    const first = await held(paths, instanceId, { command: 'update', target: TO });
    try {
      await expect(acquireInstanceOperation(paths, instanceId, { command: 'update', target: TO })).resolves.toBeNull();
    } finally {
      first.release();
    }
  });

  it("never lets one assistant's record block a command on another", async () => {
    const paths = await testPaths();
    const a = (await reserveInstance(paths, reservation(35_101))).instance_id;
    const b = (await reserveInstance(paths, reservation(35_201))).instance_id;
    await updateTo(paths, a, 'switched');

    const intents: readonly OperationIntent[] = [
      ...CONFLICTING.map((command) => ({ command })),
      { command: 'update', target: TO },
      { command: 'rollback' },
    ];
    for (const intent of intents) (await held(paths, b, intent)).release();
    expect(await inspectOperation(paths, await getInstanceReservation(paths, b))).toEqual({ state: 'none' });
    await expect(acquireInstanceOperation(paths, a, { command: 'start' })).rejects.toMatchObject({
      code: 'operation_in_progress',
    });
  });
});

describe('operation inspection for list and status', () => {
  it('shows the phase and the named commands without the lock, while another command holds it', async () => {
    const { paths, instanceId } = await fixture();
    await updateTo(paths, instanceId, 'fenced');
    const holder = await held(paths, instanceId, { command: 'rollback' });
    try {
      expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toEqual({
        state: 'open',
        record: expect.objectContaining({ kind: 'update', phase: 'fenced', to: TO, stop: STOP }),
        next: { continueWith: `gws-ea update --id ${instanceId}`, revertWith: `gws-ea rollback --id ${instanceId}` },
      });
    } finally {
      holder.release();
    }
  });

  it('reports a record it cannot read without throwing', async () => {
    const { paths, instanceId } = await fixture();
    await writeFile(paths.operationFile(instanceId), '{torn', { mode: 0o600 });

    expect(await inspectOperation(paths, await getInstanceReservation(paths, instanceId))).toMatchObject({
      state: 'unreadable',
      code: 'invalid_operation',
    });
  });
});

describe('the releases the live link may name', () => {
  it("is the registry's, and while an operation is open or closed failed, either release it moves between", async () => {
    const { paths, instanceId } = await fixture();
    const reservation = await getInstanceReservation(paths, instanceId);
    expect(liveCheckoutCommits(reservation, undefined)).toEqual([FROM.deployed_commit]);
    await updateTo(paths, instanceId, 'switched');
    const open = await readOperationRecord(paths, instanceId);
    expect(liveCheckoutCommits(reservation, open)).toEqual([FROM.deployed_commit, TO.deployed_commit]);
    expect(liveCheckoutCommits(reservation, { ...open!, phase: 'committed' })).toEqual([FROM.deployed_commit]);
  });
});
