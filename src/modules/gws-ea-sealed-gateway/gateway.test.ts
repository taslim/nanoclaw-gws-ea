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

it('writes only its own identity, and refuses one in legacy all-secrets mode', async () => {
  const gateway = useFakeGateway([MODEL_SECRET, APP_SECRET]);
  const other = gateway.createDefault('ag-other', 'other');
  other.secrets.push(MODEL_SECRET.id, APP_SECRET.id);
  const sealed = gateway.createDefault('ag-sealed', 'sealed');
  sealed.secretMode = 'all';

  expect(await sealedGatewayDrift('ag-sealed', 'browser')).toEqual(['its gateway secret mode is all']);
  await expect(reconcileSealedGateway('ag-sealed', 'browser')).rejects.toThrow('legacy all-secrets mode');
  expect(other).toMatchObject({ secretMode: 'selective', secrets: [MODEL_SECRET.id, APP_SECRET.id] });
});

it('replaces a non-model grant with strictly the model credential while leaving other agents untouched', async () => {
  const gateway = useFakeGateway([MODEL_SECRET, APP_SECRET]);
  const other = gateway.createDefault('ag-other', 'other');
  other.secrets.push(MODEL_SECRET.id, APP_SECRET.id);
  gateway.createDefault('ag-sealed', 'sealed').secrets.push(APP_SECRET.id);

  expect(await sealedGatewayDrift('ag-sealed', 'browser')).toEqual(['its gateway secret grants are not model-only']);
  await reconcileSealedGateway('ag-sealed', 'browser');

  expect(gateway.agents.get('ag-sealed')).toMatchObject({ secretMode: 'selective', secrets: [MODEL_SECRET.id] });
  expect(gateway.injected('ag-sealed', APP_SECRET.hostPattern)).toEqual([]);
  expect(gateway.injected('ag-sealed', MODEL_SECRET.hostPattern)).toEqual([MODEL_SECRET.id]);
  expect(other.secrets).toEqual([MODEL_SECRET.id, APP_SECRET.id]);
  expect(await sealedGatewayDrift('ag-sealed', 'browser')).toEqual([]);
});
