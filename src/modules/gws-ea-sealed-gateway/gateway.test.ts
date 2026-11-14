import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { ensureContainerConfig } from '../../db/container-configs.js';
import { closeDb, createAgentGroup, initTestDb, runMigrations } from '../../db/index.js';
import { reconcileSealedGateway, sealedGatewayDrift } from './gateway.js';
import { APP_SECRET, MODEL_SECRET, useFakeGateway } from './testing/fake-gateway.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'ag-sealed',
    name: 'sealed',
    folder: 'sealed',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await ensureContainerConfig('ag-sealed');
});

afterEach(async () => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  await closeDb();
});

it('assigns nothing while the model credential is ambiguous, naming the group', async () => {
  const gateway = useFakeGateway([MODEL_SECRET, { id: 'second-model', hostPattern: MODEL_SECRET.hostPattern }]);

  await expect(reconcileSealedGateway('ag-sealed', 'browser')).rejects.toThrow(
    'browser needs one unambiguous model credential',
  );
  expect(gateway.agents.size).toBe(0);
});

it('writes only its own identity, and reports one the gateway created with all secrets', async () => {
  const gateway = useFakeGateway([MODEL_SECRET, APP_SECRET]);
  const other = gateway.createDefault('ag-other', 'other');
  gateway.createDefault('ag-sealed', 'sealed');

  expect(await sealedGatewayDrift('ag-sealed', 'browser')).toEqual(['its gateway secret mode is not selective']);
  await reconcileSealedGateway('ag-sealed', 'browser');

  expect(gateway.agents.get('ag-sealed')).toMatchObject({ secretMode: 'selective', secrets: [MODEL_SECRET.id] });
  expect(other).toMatchObject({ secretMode: 'all', secrets: [] });
  expect(await sealedGatewayDrift('ag-sealed', 'browser')).toEqual([]);
});
