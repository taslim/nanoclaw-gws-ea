/**
 * Reminders (KTD8, R73): an agent comes back to its own conversation at a
 * time it chooses. Each tool sends the host action of its name, and the host
 * writes or clears the reminder in the session the request came from; no
 * argument names another (src/modules/gws-ea-reminders/index.ts).
 */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

/** The key that grants both tools; named here, since their tests load them ahead of the barrel. */
const REMINDERS_CAPABILITY = 'gws-ea-reminders';

/** How long a tool waits for the host; a request may still go through after that. */
export const REMINDER_REQUEST_TIMEOUT_MS = 30_000;

export const remindMe = requestTool({
  name: 'remind_me',
  description:
    'Come back to this conversation at a time you choose, at most 30 days ahead: your note arrives here then, as a message from your reminder. Answers with the reminder id.',
  properties: {
    at: {
      type: 'string',
      description:
        'When, as a date and time with its UTC offset, as time_resolve gives it, such as 2026-10-09T09:00:00-07:00.',
    },
    note: { type: 'string', description: 'What you want to read then: what to check, and why.' },
  },
  required: ['at', 'note'],
  repeatable: false,
  timeoutMs: REMINDER_REQUEST_TIMEOUT_MS,
});

export const clearReminder = requestTool({
  name: 'clear_reminder',
  description:
    'Clear a reminder you set in this conversation that has not come yet, by the id remind_me answered with.',
  properties: { reminder_id: { type: 'string', description: 'The reminder id, such as reminder-….' } },
  required: ['reminder_id'],
  repeatable: true,
  timeoutMs: REMINDER_REQUEST_TIMEOUT_MS,
});

registerTools([remindMe, clearReminder], REMINDERS_CAPABILITY);
