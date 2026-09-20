import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveControlPlanePaths } from './paths.js';
import { loadPrincipalSelection, persistPrincipalSelection } from './principal-selection.js';

const INSTANCE_ID = '12345678-1234-4123-8123-123456789abc';
const STARTED_AT = '2026-09-19T00:00:00.000Z';
const roots: string[] = [];

const selected = {
  messagingGroupId: 'mg-principal',
  platformId: 'gchat:spaces/dm-principal',
  userId: 'gchat:users/principal',
  senderName: 'Principal',
  authenticatedMessageId: 'spaces/dm-principal/messages/first',
  authenticatedMessageAt: '2026-09-19T00:01:00.000Z',
} as const;

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('durable principal selection', () => {
  it('persists the first exact authenticated candidate and refuses replacement', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-principal-selection-'));
    roots.push(root);
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    await mkdir(paths.instanceRoot(INSTANCE_ID), { recursive: true, mode: 0o700 });

    await expect(persistPrincipalSelection(paths, INSTANCE_ID, 'gchat', STARTED_AT, selected)).resolves.toEqual(
      selected,
    );
    await expect(loadPrincipalSelection(paths, INSTANCE_ID, 'gchat', STARTED_AT)).resolves.toMatchObject({
      candidate: selected,
    });
    await expect(
      persistPrincipalSelection(paths, INSTANCE_ID, 'gchat', STARTED_AT, {
        ...selected,
        messagingGroupId: 'mg-other',
        userId: 'gchat:users/other',
      }),
    ).rejects.toMatchObject({ code: 'principal_selection_mismatch' });
  });
});
