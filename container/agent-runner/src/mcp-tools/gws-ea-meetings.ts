/**
 * The meeting handoff's tools (KTD5, KTD16): typed requests the host carries
 * between `main` and `external-email`. No free text passes between the two.
 *
 * Each tool is named after the host action it sends, by what it acts on:
 *
 * - `main` (capability `gws-ea-meetings`) hands a scheduling job over with
 *   `meeting_arrange` or `meeting_reschedule` (which asks the organizer of an
 *   event someone else organizes), and changes one with `meeting_amend` or
 *   `meeting_cancel`; `meeting_cancel` also calls off an event the principal
 *   organizes with others. It answers a thread waiting for it with
 *   `email_respond`, closes one with `email_dismiss`, and answers the
 *   principal's own email with `email_reply_to_principal`.
 * - `external-email` (capability `gws-ea-meetings-external`) offers the
 *   principal's times with `meeting_free_time`, holds exactly the times it
 *   offers with `meeting_hold`, books the one agreed with `meeting_book`
 *   (and moves a booked meeting with it), all by slot id (KTD11), places the
 *   people its replies go to with `email_recipients`, and reports how the
 *   meeting ended with `meeting_outcome`.
 *
 * Each tool writes one request and waits for the host's answer. The host
 * checks every request against the caller and the meeting, so these
 * handlers only shape the call. A request the host is slow to answer can be
 * checked with `request_status`; each tool's timeout says whether a repeat
 * is safe.
 */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

import { answerResult, requestAction } from '../action-request.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

const MAIN_CAPABILITY = 'gws-ea-meetings';
const EXTERNAL_CAPABILITY = 'gws-ea-meetings-external';

/** How long a tool waits for the host; a request may still go through after that. */
export const MEETING_REQUEST_TIMEOUT_MS = 120_000;

const OUTCOMES = ['booked', 'settled', 'not-scheduling', 'gave-up', 'responded'] as const;
const ASK_TOPICS = ['time', 'length', 'people', 'place', 'other'] as const;

function err(text: string): CallToolResult {
  return { content: [{ type: 'text', text: `Error: ${text}` }], isError: true };
}

/** A field's shape, checked before anything is sent; the host checks its meaning. */
type Field = 'string' | 'integer' | 'boolean' | 'people' | 'ids' | 'addresses';

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
    case 'ids':
      return Array.isArray(value) && value.every((item) => typeof item === 'string' && item.trim() !== '')
        ? undefined
        : `${name} must list ids`;
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
  optional: Readonly<Record<string, Field>>,
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

/** What a timeout tells the agent: the request may still go through, and whether to repeat it. */
function timeoutText(requestId: string, repeatable: boolean): string {
  return (
    `The host has not answered request ${requestId} yet, and it may still go through. ` +
    (repeatable
      ? 'Check it with request_status, or make the same call again: a repeat changes nothing twice.'
      : 'Check it with request_status before you do anything else, and do not send it again.')
  );
}

interface RequestTool {
  /** The tool's name, which is also the host action it sends. */
  readonly name: string;
  readonly description: string;
  readonly properties: Record<string, object>;
  readonly required: Readonly<Record<string, Field>>;
  readonly optional?: Readonly<Record<string, Field>>;
  /** Whether sending the same request again is safe: the host does nothing twice. */
  readonly repeatable: boolean;
  /** A problem with the call's shape the fields alone cannot show. */
  readonly check?: (args: Record<string, unknown>) => string | undefined;
}

