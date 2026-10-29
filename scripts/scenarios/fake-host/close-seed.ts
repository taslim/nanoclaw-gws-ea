import { getDb } from '../../../src/db/connection.js';
import { resolveSystemSession } from '../../../src/session-manager.js';
import { createScheduledTask, prepareScheduledTask } from '../../../src/modules/scheduling/create.js';
import { CLOSE_PROMPT, nextClosePlacement } from '../../../src/modules/gws-ea-matters/sync.js';
import { loadTimeline } from '../../../src/modules/gws-ea-whereabouts/timeline.js';
import { sundayOnOrBefore } from '../../../src/modules/gws-ea-matters/moments.js';
import { openMatterWithLook } from '../../../src/modules/gws-ea-matters/looks.js';
import type { Session } from '../../../src/types.js';
import type { ScenarioComposition } from '../types.js';
import { readState } from './state.js';
import { closeDates, CLOSE_ZONE } from './close-dates.js';

/** The due occurrence is an invented persisted fact; the runtime clock stays real. */
export async function seedCloseScenario(
  file: string,
  main: Session,
): Promise<{ session: Session; close: NonNullable<ScenarioComposition['close']> }> {
  const fixture = readState(file);
  const referenceAt = fixture.referenceAt;
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
  await getDb().run(
    "INSERT INTO gws_ea_close_runs(id,session_id,scheduled_at,zone,timeline_version,weekly_day,state) VALUES(?,?,?,?,?,?,'pending')",
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
  return {
    session,
    close: {
      runId: id,
      task: task.row,
      scheduledAt,
      scope: {
        referenceAt,
        today: dates.today,
        tomorrow: dates.tomorrow,
        due: dates.due,
        ...(matterId ? { matterId } : {}),
      },
    },
  };
}
