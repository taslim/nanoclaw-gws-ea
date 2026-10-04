/**
 * The meeting handoff's tools (KTD5, KTD16): typed requests the host carries
 * between `main` and `external-email`. No free text passes between the two.
 *
 * - `main` (capability `gws-ea-meetings`) hands a scheduling job over with
 *   `arrange`, `reschedule` or `ask_organizer`, and changes one with
 *   `amend` or `cancel`; `cancel` also calls off an event the principal
 *   organizes with others. It answers a thread waiting for it once with
 *   `respond`, closes one with `dismiss`, and answers the principal's own
 *   email with `reply_to_principal`.
 * - `external-email` (capability `gws-ea-meetings-external`) offers the
 *   principal's times with `free_time`, holds them with `hold`, frees them
 *   with `release_holds`, books the one agreed with `book` (and moves a
 *   booked meeting with it), all by slot id (KTD11), places the people its
 *   replies go to with `recipients`, and reports how the meeting ended with
 *   `outcome`.
 * - `reschedule` with `making_room_for` moves a meeting a needs-room note
 *   listed, and the time it frees goes to the meeting that needs it (R14).
 *
 * Each tool writes one request and waits for the host's answer. The host
 * checks every request against the caller and the meeting, so these
 * handlers only shape the call.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { requestAction } from '../action-request.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAIN_CAPABILITY = 'gws-ea-meetings';
const EXTERNAL_CAPABILITY = 'gws-ea-meetings-external';

/** How long a tool waits for the host; a request may still go through after that. */
export const MEETING_REQUEST_TIMEOUT_MS = 120_000;

const OUTCOMES = ['booked', 'settled', 'needs-room', 'not-scheduling', 'gave-up', 'responded'] as const;

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/** A field's shape, checked before anything is sent; the host checks its meaning. */
type Field = 'string' | 'integer' | 'boolean' | 'people' | 'strings' | 'addresses';

/** `{ person_id, email? }` for someone with a record, or `{ email }` for someone without one. */
function isPersonRef(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  const { person_id: personId, email } = value as Record<string, unknown>;
  if (personId === undefined) return typeof email === 'string' && email.trim() !== '';
  return typeof personId === 'string' && (email === undefined || typeof email === 'string');
}

function fieldProblem(name: string, value: unknown, field: Field): string | undefined {
  switch (field) {
    case 'string':
      return typeof value === 'string' && value.trim() !== '' ? undefined : `${name} must be text`;
    case 'integer':
      return Number.isInteger(value) ? undefined : `${name} must be a whole number`;
    case 'boolean':
      return typeof value === 'boolean' ? undefined : `${name} must be true or false`;
    case 'people':
      return Array.isArray(value) && value.length > 0 && value.every(isPersonRef)
        ? undefined
        : `${name} must list people as { person_id, email? }, or { email } for someone without a record`;
    case 'strings':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'string' && item.trim() !== '')
        ? undefined
        : `${name} must list one or more ids`;
    case 'addresses':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
        ? undefined
        : `${name} must list email addresses`;
    default: {
      const unreachable: never = field;
      throw new Error(`Unknown field shape ${String(unreachable)}`);
    }
  }
}

/** The request's fields: the required ones present, and every one given of its shape. */
function fieldsOf(
  args: Record<string, unknown>,
  required: Readonly<Record<string, Field>>,
  optional: Readonly<Record<string, Field>> = {},
): Record<string, unknown> | string {
  const fields: Record<string, unknown> = {};
  for (const [name, field] of Object.entries(required)) {
    const problem = fieldProblem(name, args[name], field);
    if (problem) return args[name] === undefined ? `${name} is required` : problem;
    fields[name] = args[name];
  }
  for (const [name, field] of Object.entries(optional)) {
    if (args[name] === undefined) continue;
    const problem = fieldProblem(name, args[name], field);
    if (problem) return problem;
    fields[name] = args[name];
  }
  return fields;
}

