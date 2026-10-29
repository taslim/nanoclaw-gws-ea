import { expect, it } from 'bun:test';
import Ajv from 'ajv';
import { expectReply, remind, chatFreeTime, chatBook, chatChangeBooking, chatCancelBooking } from './gws-ea-chat.js';
import type { McpToolDefinition } from './types.js';

it.each<readonly [McpToolDefinition, Readonly<Record<string, unknown>>]>([
  [expectReply, { until: '2026-10-19T12:00:00Z' }],
  [remind, { at: '2026-10-19T12:00:00Z', note: 'Choose a venue.' }],
  [
    chatFreeTime,
    { from: '2026-10-19T12:00:00Z', to: '2026-10-20T12:00:00Z', minutes: 30, kind: 'intro', place: 'Remy’s office' },
  ],
  [chatBook, { start: '2026-10-19T12:00:00Z', minutes: 30, title: 'Venue visit' }],
  [chatChangeBooking, { booking: 'booked-here' }],
  [chatCancelBooking, { booking: 'booked-here' }],
])('refuses caller-chosen chat routing on otherwise valid %s arguments', (tool, args) => {
  const validate = new Ajv().compile(tool.tool.inputSchema);
  expect(validate(args)).toBe(true);
  expect(validate({ ...args, chat: 'another' })).toBe(false);
  expect(validate.errors?.some((error) => error.keyword === 'additionalProperties')).toBe(true);
});
