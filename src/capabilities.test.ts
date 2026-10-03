import fs from 'node:fs';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

vi.mock('./log.js', () => ({
  log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() },
}));

import {
  credentialsWithinCapabilities,
  grantsInstructions,
  isRestricted,
  listCapabilityKeys,
  parseCapabilitiesArg,
  parseStoredCapabilities,
  registerCapability,
  resolveCapabilities,
  skillsWithinCapabilities,
  teachesGateway,
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
  'schedule-stats',
  'calendar-facts',
];

// A key a module adds for one product agent: never part of `all`.
registerCapability('fixture-product-tools', { description: 'fixture', default: 'off', instructions: ['fixture'] });
// Keys a module adds whose tools reach stored gateway credentials.
registerCapability('fixture-vault-a', { description: 'fixture', default: 'off', credentials: ['vault-a'] });
registerCapability('fixture-vault-b', { description: 'fixture', default: 'off', credentials: ['vault-b', 'vault-a'] });

describe('capability registry', () => {
  it('registers every built-in key, with module keys after them', () => {
    expect(listCapabilityKeys()).toEqual([...BUILT_IN, 'fixture-product-tools', 'fixture-vault-a', 'fixture-vault-b']);
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
  const replyAndTime = new Set(['reply', 'time']);
  const all = new Set(resolveCapabilities('all', 'g'));

  it('brings only the instructions of held keys', () => {
    for (const doc of [
      'agents',
      'calendar-facts',
      'cli',
      'connect',
      'core',
      'files-send',
      'interactive',
      'memory',
      'schedule-stats',
      'scheduling',
      'self-mod',
      'time',
    ]) {
      expect(grantsInstructions(doc, all)).toBe(true);
    }
    expect(
      ['cli', 'connect', 'scheduling', 'self-mod', 'core', 'files-send', 'memory', 'time'].filter((doc) =>
        grantsInstructions(doc, replyAndTime),
      ),
    ).toEqual(['core', 'time']);
  });

  // `reply` teaches send_message alone; the file and reaction tools are taught
  // only with the key that grants them.
  it('splits the outbound tool documents between reply and files-send', () => {
    const read = (name: string): string =>
      fs.readFileSync(
        path.join(process.cwd(), 'container/agent-runner/src/mcp-tools', `${name}.instructions.md`),
        'utf8',
      );
    const core = read('core');
    const files = read('files-send');

    expect(core).toContain('`send_message`');
    for (const tool of ['send_file', 'add_reaction', 'edit_message']) expect(core).not.toContain(tool);
    expect(files).toContain('`send_file`');
    expect(files).toContain('`add_reaction`');
    expect(grantsInstructions('files-send', new Set(['reply']))).toBe(false);
    expect(grantsInstructions('files-send', new Set(['files-send']))).toBe(true);
  });

  it('leaves out instructions no key names', () => {
    expect(grantsInstructions('unclaimed-module', all)).toBe(false);
  });

  it('keeps a skill only with the keys it needs; an unnamed skill needs shell', () => {
    expect(skillsWithinCapabilities(['welcome', 'agent-browser', 'gcalendar'], all)).toEqual([
      'welcome',
      'agent-browser',
      'gcalendar',
    ]);
    expect(skillsWithinCapabilities(['welcome', 'agent-browser', 'gcalendar'], replyAndTime)).toEqual(['welcome']);
    expect(skillsWithinCapabilities(['welcome'], new Set(['time']))).toEqual([]);
  });

  it('names every credential the held keys bring, once each, in registry order', () => {
    expect(credentialsWithinCapabilities(new Set(['fixture-vault-b', 'reply', 'fixture-vault-a']))).toEqual([
      'vault-a',
      'vault-b',
    ]);
    expect(credentialsWithinCapabilities(new Set(['fixture-vault-b']))).toEqual(['vault-b', 'vault-a']);
    // Built-in keys name none, so a list of them may use no stored credential at all.
    expect(credentialsWithinCapabilities(all)).toEqual([]);
    expect(credentialsWithinCapabilities(replyAndTime)).toEqual([]);
  });

  it('teaches the gateway and lifts the read-only layers only with a shell', () => {
    expect(teachesGateway(all)).toBe(true);
    expect(isRestricted(all)).toBe(false);
    expect(teachesGateway(replyAndTime)).toBe(false);
    expect(isRestricted(replyAndTime)).toBe(true);
  });
});
