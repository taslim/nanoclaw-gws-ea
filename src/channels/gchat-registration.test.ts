import { describe, expect, it } from 'vitest';

import { getRegisteredChannelNames } from './channel-registry.js';
import './index.js';

describe('gchat channel registration', () => {
  it('registers gchat via the real channel barrel', () => {
    expect(getRegisteredChannelNames()).toContain('gchat');
  });
});
