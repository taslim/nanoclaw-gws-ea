import { expect, it } from 'vitest';

import { browserHealth } from './health.js';
import { BrowserRuntime } from './runtime.js';

it('observes host state without starting or reconciling the optional browser', async () => {
  const runtime = new BrowserRuntime();
  const health = await browserHealth(runtime.state());
  expect(health).toEqual({ schemaVersion: 1, policyVersions: [1, 2], ...runtime.state() });
  expect(health).toMatchObject({ enabled: false, proxy: { state: 'stopped' }, chrome: { state: 'stopped' } });
});
