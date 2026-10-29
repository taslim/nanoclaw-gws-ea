import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { callHost } from './state.js';
import type { ScenarioComposition } from '../types.js';

interface Run {
  id: string;
  state: string;
  ledger_writes_json: string | null;
  ledger_from_at: string | null;
  ledger_through_at: string | null;
}
interface Snapshot {
  closeRuns: Run[];
  closeSchedules: { id: string; report_text: string | null; report_notify: number | null }[];
  calendarWriteLog: { request_id: string }[];
  morningLooks: { matter_id: string }[];
  timeAnchors: { session_id: string; series_id: string; anchor: string }[];
  mailboxes: {
    sessionId: string;
    rows: {
      id: string;
      content: string;
      trigger: number;
      kind: string;
      process_after: string | null;
      series_id: string | null;
    }[];
  }[];
  tasks: { frame: { data: unknown } };
  matters: unknown[];
  sessions: unknown[];
}
interface Answer {
  frame: { ok: boolean; data?: Record<string, unknown> };
  stdout: string;
}

/** Scripted completion proves host mechanics, not whether the model chooses a good report or next look. */
export async function checkCloseCase(file: string): Promise<void> {
  const directory = path.dirname(file);
  const composition = JSON.parse(
    fs.readFileSync(path.join(directory, 'composition.json'), 'utf8'),
  ) as ScenarioComposition;
  const close = composition.close;
  assert.ok(close);
  assert.equal(composition.session.messagingGroupId, null);
  const content = JSON.parse(close.task.content) as {
    prompt: string;
    script: string;
    inConversation: boolean;
    clock: { instant: string };
  };
  assert.equal(content.inConversation, true);
  assert.ok(content.prompt.includes('Start look-back as a background Agent call'));
  assert.equal(content.script, `ncl matters evening --run ${close.runId}`);
  assert.equal(content.clock.instant, close.scheduledAt);
  assert.ok(Date.parse(close.scheduledAt) <= Date.now());
  const before = (await callHost(file, 'snapshot')) as Snapshot;
  const beforeRun = before.closeRuns.find((run) => run.id === close.runId);
  assert.equal(beforeRun, undefined, 'Only the actual native pre-task script may start this due close.');
  const steps: { method: 'ncl'; args: { argv: string[] } }[] = [];
  const add = (argv: string[]) => {
    steps.push({ method: 'ncl', args: { argv: [...argv, '--json'] } });
    return steps.length - 1;
  };
  const premature = add(['matters', 'evening', '--done', close.runId, '--report', 'Premature report must be refused.']);
  const verdict = add(['matters', 'evening', '--run', close.runId]);
  const ledger = add(['day']);
  const fresh = close.scope.matterId ? add(['matters', 'get', close.scope.matterId]) : undefined;
  const morning = add([
    'matters',
    'open',
    '--title',
    'Morning transport proof',
    '--open-loop',
    'Local transport proof only; choose no behavioral outcome.',
    '--look',
    'morning',
  ]);
  const isLeave = close.runId.endsWith('leave-by-look');
  const look = isLeave
    ? add([
        'matters',
        'open',
        '--title',
        'Dinner leave-by check',
        '--open-loop',
        'Read the traffic estimate when it becomes available, then settle leave-by for the existing dinner.',
        '--look',
        `${close.scope.tomorrow}T16:30`,
        '--event',
        'morgan.ellery@example.test/synthetic-close-dinner',
      ])
    : undefined;
  const notify = close.runId.endsWith('close-speaks');
  const report = notify
    ? 'The permit appointment requires Morgan’s original passport. Main should take a turn now; principal delivery has not happened here.'
    : 'Local mechanics proof: close completed quietly, with follow-through retained for the next main wake.';
  const done = add(['matters', 'evening', '--done', close.runId, '--report', report, ...(notify ? ['--notify'] : [])]);
  const retry = add([
    'matters',
    'evening',
    '--done',
    close.runId,
    '--report',
    'This retry must not replace the first report.',
    ...(!notify ? ['--notify'] : []),
  ]);
  const afterLedger = add(['day']);
  const probe = (await callHost(file, 'probe', { steps, phase: 'preflight' })) as {
    results: { answer: Answer; snapshot: Snapshot }[];
    restored: Snapshot;
  };
  fs.writeFileSync(
    path.join(directory, 'preflight-close-native.json'),
    JSON.stringify({ modelCalls: 0, before, steps, probe }, null, 2),
  );
  assert.equal(probe.results[premature]?.answer.frame.ok, false);
  assert.ok(probe.results[premature]?.answer.stdout.includes('captured day ledger'));
  assert.equal(probe.results[verdict]?.answer.frame.ok, true);
  if (close.scope.matterId)
    assert.ok(JSON.stringify(probe.results[verdict]?.answer).includes('Weekly pass for Sunday'));
  assert.equal(
    probe.results[ledger]?.answer.frame.data?.from,
    close.scope.completedThrough,
    'A failed close must not advance completed ledger coverage.',
  );
  assert.ok(probe.results[ledger]?.snapshot.closeRuns.find((run) => run.id === close.runId)?.ledger_through_at);
  if (fresh !== undefined) {
    assert.ok(
      before.closeRuns.some(
        (run) => run.state === 'failed' && run.ledger_writes_json?.includes('synthetic-close-applied-write'),
      ),
    );
    assert.ok(
      before.calendarWriteLog.some((row) => row.request_id === 'synthetic-close-applied-write'),
      'Failing a close must retain the journal version it captured.',
    );
    assert.equal(probe.results[fresh]?.answer.frame.ok, true);
    assert.ok(JSON.stringify(probe.results[fresh]?.answer).includes('No owner has confirmed responsibility'));
    assert.ok(
      probe.results[ledger]?.snapshot.calendarWriteLog.some(
        (row) => row.request_id === 'synthetic-close-applied-write',
      ),
    );
  }
  assert.equal(probe.results[morning]?.answer.frame.ok, true);
  assert.ok(probe.results[morning]?.snapshot.morningLooks.length);
  if (look !== undefined) {
    assert.equal(probe.results[look]?.answer.frame.ok, true, JSON.stringify(probe.results[look]?.answer));
    const anchored = probe.results[look]!.snapshot.timeAnchors;
    const placed = probe.results[look]!.answer.frame.data?.matter as {
      id: string;
      look_task_id: string;
      links: { kind: string; reference: string }[];
    };
    assert.ok(placed.links.some((link) => link.kind === 'event' && link.reference.endsWith('/synthetic-close-dinner')));
    const anchorRow = anchored.find((row) => row.series_id === placed.look_task_id);
    assert.ok(anchorRow);
    const anchor = JSON.parse(anchorRow.anchor) as {
      wall: { year: number; month: number; day: number; hour: number; minute: number };
      sourceClock: { instant: string; zone: string };
      timelineVersion: string;
    };
    assert.equal(
      `${anchor.wall.year}-${String(anchor.wall.month).padStart(2, '0')}-${String(anchor.wall.day).padStart(2, '0')}`,
      close.scope.tomorrow,
    );
    assert.equal(anchor.wall.hour, 16);
    assert.equal(anchor.wall.minute, 30);
    assert.equal(anchor.sourceClock.zone, 'America/Los_Angeles');
    assert.ok(anchor.timelineVersion);
    assert.ok(
      probe.results[look]!.snapshot.mailboxes.some(
        (box) =>
          box.sessionId !== composition.session.id &&
          box.rows.some(
            (row) =>
              row.kind === 'task' &&
              row.series_id === placed.look_task_id &&
              row.process_after === anchor.sourceClock.instant &&
              row.content.includes(placed.id),
          ),
      ),
    );
  }
  for (const index of [done, retry]) assert.equal(probe.results[index]?.answer.frame.ok, true);
  const result = probe.results[retry]!.snapshot;
  const schedule = result.closeSchedules.find((row) => row.id === close.runId);
  assert.equal(schedule?.report_text, report);
  assert.equal(schedule?.report_notify, notify ? 1 : 0);
  const notes = result.mailboxes
    .flatMap((box) => box.rows.map((row) => ({ ...row, sessionId: box.sessionId })))
    .filter((row) => row.id === `close-report-${close.runId}`);
  assert.equal(notes.length, 1);
  assert.notEqual(notes[0]?.sessionId, composition.session.id);
  assert.equal(notes[0]?.trigger, notify ? 1 : 0);
  assert.ok(notes[0]?.content.includes(report));
  if (!notify) assert.ok(notes[0]?.content.includes('host-receipt'));
  assert.equal(result.closeRuns.find((run) => run.id === close.runId)?.state, 'completed');
  assert.equal(
    result.calendarWriteLog.some((row) => row.request_id === 'synthetic-close-applied-write'),
    false,
  );
  assert.equal(
    probe.results[afterLedger]?.answer.frame.data?.from,
    result.closeRuns.find((run) => run.id === close.runId)?.ledger_through_at,
  );
  for (const key of [
    'closeRuns',
    'closeSchedules',
    'calendarWriteLog',
    'mailboxes',
    'morningLooks',
    'timeAnchors',
    'matters',
    'sessions',
  ] as const)
    assert.deepEqual(probe.restored[key], before[key], `Restore ${key} before behavioral measurement.`);
  assert.deepEqual(probe.restored.tasks.frame.data, before.tasks.frame.data);
}
