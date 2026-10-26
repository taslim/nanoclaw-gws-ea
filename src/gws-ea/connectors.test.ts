import { mkdtemp, readdir, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { inspectVoiceCapability } from './connectors.js';
import { resolveControlPlanePaths } from './paths.js';

let root: string;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'capability-catalog-')));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('shipped voice capability catalog', () => {
  it('reports host support independently from absent assets without creating optional state', async () => {
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    const voice = await inspectVoiceCapability(paths, { platform: 'win32', architecture: 'x64' });
    expect(voice).toMatchObject({
      name: 'voice',
      observed_at: expect.stringMatching(/^\d{4}-\d\d-\d\dT.*Z$/u),
      actions: ['show', 'check', 'install', 'enable', 'disable', 'uninstall'],
      scope: 'host',
      availability: { status: 'unsupported', platform: 'win32' },
      activation: { status: 'disabled', enabled: false },
      assets: { status: 'absent', installations: [] },
      assistants: [],
      default_model: 'base',
    });
    expect(await readdir(root)).toEqual([]);
  });
});
