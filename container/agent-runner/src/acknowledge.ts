/**
 * A person waiting in a live chat hears from the agent while a long job runs.
 *
 * An instruction to acknowledge first does not do this on its own: a model
 * starts a turn by thinking and calling tools, and cannot tell before it looks
 * how long a job will take, so it speaks when it is done, however long that
 * is. The runner watches the clock instead. Once a person's chat message has
 * waited `ACKNOWLEDGE_AFTER_MS` and nothing has been sent this turn, the next
 * tool result carries one reminder: if more tools are needed before the
 * reply, tell them first, in one line, what you are doing. The agent decides
 * and writes the line in its own voice; the runner never writes to anyone.
 *
 * Turn state is the poll loop's: it starts the wait when a person's chat
 * message begins a turn and stops it when the turn ends. The provider asks
 * for the reminder after each batch of tool calls.
 *
 * A chat that itself shows the person their message is being worked on needs
 * no reminder: the sign tells them it was received without asking the agent
 * for a line. The formatter's `personWaiting` leaves such chats out, and a
 * long job there gets its one-line plan from the agent's own judgment.
 */

/** How long a person waits in silence before the agent is reminded to acknowledge. */
export const ACKNOWLEDGE_AFTER_MS = 10_000;

/**
 * Channels whose host marks a person's message while a turn works on it:
 * Google Chat, where the assistant's own account puts 👀 on the message after
 * a few seconds and takes it off when the work ends (src/modules/gws-ea-chat).
 */
const WORKING_INDICATOR_CHANNELS: ReadonlySet<string> = new Set(['gchat']);

/** Whether a person writing on this channel sees that the agent is working on their message. */
export function showsWorkingIndicator(channelType: string | null): boolean {
  return channelType !== null && WORKING_INDICATOR_CHANNELS.has(channelType);
}

interface Waiting {
  readonly since: number;
  /** Whether anything has been sent this turn. */
  readonly sent: () => boolean;
  reminded: boolean;
}

let waiting: Waiting | undefined;

/** A turn answering a person in a live chat began; `sent` says whether anything has gone out since. */
export function startWaiting(sent: () => boolean, now = Date.now()): void {
  waiting = { since: now, sent, reminded: false };
}

/** The turn ended, or it answers no one waiting. */
export function stopWaiting(): void {
  waiting = undefined;
}

/** The reminder, once per turn, when a person has waited in silence long enough; otherwise undefined. */
export function acknowledgmentReminder(now = Date.now()): string | undefined {
  if (waiting === undefined || waiting.reminded || now - waiting.since < ACKNOWLEDGE_AFTER_MS) return undefined;
  waiting.reminded = true;
  if (waiting.sent()) return undefined;
  const seconds = Math.round((now - waiting.since) / 1000);
  return (
    `The person you are answering has waited ${seconds} seconds and has heard nothing from you yet. ` +
    'If you will use any more tools before your reply, first send them one line, in your own words, saying what you are doing. ' +
    'If your next message is the reply itself, just send it.'
  );
}
