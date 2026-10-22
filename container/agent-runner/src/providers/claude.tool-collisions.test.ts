import { describe, it, expect } from 'bun:test';

import './index.js';
import '../provider-contracts/index.js';
import { SDK_DISALLOWED_TOOLS, TOOL_ALLOWLIST } from './claude.js';

// Built-in Claude Code tools whose NAME reads as the obvious way to do
// something NanoClaw already models differently. Leaving one of these
// available is a silent failure: the agent calls the built-in, gets a
// coherent-sounding refusal about a subsystem NanoClaw doesn't use, and
// reports that NanoClaw is broken.
//
// SendMessage is the regression this guards. It addresses Claude Code's own
// in-session subagents; an agent that had just created a NanoClaw agent group
// called it four times and read "No agent named 'growth' is currently
// addressable" as "the group was never provisioned". RemoteTrigger and
// PushNotification read as a reminder and a message to the person, and reach
// neither: one schedules a cloud agent outside the container, the other
// notifies the account's own Claude app.
const COLLIDES_WITH_NANOCLAW: Array<[builtin: string, nanoclawWay: string]> = [
  ['SendMessage', 'mcp__nanoclaw__send_message'],
  ['AskUserQuestion', 'mcp__nanoclaw__ask_user_question'],
  ['PushNotification', 'mcp__nanoclaw__send_message'],
  ['RemoteTrigger', 'ncl tasks'],
];

describe('built-in tools that collide with what NanoClaw provides', () => {
  for (const [builtin, nanoclawWay] of COLLIDES_WITH_NANOCLAW) {
    it(`${builtin} is disallowed in favour of ${nanoclawWay}`, () => {
      expect(SDK_DISALLOWED_TOOLS).toContain(builtin);
      expect(TOOL_ALLOWLIST).not.toContain(builtin);
    });
  }

  it('the exported constant is not frozen by contract registration', () => {
    expect(Object.isFrozen(SDK_DISALLOWED_TOOLS)).toBe(false);
  });

  it('no tool is both allowlisted and disallowed', () => {
    const overlap = TOOL_ALLOWLIST.filter((t) => SDK_DISALLOWED_TOOLS.includes(t));
    expect(overlap).toEqual([]);
  });
});