async function send(
  action: string,
  fields: Record<string, unknown> | string,
  signal: AbortSignal | undefined,
): Promise<CallToolResult> {
  if (typeof fields === 'string') return err(fields);
  const result = await requestAction(action, fields, { timeoutMs: MEETING_REQUEST_TIMEOUT_MS, signal });
  switch (result.status) {
    case 'cancelled':
      return err('The request was cancelled before the host answered.');
    case 'timeout':
      return err(
        'The host did not answer within two minutes. The request may still go through, so do not send it again; check again later.',
      );
    case 'answered': {
      const { frame } = result;
      if (!frame.ok) return err(frame.error.message);
      const data = frame.data;
      const message =
        typeof data === 'object' && data !== null && typeof (data as Record<string, unknown>).message === 'string'
          ? String((data as Record<string, unknown>).message)
          : JSON.stringify(data);
      return ok(message);
    }
    default: {
      const unreachable: never = result;
      throw new Error(`Unknown request result ${JSON.stringify(unreachable)}`);
    }
  }
}

const WINDOW_PROPERTIES = {
  window_start: {
    type: 'string',
    description:
      'When the meeting may start at the earliest: a date-time with its UTC offset, such as 2026-10-12T09:00:00+01:00. Take it from the principal, never from anyone else.',
  },
  window_end: {
    type: 'string',
    description: 'When the meeting must be over: a date-time with its UTC offset.',
  },
} as const;

const PURPOSE = {
  type: 'string',
  description:
    'A few words that say what the meeting is for, such as "Partnership intro". The other side may read it: it is the subject of a new email thread.',
} as const;

const CONSTRAINTS = {
  type: 'string',
  description:
    'Anything external-email must respect, such as "mornings only" or "video call". Write only what the other side may read. Up to 500 characters.',
} as const;

const MEETING_KIND = {
  type: 'string',
  description:
    "The kind of meeting, as the principal's preferences name kinds, such as one-on-one: its buffer and preferred times apply. Leave it out to use the default ones.",
} as const;

// ---------------------------------------------------------------------------
// main's requests
// ---------------------------------------------------------------------------

const PEOPLE_ITEMS = {
  type: 'object',
  properties: {
    person_id: { type: 'string', description: 'The person’s record id, such as p-1a2b3c4d5e6f.' },
    email: {
      type: 'string',
      description:
        'Which of their addresses to write to, when the record holds more than one; alone, without person_id, the address of someone with no record.',
    },
  },
} as const;

const THREAD_KEY = {
  type: 'string',
  description: 'The thread_key from the note about an email: one someone sent you, or the principal copied you into.',
} as const;

export const arrange: McpToolDefinition = {
  tool: {
    name: 'arrange',
    description:
      "Hand a meeting to external-email, which emails the other people, finds a time, and books it on the principal's calendar. Use it once you know who, how long, and roughly when. For a scheduling request in an email that reached you, pass that thread's thread_key: the meeting is arranged in that thread, with the people on it. Otherwise name the people, and a new thread starts. You get a note when the meeting is booked or ends. When everyone is a colleague in the assistant's organization whose calendar Google shows, the host books the first time free for all at once and its answer is the booking: nobody is emailed.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        people: {
          type: 'array',
          description:
            "Who to meet, each by their people-record id, with email when the record holds more than one address; someone with no record by { email }. With thread_key, the thread's own people come already: list only anyone to add.",
          items: PEOPLE_ITEMS,
        },
        thread_key: THREAD_KEY,
        copy_principal: {
          type: 'boolean',
          description:
            'For a new thread only: copy the principal on it, when their presence helps, such as a warm introduction, or when they asked to be copied. Left out, they are not copied.',
        },
        calendar_id: {
          type: 'string',
          description: "The principal's calendar to book on: one of theirs that you can write to.",
        },
        length_minutes: { type: 'integer', description: 'How long the meeting is, in minutes (5 to 480).' },
        ...WINDOW_PROPERTIES,
        purpose: PURPOSE,
        constraints: CONSTRAINTS,
        meeting_kind: MEETING_KIND,
      },
      required: ['calendar_id', 'length_minutes', 'window_start', 'window_end', 'purpose'],
    },
  },
  async handler(args, context) {
    if (args.people === undefined && args.thread_key === undefined) {
      return err('Name the people to meet, or the thread_key the note about an email gave you.');
    }
    return send(
      'meeting_arrange',
      fieldsOf(
        args,
        {
          calendar_id: 'string',
          length_minutes: 'integer',
          window_start: 'string',
          window_end: 'string',
          purpose: 'string',
        },
        {
          people: 'people',
          thread_key: 'string',
          copy_principal: 'boolean',
          constraints: 'string',
          meeting_kind: 'string',
        },
      ),
      context?.signal,
    );
  },
};

