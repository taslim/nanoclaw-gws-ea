import fs from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../config.js', async (original) => ({
  ...(await original<typeof import('../../../config.js')>()),
  DATA_DIR: '/tmp/gws-ea-week-refresh-tests',
}));
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  createSession,
  getDb,
  getSession,
  initTestDb,
  runMigrations,
} from '../../../db/index.js';
import { prepareInboundContent } from '../../../inbound-preparation.js';
import { sessionDir } from '../../../session-manager.js';
import '../../gws-ea-profile/index.js';
import '../../gws-ea-manual/index.js';
import '../../gws-ea-matters/index.js';
import '../index.js';
import { addPrincipalAddress, bindVerifiedPrincipalUser } from '../../gws-ea-profile/db.js';
import * as mainNotes from '../../gws-ea-profile/main-note.js';
import { upsertUser } from '../../permissions/db/users.js';
import { addStay } from '../../gws-ea-whereabouts/db.js';
import { loadTimeline, zoneAt } from '../../gws-ea-whereabouts/timeline.js';
import { setManualSection } from '../../gws-ea-manual/db.js';
import { FakeCalendar } from '../testing/fake-calendar.js';
import { createWeekRefresher, flushPendingCalendarChanges } from './refresh.js';
import { settledCalendarChanges, recordPendingCalendarChange } from './pending-changes.js';
import { beginCalendarWrite, markCalendarWriteApplied } from './write-log.js';
import type { WeekView } from './view.js';

