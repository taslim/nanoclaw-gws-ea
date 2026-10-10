/**
 * How a time reads in an email: its day, its times and its zone as people
 * write them; how an event the assistant writes tells its guests: on its
 * first write alone; and that an invitation carries no Google link its
 * guests cannot open (Slice 6 R4, KTD4). The bookings themselves are covered
 * with the scheduling tools that make them (tools.test.ts).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/** The assistant's Drive and what a signed-out visit sees, for the link check (Slice 6 KTD5). */
const workspace = vi.hoisted(() => ({ drive: undefined as unknown }));
vi.mock('../gws-ea-workspace/drive-api.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../gws-ea-workspace/drive-api.js')>();
  const { delegatingDriveApi } = await import('../gws-ea-workspace/testing/fake-drive.js');
  return {
    ...actual,
    createDriveApi: () =>
      delegatingDriveApi(() => workspace.drive as import('../gws-ea-workspace/drive-api.js').DriveApi),
  };
});
// Nothing in these tests is public: a signed-out visit always meets a sign-in.
vi.mock('../gws-ea-workspace/probe.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../gws-ea-workspace/probe.js')>()),
  probeLink: async () => 'sign-in',
}));

import { closeDb, initTestDb, runMigrations } from '../../db/index.js';
import '../gws-ea-profile/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import '../gws-ea-privacy/index.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { LINKS_UNCHECKED } from '../gws-ea-workspace/link-access.js';
import { FakeDrive } from '../gws-ea-workspace/testing/fake-drive.js';
import {
  assertInvitationShareable,
  ensureEvent,
  guestsOn,
  slotLabel,
  TAG_ROLE,
  type Invitation,
} from './calendar-actions.js';
import { FakeCalendar } from './testing/fake-calendar.js';

describe('a slot as people write it', () => {
  it('names its day, its times and its zone the way people do, never an IANA name', () => {
    const span = { start: Date.parse('2026-10-06T09:00:00Z'), end: Date.parse('2026-10-06T09:30:00Z') };
    expect(slotLabel(span, 'Europe/London')).toBe('Tuesday 6 Oct, 10:00–10:30 BST');
    expect(slotLabel(span, 'America/New_York')).toBe('Tuesday 6 Oct, 05:00–05:30 EDT');
    expect(slotLabel(span, 'Africa/Lagos')).toBe('Tuesday 6 Oct, 10:00–10:30 GMT+1');
  });
});

describe('an event the assistant writes', () => {
  const PRINCIPAL = 'morgan@northwind.example';
  const REMY = 'remy@northwind.example';
  const OWNER = { key: 'gwsEaThread', value: 'thread-1' };
  const EVENT = {
    summary: 'Intro',
    start: '2026-10-06T09:00:00.000Z',
    end: '2026-10-06T09:30:00.000Z',
    attendees: guestsOn(PRINCIPAL, [REMY]),
    tags: { [TAG_ROLE]: 'booking', [OWNER.key]: OWNER.value },
  };

  it('tells its guests on the first write alone: a retry that finds it puts back what it wrote, telling no one again', async () => {
    const calendar = new FakeCalendar();
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    // A retry that finds it as it was written changes nothing.
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    // Before the next, it has been moved: the retry puts its time back without a word to anyone.
    const written = calendar.event(PRINCIPAL, 'intro01');
    if (written === undefined) throw new Error('ensureEvent made no event');
    calendar.put({
      ...written,
      start: { dateTime: '2026-10-06T10:00:00.000Z' },
      end: { dateTime: '2026-10-06T10:30:00.000Z' },
    });
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);

    expect(calendar.writes.map(({ op, sendUpdates }) => ({ op, sendUpdates }))).toEqual([
      { op: 'insert', sendUpdates: 'all' },
      { op: 'patch', sendUpdates: 'none' },
    ]);
    expect(calendar.event(PRINCIPAL, 'intro01')).toMatchObject({
      start: { dateTime: EVENT.start },
      end: { dateTime: EVENT.end },
    });
  });

  it('tells its guests again when a retry restores it: the last they heard was that it was cancelled', async () => {
    const calendar = new FakeCalendar();
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);
    await calendar.deleteEvent(PRINCIPAL, 'intro01', 'all');
    await ensureEvent(calendar, PRINCIPAL, 'intro01', EVENT, 'all', OWNER);

    expect(calendar.writes.map(({ op, sendUpdates }) => ({ op, sendUpdates }))).toEqual([
      { op: 'insert', sendUpdates: 'all' },
      { op: 'delete', sendUpdates: 'all' },
      { op: 'patch', sendUpdates: 'all' },
    ]);
    expect(calendar.event(PRINCIPAL, 'intro01')).toMatchObject({ status: 'confirmed' });
  });
});

describe('an invitation carrying a Google link', () => {
  const MORGAN = 'morgan.fixture@gmail.com';
  const REMY = 'remy@vance.example';
  let drive: FakeDrive;

  beforeEach(async () => {
    await runMigrations(await initTestDb());
    await addPrincipalAddress(MORGAN);
    drive = new FakeDrive('juno@northwind.example');
    for (const person of [MORGAN, REMY]) drive.addAccount(person);
    workspace.drive = drive;
  });

  afterEach(async () => {
    await closeDb();
  });

  async function preRead(): Promise<{ readonly id: string; readonly url: string }> {
    const { id } = await drive.createFile({ name: 'Pre-read', mimeType: 'application/vnd.google-apps.document' });
    return { id, url: `https://docs.google.com/document/d/${id}/edit` };
  }

  const invitation = (url: string, writer: Invitation['writer']): Invitation => ({
    texts: ['Intro', `Pre-read: ${url}`, undefined],
    shown: [],
    recipients: [MORGAN, REMY],
    writer,
  });

  it('is refused, writing nothing, when a guest cannot open a pre-read it links, in words fitted to who wrote it', async () => {
    const { id, url } = await preRead();
    await expect(
      assertInvitationShareable(invitation(url, 'main'), 'The event was not added', 'Write it without that detail.'),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: `The event was not added: ${REMY} can't open ${url}: it isn't shared with them. Share it with them (view-only, unless they need more), leave them out, or send it without the link.`,
    });
    await expect(
      assertInvitationShareable(invitation(url, 'external-email'), 'The booking was not made', 'Tell main.'),
    ).rejects.toMatchObject({
      code: 'forbidden',
      message: `The booking was not made: ${REMY} can't open a Google link in it. Tell main which link, and who can't open it.`,
    });

    await drive.createPermission(id, { emailAddress: REMY, role: 'reader' });
    await expect(
      assertInvitationShareable(invitation(url, 'external-email'), 'The booking was not made', 'Tell main.'),
    ).resolves.toBeUndefined();
  });

  it('answers that it can be tried again shortly when Drive is briefly down', async () => {
    const { url } = await preRead();
    for (let attempt = 0; attempt < 3; attempt += 1)
      drive.failNext('getFile', new GoogleApiError(503, 'Backend Error'));
    await expect(
      assertInvitationShareable(invitation(url, 'main'), 'The event was not added', 'Write it without that detail.'),
    ).rejects.toMatchObject({ code: 'forbidden', message: `The event was not added: ${LINKS_UNCHECKED}` });
  });

  it('is never checked for the principal alone', async () => {
    const { url } = await preRead();
    await expect(
      assertInvitationShareable(
        { ...invitation(url, 'main'), recipients: [MORGAN] },
        'The event was not added',
        'Write it without that detail.',
      ),
    ).resolves.toBeUndefined();
    expect(drive.calls.filter((call) => call.op !== 'createFile')).toEqual([]);
  });
});
