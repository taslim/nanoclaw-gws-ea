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
 *
 * Steps 2 and 3 wait while any of main's containers runs, so they never race
 * a turn that is about to set the look itself.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { isContainerRunning } from '../../container-runner.js';
import { log } from '../../log.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { listOpenLookSlots, type LookSlot } from './db.js';
import {
  findTasks,
  lookSeries,
  mainConversation,
  mainConversations,
  oneAtATime,
  seriesKey,
  setLook,
  stillToCome,
  type HeldTask,
} from './looks.js';
import { keepMorning } from './morning.js';

/** How often the host makes its pass. */
const PASS_MS = 60_000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** Each open matter's slot, with the task it records as main's conversations hold it. */
interface Slot {
  readonly slot: LookSlot;
  readonly held: HeldTask | undefined;
}

async function readSlots(): Promise<Slot[]> {
  const slots = await listOpenLookSlots();
  const tasks = await findTasks(slots.flatMap((slot) => (slot.look_task_id === null ? [] : [slot.look_task_id])));
  return slots.map((slot) => ({ slot, held: slot.look_task_id === null ? undefined : tasks.get(slot.look_task_id) }));
}

/** Step 2: a look at the next morning for every open matter whose look will not come back. */
async function handBackMattersWithoutALook(
  conversation: Session,
  morning: string,
  slots: readonly Slot[],
): Promise<void> {
  for (const { slot, held } of slots) {
    if (stillToCome(held?.task)) continue;
    await setLook(conversation, slot.id, slot.look_task_id, { kind: 'once', at: morning }, true);
  }
}

/**
 * Step 3: a repeating look whose latest run failed, and whose next
 * occurrence is more than a day after the next morning, comes at the morning.
 * Once it runs, the sweep arms the next occurrence from its cron again.
 */
async function bringFailedRepeatsForward(morning: string, slots: readonly Slot[]): Promise<void> {
  for (const { held } of slots) {
    if (held === undefined) continue;
    const { session, task } = held;
    if (task.status !== 'pending' || task.recurrence === null || task.processAfter === null) continue;
    if (Date.parse(task.processAfter) - Date.parse(morning) <= DAY_MS) continue;
    const key = seriesKey(task);
    await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => {
      if (mailbox.trailingFailedRuns(key) > 0) mailbox.updateTask(key, { processAfter: morning });
    });
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

/** One pass of the host's guarantees. Nothing to keep until main and the principal's conversation exist. */
export function keepMattersOnTime(): Promise<void> {
  return oneAtATime(async () => {
    const conversation = await mainConversation();
    if (conversation === undefined) return;
    const { next: morning } = await keepMorning(conversation);
    const idle = (await mainConversations()).every((session) => !isContainerRunning(session.id));
    if (idle) {
      // Step 2 acts on looks that will not come back, step 3 on ones still to come: one read serves both.
      const slots = await readSlots();
      await handBackMattersWithoutALook(conversation, morning, slots);
      await bringFailedRepeatsForward(morning, slots);
    }
    await cancelStrayLooks();
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
