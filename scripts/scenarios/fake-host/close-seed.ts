import { getDb } from '../../../src/db/connection.js';
import { resolveSystemSession } from '../../../src/session-manager.js';
import { createScheduledTask, prepareScheduledTask } from '../../../src/modules/scheduling/create.js';
import { CLOSE_PROMPT, nextClosePlacement } from '../../../src/modules/gws-ea-matters/sync.js';
import {
  beginCloseRun,
  recordCloseLedger,
  completeCloseRun,
  failCloseRun,
} from '../../../src/modules/gws-ea-matters/close-runs.js';
import { loadTimeline } from '../../../src/modules/gws-ea-whereabouts/timeline.js';
import { sundayOnOrBefore } from '../../../src/modules/gws-ea-matters/moments.js';
import { openMatterWithLook } from '../../../src/modules/gws-ea-matters/looks.js';
import { beginCalendarWrite, markCalendarWriteApplied } from '../../../src/modules/gws-ea-meetings/week/write-log.js';
import type { Session } from '../../../src/types.js';
import type { ScenarioComposition } from '../types.js';
import { readState, SYNTHETIC_IDENTITY } from './state.js';
import { closeDates, CLOSE_ZONE } from './close-dates.js';

/** Due occurrences and historical receipts are invented persisted facts; the runtime clock stays real. */
export async function seedCloseScenario(
  file: string,
  main: Session,
): Promise<{ session: Session; close: NonNullable<ScenarioComposition['close']> }> {
  const fixture = readState(file);
  const referenceAt = fixture.referenceAt ?? new Date().toISOString();
  const reference = Date.parse(referenceAt);
  const dates = closeDates(referenceAt);
  const timeline = await loadTimeline();
  let moment = nextClosePlacement(timeline, reference - 86_400_000);
  if (fixture.scenario.id === 'sunday-stale-matter') {
    let sunday = sundayOnOrBefore(reference, CLOSE_ZONE);
    if (Date.parse(dates.at(sunday, 21)) > reference) sunday = sundayOnOrBefore(reference - 7 * 86_400_000, CLOSE_ZONE);
    moment = nextClosePlacement(timeline, Date.parse(dates.at(sunday, 0)));
  }
  const id = `gws-ea-close-synthetic-${fixture.scenario.id}`;
  const { session } = await resolveSystemSession(main.agent_group_id, `system:gws-ea-close:${id}`);
  const scheduledAt = new Date(moment.at).toISOString();
  const completedId = `synthetic-completed-${fixture.scenario.id}`;
  const completedThrough = new Date(moment.at - 2 * 86_400_000).toISOString();
  await beginCloseRun({
    id: completedId,
    sessionId: 'synthetic-history-completed',
    taskId: completedId,
    startedAt: completedThrough,
  });
  await recordCloseLedger(completedId, 'synthetic-history-completed', {
    from: null,
    through: completedThrough,
    writes: [],
  });
  await completeCloseRun(completedId, 'synthetic-history-completed', completedThrough);
  const historicalWriteAt = new Date(moment.at - 86_400_000 - 60_000).toISOString();
  if (fixture.scenario.id === 'sunday-stale-matter') {
    const start = dates.at(dates.tomorrow, 19);
    await beginCalendarWrite({
      requestId: 'synthetic-close-applied-write',
      calendarId: SYNTHETIC_IDENTITY.principalEmail,
      eventId: 'synthetic-stale-proposal-review',
      action: 'create_event',
      request: { title: 'Earlier provisional proposal review' },
      before: null,
      affectedStart: start,
      affectedEnd: dates.at(dates.tomorrow, 19, 25),
    });
    await markCalendarWriteApplied('synthetic-close-applied-write', 'The earlier provisional review was created.');
    await getDb().run(
      'UPDATE gws_ea_calendar_write_log SET updated_at=? WHERE request_id=?',
      historicalWriteAt,
      'synthetic-close-applied-write',
    );
  }
  const failedId = `synthetic-failed-${fixture.scenario.id}`;
  await beginCloseRun({
    id: failedId,
    sessionId: 'synthetic-history-failed',
    taskId: failedId,
    startedAt: new Date(moment.at - 86_400_000).toISOString(),
  });
  await recordCloseLedger(failedId, 'synthetic-history-failed', {
    from: completedThrough,
    through: new Date(moment.at - 43_200_000).toISOString(),
    writes:
      fixture.scenario.id === 'sunday-stale-matter'
        ? [{ requestId: 'synthetic-close-applied-write', updatedAt: historicalWriteAt }]
        : [],
  });
  await failCloseRun(failedId, new Date(moment.at - 43_200_000 + 60_000).toISOString());
  await getDb().run(
    'INSERT INTO gws_ea_close_schedule(id,session_id,scheduled_at,zone,timeline_version,weekly_day) VALUES(?,?,?,?,?,?)',
    id,
    session.id,
    scheduledAt,
    moment.zone,
    timeline.version,
    null,
  );
  const prepared = prepareScheduledTask({
    name: 'gws-ea close',
    prompt: `${CLOSE_PROMPT}\nClose-run: ${id}.`,
    script: `ncl matters evening --run ${id}`,
    processAfter: scheduledAt,
    timezone: moment.zone,
  });
  prepared.clock = { instant: scheduledAt, zone: moment.zone };
  const task = await createScheduledTask(main.agent_group_id, prepared, { session, id });
  let matterId: string | undefined;
  if (fixture.scenario.id === 'sunday-stale-matter') {
    const matter = await openMatterWithLook(
      {
        title: 'Proposal for Juno',
        openLoop:
          'Proposal needs an owner, 45 minutes of preparation and confirmation before Wednesday. The linked conversation has the current facts; the old summary is stale.',
        dueAt: dates.due,
        needsMinutes: 45,
        links: [{ kind: 'thread', reference: 'mail-synthetic-stale-proposal' }],
      },
      { kind: 'morning' },
    );
    matterId = matter.matter.id;
    await getDb().run(
      'UPDATE gws_ea_matters SET created_at=?,updated_at=? WHERE id=?',
      new Date(reference - 14 * 86_400_000).toISOString(),
      new Date(reference - 14 * 86_400_000).toISOString(),
      matter.matter.id,
    );
  }
  if (fixture.scenario.id === 'close-quiet') {
    await openMatterWithLook(
      {
        title: 'Annual paperwork',
        openLoop: 'Settled until the scheduled review next month; no pending decision or new result.',
        links: [],
      },
      { kind: 'once', at: new Date(reference + 30 * 86_400_000).toISOString() },
    );
  }
  const { writeDestinations } = await import('../../../src/modules/agent-to-agent/write-destinations.js');
  await writeDestinations(main.agent_group_id, session.id);
  const Database = (await import('better-sqlite3')).default;
  const { inboundDbPath } = await import('../../../src/mailbox/sqlite/paths.js');
  const { parseDestinationRecord } = await import('../../../src/mailbox/model.js');
  const inbox = new Database(inboundDbPath(main.agent_group_id, session.id), { readonly: true });
  let destinations: ReturnType<typeof parseDestinationRecord>[];
  try {
    destinations = inbox
      .prepare(
        'SELECT name,display_name AS displayName,type,channel_type AS channelType,platform_id AS platformId,agent_group_id AS agentGroupId,session_mode AS sessionMode FROM destinations',
      )
      .all()
      .map(parseDestinationRecord);
  } finally {
    inbox.close();
  }
  return {
    session,
    close: {
      runId: id,
      task: task.row,
      destinations: destinations ?? [],
      scheduledAt,
      scope: {
        referenceAt,
        today: dates.today,
        tomorrow: dates.tomorrow,
        due: dates.due,
        completedThrough,
        ...(matterId ? { matterId } : {}),
      },
    },
  };
}
