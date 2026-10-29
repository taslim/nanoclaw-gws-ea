import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { ViewEntry } from './state.js';

let root: string;
let file: string;
const now = Date.parse('2026-10-05T21:30:00Z');
function view(version = 'first', entries: readonly ViewEntry[] = [{ id: 'e', text: 'Remy Vance at 09:00' }]) {
  return {
    schema: 1,
    version,
    asOf: new Date(now).toISOString(),
    text: 'Eight coming days',
    manual: 'Current priorities',
    days: [
      { date: '2026-10-05', header: 'Monday', entries },
      { date: '2026-10-06', header: 'Tuesday', entries: [{ id: 'kept', text: 'Unchanged protected morning' }] },
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
    ['--preload', path.join(root, 'clock.ts'), path.join(import.meta.dir, 'hook.ts'), file, path.join(root, 'state')],
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
  fs.writeFileSync(path.join(root, 'clock.ts'), `Date.now = () => ${now};`);
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
describe('the native week hooks', () => {
  it('prints a full startup and compact view with current Manual text, suppressing an unchanged resume', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    expect(run('SessionStart', 'startup').stdout).toContain('Eight coming days');
    expect(run('SessionStart', 'resume').stdout).toBe('');
    const updated = { ...view(), manual: 'Look back edited these priorities' };
    fs.writeFileSync(file, JSON.stringify(updated));
    expect(run('SessionStart', 'compact').stdout).toContain('Look back edited these priorities');
    expect(run('UserPromptSubmit').stdout).not.toContain('Remy Vance');
  });
  it('carries the changed day on approval and browser-report turns and sees a seconds-old Brussels stay', () => {
    fs.writeFileSync(file, JSON.stringify(view()));
    run('SessionStart', 'startup');
    fs.writeFileSync(
      file,
      JSON.stringify(
        view('second', [
          { id: 'e', text: 'Juno Hale at 10:00' },
          { id: 'finding', text: 'Overlap: 10:00' },
        ]),
      ),
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
    expect(approval.stdout).toContain('night');
    fs.writeFileSync(file, JSON.stringify(view('third', [{ id: 'e', text: 'Browser report changed the next event' }])));
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
          Array.from({ length: 30 }, (_, n) => ({ id: String(n), text: `${n}: ${'x'.repeat(250)}` })),
        ),
      ),
    );
    const text = run('UserPromptSubmit').stdout;
    expect(text.length).toBeLessThanOrEqual(4_500);
    expect(text).toMatch(/\+\d+ more\n$/u);
    const printed = text.split('\n').filter((line) => /^2026-10-05:/u.test(line)).length;
    expect(text).toEndWith(`+${31 - printed} more\n`);
  });
  it('reports a changed overflow even when its omitted count is unchanged', () => {
    fs.writeFileSync(file, JSON.stringify(view('first', [{ id: 'more', text: '+3000 more', version: 'old' }])));
    run('SessionStart', 'startup');
    fs.writeFileSync(file, JSON.stringify(view('second', [{ id: 'more', text: '+3000 more', version: 'new' }])));
    expect(run('UserPromptSubmit').stdout).toContain('2026-10-05: +3000 more');
  });
  it.each(['missing', 'corrupt', 'stale'])('fails open in one line for a %s view', (kind) => {
    if (kind === 'corrupt') fs.writeFileSync(file, '{');
    if (kind === 'stale') fs.writeFileSync(file, JSON.stringify({ ...view(), asOf: '2026-10-01T00:00:00Z' }));
    const answer = run('UserPromptSubmit');
    expect(answer.status).toBe(0);
    expect(answer.stdout).toMatch(/^view as of .+ unavailable; use days\n$/u);
  });
});