export const reschedule: McpToolDefinition = {
  tool: {
    name: 'reschedule',
    description:
      "Have external-email move a meeting the principal organizes to a new time, writing to the other attendees and moving the event once they agree. Use it for an event on the principal's calendar that the principal (or the assistant for them) organized. For an event someone else organized, use ask_organizer. To make room for a meeting that needs it, pass making_room_for with one of the meetings its note lists: the time the move frees goes to that meeting.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: 'The calendar the event is on.' },
        event_id: { type: 'string', description: 'The event’s id on that calendar.' },
        length_minutes: {
          type: 'integer',
          description: 'A new length in minutes, when it changes; otherwise the event keeps its length.',
        },
        ...WINDOW_PROPERTIES,
        purpose: PURPOSE,
        constraints: CONSTRAINTS,
        meeting_kind: MEETING_KIND,
        making_room_for: {
          type: 'string',
          description:
            'The id of a meeting whose note says it needs room, when this move makes room for it. Only an event that note lists can move for it.',
        },
      },
      required: ['calendar_id', 'event_id', 'window_start', 'window_end', 'purpose'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_reschedule',
      fieldsOf(
        args,
        { calendar_id: 'string', event_id: 'string', window_start: 'string', window_end: 'string', purpose: 'string' },
        { length_minutes: 'integer', constraints: 'string', meeting_kind: 'string', making_room_for: 'string' },
      ),
      context?.signal,
    );
  },
};

export const askOrganizer: McpToolDefinition = {
  tool: {
    name: 'ask_organizer',
    description:
      'Have external-email ask the organizer of an invitation to the principal to move it to another time, when it conflicts with something that matters more.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        calendar_id: { type: 'string', description: "The principal's calendar the invitation is on." },
        event_id: { type: 'string', description: 'The invitation’s event id on that calendar.' },
        ...WINDOW_PROPERTIES,
        purpose: PURPOSE,
        constraints: CONSTRAINTS,
      },
      required: ['calendar_id', 'event_id', 'window_start', 'window_end', 'purpose'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_ask_organizer',
      fieldsOf(
        args,
        { calendar_id: 'string', event_id: 'string', window_start: 'string', window_end: 'string', purpose: 'string' },
        { constraints: 'string' },
      ),
      context?.signal,
    );
  },
};

export const cancel: McpToolDefinition = {
  tool: {
    name: 'cancel',
    description:
      'Call something off when the principal asks. Give meeting_id for a meeting you handed to external-email: its email thread is closed and the people it wrote to get one short line saying the meeting is off; an event it already booked stays until you cancel that too. Or give calendar_id and event_id for an event the principal organizes with others, on a calendar you can change: the host deletes it and Google sends its guests the cancellation. For an event someone else organizes, use ask_organizer or decline it instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: { type: 'string', description: 'The meeting’s id, such as mtg-….' },
        calendar_id: { type: 'string', description: 'The calendar the event is on, instead of meeting_id.' },
        event_id: { type: 'string', description: 'The event’s id on that calendar, with calendar_id.' },
      },
    },
  },
  async handler(args, context) {
    if (args.meeting_id !== undefined) {
      if (args.calendar_id !== undefined || args.event_id !== undefined) {
        return err('Give either meeting_id, or calendar_id with event_id, not both.');
      }
      return send('meeting_cancel', fieldsOf(args, { meeting_id: 'string' }), context?.signal);
    }
    if (args.calendar_id === undefined && args.event_id === undefined) {
      return err('Give the meeting_id of a meeting you handed over, or the calendar_id and event_id of an event.');
    }
    return send('meeting_cancel', fieldsOf(args, { calendar_id: 'string', event_id: 'string' }), context?.signal);
  },
};

export const amend: McpToolDefinition = {
  tool: {
    name: 'amend',
    description:
      "Change a meeting external-email is still arranging: its length, window, or constraints when the principal changes their mind, or people to add to a meeting you handed over with arrange. Someone added joins the meeting and its email thread, and external-email's next reply goes to them too. external-email gets the new brief at once.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: { type: 'string', description: 'The meeting’s id.' },
        length_minutes: { type: 'integer', description: 'The new length in minutes.' },
        ...WINDOW_PROPERTIES,
        constraints: CONSTRAINTS,
        people: {
          type: 'array',
          description:
            'People to add, each by their people-record id, with email when the record holds more than one address; someone with no record by { email }.',
          items: PEOPLE_ITEMS,
        },
      },
      required: ['meeting_id'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_amend',
      fieldsOf(
        args,
        { meeting_id: 'string' },
        {
          length_minutes: 'integer',
          window_start: 'string',
          window_end: 'string',
          constraints: 'string',
          people: 'people',
        },
      ),
      context?.signal,
    );
  },
};

