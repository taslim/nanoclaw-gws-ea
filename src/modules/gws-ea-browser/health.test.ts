import { expect, it, vi } from 'vitest';

const runtime = vi.hoisted(() => ({
  reconcile: vi.fn(async () => undefined),
  state: vi.fn(() => ({ enabled: false, proxy: { state: 'stopped' }, chrome: { state: 'stopped' } })),
}));
vi.mock('./index.js', () => ({ getBrowserRuntime: () => runtime }));
import { browserHealth } from './health.js';

it('observes host state without starting or reconciling the optional browser', async () => {
  expect(await browserHealth()).toEqual({ schemaVersion: 1, policyVersions: [1, 2], ...runtime.state() });
  expect(runtime.reconcile).not.toHaveBeenCalled();
});
