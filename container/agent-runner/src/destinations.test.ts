import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './db/connection.js';
import { buildSystemPromptAddendum } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

function seedDestination(
  name: string,
  displayName: string,
  channelType: string,
  platformId: string,
  kind: 'chat' | 'email' = 'chat',
): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, kind)
       VALUES (?, ?, 'channel', ?, ?, NULL, ?)`,
    )
    .run(name, displayName, channelType, platformId, kind);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa');

    expect(prompt).toContain('Wrap each delivered message');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });

  it('emits the email voice contract and tags email destinations when one is present', () => {
    seedDestination('principal', 'Owner', 'gchat', 'gchat:spaces/X', 'chat');
    seedDestination('email-external', 'External', 'email', 'email:external', 'email');

    const prompt = buildSystemPromptAddendum('Andy');

    expect(prompt).toContain('`[email]`');
    expect(prompt).toContain('Email destinations');
    expect(prompt).toContain('write proper emails to the recipient');
    expect(prompt).toContain('third-person');
    expect(prompt).toMatch(/`principal`(?! `\[email\]`)/);
  });

  it('omits the email voice contract when no email destinations are wired', () => {
    seedDestination('principal', 'Owner', 'gchat', 'gchat:spaces/X', 'chat');
    seedDestination('heartbeat', 'Heartbeat', 'gchat', 'gchat:spaces/Y', 'chat');

    const prompt = buildSystemPromptAddendum('Andy');

    expect(prompt).not.toContain('Email destinations');
    expect(prompt).not.toContain('`[email]`');
  });

  it('drops the blanket "Default to silence" / "never reply in inbound" rules', () => {
    seedDestination('principal', 'Owner', 'gchat', 'gchat:spaces/X');
    seedDestination('heartbeat', 'Heartbeat', 'gchat', 'gchat:spaces/Y');

    const prompt = buildSystemPromptAddendum('Andy');

    expect(prompt).not.toContain('Default to silence');
    expect(prompt).not.toContain('Never route status updates');
  });
});
