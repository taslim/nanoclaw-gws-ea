import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, createAgentGroup, getDb, initTestDb } from '../../db/index.js';
import { ensureContainerConfig, getContainerConfig } from '../../db/container-configs.js';
import { migrations, runMigrations } from '../../db/migrations/index.js';
// Side-effect import: registers the module migration.
import './index.js';

beforeEach(async () => {
  // A database from before the module: built-in migrations only.
  await runMigrations(await initTestDb(), migrations);
  await createAgentGroup({ id: 'ag-1', name: 'a', folder: 'a', agent_provider: null, created_at: '' });
  await ensureContainerConfig('ag-1');
});

afterEach(async () => {
  await closeDb();
});

describe('capabilities module migration', () => {
  it('gives every existing group all, under its permanent module name', async () => {
    expect((await getContainerConfig('ag-1'))!.capabilities).toBeUndefined();

    await runMigrations(getDb());

    expect((await getContainerConfig('ag-1'))!.capabilities).toBe('"all"');
    const applied = await getDb().all<{ name: string }>('SELECT name FROM schema_version');
    expect(applied.map((row) => row.name)).toContain('module:capabilities:container-config-capabilities');
  });

  it('gives a group created after it all', async () => {
    await runMigrations(getDb());
    await createAgentGroup({ id: 'ag-2', name: 'b', folder: 'b', agent_provider: null, created_at: '' });
    await ensureContainerConfig('ag-2');

    expect((await getContainerConfig('ag-2'))!.capabilities).toBe('"all"');
  });
});
