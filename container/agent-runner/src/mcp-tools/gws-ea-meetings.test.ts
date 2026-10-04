/**
 * The meeting tools: main's requests, and external-email's calendar tools,
 * recipients and outcome, each a typed request the host answers with an
 * `action_response` (KTD5).
 */
import { afterEach, beforeEach, describe, expect, it } from 'bun:test';

import { requestAction } from '../action-request.js';
import { getUndeliveredMessages } from '../db/messages-out.js';
import { closeSessionDb, getInboundDb, initTestSessionDb } from '../mailbox/sqlite/connection.js';
import {
  amend,
  arrange,
  askOrganizer,
  book,
  cancel,
  dismiss,
  freeTime,
  hold,
  outcome,
  recipients,
  releaseHolds,
  replyToPrincipal,
  reschedule,
  respond,
} from './gws-ea-meetings.js';
import type { McpToolDefinition } from './types.js';

beforeEach(() => initTestSessionDb());
afterEach(() => closeSessionDb());

/** The host's side: wait for the request, then answer it the way delivery does. */
async function answerNext(frame: (requestId: string) => unknown): Promise<Record<string, unknown>> {
  while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
  const [row] = getUndeliveredMessages();
  const request = JSON.parse(row.content) as Record<string, unknown>;
  const requestId = String(request.requestId);
  getInboundDb()
    .prepare('INSERT INTO messages_in (id, kind, timestamp, content, trigger) VALUES (?, ?, ?, ?, 0)')
    .run(
      `action-resp-${requestId}`,
      'system',
      new Date().toISOString(),
      JSON.stringify({ type: 'action_response', requestId, frame: frame(requestId) }),
    );
  return { ...request, messageId: row.id };
}

async function call(tool: McpToolDefinition, args: Record<string, unknown>, frame: (id: string) => unknown) {
  const [result, request] = await Promise.all([tool.handler(args), answerNext(frame)]);
  return { result, request };
}

const WINDOW = { window_start: '2026-10-12T09:00:00+01:00', window_end: '2026-10-16T17:00:00+01:00' };

