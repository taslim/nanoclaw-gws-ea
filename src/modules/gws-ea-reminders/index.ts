/**
 * GWS-EA's reminders (KTD8, R73): either agent comes back to its own
 * conversation at a time it chooses. Nothing else times follow-through.
 *
 * `remind_me` writes a due chat row into the calling session's own inbound
 * mailbox. Core's `process_after` holds it, and the host sweep wakes the
 * session once it is due, whether or not its container is running.
 * `clear_reminder` settles one of the session's waiting reminders by id. The
 * session is always the one the request was delivered from, and no argument
 * names another, so one conversation never sets or clears another's.
 * `main`'s one shared session may hold several at once.
 *
 * Each request gets one `action_response` (`writeActionResponse`), a refusal
 * included, which the runner's tool shows as is (`answerResult`):
 *
 *   remind_me       { at, note }    → { reminder_id, at, message }
 *   clear_reminder  { reminder_id } → { reminder_id, message }
 *
 * `at` is a date and time with its UTC offset, as `time_resolve` gives it,
 * in the future and at most 30 days ahead; the answer's `at` is that time in
 * UTC. `note` is what the agent wants to read when it comes back. A refusal
 * answers `invalid-args` or `forbidden`, with why.
 *
 * A reminder is the agent's note to itself: no route, no sender identity,
 * no principal mark, and never sender `system`, so a note drawn from an
 * email never reads as the host's word. Its id starts with
 * `REMINDER_ID_PREFIX`, which is how a reader of the mailbox tells a
 * reminder, which keeps its own time, from any other row waiting to be due.
 */
import { registerCapability } from '../../capabilities.js';
import { writeActionResponse } from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { resolveGroupTimezone } from '../../container-config.js';
import { isTaskThread } from '../../db/sessions.js';
import { registerDeliveryAction, type DeliveryActionHandler } from '../../delivery.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { unguarded } from '../../guard/index.js';
import { log } from '../../log.js';
import { parseIsoTimestamp } from '../../mailbox/model.js';
import { withExistingMailboxSession, writeSessionMessage } from '../../session-manager.js';
import { formatLocalTime } from '../../timezone.js';
import type { Session } from '../../types.js';
import { isDuplicateNote } from '../gws-ea-profile/main-note.js';

/** The key that grants an agent `remind_me` and `clear_reminder`. */
export const REMINDERS_CAPABILITY = 'gws-ea-reminders';

registerCapability(REMINDERS_CAPABILITY, {
  description: 'remind_me, clear_reminder: come back to this conversation at a chosen time, up to 30 days ahead',
  default: 'on',
  instructions: ['reminders'],
});

/** Every reminder's id starts with this: the remainder is the id of the request that set it. */
export const REMINDER_ID_PREFIX = 'reminder-';

/**
 * Whether a `messages_in` row is a reminder. A reminder keeps its own time,
 * so nothing that times a session's other rows ever joins or counts it (KTD3).
 */
export function isReminderId(id: string): boolean {
  return id.startsWith(REMINDER_ID_PREFIX);
}

/** How a reminder reads to the agent when it comes back: its own, and nobody else's. */
const REMINDER_SENDER = 'your reminder';
const MAX_AHEAD_MS = 30 * 24 * 60 * 60 * 1000;
const NOTE_MAX = 1_000;
const REQUEST_ID = /^[A-Za-z0-9._:-]{1,128}$/u;
const REMINDER_ID = /^reminder-[A-Za-z0-9._:-]{1,128}$/u;
const DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?(?:Z|[+-]\d{2}:\d{2})$/iu;

/** A request the host refuses as asked: the agent reads why and can ask differently. */
class ReminderRefusal extends Error {
  constructor(
    readonly code: 'invalid-args' | 'forbidden',
    message: string,
  ) {
    super(message);
    this.name = 'ReminderRefusal';
  }
}

function invalid(message: string): ReminderRefusal {
  return new ReminderRefusal('invalid-args', message);
}

/** The time a reminder comes back, in UTC. */
function dueAt(value: unknown, now: number): string {
  if (typeof value !== 'string' || !DATE_TIME.test(value)) {
    throw invalid('at must be a date and time with its UTC offset, such as 2026-10-07T09:00:00-04:00');
  }
  const due = Date.parse(value);
  if (!Number.isFinite(due)) throw invalid(`at is not a real date and time: ${value}`);
  if (due <= now) throw invalid('at must be in the future');
  if (due - now > MAX_AHEAD_MS) throw invalid('at must be at most 30 days ahead');
  return new Date(due).toISOString();
}

function noteOf(value: unknown): string {
  const note = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (note === '' || note.length > NOTE_MAX || hasControlCharacters(note)) {
    throw invalid(`note must be text of 1 to ${NOTE_MAX} characters`);
  }
  return note;
}

