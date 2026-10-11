/**
 * The host's guarantees for matters (KTD7, R13, R14, R16, R24): a pass every
 * minute, without the model, that keeps time for main.
 *
 * 1. The morning series exists (`morning.ts`).
 * 2. Every open matter has a look still to come. One left without, because
 *    its look ran and no new one was set, or was cancelled, paused or lost,
 *    gets one at the next morning, named as handed back (R14).
 * 3. A repeating look whose latest run failed comes back at the next morning
 *    instead of at its next date, which its cron keeps: a failed birthday
 *    look comes back the next day, not next year. Its next occurrence is
 *    brought forward, so the series still has one occurrence to come, which
 *    every reader of a series sees.
 * 4. Any other look task naming a matter is cancelled, so an open matter has
 *    one look and a closed one none.
 * 5. Threads still waiting to be placed ride on main's next turn of any kind
 *    (R27): one note that wakes nothing names them all, written once no
 *    earlier note asking main to place them is still to be read.
 *
 * Steps 2 and 3 wait while any of main's containers runs, so they never race
 * a turn that is about to set the look itself.
 */
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';

import { isContainerRunning } from '../../container-runner.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { listUnplacedThreads, recordPlacementNote } from '../gws-ea-inbox/thread-map.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { listOpenLookSlots, markLookFailed, type LookSlot } from './db.js';
import {
  listHeldLookSlots,
  lookSeries,
  mainConversation,
  mainConversations,
  oneAtATime,
  seriesKey,
  setLook,
  stillToCome,
  type HeldSlot,
} from './looks.js';
import { keepMorning, unplacedThreadLine } from './morning.js';
import { principalTimezone } from './render.js';

/** How often the host makes its pass. */
const PASS_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Step 2: a look at the next morning for every open matter whose look will not come back. */
async function handBackMattersWithoutALook(
  conversation: Session,
  morning: string,
  slots: readonly HeldSlot[],
): Promise<void> {
  for (const { slot, held } of slots) {
    if (stillToCome(held?.task)) continue;
    await setLook(conversation, slot.id, slot.look_task_id, { kind: 'once', at: morning }, true);
  }
}

/** A repeating look still to come: its slot, its series, and when its next occurrence comes, ISO. */
interface Repeat {
  readonly slot: LookSlot;
  readonly key: string;
  readonly processAfter: string;
}

/**
 * Step 3: a repeating look whose latest run failed, and whose next
 * occurrence is more than a day after the next morning, comes at the morning.
 * A failed script shows in the series' runs; a failed turn, which the runner
 * settles as done, shows in the mark the notices module sets on the matter.
 * Once it runs, the sweep arms the next occurrence from its cron again.
 */
async function bringFailedRepeatsForward(morning: string, slots: readonly HeldSlot[]): Promise<void> {
  // The repeating looks still to come, by the conversation that holds each, so its mailbox opens once.
  const conversations = new Map<string, { readonly session: Session; readonly repeats: Repeat[] }>();
  for (const { slot, held } of slots) {
    if (held === undefined) continue;
    const { session, task } = held;
    // Until the sweep arms the occurrence after a failed run, the mark waits for the next pass.
    if (task.status !== 'pending' || task.recurrence === null || task.processAfter === null) continue;
    const conversation = conversations.get(session.id) ?? { session, repeats: [] };
    conversation.repeats.push({ slot, key: seriesKey(task), processAfter: task.processAfter });
    conversations.set(session.id, conversation);
  }
  for (const { session, repeats } of conversations.values()) {
    const failed =
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        repeats.filter(({ slot, key, processAfter }) => {
          // A failed script shows in the series' runs; a failed turn, which the runner settles as done, only in the mark.
          const failed = slot.look_failed_at !== null || mailbox.trailingFailedRuns(key) > 0;
          if (failed && Date.parse(processAfter) - Date.parse(morning) > DAY_MS) {
            mailbox.updateTask(key, { processAfter: morning });
          }
          return failed;
        }),
      )) ??
      // A conversation whose mailbox is gone has no runs to read and no look to move: only the marks count.
      repeats.filter(({ slot }) => slot.look_failed_at !== null);
    // Each mark is cleared once its look has come forward.
    for (const { slot } of failed) if (slot.look_failed_at !== null) await markLookFailed(slot.id, null);
  }
}

