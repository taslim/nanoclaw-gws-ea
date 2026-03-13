import { describe, it, expect } from 'vitest';

import { GChatChannel } from './channels/gchat.js';

describe('GChatChannel', () => {
  it('ownsJid returns true for gchat: prefix', () => {
    const channel = new GChatChannel({
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });
    expect(channel.ownsJid('gchat:ABC123')).toBe(true);
  });

  it('ownsJid returns false for non-gchat JIDs', () => {
    const channel = new GChatChannel({
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });
    expect(channel.ownsJid('120363@g.us')).toBe(false);
    expect(channel.ownsJid('tg:12345')).toBe(false);
  });

  it('isConnected returns false before connect', () => {
    const channel = new GChatChannel({
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });
    expect(channel.isConnected()).toBe(false);
  });

  it('has name "gchat"', () => {
    const channel = new GChatChannel({
      onMessage: () => {},
      onChatMetadata: () => {},
      registeredGroups: () => ({}),
    });
    expect(channel.name).toBe('gchat');
  });
});