type Handle = (
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
) => Promise<Record<string, unknown>>;

async function remindMe(
  content: Record<string, unknown>,
  session: Session,
  requestId: string,
): Promise<Record<string, unknown>> {
  if (isTaskThread(session.thread_id)) {
    throw new ReminderRefusal('forbidden', 'A scheduled task run has no conversation to come back to.');
  }
  const now = Date.now();
  const at = dueAt(content.at, now);
  const note = noteOf(content.note);
  const id = `${REMINDER_ID_PREFIX}${requestId}`;
  const timezone = await resolveGroupTimezone(session.agent_group_id);
  try {
    await writeSessionMessage(session.agent_group_id, session.id, {
      id,
      kind: 'chat',
      // The time it comes back, which the agent reads as the message's time.
      timestamp: at,
      content: JSON.stringify({
        text: `You set this reminder on ${formatLocalTime(new Date(now).toISOString(), timezone)}: ${note}`,
        sender: REMINDER_SENDER,
      }),
      processAfter: at,
      trigger: true,
    });
  } catch (error) {
    // A replayed request: the reminder it set is already there.
    if (!isDuplicateNote(error)) throw error;
  }
  return { reminder_id: id, at, message: `Reminder ${id} is set for ${formatLocalTime(at, timezone)}.` };
}

async function clearReminder(content: Record<string, unknown>, session: Session): Promise<Record<string, unknown>> {
  const id = content.reminder_id;
  if (typeof id !== 'string' || !REMINDER_ID.test(id)) {
    throw invalid('reminder_id must be the id remind_me answered with, such as reminder-…');
  }
  const outcome = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
    const waiting = mailbox.getMessageForRetry(id, 'pending');
    // A reminder has its own time and no route.
    if (!waiting || waiting.processAfter === null || waiting.channelType !== null) return 'missing' as const;
    if (Date.parse(waiting.processAfter) <= Date.now()) return 'due' as const;
    // Settled as done, the status a handled message gets, so it never wakes the session.
    // The row stays, which keeps a replayed remind_me from setting it again.
    mailbox.applyProcessingAcks([
      { messageId: id, status: 'completed', statusChanged: parseIsoTimestamp(new Date().toISOString()) },
    ]);
    return 'cleared' as const;
  });
  switch (outcome) {
    case 'cleared':
      return { reminder_id: id, message: `Reminder ${id} is cleared.` };
    case 'due':
      throw invalid(`Reminder ${id} has already come due.`);
    case 'missing':
    case undefined:
      throw invalid(`There is no waiting reminder ${id} in this conversation.`);
    default: {
      const unreachable: never = outcome;
      throw new Error(`Unknown outcome: ${String(unreachable)}`);
    }
  }
}

function errorFrame(requestId: string, error: unknown): ResponseFrame {
  if (error instanceof ReminderRefusal) {
    return { id: requestId, ok: false, error: { code: error.code, message: error.message } };
  }
  const reason = error instanceof Error ? error.message : String(error);
  return { id: requestId, ok: false, error: { code: 'handler-error', message: `The host could not do it: ${reason}` } };
}

/** A delivery action that answers its request once, a refusal or failure included. */
function answering(action: string, handle: Handle): DeliveryActionHandler {
  return async (content, session) => {
    const requestId = typeof content.requestId === 'string' ? content.requestId : '';
    if (!REQUEST_ID.test(requestId)) {
      log.warn('Reminder request without a request id: nothing to answer', { action, sessionId: session.id });
      return;
    }
    let frame: ResponseFrame;
    /* eslint-disable no-catch-all/no-catch-all -- every request is answered, a failure included; nothing is rethrown into a retry */
    try {
      frame = { id: requestId, ok: true, data: await handle(content, session, requestId) };
    } catch (error) {
      if (error instanceof ReminderRefusal) {
        log.info('Reminder request refused', { action, requestId, sessionId: session.id, reason: error.message });
      } else {
        log.error('Reminder request failed', { action, requestId, sessionId: session.id, err: error });
      }
      frame = errorFrame(requestId, error);
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await writeActionResponse(session, requestId, frame);
  };
}

const REQUESTS: ReadonlyArray<readonly [string, Handle]> = [
  ['remind_me', remindMe],
  ['clear_reminder', clearReminder],
];

/** The action names reminders answer, which the runner's tools of the same names send. */
export const REMINDER_ACTIONS: readonly string[] = REQUESTS.map(([action]) => action);

for (const [action, handle] of REQUESTS) {
  registerDeliveryAction(
    action,
    answering(action, handle),
    unguarded("acts only on the calling session's own mailbox, which the delivery names; no argument reaches another"),
  );
}
