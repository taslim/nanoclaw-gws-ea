import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  grantsInstructions,
  listCapabilityKeys,
  parseCapabilitiesArg,
  parseStoredCapabilities,
  registerCapability,
  resolveCapabilities,
} from './capabilities.js';
import { log } from './log.js';

const BUILT_IN = [
  'reply',
  'files-send',
  'files-read',
  'files-write',
  'shell',
  'web',
  'subagents',
  'conversation-context',
  'mcp-servers',
  'interactive',
  'agents',
  'self-mod',
  'time',
  'request-status',
];

// A key a module adds for one product agent: never part of `all`.
registerCapability('fixture-product-tools', { description: 'fixture', default: 'off', instructions: ['fixture'] });

describe('capability registry', () => {
  it('registers every built-in key, with module keys after them', () => {
    expect(listCapabilityKeys()).toEqual([...BUILT_IN, 'fixture-product-tools']);
  });

  it('refuses a duplicate, malformed, or reserved key', () => {
    expect(() => registerCapability('reply', { description: 'again', default: 'on' })).toThrow(/already registered/);
    expect(() => registerCapability('Bad_Key', { description: 'x', default: 'on' })).toThrow(/lowercase/);
    expect(() => registerCapability('all', { description: 'x', default: 'on' })).toThrow(/not "all"/);
  });
});

describe('stored capabilities', () => {
  it('read an absent column as all, and a stored list as itself', () => {
    expect(parseStoredCapabilities(undefined, 'g')).toBe('all');
    expect(parseStoredCapabilities('"all"', 'g')).toBe('all');
    expect(parseStoredCapabilities('["time","reply"]', 'g')).toEqual(['time', 'reply']);
  });

  it('grant nothing for an unreadable value, loudly', () => {
    for (const raw of ['{not json', '"some"', '[1]', 'null']) {
      expect(parseStoredCapabilities(raw, 'g')).toEqual([]);
    }
    expect(log.error).toHaveBeenCalled();
  });

  it('resolve all to every key whose default is on', () => {
    expect(resolveCapabilities('all', 'g')).toEqual(BUILT_IN);
  });

  it('resolve a list in registry order, ignoring an unknown key with one warning', () => {
    vi.mocked(log.warn).mockClear();
    expect(resolveCapabilities(['time', 'teleport', 'reply'], 'g')).toEqual(['reply', 'time']);
    expect(resolveCapabilities(['teleport'], 'g')).toEqual([]);
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it('grant a default-off key only when listed', () => {
    expect(resolveCapabilities(['reply', 'fixture-product-tools'], 'g')).toEqual(['reply', 'fixture-product-tools']);
  });
});

describe('--capabilities argument', () => {
  it('takes all, or keys in any order and spacing', () => {
    expect(parseCapabilitiesArg(' all ')).toBe('all');
    expect(parseCapabilitiesArg('time, reply,reply')).toEqual(['reply', 'time']);
  });

  it('refuses an unknown key or an empty list, naming the keys', () => {
    expect(() => parseCapabilitiesArg('reply,teleport')).toThrow(/unknown capability "teleport" — keys: reply/);
    expect(() => parseCapabilitiesArg(' , ')).toThrow(/"all" or comma-separated keys/);
  });
});

describe('what a list grants on the host', () => {
  const all = new Set(resolveCapabilities('all', 'g'));

  it('leaves out instructions no key names', () => {
    expect(grantsInstructions('unclaimed-module', all)).toBe(false);
  });
});
