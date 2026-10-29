import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { callHost, readState, SYNTHETIC_IDENTITY, type SyntheticEvent } from './state.js';
import { checkConcreteCase } from './concrete-checks.js';

interface CliAnswer {
  readonly frame: { readonly ok: boolean; readonly data?: unknown };
  readonly stdout: string;
}

/** Read each case's actual native facts without consuming its model-facing mutation. */
export async function checkStoreCases(
  file: string,
  snapshot: { events: SyntheticEvent[]; mail: unknown[] },
): Promise<void> {
  const scenario = readState(file).scenario;
  if (scenario.datasetReady) return checkConcreteCase(file);
  const ncl = async (argv: string[]): Promise<CliAnswer> => {
    const answer = (await callHost(file, 'ncl', { argv: [...argv, '--json'], phase: 'preflight' })) as CliAnswer;
    assert.equal(answer.frame.ok, true, answer.stdout);
    return answer;
  };
  if (scenario.id === 'location-field' || scenario.id === 'move-with-guest') {
    const found = (await callHost(file, 'gog', {
      argv: ['gmail', 'messages', 'search', scenario.id === 'location-field' ? 'Remy lunch' : 'Juno move'],
      phase: 'preflight',
    })) as { messages: { body: string }[] };
    assert.equal(found.messages.length, 1);
    if (scenario.id === 'location-field') {
      assert.deepEqual(snapshot.events, []);
      assert.ok(found.messages[0]?.body.includes('60 minutes'));
      assert.ok(found.messages[0]?.body.includes('800 Fiction Lane, San Francisco'));
      assert.ok((await ncl(['people', 'find', '--query', 'Remy'])).stdout.includes('remy.vance@example.test'));
    } else {
      assert.equal(snapshot.events.length, 1);
      assert.equal(snapshot.events[0]?.organizer?.email, SYNTHETIC_IDENTITY.principalEmail);
      assert.ok(snapshot.events[0]?.attendees?.some((guest) => guest.email === 'juno.hale@example.test'));
      assert.ok(found.messages[0]?.body.includes('Friday November 6 at 14:00'));
      const days = await callHost(file, 'action', {
        action: 'days',
        requestId: 'preflight-move-days',
        start: '2026-11-03',
        end: '2026-11-03',
        phase: 'preflight',
      });
      assert.ok(JSON.stringify(days).includes('synthetic-project-brief'));
    }
    const free = (await callHost(file, 'action', {
      action: 'check',
      requestId: 'preflight-write-free',
      start: scenario.id === 'location-field' ? '2026-11-06T12:00:00-08:00' : '2026-11-06T14:00:00-08:00',
      end: scenario.id === 'location-field' ? '2026-11-06T13:00:00-08:00' : '2026-11-06T14:25:00-08:00',
      phase: 'preflight',
    })) as { frame?: { ok: boolean } };
    assert.equal(free.frame?.ok, true);
    assert.ok(!JSON.stringify(free).includes('minutes overlap'));
  } else if (scenario.id === 'unknown-pronouns') {
    assert.deepEqual(snapshot.events, []);
    assert.deepEqual(snapshot.mail, []);
    const found = await ncl(['people', 'find', '--query', 'Juno']);
    const people = found.frame.data as { people: { id: string; name: string }[] };
    assert.equal(people.people.length, 1);
    assert.equal(people.people[0]?.name, 'Juno Hale');
    const id = people.people[0]?.id;
    assert.ok(id);
    const person = await ncl(['people', 'get', id]);
    assert.ok(person.stdout.includes('New project coordinator.'));
    const directory = await callHost(file, 'gog', { argv: ['people', 'search', 'Juno', '--all'], phase: 'preflight' });
    assert.deepEqual(directory, { people: [{ name: 'Juno Hale', email: 'juno.hale@example.test' }] });
    const note = fs.readFileSync(path.join(path.dirname(file), 'agent', 'memory', 'people', `${id}.md`), 'utf8');
    assert.ok(note.includes('No pronouns have been supplied or observed.'));
    assert.ok(!/\b(?:she|her|he|him)\b/iu.test(note));
    assert.ok(
      fs.readFileSync(path.join(path.dirname(file), 'agent', 'memory', 'index.md'), 'utf8').includes(`people/${id}.md`),
    );
  } else if (scenario.id === 'trip-zone') {
    const whereabouts = await ncl(['whereabouts', 'get']);
    assert.ok(whereabouts.stdout.includes('London'));
    assert.ok(whereabouts.stdout.includes('Europe/London'));
    const days = (await callHost(file, 'action', {
      action: 'days',
      requestId: 'preflight-trip-days',
      start: '2026-11-03',
      end: '2026-11-03',
      phase: 'preflight',
    })) as { frame?: { ok: boolean; data?: { message?: string } } };
    assert.equal(days.frame?.ok, true);
    assert.ok(days.frame?.data?.message?.includes('London project call'));
    assert.ok(days.frame?.data?.message?.includes('Europe/London'));
    assert.ok(days.frame?.data?.message?.includes('17:00'));
    const conversion = spawnSync(
      process.execPath,
      [path.join(path.dirname(fileURLToPath(import.meta.url)), 'time-check.ts'), path.dirname(file)],
      { encoding: 'utf8' },
    );
    assert.equal(conversion.status, 0, conversion.stderr);
    const before = await ncl(['tasks', 'list']);
    const created = await ncl([
      'tasks',
      'create',
      '--name',
      'synthetic-london-preflight',
      '--prompt',
      'Remind Morgan about the London call at 5pm London time.',
      '--process-after',
      '2026-11-03T16:40:00+00:00',
    ]);
    const task = created.frame.data as { series_id: string; process_after: string };
    try {
      assert.equal(Date.parse(task.process_after), Date.parse('2026-11-03T16:40:00Z'));
      assert.ok((await ncl(['tasks', 'get', task.series_id])).stdout.includes('5pm London time'));
    } finally {
      await ncl(['tasks', 'delete', task.series_id]);
    }
    assert.deepEqual((await ncl(['tasks', 'list'])).frame.data, before.frame.data);
  } else if (scenario.id === 'principal-does-it') {
    assert.deepEqual(snapshot.events, []);
    assert.deepEqual(snapshot.mail, []);
    const before = await ncl(['tasks', 'list']);
    const at = new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString();
    const created = await ncl([
      'tasks',
      'create',
      '--name',
      'synthetic-reminder-preflight',
      '--prompt',
      'Remind Morgan to call Remy personally; do not call or apologize for Morgan.',
      '--process-after',
      at,
    ]);
    const task = created.frame.data as { series_id: string; process_after: string };
    assert.equal(task.process_after, at);
    assert.ok(task.series_id);
    try {
      const read = await ncl(['tasks', 'get', task.series_id]);
      assert.ok(read.stdout.includes('Remind Morgan to call Remy personally'));
      assert.ok((await ncl(['tasks', 'list'])).stdout.includes(task.series_id));
    } finally {
      await ncl(['tasks', 'delete', task.series_id]);
    }
    assert.deepEqual((await ncl(['tasks', 'list'])).frame.data, before.frame.data);
  } else if (scenario.id === 'missing-remy' || scenario.id === 'assistant-missing-invite') {
    const days = (await callHost(file, 'action', {
      action: 'days',
      requestId: 'preflight-case-days',
      start: '2026-11-03',
      end: '2026-11-03',
      phase: 'preflight',
    })) as { frame?: { ok: boolean; data?: { message?: string } } };
    assert.equal(days.frame?.ok, true);
    assert.equal(snapshot.events.length, 1);
    const event = snapshot.events[0];
    assert.ok(event);
    assert.ok(days.frame?.data?.message?.includes(event.summary ?? ''));
    assert.ok(days.frame?.data?.message?.includes(event.id));
    const search = (await callHost(file, 'gog', {
      argv: ['gmail', 'search', scenario.id === 'missing-remy' ? 'Remy phone' : 'Juno invitation'],
      phase: 'preflight',
    })) as { threads: { id: string; messageCount: number }[] };
    assert.equal(search.threads.length, 1);
    assert.equal(search.threads[0]?.messageCount, 1);
    const thread = (await callHost(file, 'gog', {
      argv: ['gmail', 'thread', 'get', search.threads[0]!.id, '--sanitize-content'],
      phase: 'preflight',
    })) as { messages: { id: string; snippet: string; body: string; headers: { from: string } }[] };
    assert.equal(thread.messages.length, 1);
    const message = thread.messages[0];
    assert.ok(message);
    assert.equal(message.body, message.snippet);
    const single = await callHost(file, 'gog', {
      argv: ['gmail', 'get', message.id, '--sanitize-content'],
      phase: 'preflight',
    });
    assert.deepEqual(single, message);
    const raw = snapshot.mail[0] as { id: string; payload: { body: { data: string } } };
    assert.equal(message.id, raw.id);
    assert.equal(message.body, Buffer.from(raw.payload.body.data, 'base64url').toString());
    if (scenario.id === 'missing-remy') {
      assert.equal(event.summary, 'Call with Remy');
      assert.ok(!(event.attendees ?? []).some((attendee) => attendee.email === 'remy.vance@example.test'));
      assert.ok(message.snippet.includes('Morgan will call Remy directly'));
    } else {
      assert.equal(event.organizer?.email, 'juno.hale@example.test');
      assert.ok((event.attendees ?? []).some((attendee) => attendee.email === SYNTHETIC_IDENTITY.principalEmail));
      assert.ok(!(event.attendees ?? []).some((attendee) => attendee.email === SYNTHETIC_IDENTITY.assistantEmail));
      assert.ok(message.snippet.includes('14:00–14:25 America/Los_Angeles'));
      assert.ok(message.snippet.includes('Morgan calls Juno'));
    }
    const native = (await callHost(file, 'action', {
      action: 'check',
      requestId: 'preflight-case-clash',
      start: scenario.id === 'missing-remy' ? '2026-11-03T17:05:00-08:00' : '2026-11-03T14:05:00-08:00',
      end: scenario.id === 'missing-remy' ? '2026-11-03T17:10:00-08:00' : '2026-11-03T14:10:00-08:00',
      phase: 'preflight',
    })) as { frame?: { ok: boolean; data?: unknown } };
    assert.equal(native.frame?.ok, true);
    assert.ok(JSON.stringify(native.frame?.data).includes('minutes overlap'));
  } else throw new Error(`No native case checks for ${scenario.id}`);
}
