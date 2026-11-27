import { describe, expect, it } from 'vitest';

import { nodeHonorsEnvProxy } from './node-env-proxy.js';

describe('nodeHonorsEnvProxy', () => {
  it('accepts 22.21+, 24.5+ and 25+ only', () => {
    for (const v of ['22.21.0', '22.22.1', '24.5.0', '25.0.0']) expect(nodeHonorsEnvProxy(v)).toBe(true);
    for (const v of ['20.19.0', '22.20.0', '23.11.1', '24.0.0', '24.4.1']) expect(nodeHonorsEnvProxy(v)).toBe(false);
  });
});