describe('the meeting tools', () => {
  it('send arrange as one typed request carried by its own outbound message, and return the host’s answer', async () => {
    const args = {
      people: [{ person_id: 'p-0123456789ab' }],
      calendar_id: 'pat@principal.example',
      length_minutes: 30,
      ...WINDOW,
      purpose: 'Partnership intro',
      constraints: 'Mornings suit best.',
    };
    const { result, request } = await call(arrange, args, (id) => ({
      id,
      ok: true,
      data: { meeting_id: 'mtg-1', message: 'Handed to external-email as meeting mtg-1.' },
    }));
    expect(request).toMatchObject({ action: 'meeting_arrange', ...args });
    expect(request.requestId).toBe(request.messageId);
    expect(result.isError).not.toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Handed to external-email as meeting mtg-1.' }]);
  });

  it('return a refusal as an error the agent can read', async () => {
    const { result } = await call(cancel, { meeting_id: 'mtg-1' }, (id) => ({
      id,
      ok: false,
      error: { code: 'forbidden', message: 'Meeting mtg-1 is already cancelled.' },
    }));
    expect(result.isError).toBe(true);
    expect(result.content).toEqual([{ type: 'text', text: 'Error: Meeting mtg-1 is already cancelled.' }]);
  });

  it('carry each request’s own fields', async () => {
    const cases: Array<[McpToolDefinition, string, Record<string, unknown>]> = [
      [reschedule, 'meeting_reschedule', { calendar_id: 'c', event_id: 'e', ...WINDOW, purpose: 'Moving it' }],
      [
        reschedule,
        'meeting_reschedule',
        { calendar_id: 'c', event_id: 'e', ...WINDOW, purpose: 'Making room', making_room_for: 'mtg-1' },
      ],
      [askOrganizer, 'meeting_ask_organizer', { calendar_id: 'c', event_id: 'e', ...WINDOW, purpose: 'Your invite' }],
      [amend, 'meeting_amend', { meeting_id: 'mtg-1', length_minutes: 60 }],
      [outcome, 'meeting_outcome', { meeting_id: 'mtg-1', outcome: 'gave-up' }],
      [cancel, 'meeting_cancel', { meeting_id: 'mtg-1' }],
      [cancel, 'meeting_cancel', { calendar_id: 'c', event_id: 'e' }],
      [
        arrange,
        'meeting_arrange',
        {
          people: [{ person_id: 'p-0123456789ab' }],
          calendar_id: 'c',
          length_minutes: 30,
          ...WINDOW,
          purpose: 'Intro',
          meeting_kind: 'one-on-one',
        },
      ],
      [freeTime, 'meeting_free_time', { meeting_id: 'mtg-1' }],
      [
        freeTime,
        'meeting_free_time',
        { meeting_id: 'mtg-1', date: '2026-10-14', time: '15:00', timezone: 'America/New_York' },
      ],
      [hold, 'meeting_hold', { meeting_id: 'mtg-1', slot_ids: ['slot-3fa9c2e1b7d0', 'slot-0b1c2d3e4f5a'] }],
      [releaseHolds, 'meeting_release_holds', { meeting_id: 'mtg-1' }],
      [releaseHolds, 'meeting_release_holds', { meeting_id: 'mtg-1', slot_ids: ['slot-3fa9c2e1b7d0'] }],
      [book, 'meeting_book', { meeting_id: 'mtg-1', slot_id: 'slot-3fa9c2e1b7d0' }],
      [
        arrange,
        'meeting_arrange',
        {
          people: [{ person_id: 'p-0123456789ab', email: 'sam@studio.example' }, { email: 'kim@else.example' }],
          calendar_id: 'c',
          length_minutes: 30,
          ...WINDOW,
          purpose: 'Intro',
          copy_principal: true,
        },
      ],
      [
        arrange,
        'meeting_arrange',
        { thread_key: 'mail-inbound-1', calendar_id: 'c', length_minutes: 30, ...WINDOW, purpose: 'Catch up' },
      ],
      [amend, 'meeting_amend', { meeting_id: 'mtg-1', people: [{ person_id: 'p-0123456789ab' }] }],
      [respond, 'meeting_respond', { thread_key: 'mail-inbound-1', purpose: 'Decline kindly' }],
      [
        respond,
        'meeting_respond',
        { thread_key: 'mail-inbound-1', purpose: 'Holding line', constraints: 'Say a week at most.' },
      ],
      [dismiss, 'meeting_dismiss', { thread_key: 'mail-inbound-1' }],
      [replyToPrincipal, 'meeting_reply_to_principal', { gmail_message_id: '18c2f0a1b2', text: 'Done.\nIt is at 4.' }],
      [recipients, 'meeting_recipients', { meeting_id: 'mtg-1', to: ['sales@acme.example'] }],
      [
        recipients,
        'meeting_recipients',
        { meeting_id: 'mtg-1', to: ['sales@acme.example'], cc: [], bcc: ['alex@principal.example'] },
      ],
      [outcome, 'meeting_outcome', { meeting_id: 'mtg-1', outcome: 'responded' }],
    ];
    for (const [tool, action, args] of cases) {
      const { request } = await call(tool, args, (id) => ({ id, ok: true, data: { message: 'ok' } }));
      expect(request).toMatchObject({ action, ...args });
      closeSessionDb();
      initTestSessionDb();
    }
  });

  it('refuse a malformed call without sending anything', async () => {
    for (const [tool, args] of [
      [arrange, { calendar_id: 'c', length_minutes: 30, ...WINDOW }],
      [cancel, {}],
      [cancel, { calendar_id: 'c' }],
      [cancel, { meeting_id: 'mtg-1', calendar_id: 'c', event_id: 'e' }],
      [outcome, { meeting_id: 'mtg-1', outcome: 'done' }],
      [amend, { meeting_id: 'mtg-1', length_minutes: '60' }],
      [freeTime, {}],
      [freeTime, { meeting_id: 'mtg-1', time: '15:00' }],
      [hold, { meeting_id: 'mtg-1', slot_ids: 'slot-3fa9c2e1b7d0' }],
      [hold, { meeting_id: 'mtg-1', slot_ids: [] }],
      [book, { meeting_id: 'mtg-1' }],
      [releaseHolds, { meeting_id: 'mtg-1', slot_ids: [3] }],
      [reschedule, { calendar_id: 'c', event_id: 'e', ...WINDOW, purpose: 'Making room', making_room_for: 7 }],
      [arrange, { calendar_id: 'c', length_minutes: 30, ...WINDOW, purpose: 'Intro', people: [{ name: 'Sam' }] }],
      [
        arrange,
        { calendar_id: 'c', length_minutes: 30, ...WINDOW, purpose: 'Intro', thread_key: 'k', copy_principal: 'yes' },
      ],
      [amend, { meeting_id: 'mtg-1', people: [] }],
      [respond, { thread_key: 'mail-inbound-1' }],
      [respond, { purpose: 'Decline kindly' }],
      [dismiss, {}],
      [replyToPrincipal, { gmail_message_id: '18c2f0a1b2' }],
      [replyToPrincipal, { text: 'Done.' }],
      [recipients, { meeting_id: 'mtg-1' }],
      [recipients, { meeting_id: 'mtg-1', to: [] }],
      [recipients, { meeting_id: 'mtg-1', to: ['sales@acme.example'], bcc: 'alex@principal.example' }],
    ] as const) {
      const result = await tool.handler(args);
      expect(result.isError).toBe(true);
    }
    expect(getUndeliveredMessages()).toHaveLength(0);
  });
});

describe('requestAction', () => {
  it('gives up after its timeout, and stops at once when cancelled', async () => {
    expect(await requestAction('meeting_cancel', { meeting_id: 'mtg-1' }, { timeoutMs: 20, pollMs: 5 })).toEqual({
      status: 'timeout',
    });
    const controller = new AbortController();
    const waiting = requestAction(
      'meeting_cancel',
      { meeting_id: 'mtg-1' },
      { timeoutMs: 60_000, signal: controller.signal },
    );
    controller.abort();
    expect(await waiting).toEqual({ status: 'cancelled' });
  });

  it('never lets a field overwrite the action or its request id', async () => {
    const waiting = requestAction('meeting_cancel', { action: 'cli_request', requestId: 'forged' }, { timeoutMs: 20 });
    while (getUndeliveredMessages().length === 0) await Bun.sleep(1);
    const [row] = getUndeliveredMessages();
    expect(JSON.parse(row.content)).toMatchObject({ action: 'meeting_cancel', requestId: row.id });
    await waiting;
  });
});