/** A tool that sends one typed request named after itself, and returns the host's answer. */
function requestTool(spec: RequestTool): McpToolDefinition {
  return {
    tool: {
      name: spec.name,
      description: spec.description,
      inputSchema: { type: 'object' as const, properties: spec.properties, required: Object.keys(spec.required) },
    },
    async handler(args, context) {
      const problem = spec.check?.(args);
      if (problem) return err(problem);
      const fields = fieldsOf(args, spec.required, spec.optional ?? {});
      if (typeof fields === 'string') return err(fields);
      const result = await requestAction(spec.name, fields, {
        timeoutMs: MEETING_REQUEST_TIMEOUT_MS,
        signal: context?.signal,
      });
      switch (result.status) {
        case 'cancelled':
          return err('The request was cancelled before the host answered.');
        case 'timeout':
          return err(timeoutText(result.requestId, spec.repeatable));
        case 'answered':
          return answerResult(result.frame);
        default: {
          const unreachable: never = result;
          throw new Error(`Unknown request result ${JSON.stringify(unreachable)}`);
        }
      }
    },
  };
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

export const arrange = requestTool({
  name: 'meeting_arrange',
  description:
    "Hand a meeting to external-email, which emails the other people, finds a time, and books it on the principal's calendar. For a scheduling request in an email that reached you, pass that thread's thread_key: the meeting is arranged in that thread, with the people on it. Otherwise name the people, and a new thread starts. When everyone is a colleague in the assistant's organization whose calendar Google shows, the host books the best time free for all at once, and its answer is the booking: nobody is emailed.",
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
      description: 'For a new thread only: copy the principal on it. Left out, they are not copied.',
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
  required: {
    calendar_id: 'string',
    length_minutes: 'integer',
    window_start: 'string',
    window_end: 'string',
    purpose: 'string',
  },
  optional: {
    people: 'people',
    thread_key: 'string',
    copy_principal: 'boolean',
    constraints: 'string',
    meeting_kind: 'string',
  },
  repeatable: false,
  check: (args) =>
    args.people === undefined && args.thread_key === undefined
      ? 'Name the people to meet, or the thread_key the note about an email gave you.'
      : undefined,
});

export const reschedule = requestTool({
  name: 'meeting_reschedule',
  description:
    "Have external-email move an event on the principal's calendar to a time in a new window. When the principal organizes it, external-email writes to its guests and the host moves the event once they agree. When someone else organizes it, external-email asks that organizer to move it, and the answer says so. To make room for a meeting with someone inner circle or close, pass making_room_for with that meeting's id: only a meeting the assistant booked with people who matter less can move for it, and the time the move frees goes to that meeting.",
  properties: {
    calendar_id: { type: 'string', description: 'The calendar the event is on.' },
    event_id: { type: 'string', description: 'The event’s id on that calendar.' },
    length_minutes: {
      type: 'integer',
      description: 'A new length in minutes, for an event the principal organizes; otherwise it keeps its length.',
    },
    ...WINDOW_PROPERTIES,
    purpose: PURPOSE,
    constraints: CONSTRAINTS,
    meeting_kind: MEETING_KIND,
    making_room_for: {
      type: 'string',
      description: 'The id of a meeting with someone inner circle or close that this move makes room for.',
    },
  },
  required: {
    calendar_id: 'string',
    event_id: 'string',
    window_start: 'string',
    window_end: 'string',
    purpose: 'string',
  },
  optional: { length_minutes: 'integer', constraints: 'string', meeting_kind: 'string', making_room_for: 'string' },
  repeatable: false,
});

export const cancel = requestTool({
  name: 'meeting_cancel',
  description:
    'Call something off. Give meeting_id for a meeting you handed to external-email: the host releases its held times and deletes the event it booked, and Google sends the guests its cancellation. Or give calendar_id and event_id for an event the principal organizes with others: the host deletes it, and Google sends its guests the cancellation. For an event someone else organizes, decline it or have meeting_reschedule ask its organizer instead.',
  properties: {
    meeting_id: { type: 'string', description: 'The meeting’s id, such as mtg-….' },
    calendar_id: { type: 'string', description: 'The calendar the event is on, instead of meeting_id.' },
    event_id: { type: 'string', description: 'The event’s id on that calendar, with calendar_id.' },
  },
  required: {},
  optional: { meeting_id: 'string', calendar_id: 'string', event_id: 'string' },
  repeatable: false,
  check: (args) => {
    if (args.meeting_id !== undefined) {
      return args.calendar_id !== undefined || args.event_id !== undefined
        ? 'Give either meeting_id, or calendar_id with event_id, not both.'
        : undefined;
    }
    return args.calendar_id === undefined || args.event_id === undefined
      ? 'Give the meeting_id of a meeting you handed over, or the calendar_id and event_id of an event.'
      : undefined;
  },
});

export const amend = requestTool({
  name: 'meeting_amend',
  description:
    "Answer what external-email asked you, change a job it holds, or both; it gets a new brief at once, and the question closes. A meeting still being arranged takes a new length, window or constraints, and people to add when you handed it over with meeting_arrange. A booked one takes people to add, who join its event with Google's update, and new constraints; move it with meeting_reschedule. A conversation takes only your answer. Someone added joins the email thread, and external-email's next reply goes to them too.",
  properties: {
    meeting_id: { type: 'string', description: 'The meeting’s id.' },
    answer: {
      type: 'string',
      description:
        'Your words to external-email: the answer to what it asked, or what to tell them. The other side may read what it leads to, so write only what they may know. Up to 1,000 characters.',
    },
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
  required: { meeting_id: 'string' },
  optional: {
    answer: 'string',
    length_minutes: 'integer',
    window_start: 'string',
    window_end: 'string',
    constraints: 'string',
    people: 'people',
  },
  repeatable: false,
});

export const respond = requestTool({
  name: 'email_respond',
  description:
    'Have external-email answer an email thread that is waiting for you, to everyone on it, such as declining with an alternative or routing the request. Say in purpose what the answer must do; external-email writes it. For a scheduling request, use meeting_arrange with the thread_key instead.',
  properties: {
    thread_key: THREAD_KEY,
    purpose: {
      type: 'string',
      description:
        'What the answer must do, such as "Decline kindly: the principal is not taking speaking slots this autumn; suggest asking again in January". Everyone on the thread may read what it leads to, so write only what they may know. Up to 500 characters.',
    },
    constraints: CONSTRAINTS,
  },
  required: { thread_key: 'string', purpose: 'string' },
  optional: { constraints: 'string' },
  repeatable: false,
});

export const dismiss = requestTool({
  name: 'email_dismiss',
  description:
    'Close an email thread that is waiting for you, sending nothing. Later mail in it reaches you as a new email. A thread with a meeting in progress is closed by cancelling the meeting instead.',
  properties: { thread_key: THREAD_KEY },
  required: { thread_key: 'string' },
  repeatable: true,
});

export const replyToPrincipal = requestTool({
  name: 'email_reply_to_principal',
  description:
    "Answer an email the principal sent you, by email, in their thread. It goes to the principal alone, from the assistant's address.",
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
  required: { gmail_message_id: 'string', text: 'string' },
  repeatable: false,
});

// ---------------------------------------------------------------------------
// external-email's calendar tools
// ---------------------------------------------------------------------------

const MEETING_ID = { type: 'string', description: 'The meeting id from your brief.' } as const;

export const freeTime = requestTool({
  name: 'meeting_free_time',
  description:
    "Get open times for this conversation's meeting, best first, each with a slot id and its day and local time. The host works them out from the principal's calendar and preferences: you never see the calendar itself. With date (and time), it looks at that day only (and checks that exact start), read in timezone when you give one. Answers are capped per meeting.",
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
  required: { meeting_id: 'string' },
  optional: { date: 'string', time: 'string', timezone: 'string' },
  repeatable: true,
  check: (args) => (args.time !== undefined && args.date === undefined ? 'Give the date the time is on.' : undefined),
});

export const hold = requestTool({
  name: 'meeting_hold',
  description:
    'Hold exactly the times you offer, by their slot ids from meeting_free_time, so nothing else takes them while the other side chooses. Any other time held for the meeting is released; an empty list releases them all. At most three. A time that is no longer open is refused, and then nothing changes.',
  properties: {
    meeting_id: MEETING_ID,
    slot_ids: { type: 'array', items: { type: 'string' }, description: 'The slot ids of the times you offer now.' },
  },
  required: { meeting_id: 'string', slot_ids: 'ids' },
  repeatable: true,
});

export const book = requestTool({
  name: 'meeting_book',
  description:
    "Book the time the other side picked, by its slot id. The host creates the meeting on the principal's calendar, invites the people in your brief, and releases the other holds; for a meeting being moved, it moves the existing event. Once the meeting is booked, a newly offered slot moves the booked event there instead.",
  properties: {
    meeting_id: MEETING_ID,
    slot_id: { type: 'string', description: 'The slot id of the time they picked.' },
  },
  required: { meeting_id: 'string', slot_id: 'string' },
  repeatable: true,
});

// ---------------------------------------------------------------------------
// external-email's recipients and report
// ---------------------------------------------------------------------------

export const recipients = requestTool({
  name: 'email_recipients',
  description:
    "Choose where the people already on this conversation's email thread go in your next replies: To, Cc, or Bcc, or left off by not listing them. You cannot add anyone. Without this, every reply goes to everyone on the thread as the latest email placed them. A choice holds until the next email in the thread changes who is on it.",
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
  required: { meeting_id: 'string', to: 'addresses' },
  optional: { cc: 'addresses', bcc: 'addresses' },
  repeatable: true,
  check: (args) => (Array.isArray(args.to) && args.to.length === 0 ? 'Put at least one address on to.' : undefined),
});

export const askMain = requestTool({
  name: 'meeting_ask_main',
  description:
    'Ask main about something your brief does not cover, and wait: another window, another length, someone to add, another place, or anything only the principal can answer. You name only what it is about; main reads their emails itself, and its answer comes as a new brief. One question at a time.',
  properties: {
    meeting_id: MEETING_ID,
    about: { type: 'string', enum: [...ASK_TOPICS], description: 'What they asked for that main must answer.' },
  },
  required: { meeting_id: 'string', about: 'string' },
  repeatable: false,
  check: (args) =>
    ASK_TOPICS.some((topic) => topic === args.about) ? undefined : `about must be one of ${ASK_TOPICS.join(', ')}`,
});

export const outcome = requestTool({
  name: 'meeting_outcome',
  description:
    "Report how this conversation's meeting ended, once. booked: after meeting_book succeeded. settled: the organizer moved their invitation. not-scheduling: the thread is not about arranging a meeting. gave-up: no time could be agreed. responded: the answer a respond brief asked for is written. The host fills in the details for the principal.",
  properties: {
    meeting_id: MEETING_ID,
    outcome: { type: 'string', enum: [...OUTCOMES], description: 'How the meeting ended.' },
  },
  required: { meeting_id: 'string', outcome: 'string' },
  repeatable: true,
  check: (args) =>
    OUTCOMES.some((value) => value === args.outcome) ? undefined : `outcome must be one of ${OUTCOMES.join(', ')}`,
});

registerTools([arrange, reschedule, cancel, amend, respond, dismiss, replyToPrincipal], MAIN_CAPABILITY);
registerTools([freeTime, hold, book, askMain, recipients, outcome], EXTERNAL_CAPABILITY);
