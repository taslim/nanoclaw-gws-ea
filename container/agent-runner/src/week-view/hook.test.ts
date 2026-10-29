import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ViewEntry } from './state.js';

let root: string;
let file: string;
let doc: string;
const now = Date.parse('2026-10-05T21:30:00Z');
const PROFILE = 'Profile\nMorgan Ellery';
const PRIORITIES = 'Priorities (Oct 5)\nFinish the board deck';
const entry = (id: string, text: string, version = text): ViewEntry => ({ id, text, version });
function view(
  version = 'first',
  entries: readonly ViewEntry[] = [entry('e', 'Remy Vance at 09:00')],
  manual: readonly string[] = [PROFILE, PRIORITIES],
) {
  return {
    schema: 1,
    version,
    asOf: new Date(now).toISOString(),
    text: 'Eight coming days',
    manual,
    days: [
      { date: '2026-10-05', header: 'Monday', version: 'monday', entries },
      {
        date: '2026-10-06',
        header: 'Tuesday',
        version: 'tuesday',
        entries: [entry('kept', 'Unchanged protected morning')],
      },
    ],
    timeline: {
      homeZone: 'America/Los_Angeles',
      base: { home_place_id: null },
      places: [],
      rhythm: [],
      legs: [],
      stays: [{ ids: ['new'], zone: 'Europe/Brussels', start: now - 2_000, end: null, certainty: 'certain' }],
    },
  };
}
function run(event: string, source?: string) {
  return spawnSync(
    process.execPath,
    [
      '--preload',
      path.join(root, 'clock.ts'),
      path.join(import.meta.dir, 'hook.ts'),
      file,
      path.join(root, 'state'),
      doc,
    ],
    {
      input: JSON.stringify({ hook_event_name: event, source, session_id: 'provider-a' }),
      encoding: 'utf8',
      timeout: 10_000,
    },
  );
}
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'week-hook-'));
  file = path.join(root, 'view.json');
  doc = path.join(root, 'CLAUDE.md');
  fs.writeFileSync(doc, `# Character\n\nWarm.\n\n# Principal Manual\n\n${PROFILE}\n\n${PRIORITIES}\n`);
  fs.writeFileSync(path.join(root, 'clock.ts'), `Date.now = () => ${now};`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('the native week hooks', () => {
  it('prints the full view at startup without the Manual its project document holds, suppressing an unchanged resume', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    const startup = run('SessionStart', 'startup').stdout;
    expect(startup).toContain('Eight coming days');
    expect(startup).not.toContain('Principal Manual');
    expect(startup).not.toContain('Finish the board deck');
    expect(run('SessionStart', 'resume').stdout).toBe('');
  });
  it('prints only Manual sections edited since composition, again after a compaction, and none twice in a turn', () => {
    const edited = 'Priorities (Oct 5)\nLook back edited these priorities';
    fs.writeFileSync(file, JSON.stringify(view('first', undefined, [PROFILE, edited])));
    const startup = run('SessionStart', 'startup').stdout;
    expect(startup).toContain(`Principal Manual sections changed (current text)\n${edited}`);
    expect(startup).not.toContain('Morgan Ellery');
    expect(run('UserPromptSubmit').stdout).not.toContain('Principal Manual');
    const compact = run('SessionStart', 'compact').stdout;
    expect(compact).toContain(edited);
    expect(compact).not.toContain('Morgan Ellery');
    const narrative = 'Who the principal is (Oct 5)\nMorgan builds furniture.';
    fs.writeFileSync(file, JSON.stringify(view('second', undefined, [PROFILE, edited, narrative])));
    const resume = run('SessionStart', 'resume').stdout;
    expect(resume).toContain(narrative);
    expect(resume).not.toContain('Look back edited');
  });
  it('prints nothing for entries whose text changed only in its untrusted wrapper ids', () => {
    const wrapped = (id: string) =>
      `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: google_calendar\n---\nRemy Vance\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
    fs.writeFileSync(file, JSON.stringify(view('first', [entry('e', wrapped('aaaa'), 'same')])));
    run('SessionStart', 'startup');
    fs.writeFileSync(file, JSON.stringify(view('second', [entry('e', wrapped('bbbb'), 'same')])));
    expect(run('UserPromptSubmit').stdout).toBe(
      'Now: 2026-10-05 23:30 (Europe/Brussels; night; default night 22:00–07:00)\n',
    );
  });
  it('carries the changed day on approval and browser-report turns and sees a seconds-old Brussels stay', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    run('SessionStart', 'startup');
    fs.writeFileSync(
      file,
      JSON.stringify(view('second', [entry('e', 'Juno Hale at 10:00'), entry('finding', 'Overlap: 10:00')])),
    );
    const approval = run('UserPromptSubmit');
    expect(approval.status).toBe(0);
    expect(approval.stdout).toContain('2026-10-05');
    expect(approval.stdout).toContain('Juno Hale at 10:00');
    expect(approval.stdout).toContain('Overlap: 10:00');
    expect(approval.stdout).not.toContain('Eight coming days');
    expect(approval.stdout).not.toContain('Unchanged protected morning');
    expect(approval.stdout).not.toContain('2026-10-06');
    expect(approval.stdout).toContain('23:30');
    expect(approval.stdout).toContain('Europe/Brussels');
    expect(approval.stdout).toContain('(Europe/Brussels; night; default night 22:00–07:00)');
    fs.writeFileSync(file, JSON.stringify(view('third', [entry('e', 'Browser report changed the next event')])));
    expect(run('UserPromptSubmit').stdout).toContain('Browser report changed the next event');
  });
  it('bounds a burst of thirty changes with an exact remaining count', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    run('SessionStart', 'startup');
    fs.writeFileSync(
      file,
      JSON.stringify(
        view(
          'burst',
          Array.from({ length: 30 }, (_, n) => entry(String(n), `${n}: ${'x'.repeat(250)}`)),
        ),
      ),
    );
    const text = run('UserPromptSubmit').stdout;
    expect(text.length).toBeLessThanOrEqual(4_500);
    expect(text).toMatch(/\+\d+ more\n$/u);
    const printed = text.split('\n').filter((line) => /^2026-10-05:/u.test(line)).length;
    expect(text).toEndWith(`+${31 - printed} more\n`);
  });
  it('says an entry that left the view is no longer shown, since a busy day can push it past the budget', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    run('SessionStart', 'startup');
    fs.writeFileSync(file, JSON.stringify(view('second', [entry('more', '+1 more; use days')])));
    const text = run('UserPromptSubmit').stdout;
    expect(text).toContain('2026-10-05: no longer shown: Remy Vance at 09:00');
    expect(text).toContain('2026-10-05: +1 more; use days');
  });
  it.each([600, 6_000])('delivers a complete %i-character Manual update even during a calendar burst', (length) => {
    fs.writeFileSync(file, JSON.stringify(view()));
    run('SessionStart', 'startup');
    const manual = `New priorities: ${'m'.repeat(length)}\nThe final principle is present.`;
    fs.writeFileSync(
      file,
      JSON.stringify(
        view(
          'changed',
          Array.from({ length: 30 }, (_, n) => entry(String(n), `${n}: ${'x'.repeat(250)}`)),
          [PROFILE, manual],
        ),
      ),
    );
    const answer = run('UserPromptSubmit');
    expect(answer.status).toBe(0);
    expect(answer.stdout).toContain(`Principal Manual sections changed (current text)\n${manual}`);
    expect(answer.stdout).not.toContain('Morgan Ellery');
    expect(answer.stdout.length).toBeLessThan(12_200);
    expect(run('UserPromptSubmit').stdout).not.toContain('New priorities:');
    expect(run('SessionStart', 'resume').stdout).toBe('');
  });
  it.each(['missing', 'corrupt', 'stale'])('fails open in one line for a %s view', (kind) => {
    if (kind === 'corrupt') fs.writeFileSync(file, '{');
    if (kind === 'stale') fs.writeFileSync(file, JSON.stringify({ ...view(), asOf: '2026-10-01T00:00:00Z' }));
    const answer = run('UserPromptSubmit');
    expect(answer.status).toBe(0);
    expect(answer.stdout).toMatch(/^view as of .+ unavailable; use days\n$/u);
  });
});
