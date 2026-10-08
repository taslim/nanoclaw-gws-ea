/**
 * GWS-EA's email tools (KTD4, KTD5, KTD7, KTD9): typed requests to the host,
 * each named after the action it sends but `email_principal`, which sends
 * main's `email_send`. The host checks every request
 * against its caller and thread, so these handlers only shape the call and
 * stage the files it carries.
 *
 * - `main` (capability `gws-ea-email`) hands work in an email thread to
 *   `external-email` with `email_handoff`, and writes to the principal in one
 *   of their threads with `email_principal`.
 * - `external-email` (capability `gws-ea-email-external`) writes in its own
 *   thread with `email_send`, tells main what main should know with
 *   `tell_main`, and schedules on the principal's calendar with `free_time`,
 *   `hold`, `book`, `change_booking` and `cancel_booking`, each bound by the
 *   host to the thread whose session calls it.
 *
 * Both send the host's one `email_send` action, which answers each caller by
 * its own rules; each agent's tool has only the fields and limits that are its.
 * A sent email is the turn's reply, so both mark the request as delivering.
 *
 * A file goes with a request the way `send_file` sends one: copied into the
 * session's outbox under the request's id before the request is written, and
 * read by the host from there alone, never from a path the agent names.
 */
import fs from 'node:fs';
import path from 'node:path';

import { requestOutbox, requestTool } from '../action-request.js';
import { registerTools } from './server.js';

const MAIN_CAPABILITY = 'gws-ea-email';
const EXTERNAL_CAPABILITY = 'gws-ea-email-external';

/** How long a tool waits for the host; a request may still go through after that. */
export const EMAIL_REQUEST_TIMEOUT_MS = 120_000;

const WORKSPACE = '/workspace/agent';
const MAX_FILES = 10;

/**
 * Copy the files a request names into its outbox, each by its file name, and
 * send those names. Every file is checked first, so a refusal stages nothing.
 */
function stageFiles(fields: Record<string, unknown>, requestId: string): Record<string, unknown> | string {
  const listed = fields.files;
  if (listed === undefined) return fields;
  if (
    !Array.isArray(listed) ||
    listed.length > MAX_FILES ||
    !listed.every((item): item is string => typeof item === 'string' && item.trim() !== '')
  ) {
    return `files must list up to ${MAX_FILES} file paths`;
  }
  const sources = listed.map((item) => (path.isAbsolute(item) ? item : path.resolve(WORKSPACE, item)));
  const missing = listed.find((_, index) => fs.statSync(sources[index], { throwIfNoEntry: false })?.isFile() !== true);
  if (missing !== undefined) return `No file at ${missing}`;
  const names = sources.map((source) => path.basename(source));
  const repeated = names.find((name, index) => names.indexOf(name) !== index);
  if (repeated !== undefined) return `Two of the files are named ${repeated}: send them in separate requests.`;
  if (sources.length > 0) {
    const outbox = requestOutbox(requestId);
    fs.mkdirSync(outbox, { recursive: true });
    sources.forEach((source, index) => fs.copyFileSync(source, path.join(outbox, names[index])));
  }
  return { ...fields, files: names };
}

const ADDRESSES = { type: 'array', items: { type: 'string' } } as const;
const FILES = {
  type: 'array',
  items: { type: 'string' },
  description: 'Paths of files to send with it, absolute or relative to /workspace/agent/. Up to 10.',
} as const;
const DATE_TIME = 'A date and time with its UTC offset, as time_resolve gives it, such as 2026-10-12T09:00:00-07:00.';
const MINUTES = { type: 'integer', description: 'How long the meeting is, in minutes (5 to 480).' } as const;
const BOOKING = { type: 'string', description: 'The booking id book answered with.' } as const;

const common = { timeoutMs: EMAIL_REQUEST_TIMEOUT_MS } as const;

// ---------------------------------------------------------------------------
// main's tools
// ---------------------------------------------------------------------------

export const emailHandoff = requestTool({
  ...common,
  name: 'email_handoff',
  description:
    "Hand external-email work in one email thread: an existing one by thread_key, or a new one with the people you name. It reads your message, decides who each email goes to and who is copied, and writes the emails. The host refuses a message or text file carrying one of the principal's private details. Answers with the thread_key.",
  properties: {
    thread_key: { type: 'string', description: 'The mail-… key of an existing thread, as a message about it gave it.' },
    people: {
      ...ADDRESSES,
      description:
        'Email addresses of the people a new thread is with (1 to 20), or of anyone to bring into an existing one. Say in your message if someone should only be copied.',
    },
    message: {
      type: 'string',
      description:
        'Your words to external-email, in plain language. The people on the thread may read what it leads to.',
    },
    files: { ...FILES, description: `${FILES.description} external-email may attach them in this thread only.` },
    calendar: {
      type: 'string',
      description: "The principal's calendar its bookings go on, when not their primary one.",
    },
  },
  required: ['message'],
  repeatable: false,
  prepare: stageFiles,
});

export const emailToPrincipal = requestTool({
  ...common,
  name: 'email_principal',
  action: 'email_send',
  description:
    'Email the principal in one of their email threads, by its thread_key: only to the address Gmail verified wrote to you there. Your reply to the message you are answering goes there already; this writes in another thread, or later. Answers once it is sent.',
  properties: {
    thread_key: { type: 'string', description: 'The mail-… key of the principal’s thread.' },
    text: { type: 'string', description: 'Your email, in markdown.' },
    files: { ...FILES, description: `${FILES.description} The principal may receive any file.` },
  },
  required: ['thread_key', 'text'],
  repeatable: false,
  delivers: true,
  prepare: stageFiles,
});