/** Step 4: cancel every look task that is not the one its matter records, a closed matter recording none. */
async function cancelStrayLooks(): Promise<void> {
  const recorded = new Map((await listOpenLookSlots()).map((slot) => [slot.id, slot.look_task_id]));
  for (const session of await mainConversations()) {
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      for (const task of mailbox.listLiveTasks()) {
        const key = seriesKey(task);
        const look = lookSeries(key);
        if (look !== undefined && recorded.get(look.matterId) !== key) mailbox.cancelTask(key);
      }
    });
  }
}

/**
 * Step 5: one note, waking nothing, that names every thread waiting to be
 * placed, unless each one's last note asking main to place it is still to
 * be read in `conversation`. Its id comes from the threads and the notes
 * before it, so a pass that wrote it and failed to record it writes no other.
 */
async function remindOfUnplacedThreads(conversation: Session): Promise<void> {
  const threads = await listUnplacedThreads();
  if (threads.length === 0) return;
  const asked = threads.flatMap((thread) => (thread.placementNote === null ? [] : [thread.placementNote]));
  const unread = await withExistingMailboxSession(
    conversation.agent_group_id,
    conversation.id,
    (mailbox) => new Set(asked.filter((id) => mailbox.getMessageForRetry(id, 'pending') !== undefined)),
  );
  if (threads.every((thread) => thread.placementNote !== null && unread?.has(thread.placementNote) === true)) return;
  const id = `matters-unplaced-${createHash('sha256')
    .update(threads.map((thread) => `${thread.threadKey}\u0000${thread.placementNote ?? ''}`).join('\u0000'))
    .digest('hex')
    .slice(0, 24)}`;
  const timezone = await principalTimezone();
  const written = await writeNoteForMain({
    id,
    timestamp: new Date().toISOString(),
    wake: false,
    text: [
      'Email threads you have not placed are waiting on you, and external-email reads none of their mail until you place each one and hand it over:',
      ...threads.map((thread) => unplacedThreadLine(thread, timezone)),
    ].join('\n'),
  });
  if (written === 'written' || written === 'already-written') {
    await recordPlacementNote(
      threads.map((thread) => thread.threadKey),
      id,
    );
  }
}

/** One pass of the host's guarantees. Nothing to keep until main and the principal's conversation exist. */
export function keepMattersOnTime(): Promise<void> {
  return oneAtATime(async () => {
    const conversation = await mainConversation();
    if (conversation === undefined) return;
    const { next: morning } = await keepMorning(conversation);
    const idle = (await mainConversations()).every((session) => !isContainerRunning(session.id));
    if (idle) {
      // Step 2 acts on looks that will not come back, step 3 on ones still to come: one read serves both.
      const slots = await listHeldLookSlots();
      await handBackMattersWithoutALook(conversation, morning, slots);
      await bringFailedRepeatsForward(morning, slots);
    }
    await cancelStrayLooks();
    await remindOfUnplacedThreads(conversation);
  });
}

/** Keep matters on time until `signal` aborts: a pass now, then one a minute. */
export async function runMattersLoop(signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    /* eslint-disable no-catch-all/no-catch-all -- a background loop: every failure is logged and the next pass tries again */
    try {
      await keepMattersOnTime();
    } catch (error) {
      log.warn('Could not keep matters on time; the next pass tries again', { err: error });
    }
    /* eslint-enable no-catch-all/no-catch-all */
    await delay(PASS_MS, undefined, { signal }).catch(() => undefined);
  }
}
