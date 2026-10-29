import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildWeek } from './model.js';
import { event, input, timeline } from './testing/fixture.js';
import { renderWeekView } from './view.js';

describe('the session week view', () => {
  it('renders eight local days, working hours, kept time, moves and findings within its budget', () => {
    const week = buildWeek(
      input([event('call', '2026-10-05T16:00Z', '2026-10-05T17:00Z', { summary: 'Remy Vance', location: 'Office' })], {
        dayCount: 8,
      }),
    );
    const view = renderWeekView(week, '2026-10-05T07:00:00.000Z', ['Current Manual']);
    expect(view.days).toHaveLength(8);
    expect(view.text.length).toBeLessThanOrEqual(8_000);
    expect(view.text).toContain('America/Los_Angeles');
    expect(view.text).toContain('Working hours');
    expect(view.text).toContain('Remy Vance');
    expect(view.manual).toEqual(['Current Manual']);
  });
  it('versions an unchanged week identically, so the real hook sends an empty diff', () => {
    const week = buildWeek(
      input(
        [
          event('call', '2026-10-05T16:00Z', '2026-10-05T17:00Z', {
            summary: 'Remy Vance',
            location: 'Brussels office',
            attendees: [{ email: 'remy@vance.example' }],
          }),
        ],
        { dayCount: 8 },
      ),
    );
    const asOf = new Date().toISOString();
    const first = renderWeekView(week, asOf, ['Profile\nMorgan Ellery']);
    const second = renderWeekView(week, asOf, ['Profile\nMorgan Ellery']);
    expect(second.text).not.toBe(first.text);
    expect(second.version).toBe(first.version);
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'week-view-diff-'));
    try {
      const file = path.join(root, 'week-view.json');
      const hook = (event: string, view: typeof first) => {
        fs.writeFileSync(file, JSON.stringify(view));
        return execFileSync(
          'bun',
          [
            path.resolve('container/agent-runner/src/week-view/hook.ts'),
            file,
            path.join(root, 'state'),
            path.join(root, 'CLAUDE.md'),
          ],
          {
            input: JSON.stringify({ hook_event_name: event, source: 'startup', session_id: 'provider-a' }),
            encoding: 'utf8',
          },
        );
      };
      expect(hook('SessionStart', first)).toContain('Remy Vance');
      expect(hook('UserPromptSubmit', second)).toMatch(/^Now: [^\n]+\n$/u);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
  it('holds in its days exactly the entries its text shows, and only the timeline the clock reads', () => {
    const week = buildWeek(
      input(
        Array.from({ length: 96 }, (_, index) =>
          event(`calendar-${index}`, '2026-10-05T16:00Z', '2026-10-05T17:00Z', {
            summary: `Remy Vance ${index} ${'planning '.repeat(25)}`,
            location: `Office ${'Brussels '.repeat(25)}`,
            description: 'Detailed calendar notes '.repeat(500),
          }),
        ),
        { dayCount: 8 },
      ),
    );
    const view = renderWeekView(week, '2026-10-05T07:00:00.000Z', ['Current Manual '.repeat(400)]);
    const bytes = JSON.stringify(view);
    expect(view.text.length).toBeLessThanOrEqual(8_000);
    const { homeZone, base, places, rhythm, stays, legs } = timeline;
    expect(view.timeline).toEqual({ homeZone, base, places, rhythm, stays, legs });
    expect(view.days).toHaveLength(8);
    const entries = view.days.flatMap((day) => day.entries);
    expect(entries.filter((entry) => /^\+\d+ more; use days$/u.test(entry.text))).toHaveLength(1);
    expect(entries.filter((entry) => !view.text.includes(entry.text))).toEqual([]);
    expect(bytes.match(/<<<EXTERNAL_UNTRUSTED_CONTENT/gu)?.length).toBe(
      bytes.match(/<<<END_EXTERNAL_UNTRUSTED_CONTENT/gu)?.length,
    );
  });
});
