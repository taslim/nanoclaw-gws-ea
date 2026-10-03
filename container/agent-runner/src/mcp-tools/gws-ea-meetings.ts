/**
 * The meeting handoff's tools (KTD5): typed requests the host carries
 * between `main` and `external-email`. No free text passes between the two.
 *
 * - `main` (capability `gws-ea-meetings`) hands a scheduling job over with
 *   `arrange`, `reschedule` or `ask_organizer`, and changes one with
 *   `amend` or `cancel`; `cancel` also calls off an event the principal
 *   organizes with others.
 * - `external-email` (capability `gws-ea-meetings-external`) offers the
 *   principal's times with `free_time`, holds them with `hold`, frees them
 *   with `release_holds`, books the one agreed with `book`, all by slot id
 *   (KTD11), and reports how the meeting ended with `outcome`.
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

const OUTCOMES = ['booked', 'settled', 'needs-room', 'not-scheduling', 'gave-up'] as const;

function ok(text: string): CallToolResult {
  return { content: [{ type: 'text', text }] };
}

function err(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/** A field's shape, checked before anything is sent; the host checks its meaning. */
type Field = 'string' | 'integer' | 'people' | 'strings';

function fieldProblem(name: string, value: unknown, field: Field): string | undefined {
  switch (field) {
    case 'string':
      return typeof value === 'string' && value.trim() !== '' ? undefined : `${name} must be text`;
    case 'integer':
      return Number.isInteger(value) ? undefined : `${name} must be a whole number`;
    case 'people':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every(
          (person) =>
            typeof person === 'object' &&
            person !== null &&
            typeof (person as Record<string, unknown>).person_id === 'string' &&
            ['string', 'undefined'].includes(typeof (person as Record<string, unknown>).email),
        )
        ? undefined
        : `${name} must list people as { person_id, email? }`;
    case 'strings':
      return Array.isArray(value) &&
        value.length > 0 &&
        value.every((item) => typeof item === 'string' && item.trim() !== '')
        ? undefined
        : `${name} must list one or more ids`;
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

export const arrange: McpToolDefinition = {
  tool: {
    name: 'arrange',
    description:
      "Hand a new meeting to external-email, which emails the other people, finds a time, and books it on the principal's calendar. Use it once you know who, how long, and roughly when. For a thread the principal copied you into, pass its thread_key instead of people. You get a note when the meeting is booked or ends. When everyone is a colleague in the assistant's organization whose calendar Google shows, the host books the first time free for all at once and its answer is the booking: nobody is emailed.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        people: {
          type: 'array',
          description:
            "Who to meet, each by their people-record id. Add email when the record holds more than one address. Leave this out for a copied-in thread: its people are the ones on the principal's message.",
          items: {
            type: 'object',
            properties: {
              person_id: { type: 'string', description: 'The person’s record id, such as p-1a2b3c4d5e6f.' },
              email: { type: 'string', description: 'Which of their addresses to write to.' },
            },
            required: ['person_id'],
          },
        },
        thread_key: {
          type: 'string',
          description: 'The thread key from the note about a thread the principal copied you into.',
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
      return err('Name the people to meet, or the thread_key of a thread the principal copied you into.');
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
        { people: 'people', thread_key: 'string', constraints: 'string', meeting_kind: 'string' },
      ),
      context?.signal,
    );
  },
};

export const reschedule: McpToolDefinition = {
  tool: {
    name: 'reschedule',
    description:
      "Have external-email move a meeting the principal organizes to a new time, writing to the other attendees and moving the event once they agree. Use it for an event on the principal's calendar that the principal (or the assistant for them) organized. For an event someone else organized, use ask_organizer.",
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
        { length_minutes: 'integer', constraints: 'string', meeting_kind: 'string' },
      ),
      context?.signal,
    );
  },
};

export const askOrganizer: McpToolDefinition = {
  tool: {
    name: 'ask_organizer',
    description:
      'Have external-email ask the organizer of an invitation to the principal to move it to another time, when it conflicts with something that matters more. Only for an organizer the principal has a people record for; for anyone else, bring the invitation to the principal instead.',
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
      'Change the length, the window, or the constraints of a meeting external-email is still arranging, when the principal changes their mind. external-email gets the new brief at once.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        meeting_id: { type: 'string', description: 'The meeting’s id.' },
        length_minutes: { type: 'integer', description: 'The new length in minutes.' },
        ...WINDOW_PROPERTIES,
        constraints: CONSTRAINTS,
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
        { length_minutes: 'integer', window_start: 'string', window_end: 'string', constraints: 'string' },
      ),
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
      "Book the time the other side picked, by its slot id. The host creates the meeting on the principal's calendar from your brief, invites the people in it, and releases the other holds; for a meeting being moved, it moves the existing event. Then report booked with outcome.",
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
// external-email's report
// ---------------------------------------------------------------------------

export const outcome: McpToolDefinition = {
  tool: {
    name: 'outcome',
    description:
      "Report how this conversation's meeting ended, once. booked: after book succeeded. settled: the organizer moved their invitation. needs-room: nothing in the window fits, for someone in the inner circle or close. not-scheduling: the thread is not about arranging a meeting. gave-up: no time could be agreed. The host fills in the details for the principal.",
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

registerTools([arrange, reschedule, askOrganizer, cancel, amend], MAIN_CAPABILITY);
registerTools([freeTime, hold, releaseHolds, book, outcome], EXTERNAL_CAPABILITY);
