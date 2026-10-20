import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { closeSessionDb, getInboundDb, initTestSessionDb } from './mailbox/sqlite/connection.js';
import { buildSystemPromptAddendum, type SessionMode } from './destinations.js';

beforeEach(() => {
  initTestSessionDb();
});

afterEach(() => {
  closeSessionDb();
});

const CHAT: SessionMode = { kind: 'chat' };
/** A chat agent's grants: `reply` holds `send_message`. */
const REPLY: ReadonlySet<string> = new Set(['reply']);
/** An agent that answers only through its own tools and message blocks, as external-email does. */
const NO_REPLY: ReadonlySet<string> = new Set(['files-read', 'time']);

function seedDestination(name: string, displayName: string, channelType: string, platformId: string): void {
  getInboundDb()
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', ?, ?, NULL)`,
    )
    .run(name, displayName, channelType, platformId);
}

describe('buildSystemPromptAddendum — multi-destination routing guidance', () => {
  it('includes default-routing nudge when there are >1 destinations', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    seedDestination('whatsapp-mg-17780', 'whatsapp-mg-17780', 'whatsapp', 'phone-2@s.whatsapp.net');

    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('your answer still has to be sent after it');
    expect(prompt).toContain('from="name"');
    expect(prompt).toContain('`casa`');
    expect(prompt).toContain('`whatsapp-mg-17780`');
  });

  it('describes message wrapping for a single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('Wrap every reply in a `<message to="name">');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('`casa`');
  });

  it('tells a chat agent that text outside a block stays private, and that a reply already sent ends the turn', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const chat = buildSystemPromptAddendum('Casa', CHAT, REPLY);
    const task = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'daily-briefing-a25c' }, REPLY);

    expect(chat).toContain('Wrap every reply in a `<message to="name">…</message>` block: text outside a block is not delivered');
    expect(chat).toContain('When `send_message` has already delivered your reply, end the turn without another block');
    expect(chat).not.toContain('finish with the outcome');
    expect(task).not.toContain('already delivered your reply');
  });

  it('handles the no-destination case without crashing', () => {
    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('no configured destinations');
    expect(prompt).not.toContain('default to addressing');
  });

  it('includes default-routing and wrapping instructions for single destination', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('Wrap every reply in a `<message to="name">');
    expect(prompt).toContain('<message to="name">');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('`casa`');
  });

  it('gives task sessions only explicit-tool delivery instructions', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'daily-briefing-a25c' }, REPLY);

    expect(prompt).toContain('isolated task run');
    expect(prompt).toContain('send_message({ to: "name"');
    expect(prompt).toContain('tasks/daily-briefing-a25c.md');
    expect(prompt).toContain('Only notify someone when the task asks');
    expect(prompt).not.toContain('<message to=');
    expect(prompt).not.toContain('default to addressing');
  });

  it("defaults task escalation to the agent's own channel instead of its parent agent", () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'Parent', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' }, REPLY);

    expect(prompt).toContain(
      'For user-visible escalation output, default to your own channel destination(s): `casa`',
    );
    expect(prompt).toContain(
      'Use an agent-type destination like `parent` only when the task explicitly calls for routing through another agent, not as your default escalation path.',
    );
    expect(prompt).not.toContain('default to `parent`');
  });

  it('keeps generic task guidance when no channel destination exists', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
         VALUES ('parent', 'Parent', 'agent', NULL, NULL, 'ag-parent')`,
      )
      .run();

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' }, REPLY);

    expect(prompt).toContain('Always pass the explicit named destination.');
    expect(prompt).not.toContain('For user-visible escalation output, default to');
    expect(prompt).not.toContain('your own channel destination(s):');
  });
});

describe('buildSystemPromptAddendum — reading messages', () => {
  it('explains the inbound block kinds in chat mode, after the sending section', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('## Reading messages');
    expect(prompt).toContain('<cross-session-context>');
    expect(prompt).toContain('<dm-history>');
    expect(prompt).toContain('`sender="you"` marks your own');
    expect(prompt).toContain('ask.');
    expect(prompt.indexOf('## Sending messages')).toBeLessThan(prompt.indexOf('## Reading messages'));
  });

  it('names a scheduled task that comes back to the conversation, and lets one with nothing to say stay quiet', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const reading = buildSystemPromptAddendum('Casa', CHAT, REPLY).split('## Reading messages')[1] ?? '';

    expect(reading).toContain('`<task>`');
    expect(reading).toContain('end the turn without a block');
  });

  it('omits the reading section in task mode, which never receives echoes', () => {
    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' }, REPLY);

    expect(prompt).not.toContain('Reading messages');
    expect(prompt).not.toContain('cross-session-context');
  });
});

describe('buildSystemPromptAddendum — who the agent is', () => {
  it('names the agent and leaves signing to its guidance', () => {
    const prompt = buildSystemPromptAddendum('Remy Vance', CHAT, REPLY);

    expect(prompt).toContain('# You are Remy Vance');
    expect(prompt).toContain(
      'Your name is **Remy Vance**. Use it when the channel asks who you are and when introducing yourself. Sign only where your guidance asks for it.',
    );
    expect(prompt).not.toContain('when signing');
  });
});

describe('buildSystemPromptAddendum — delivery worded for the tools the agent holds', () => {
  const QUIET = 'When a turn has nothing to send, end it with only `<internal>…</internal>`';

  it('teaches send_message, the sent-reply ending and pacing only to an agent holding reply', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', CHAT, REPLY);

    expect(prompt).toContain('The `send_message` MCP tool is the same delivery, available mid-turn.');
    expect(prompt).toContain('When `send_message` has already delivered your reply');
    expect(prompt).toContain('send one acknowledgment and then updates only at meaningful milestones');
  });

  it('gives an agent without reply no send_message, "on it" or acknowledgment wording, and keeps blocks, routing and no narration', () => {
    seedDestination('inbox', 'Inbox', 'email', 'thread-1');

    const prompt = buildSystemPromptAddendum('Remy Vance', CHAT, NO_REPLY);

    expect(prompt).not.toContain('send_message');
    expect(prompt).not.toContain('"on it"');
    expect(prompt).not.toMatch(/acknowledg/iu);
    expect(prompt).toContain('Wrap every reply in a `<message to="name">…</message>` block');
    expect(prompt).toContain('default to addressing the destination it came `from`');
    expect(prompt).toContain('Do not narrate your work: make each message the outcome, not a play-by-play.');
  });

  it('tells every chat agent that a turn with nothing to send ends with only <internal>, beside the wrapping rule', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    for (const capabilities of [REPLY, NO_REPLY]) {
      const prompt = buildSystemPromptAddendum('Casa', CHAT, capabilities);
      expect(prompt).toContain(QUIET);
      expect(prompt.indexOf(QUIET)).toBeGreaterThan(prompt.indexOf('Wrap every reply'));
      expect(prompt.indexOf(QUIET)).toBeLessThan(prompt.indexOf('default to addressing'));
    }
  });

  it('tells a chat agent with no destinations the quiet ending too', () => {
    expect(buildSystemPromptAddendum('Casa', CHAT, NO_REPLY)).toContain(QUIET);
  });

  it('names no send_message in a task run without reply', () => {
    seedDestination('casa', 'Casa', 'whatsapp', 'group-1@g.us');

    const prompt = buildSystemPromptAddendum('Casa', { kind: 'task', taskId: 'weekly-report' }, NO_REPLY);

    expect(prompt).toContain('isolated task run');
    expect(prompt).toContain('tasks/weekly-report.md');
    expect(prompt).not.toContain('send_message');
    expect(prompt).not.toContain('send_file');
    expect(prompt).not.toContain(QUIET);
  });

  it('words a per-thread destination for an agent without reply as a block reply only', () => {
    getInboundDb()
      .prepare(
        `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id, session_mode)
         VALUES ('browser', 'browser', 'agent', NULL, NULL, 'ag-browser', 'per-thread')`,
      )
      .run();

    const withReply = buildSystemPromptAddendum('Casa', CHAT, REPLY);
    const without = buildSystemPromptAddendum('Casa', CHAT, NO_REPLY);

    expect(withReply).toContain('thread: "new"');
    expect(without).not.toContain('send_message');
    expect(without).toContain(
      'A destination marked per-thread takes a `<message to>` block only as a reply, when this batch has exactly one thread from that destination.',
    );
  });
});