// ---------------------------------------------------------------------------
// external-email's tools
// ---------------------------------------------------------------------------

export const emailSend = requestTool({
  ...common,
  name: 'email_send',
  description:
    "Send an email in this thread now. The thread's first email needs a subject, and goes to the people main named unless to says otherwise. Without to, it goes to everyone as the latest email placed them. to and cc may name only people in the thread or named by main. Answers once it is sent.",
  properties: {
    text: { type: 'string', description: 'Your email, in markdown.' },
    subject: { type: 'string', description: "The thread's first email only: its subject." },
    to: { ...ADDRESSES, description: 'Who it goes to, in place of everyone.' },
    cc: { ...ADDRESSES, description: 'Who is copied, with to.' },
    files: { ...FILES, description: 'Paths of files main handed you for this thread, to attach.' },
  },
  required: ['text'],
  repeatable: false,
  delivers: true,
  prepare: stageFiles,
});

export const tellMain = requestTool({
  ...common,
  name: 'tell_main',
  description:
    'Tell main something from this thread: what happened, what someone asks of the principal, or what you need. main reads it as information from this thread, and any answer comes here as a new message. Answers once main has it.',
  properties: { message: { type: 'string', description: 'What main should know, in plain language.' } },
  required: ['message'],
  repeatable: false,
});

/** The other side's zone: an answer then gives each time in it too, ready to write. */
const THEIR_ZONE = {
  type: 'string',
  description: "The other side's time zone, such as Europe/Berlin, when you know it: the answer gives times in it too.",
} as const;

export const freeTime = requestTool({
  ...common,
  name: 'free_time',
  description:
    "The principal's free windows between from and to for a meeting of minutes, in date order, never in protected time: any start that ends by a window's end is free. Each shows the principal's time, the other side's when you give timezone (their night left out), and how it fits the principal's preferences. You pick the times.",
  properties: {
    from: { type: 'string', description: `The earliest start. ${DATE_TIME}` },
    to: { type: 'string', description: `When the meeting must be over. ${DATE_TIME}` },
    minutes: MINUTES,
    timezone: THEIR_ZONE,
  },
  required: ['from', 'to', 'minutes'],
  repeatable: true,
});

export const hold = requestTool({
  ...common,
  name: 'hold',
  description:
    "Hold up to three start times on the principal's calendar while someone chooses, replacing what this thread held; an empty list releases them all. A hold lapses three days after it was last held. A time that is protected or no longer free is refused, and nothing changes.",
  properties: {
    starts: { type: 'array', items: { type: 'string' }, description: `The start times you offer. ${DATE_TIME}` },
    minutes: MINUTES,
  },
  required: ['starts'],
  repeatable: true,
});

export const book = requestTool({
  ...common,
  name: 'book',
  description:
    "Book an agreed time as a new event on the principal's calendar, inviting everyone in the conversation but the principal, or the invitees you name from the thread. Google sends the invitation; this thread's holds are released, and main hears. A time that is protected or no longer free is refused. Answers with the booking id.",
  properties: {
    start: { type: 'string', description: `When it starts. ${DATE_TIME}` },
    minutes: MINUTES,
    title: { type: 'string', description: 'What the invitees see on their calendars.' },
    notes: { type: 'string', description: 'What the invitees read in the invitation.' },
    location: { type: 'string', description: 'Where they meet: an address, a phone number, or their own link.' },
    video_call: { type: 'boolean', description: 'true to add a Google Meet link.' },
    invitees: {
      ...ADDRESSES,
      description: 'Who to invite, each on the thread, in place of everyone in the conversation.',
    },
    timezone: THEIR_ZONE,
  },
  required: ['start', 'minutes', 'title'],
  repeatable: false,
});

export const changeBooking = requestTool({
  ...common,
  name: 'change_booking',
  description:
    'Change a booking this thread made: its time, length, title, location, notes, or a Google Meet link. Give only what changes. A new time that is protected or no longer free is refused. Google sends the invitees the update, and main hears.',
  properties: {
    booking: BOOKING,
    start: { type: 'string', description: `The new start. ${DATE_TIME}` },
    minutes: { ...MINUTES, description: 'The new length, in minutes (5 to 480).' },
    title: { type: 'string', description: 'The new title the invitees see.' },
    location: { type: 'string', description: 'The new place: an address, a phone number, or their own link.' },
    notes: { type: 'string', description: 'The new notes the invitees read in the invitation.' },
    video_call: { type: 'boolean', description: 'true to add a Google Meet link.' },
    timezone: THEIR_ZONE,
  },
  required: ['booking'],
  repeatable: true,
});

export const cancelBooking = requestTool({
  ...common,
  name: 'cancel_booking',
  description: 'Cancel a booking this thread made. Google sends the invitees the cancellation, and main hears.',
  properties: { booking: BOOKING, timezone: THEIR_ZONE },
  required: ['booking'],
  repeatable: true,
});

registerTools([emailHandoff, emailToPrincipal], MAIN_CAPABILITY);
registerTools([emailSend, tellMain, freeTime, hold, book, changeBooking, cancelBooking], EXTERNAL_CAPABILITY);
