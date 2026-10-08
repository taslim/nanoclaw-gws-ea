/**
 * The outgoing date check as a guard at the delivery adapter: a reply whose
 * weekday and date disagree never reaches its channel, and the reason tells
 * the agent the weekday each reading falls on. Dates without a year read
 * from today on the principal's clock.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import {
  OutboundRefusedError,
  setDeliveryAdapter,
  type ChannelDeliveryAdapter,
  type OutboundSend,
} from '../../delivery.js';
import '../gws-ea-profile/index.js';
import { judgeDates, WEEKDAY_GUARD_ID, weekdayRefusal } from './index.js';

/** Wednesday 7 October 2026, 23:30 in Los Angeles: already Thursday 8 October in Lagos. */
const NOW = new Date('2026-10-08T06:30:00.000Z');

function chat(text: string): OutboundSend {
  return {
    channelType: 'gchat',
    platformId: 'spaces/dm',
    threadId: null,
    instance: undefined,
    kind: 'chat',
    content: JSON.stringify({ text }),
    files: undefined,
  };
}

beforeEach(async () => {
  vi.useFakeTimers({ now: NOW, toFake: ['Date'] });
  await runMigrations(await initTestDb());
  await getDb().run("UPDATE gws_ea_profile SET principal_timezone = 'America/Los_Angeles' WHERE singleton = 1");
});

afterEach(async () => {
  vi.useRealTimers();
  await closeDb();
});

describe('the outgoing date check', () => {
  it('refuses a reply whose weekday and date disagree, naming the weekday the date falls on', async () => {
    expect(await judgeDates(chat('Done: Friday 15 October at 10, with Remy.'))).toEqual({
      effect: 'refuse',
      reason:
        'it says "Friday 15 October", but 15 October 2026 is a Thursday. Work the day out with the time tools and write it again; give the year when you mean another one, and put words you quote from someone else in quotation marks.',
    });
    expect(await judgeDates(chat('Done: Thursday 15 October at 10, with Remy.'))).toEqual({ effect: 'allow' });
  });

  it("reads every field an email or card carries, and nothing in someone else's quoted words", async () => {
    const email = {
      ...chat(''),
      channelType: 'email',
      content: JSON.stringify({ subject: 'Thu 16 Oct?', text: 'Hi Remy, would that work?' }),
    };
    expect((await judgeDates(email)).effect).toBe('refuse');
    expect(
      await judgeDates(chat('Remy asked for "Thursday 16 October", which is a Friday: I offered Friday 16 October.')),
    ).toEqual({ effect: 'allow' });
  });

  it("reads a date without a year from today on the principal's clock", async () => {
    // 1 January 2027 is a Friday; read as January 2026 it would be a Thursday, a day the check never takes.
    expect(await weekdayRefusal(['Friday 1 January'])).toBeUndefined();
    await getDb().run("UPDATE gws_ea_profile SET principal_timezone = 'Africa/Lagos' WHERE singleton = 1");
    expect(await weekdayRefusal(['Thursday 8 October 2026'])).toBeUndefined();
  });

  it('keeps a refused reply from the channel: the adapter never sees it', async () => {
    const sent: string[] = [];
    const channel: ChannelDeliveryAdapter = {
      async deliver(_channel, _platform, _thread, _kind, content) {
        sent.push(content);
        return 'platform-1';
      },
    };
    const guarded = setDeliveryAdapter(channel);
    const refused = guarded.deliver('gchat', 'spaces/dm', null, 'chat', JSON.stringify({ text: 'Tue 14 Oct works.' }));
    await expect(refused).rejects.toBeInstanceOf(OutboundRefusedError);
    await expect(refused).rejects.toMatchObject({ guardId: WEEKDAY_GUARD_ID });
    await guarded.deliver('gchat', 'spaces/dm', null, 'chat', JSON.stringify({ text: 'Wed 14 Oct works.' }));
    expect(sent).toEqual([JSON.stringify({ text: 'Wed 14 Oct works.' })]);
  });
});