export const respond: McpToolDefinition = {
  tool: {
    name: 'respond',
    description:
      'Have external-email write one reply in an email thread that is waiting for you, to everyone on it: to decline with an alternative, route, acknowledge, or send a holding line. Say in purpose what the reply must do; external-email writes it. You get a note once it has gone, or if it could not be sent, and the thread then waits for you again, so you can arrange, respond, or dismiss it later. For a scheduling request, use arrange with the thread_key instead.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        thread_key: THREAD_KEY,
        purpose: {
          type: 'string',
          description:
            'What the one reply must do, such as "Decline kindly: the principal is not taking speaking slots this autumn; suggest asking again in January". Everyone on the thread may read what it leads to, so write only what they may know. Up to 500 characters.',
        },
        constraints: CONSTRAINTS,
      },
      required: ['thread_key', 'purpose'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_respond',
      fieldsOf(args, { thread_key: 'string', purpose: 'string' }, { constraints: 'string' }),
      context?.signal,
    );
  },
};

export const dismiss: McpToolDefinition = {
  tool: {
    name: 'dismiss',
    description:
      'Close an email thread that is waiting for you, sending nothing: for a thread that needs no reply, such as a thank-you. Later mail in it reaches you as a new email. A thread with a meeting in progress is closed by cancelling the meeting instead.',
    inputSchema: {
      type: 'object' as const,
      properties: { thread_key: THREAD_KEY },
      required: ['thread_key'],
    },
  },
  async handler(args, context) {
    return send('meeting_dismiss', fieldsOf(args, { thread_key: 'string' }), context?.signal);
  },
};

export const replyToPrincipal: McpToolDefinition = {
  tool: {
    name: 'reply_to_principal',
    description:
      "Answer an email the principal sent you, by email, in their thread. It goes to the principal alone, from the assistant's address. Use it whenever the principal emails you, and don't repeat the answer in chat.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        gmail_message_id: {
          type: 'string',
          description: 'The Gmail message id from the note about the principal’s email.',
        },
        text: {
          type: 'string',
          description: 'Your answer, as plain text, written to the principal. Line breaks are kept.',
        },
      },
      required: ['gmail_message_id', 'text'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_reply_to_principal',
      fieldsOf(args, { gmail_message_id: 'string', text: 'string' }),
      context?.signal,
    );
  },
};

// ---------------------------------------------------------------------------
// external-email's calendar tools
// ---------------------------------------------------------------------------

const MEETING_ID = { type: 'string', description: 'The meeting id from your brief.' } as const;

export const freeTime: McpToolDefinition = {
  tool: {
    name: 'free_time',
    description:
      "Get open times for this conversation's meeting, best first, each with a slot id and its day and local time. The host works them out from the principal's calendar and preferences: you never see the calendar itself. With date (and time), it looks at that day only (and checks that exact start), in timezone when you give one. Calls are capped per meeting.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: MEETING_ID,
        date: {
          type: 'string',
          description: 'Only this day, as YYYY-MM-DD, such as a day the other side asked about.',
        },
        time: {
          type: 'string',
          description: 'With date: check this exact start, as 24-hour HH:MM, such as a time the other side proposed.',
        },
        timezone: {
          type: 'string',
          description:
            "The other side's timezone, such as America/New_York, when you know it: date and time are read in it, and each time is also shown in it.",
        },
      },
      required: ['meeting_id'],
    },
  },
  async handler(args, context) {
    if (args.time !== undefined && args.date === undefined) return err('Give the date the time is on.');
    return send(
      'meeting_free_time',
      fieldsOf(args, { meeting_id: 'string' }, { date: 'string', time: 'string', timezone: 'string' }),
      context?.signal,
    );
  },
};

