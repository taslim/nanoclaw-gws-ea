import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getSchedulingPreferenceValues, type SchedulingPreferenceValues } from '../gws-ea-preferences/db.js';
import { noteCarriesNewFact } from '../gws-ea-profile/main-note.js';
import { createScheduledTask, prepareScheduledTask } from '../scheduling/create.js';
import { dateString, parseDate, wallClock, zonedInstant } from '../gws-ea-whereabouts/clock.js';
import { WEEKDAYS } from '../gws-ea-whereabouts/records.js';
import { loadTimeline, zoneAt } from '../gws-ea-whereabouts/timeline.js';
import { ECHO_CHANNEL_TYPE } from '../cross-session-context/config.js';
import { mainConversations, type ScriptVerdict } from './looks.js';

const minutes = (clock: string): number => Number(clock.slice(0, 2)) * 60 + Number(clock.slice(3));

function morningMinute(day: string, preferences: SchedulingPreferenceValues): number {
  const weekday = WEEKDAYS[(new Date(`${day}T12:00Z`).getUTCDay() + 6) % 7];
  const hours = preferences.working_hours.find((row) => row.weekday === weekday);
  if (!hours?.off) return hours ? Math.max(0, minutes(hours.start) - 60) : 7 * 60;
  let minute = 9 * 60;
  for (const window of [...preferences.protected_windows]
    .filter((row) => row.weekdays.includes(weekday))
    .sort((a, b) => minutes(a.start) - minutes(b.start))) {
    if (minutes(window.start) <= minute && minute < minutes(window.end)) minute = minutes(window.end);
  }
  return minute;
}

export async function morningLookIds(): Promise<Set<string>> {
  return new Set(
    (await getDb().all<{ matter_id: string }>('SELECT matter_id FROM gws_ea_morning_looks')).map(
      (row) => row.matter_id,
    ),
  );
}

interface MorningDecision {
  readonly day: string;
  readonly scheduled_at: string;
  readonly zone: string;
  readonly session_id: string;
  readonly task_id: string | null;
  readonly matters_json: string;
  readonly created: number;
}

async function ensureMorningTask(decision: MorningDecision): Promise<void> {
  if (decision.task_id === null || decision.created === 1) return;
  const session = await getSession(decision.session_id);
  if (!session) throw new Error('The morning conversation is unavailable.');
  /** to: main */
  const prepared = prepareScheduledTask({
    name: 'gws-ea morning',
    processAfter: decision.scheduled_at,
    timezone: decision.zone,
    prompt:
      'The morning holds work for you. Read the script facts and unread notes, act on the held looks, and set each next look or close its matter. Judge what needs the principal and combine it in one message when appropriate.',
    script: `ncl matters morning --date ${decision.day}`,
  });
  await createScheduledTask(session.agent_group_id, prepared, { session, id: decision.task_id });
  const ids = JSON.parse(decision.matters_json) as string[];
  await getDb().transaction(async () => {
    for (const id of ids) {
      await getDb().run(
        'UPDATE gws_ea_matters SET look_task_id=? WHERE id=? AND closed_at IS NULL AND id IN (SELECT matter_id FROM gws_ea_morning_looks)',
        decision.task_id,
        id,
      );
      await getDb().run('DELETE FROM gws_ea_morning_looks WHERE matter_id=?', id);
    }
    await getDb().run('UPDATE gws_ea_morning_decisions SET created=1 WHERE day=?', decision.day);
  });
}

async function heldNotes(): Promise<boolean> {
  for (const session of await mainConversations()) {
    const held = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .getInboundRecords({ status: 'pending' })
        .some(
          (message) =>
            message.kind !== 'system' &&
            message.kind !== 'task' &&
            !message.trigger &&
            message.channelType !== ECHO_CHANNEL_TYPE &&
            (message.processAfter === null || Date.parse(message.processAfter) <= Date.now()) &&
            noteCarriesNewFact(message.content),
        ),
    );
    if (held) return true;
  }
  return false;
}

/** Decide once per local date. Quiet decisions create no task or session and survive a host restart. */
export async function keepMorning(conversation: Session): Promise<void> {
  for (const pending of await getDb().all<MorningDecision>(
    'SELECT * FROM gws_ea_morning_decisions WHERE task_id IS NOT NULL AND created=0',
  ))
    await ensureMorningTask(pending);
  const timeline = await loadTimeline();
  const zone = zoneAt(timeline, Date.now());
  if (zone === null) return;
  const day = dateString(wallClock(Date.now(), zone));
  if (await getDb().get('SELECT day FROM gws_ea_morning_decisions WHERE day=?', day)) return;
  const preferences = await getSchedulingPreferenceValues();
  const at = zonedInstant(parseDate(day), morningMinute(day, preferences), zone);
  if (Date.now() < at || zoneAt(timeline, at) !== zone) return;
  const ids = [...(await morningLookIds())];
  const needed = ids.length > 0 || (await heldNotes());
  const decision: MorningDecision = {
    day,
    scheduled_at: new Date(at).toISOString(),
    zone,
    session_id: conversation.id,
    task_id: needed ? `gws-ea-morning-${day}` : null,
    matters_json: JSON.stringify(ids),
    created: needed ? 0 : 1,
  };
  await getDb().run(
    `INSERT INTO gws_ea_morning_decisions (day,scheduled_at,zone,session_id,task_id,matters_json,created) VALUES (?,?,?,?,?,?,?)`,
    day,
    decision.scheduled_at,
    zone,
    conversation.id,
    decision.task_id,
    decision.matters_json,
    decision.created,
  );
  await ensureMorningTask(decision);
}

export async function morningVerdict(day: string): Promise<ScriptVerdict> {
  const decision = await getDb().get<MorningDecision>('SELECT * FROM gws_ea_morning_decisions WHERE day=?', day);
  if (!decision?.task_id) return { wakeAgent: false, data: [] };
  const ids = JSON.parse(decision.matters_json) as string[];
  const rows = await getDb().all<{ id: string; title: string }>(
    'SELECT id,title FROM gws_ea_matters WHERE closed_at IS NULL AND look_task_id=?',
    decision.task_id,
  );
  const byId = new Map(rows.map((row) => [row.id, row]));
  const matters: string[] = [];
  for (const id of ids) {
    const row = byId.get(id);
    if (row) matters.push(`- ${id}: ${row.title}`);
  }
  return { wakeAgent: true, data: [`Morning ${day} in ${decision.zone}.`, ...matters] };
}