const root = '/tmp/gws-ea-week-refresh-tests';
const stamp = '2026-10-05T07:00:00.000Z';
const principal = 'morgan@ellery.example';
let calendar: FakeCalendar;
let refresher: ReturnType<typeof createWeekRefresher>;
function file(id = 'conversation-a') {
  return `${sessionDir('main', id)}/week-view.json`;
}
function readView(id = 'conversation-a'): WeekView {
  return JSON.parse(fs.readFileSync(file(id), 'utf8')) as WeekView;
}
beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await runMigrations(await initTestDb());
  await createAgentGroup({ id: 'main', name: 'main', folder: 'main', created_at: stamp, agent_provider: null });
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='main', principal_timezone='America/Los_Angeles', principal_first_name='Morgan', assistant_first_name='Juno' WHERE singleton=1",
  );
  await addPrincipalAddress(principal);
  for (const id of ['conversation-a', 'conversation-b', 'close-system'])
    await createSession({
      id,
      agent_group_id: 'main',
      messaging_group_id: null,
      thread_id: id === 'close-system' ? 'system:close' : null,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'stopped',
      last_active: stamp,
      created_at: stamp,
    });
  calendar = new FakeCalendar();
  calendar.calendars.set(principal, { id: principal, accessRole: 'reader' });
  refresher = createWeekRefresher({ calendar: () => calendar, now: () => new Date(stamp) });
});
afterEach(async () => {
  await refresher?.stop();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
  vi.restoreAllMocks();
  vi.useRealTimers();
});
describe('the independent week refresher', () => {
  it('writes both conversations but no system view; derives sixty days while displaying eight', async () => {
    calendar.put({
      calendarId: principal,
      id: 'flight',
      location: 'Brussels',
      start: { dateTime: '2026-11-14T19:00:00Z', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-11-15T07:00:00Z', timeZone: 'Europe/Brussels' },
    });
    await refresher.refresh();
    expect(fs.readFileSync(file(), 'utf8')).toBe(fs.readFileSync(file('conversation-b'), 'utf8'));
    expect(readView().days).toHaveLength(8);
    expect(fs.existsSync(file('close-system'))).toBe(false);
    expect(zoneAt(await loadTimeline(), Date.parse('2026-11-15T15:00:00Z'))).toBe('Europe/Brussels');
  });
  it('writes the view into the evening close session while its run is open', async () => {
    await getDb().run(
      `INSERT INTO gws_ea_close_runs (id,session_id,scheduled_at,zone,timeline_version,state,started_at)
       VALUES ('close-1','close-system',?,'America/Los_Angeles','fixed','open',?)`,
      stamp,
      stamp,
    );
    await refresher.refresh();
    expect(fs.readFileSync(file('close-system'), 'utf8')).toBe(fs.readFileSync(file(), 'utf8'));
  });
  it('leaves an unchanged view in place and still writes a conversation that has none', async () => {
    calendar.put({
      calendarId: principal,
      id: 'call',
      summary: 'Call with Remy Vance',
      location: 'Brussels office',
      start: { dateTime: '2026-10-06T16:00Z' },
      end: { dateTime: '2026-10-06T17:00Z' },
    });
    await refresher.refresh();
    const written = fs.statSync(file()).ino;
    await refresher.refresh();
    expect(fs.statSync(file()).ino).toBe(written);
    await createSession({
      id: 'conversation-c',
      agent_group_id: 'main',
      messaging_group_id: null,
      thread_id: null,
      agent_provider: 'claude',
      status: 'active',
      container_status: 'stopped',
      last_active: stamp,
      created_at: stamp,
    });
    await refresher.refresh();
    expect(readView('conversation-c').version).toBe(readView().version);
    expect(fs.statSync(file()).ino).toBe(written);
  });
  it('keeps the previous file and as-of time after a Google read failure', async () => {
    await refresher.refresh();
    const before = fs.readFileSync(file(), 'utf8');
    vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('Google unavailable'));
    refresher = createWeekRefresher({ calendar: () => calendar, now: () => new Date(stamp) });
    await expect(refresher.refresh()).rejects.toThrow('Google unavailable');
    expect(fs.readFileSync(file(), 'utf8')).toBe(before);
  });
  it('rerenders a seconds-old stay and current Manual without reading Google on a principal turn', async () => {
    await refresher.start();
    const reads = vi.spyOn(calendar, 'listEventDetails');
    await addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2026-10-05T06:59:58Z',
      end: '2026-10-06T00:00:00Z',
      source: 'said',
      certainty: 'certain',
    });
    await refresher.refresh();
    reads.mockClear();
    await setManualSection('priorities', 'Leave time for Remy Vance');
    await refresher.refresh();
    const view = readView();
    expect(view.timeline.stays[0].zone).toBe('Europe/Brussels');
    expect(view.manual.join('\n\n')).toContain('Leave time for Remy Vance');
    expect(reads).not.toHaveBeenCalled();
  });
  it('coalesces overlapping sweeps and reads only the touched local days for a settled notice', async () => {
    await refresher.refresh();
    const reads = vi.spyOn(calendar, 'listEventDetails');
    calendar.put({
      calendarId: principal,
      id: 'new',
      summary: 'Remy Vance',
      start: { dateTime: '2026-10-07T16:00Z' },
      end: { dateTime: '2026-10-07T17:00Z' },
    });
    await recordPendingCalendarChange(
      'notice',
      { calendarId: principal, eventId: 'new', change: 'created' },
      new Date('2026-10-05T06:58:00Z'),
    );
    await Promise.all([refresher.refresh(), refresher.refresh(), refresher.refresh()]);
    expect(fs.readFileSync(file(), 'utf8')).toContain('Remy Vance');
    expect(reads.mock.calls.length).toBe(1);
    const [, start, end] = reads.mock.calls[0];
    expect(Date.parse(end) - Date.parse(start)).toBeLessThanOrEqual(4 * 86_400_000);
  });
  it('extends the full read at local midnight and refreshes busy-only calendars every fifteen minutes', async () => {
    let at = Date.parse(stamp);
    refresher = createWeekRefresher({ calendar: () => calendar, now: () => new Date(at) });
    calendar.calendars.set('busy@ellery.example', {
      id: 'busy@ellery.example',
      dataOwner: principal,
      accessRole: 'freeBusyReader',
    });
    const details = vi.spyOn(calendar, 'listEventDetails');
    const busy = vi.spyOn(calendar, 'freeBusy');
    await refresher.refresh();
    const original = details.mock.calls.length;
    at += 14 * 60_000;
    await refresher.refresh();
    expect(details.mock.calls.length).toBe(original);
    at += 60_000;
    await refresher.refresh();
    expect(details.mock.calls.length).toBe(original + 1);
    expect(busy.mock.calls.length).toBe(2);
    at = Date.parse('2026-10-06T07:00:00Z');
    await refresher.refresh();
    expect(readView().days[0].date).toBe('2026-10-06');
    expect(details.mock.calls.length).toBe(original + 2);
  });
  it('lets the matters clock advance while its independent Google request is pending', async () => {
    vi.useFakeTimers();
    const nativeRead = calendar.listEventDetails.bind(calendar);
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    vi.spyOn(calendar, 'listEventDetails').mockImplementation(async (...args) => {
      await held;
      return nativeRead(...args);
    });
    const pending = refresher.start();
    let matterSteps = 0;
    const minute = setInterval(() => {
      matterSteps++;
    }, 60_000);
    await vi.advanceTimersByTimeAsync(180_000);
    expect(matterSteps).toBe(3);
    clearInterval(minute);
    release?.();
    await pending;
  });
  it('publishes a fresh stay clock before a failed placement reread', async () => {
    await refresher.start();
    vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('Google unavailable'));
    await expect(
      addStay({
        locality: 'Brussels',
        zone: 'Europe/Brussels',
        start: '2026-10-05T06:59:58Z',
        end: '2026-10-06T00:00:00Z',
        source: 'said',
        certainty: 'certain',
      }),
    ).resolves.toMatchObject({ zone: 'Europe/Brussels' });
    await vi.waitFor(() => expect(readView().timeline.stays[0]?.zone).toBe('Europe/Brussels'));
  });
  it('saves a whereabouts edit without waiting for the calendar read in flight', async () => {
    await refresher.start();
    await recordPendingCalendarChange(
      'pending-mail',
      { calendarId: principal, eventId: 'pending', change: 'created' },
      new Date('2026-10-05T06:58:00Z'),
    );
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detail = calendar.getEventDetail.bind(calendar);
    vi.spyOn(calendar, 'getEventDetail').mockImplementation(async (...args) => {
      await held;
      return detail(...args);
    });
    const saved = addStay({
      locality: 'Brussels',
      zone: 'Europe/Brussels',
      start: '2026-10-05T06:59:58Z',
      end: '2026-10-06T00:00:00Z',
      source: 'said',
      certainty: 'certain',
    });
    const answer = await Promise.race([saved, new Promise((resolve) => setTimeout(resolve, 1_000, 'waiting'))]);
    release?.();
    expect(answer).toMatchObject({ zone: 'Europe/Brussels' });
    await vi.waitFor(() => expect(readView().timeline.stays[0]?.zone).toBe('Europe/Brussels'));
    await refresher.refresh();
  });
  it('prepares an authenticated principal message without any Google read', async () => {
    await refresher.start();
    const at = new Date().toISOString();
    const userId = 'gchat:users/morgan';
    await upsertUser({ id: userId, kind: 'gchat', display_name: 'Morgan Ellery', created_at: at });
    await bindVerifiedPrincipalUser(userId, at);
    const messagingGroup = {
      id: 'principal-dm',
      channel_type: 'gchat',
      platform_id: 'spaces/morgan',
      is_group: 0,
      name: null,
      unknown_sender_policy: 'strict' as const,
      created_at: at,
    };
    await createMessagingGroup(messagingGroup);
    const session = await getSession('conversation-a');
    if (!session) throw new Error('Missing conversation fixture');
    const calls = calendar.calls;
    const result = await prepareInboundContent({
      session,
      messagingGroup,
      channelType: 'gchat',
      instance: 'gchat',
      platformId: 'spaces/morgan',
      messageId: 'principal-hello',
      timestamp: at,
      authenticatedSender: { userId, kind: 'human' },
      content: JSON.stringify({ text: 'What is ahead today?' }),
    });
    expect(result).toContain('principal-hello');
    expect(calendar.calls).toBe(calls);
  });
  it('derives one leg from folded copies on two principal calendars', async () => {
    calendar.calendars.set('shared-calendar', { id: 'shared-calendar', dataOwner: principal, accessRole: 'reader' });
    for (const calendarId of [principal, 'shared-calendar'])
      calendar.put({
        calendarId,
        id: calendarId === principal ? 'flight' : 'flight-copy',
        iCalUID: 'one-flight',
        location: 'Brussels',
        start: { dateTime: '2026-10-06T19:00:00Z', timeZone: 'America/Los_Angeles' },
        end: { dateTime: '2026-10-07T07:00:00Z', timeZone: 'Europe/Brussels' },
      });
    await refresher.refresh();
    expect((await loadTimeline()).legs).toHaveLength(1);
  });
  it('writes matching views before a settled change note and consumes only the delivered pending rows', async () => {
    await refresher.refresh();
    calendar.put({
      calendarId: principal,
      id: 'dinner',
      summary: 'Dinner with Remy Vance',
      start: { dateTime: '2026-10-07T01:00Z' },
      end: { dateTime: '2026-10-07T02:00Z' },
    });
    await recordPendingCalendarChange(
      'dinner-mail',
      { calendarId: principal, eventId: 'dinner', change: 'created' },
      new Date('2026-10-05T06:58:00Z'),
    );
    const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockImplementation(async () => {
      expect(readView().text).toContain('Dinner with Remy Vance');
      expect(fs.readFileSync(file('conversation-b'), 'utf8')).toBe(fs.readFileSync(file(), 'utf8'));
      return 'written';
    });
    await refresher.refresh();
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0][0].text).toContain('Dinner with Remy Vance');
    expect(await settledCalendarChanges(new Date('2100-01-01'))).toEqual([]);
  });
  it('keeps a notice that arrives while the note renders for the next note', async () => {
    const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockResolvedValue('written');
    const notice = { calendarId: principal, eventId: 'dinner', change: 'changed' as const };
    await recordPendingCalendarChange('gmail-1', notice, new Date('2026-10-05T16:00:00Z'));
    await recordPendingCalendarChange('gmail-2', notice, new Date('2026-10-05T16:00:20Z'));
    expect(await flushPendingCalendarChanges(calendar, new Date('2026-10-05T16:00:40Z'))).toBe(0);
    const detail = calendar.getEventDetail.bind(calendar);
    vi.spyOn(calendar, 'getEventDetail').mockImplementationOnce(async (...args) => {
      await recordPendingCalendarChange('gmail-3', notice, new Date('2026-10-05T16:02:01Z'));
      return detail(...args);
    });
    expect(await flushPendingCalendarChanges(calendar, new Date('2026-10-05T16:02:00Z'))).toBe(1);
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0][0]).toMatchObject({ wake: true, text: expect.stringContaining('Event dinner') });
    expect((await settledCalendarChanges(new Date('2100-01-01'))).flatMap((c) => c.messageIds)).toEqual(['gmail-3']);
    expect(await flushPendingCalendarChanges(calendar, new Date('2026-10-05T16:04:00Z'))).toBe(1);
    expect(await settledCalendarChanges(new Date('2100-01-01'))).toEqual([]);
  });
  it('delivers and settles a notice whose findings cannot be read, once', async () => {
    const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockResolvedValue('written');
    await recordPendingCalendarChange(
      'gmail-1',
      { calendarId: principal, eventId: 'dinner', change: 'changed' },
      new Date('2026-10-05T16:00:00Z'),
    );
    vi.spyOn(calendar, 'getEventDetail').mockRejectedValueOnce(new Error('Google unavailable'));
    expect(await flushPendingCalendarChanges(calendar, new Date('2026-10-05T16:02:00Z'))).toBe(1);
    expect(note.mock.calls[0][0].text).toContain('findings unavailable');
    expect(await settledCalendarChanges(new Date('2100-01-01'))).toEqual([]);
    expect(await flushPendingCalendarChanges(calendar, new Date('2026-10-05T16:03:00Z'))).toBe(0);
  });
  it('leads a change note with the event, then the findings of the days it left and joined', async () => {
    for (let day = 5; day <= 12; day++)
      calendar.put({
        calendarId: principal,
        id: `workshop${day}`,
        summary: `Workshop ${day}`,
        location: '1 Ferry Building, San Francisco, CA 94111, USA',
        attendees: [{ email: 'remy@vance.example' }],
        start: { dateTime: `2026-10-${String(day).padStart(2, '0')}T11:30:00-07:00` },
        end: { dateTime: `2026-10-${String(day).padStart(2, '0')}T14:00:00-07:00` },
      });
    calendar.put({
      calendarId: principal,
      id: 'moved',
      summary: 'Call with Juno Hale',
      start: { dateTime: '2026-10-08T16:00Z' },
      end: { dateTime: '2026-10-08T17:00Z' },
    });
    await refresher.refresh();
    calendar.put({
      calendarId: principal,
      id: 'moved',
      summary: 'Call with Juno Hale',
      start: { dateTime: '2026-10-07T16:00Z' },
      end: { dateTime: '2026-10-07T17:00Z' },
    });
    await recordPendingCalendarChange(
      'moved-mail',
      { calendarId: principal, eventId: 'moved', change: 'changed' },
      new Date('2026-10-05T06:58:00Z'),
    );
    const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockResolvedValue('written');
    await refresher.refresh();
    const text = note.mock.calls[0][0].text;
    expect(text.indexOf('Call with Juno Hale')).toBeGreaterThan(0);
    expect(text.indexOf('Call with Juno Hale')).toBeLessThan(text.indexOf('Findings for 2026-10-07, 2026-10-08:'));
    expect(text).toContain('Workshop 7');
    expect(text).toContain('Workshop 8');
    expect(text).not.toContain('Workshop 10');
    expect(text).not.toMatch(/\d+ more\./u);
  });
  it('observes a durable assistant write and rereads its touched day only', async () => {
    await refresher.refresh();
    const reads = vi.spyOn(calendar, 'listEventDetails');
    calendar.put({
      calendarId: principal,
      id: 'new-call',
      summary: 'Call with Juno Hale',
      start: { dateTime: '2026-10-08T16:00Z' },
      end: { dateTime: '2026-10-08T17:00Z' },
    });
    await beginCalendarWrite({
      requestId: 'own-call',
      calendarId: principal,
      eventId: 'new-call',
      action: 'create_event',
      request: { title: 'Call with Juno Hale' },
      before: null,
      affectedStart: '2026-10-08T16:00:00Z',
      affectedEnd: '2026-10-08T17:00:00Z',
    });
    await markCalendarWriteApplied('own-call', 'Call created');
    await refresher.refresh();
    expect(readView().text).toContain('Call with Juno Hale');
    expect(reads).toHaveBeenCalledOnce();
    expect(Date.parse(reads.mock.calls[0][2]) - Date.parse(reads.mock.calls[0][1])).toBeLessThanOrEqual(2 * 86_400_000);
  });
  it('removes a derived stay when a cancellation carries no event dates', async () => {
    calendar.put({
      calendarId: principal,
      id: 'flight',
      location: 'Brussels',
      start: { dateTime: '2026-10-06T19:00:00Z', timeZone: 'America/Los_Angeles' },
      end: { dateTime: '2026-10-07T07:00:00Z', timeZone: 'Europe/Brussels' },
    });
    await refresher.refresh();
    calendar.put({ calendarId: principal, id: 'flight', status: 'cancelled' });
    await recordPendingCalendarChange(
      'cancellation',
      { calendarId: principal, eventId: 'flight', change: 'cancelled' },
      new Date('2026-10-05T06:58:00Z'),
    );
    await refresher.refresh();
    expect((await loadTimeline()).legs).toEqual([]);
    expect(readView().timeline.legs).toEqual([]);
  });
  it('saves a Manual edit without waiting for the calendar reread, and publishes it before that read', async () => {
    await refresher.start();
    calendar.put({
      calendarId: principal,
      id: 'pending',
      start: { dateTime: '2026-10-07T16:00Z' },
      end: { dateTime: '2026-10-07T17:00Z' },
    });
    await recordPendingCalendarChange(
      'pending-mail',
      { calendarId: principal, eventId: 'pending', change: 'created' },
      new Date('2026-10-05T06:58:00Z'),
    );
    let release: (() => void) | undefined;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const detail = calendar.getEventDetail.bind(calendar);
    vi.spyOn(calendar, 'getEventDetail').mockImplementation(async (...args) => {
      await held;
      return detail(...args);
    });
    const asOf = readView().asOf;
    await expect(setManualSection('priorities', 'Preserve an evening with Remy Vance')).resolves.toMatchObject({
      section: { text: 'Preserve an evening with Remy Vance' },
    });
    await vi.waitFor(() => expect(readView().manual.join('\n\n')).toContain('Preserve an evening with Remy Vance'));
    expect(readView().asOf).toBe(asOf);
    release?.();
    await refresher.refresh();
  });
  it('tells main of a settled change when the read fails, then waits a minute and reads every day afresh', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    await refresher.start();
    calendar.put({
      calendarId: principal,
      id: 'moved',
      summary: 'Call with Juno Hale',
      start: { dateTime: '2026-10-07T16:00Z' },
      end: { dateTime: '2026-10-07T17:00Z' },
    });
    await recordPendingCalendarChange(
      'moved-mail',
      { calendarId: principal, eventId: 'moved', change: 'changed' },
      new Date('2026-10-05T06:58:00Z'),
    );
    const reads = vi.spyOn(calendar, 'listEventDetails').mockRejectedValue(new Error('Google unavailable'));
    const note = vi.spyOn(mainNotes, 'writeNoteForMain').mockResolvedValue('written');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(note).toHaveBeenCalledOnce();
    expect(note.mock.calls[0][0].text).toContain('Event moved on calendar');
    expect(note.mock.calls[0][0].text).toContain('findings unavailable');
    expect(await settledCalendarChanges(new Date('2100-01-01'))).toEqual([]);
    const failed = reads.mock.calls.length;
    await vi.advanceTimersByTimeAsync(55_000);
    expect(reads.mock.calls.length).toBe(failed);
    reads.mockRestore();
    const full = vi.spyOn(calendar, 'listCalendars');
    await vi.advanceTimersByTimeAsync(5_000);
    expect(full).toHaveBeenCalled();
    expect(readView().text).toContain('Call with Juno Hale');
  });
});