export const hold: McpToolDefinition = {
  tool: {
    name: 'hold',
    description:
      "Hold the times you offer on the principal's calendar, by their slot ids from free_time, so nothing else takes them while the other side chooses. At most three per meeting. A time that is no longer open is refused.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: MEETING_ID,
        slot_ids: { type: 'array', items: { type: 'string' }, description: 'The slot ids of the times you offer.' },
      },
      required: ['meeting_id', 'slot_ids'],
    },
  },
  async handler(args, context) {
    return send('meeting_hold', fieldsOf(args, { meeting_id: 'string', slot_ids: 'strings' }), context?.signal);
  },
};

export const releaseHolds: McpToolDefinition = {
  tool: {
    name: 'release_holds',
    description:
      'Release the times you held for this meeting when the other side turns them down: the slot ids given, or every hold when you give none. Booking releases the other holds by itself.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: MEETING_ID,
        slot_ids: { type: 'array', items: { type: 'string' }, description: 'The held slot ids to release.' },
      },
      required: ['meeting_id'],
    },
  },
  async handler(args, context) {
    return send(
      'meeting_release_holds',
      fieldsOf(args, { meeting_id: 'string' }, { slot_ids: 'strings' }),
      context?.signal,
    );
  },
};

export const book: McpToolDefinition = {
  tool: {
    name: 'book',
    description:
      "Book the time the other side picked, by its slot id. The host creates the meeting on the principal's calendar from your brief, invites the people in it, and releases the other holds; for a meeting being moved, it moves the existing event. Then report booked with outcome. Once the meeting is booked, a newly offered slot moves the booked event there instead, and main hears of it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: MEETING_ID,
        slot_id: { type: 'string', description: 'The slot id of the time they picked.' },
      },
      required: ['meeting_id', 'slot_id'],
    },
  },
  async handler(args, context) {
    return send('meeting_book', fieldsOf(args, { meeting_id: 'string', slot_id: 'string' }), context?.signal);
  },
};

// ---------------------------------------------------------------------------
// external-email's recipients and report
// ---------------------------------------------------------------------------

export const recipients: McpToolDefinition = {
  tool: {
    name: 'recipients',
    description:
      "Choose where the people already on this conversation's email thread go in your next replies: To, Cc, or Bcc, or left off by not listing them. You cannot add anyone: to include someone new, invite the people on the thread to copy them in. Without this, every reply goes to everyone on the thread as the latest email placed them. A choice holds until the next email in the thread changes who is on it.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: MEETING_ID,
        to: {
          type: 'array',
          items: { type: 'string' },
          description: 'The addresses on To: at least one, each already on the thread.',
        },
        cc: { type: 'array', items: { type: 'string' }, description: 'The addresses on Cc.' },
        bcc: {
          type: 'array',
          items: { type: 'string' },
          description: 'The addresses on Bcc: they get your replies, and the others do not see them.',
        },
      },
      required: ['meeting_id', 'to'],
    },
  },
  async handler(args, context) {
    if (Array.isArray(args.to) && args.to.length === 0) return err('Put at least one address on to.');
    return send(
      'meeting_recipients',
      fieldsOf(args, { meeting_id: 'string', to: 'addresses' }, { cc: 'addresses', bcc: 'addresses' }),
      context?.signal,
    );
  },
};

export const outcome: McpToolDefinition = {
  tool: {
    name: 'outcome',
    description:
      "Report how this conversation's meeting ended. Report each ending once, except needs-room, which you report again whenever free_time says so. booked: after book succeeded. settled: the organizer moved their invitation. needs-room: nothing in the window fits, for someone in the inner circle or close. not-scheduling: the thread is not about arranging a meeting. gave-up: no time could be agreed. responded: the one reply a respond brief asked for is written. The host fills in the details for the principal.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: { type: 'string', description: 'The meeting id from your brief.' },
        outcome: { type: 'string', enum: [...OUTCOMES], description: 'How the meeting ended.' },
      },
      required: ['meeting_id', 'outcome'],
    },
  },
  async handler(args, context) {
    if (!OUTCOMES.some((value) => value === args.outcome)) {
      return err(`outcome must be one of ${OUTCOMES.join(', ')}`);
    }
    return send('meeting_outcome', fieldsOf(args, { meeting_id: 'string', outcome: 'string' }), context?.signal);
  },
};

registerTools([arrange, reschedule, askOrganizer, cancel, amend, respond, dismiss, replyToPrincipal], MAIN_CAPABILITY);
registerTools([freeTime, hold, releaseHolds, book, recipients, outcome], EXTERNAL_CAPABILITY);
