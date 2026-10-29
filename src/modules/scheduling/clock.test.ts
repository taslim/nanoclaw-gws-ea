import { describe, expect, it } from 'vitest';
import { prepareScheduledTask } from './create.js';

describe('the clock a task was set on', () => {
  it('retains different written clocks that otherwise normalize to the same UTC instant', () => {
    const brussels = prepareScheduledTask({
      prompt: 'Check in',
      processAfter: '2999-01-01T09:00:00+01:00',
      timezone: 'America/Los_Angeles',
    });
    const utc = prepareScheduledTask({
      prompt: 'Check in',
      processAfter: '2999-01-01T08:00:00Z',
      timezone: 'America/Los_Angeles',
    });
    expect(brussels.processAfter).toBe(utc.processAfter);
    expect(brussels).toMatchObject({ clock: { instant: '2999-01-01T08:00:00.000Z', zone: '+01:00' } });
    expect(utc).toMatchObject({ clock: { instant: '2999-01-01T08:00:00.000Z', zone: 'UTC' } });
  });
  it('retains the IANA interpretation of a naive clock and a cron-derived occurrence', () => {
    const task = prepareScheduledTask({
      prompt: 'Check in',
      processAfter: '2999-01-01T09:00',
      timezone: 'Europe/Brussels',
    });
    expect(task).toMatchObject({ clock: { instant: task.processAfter, zone: 'Europe/Brussels' } });
    const repeating = prepareScheduledTask({
      prompt: 'Check in',
      recurrence: '0 9 * * *',
      timezone: 'Europe/Brussels',
    });
    expect(repeating).toMatchObject({ clock: { instant: repeating.processAfter, zone: 'Europe/Brussels' } });
  });
});
