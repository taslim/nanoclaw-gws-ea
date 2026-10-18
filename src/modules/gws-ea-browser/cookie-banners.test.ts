import type { Page } from 'playwright-core';
import { describe, expect, it, vi } from 'vitest';

import {
  chooseCookieBanners,
  cookieBannerControlKind,
  nextCookieBannerStep,
  settleCookieBanners,
  type CookieBannerControlRead,
  type CookieBannerRegionRead,
} from './cookie-banners.js';

const kind = (text: string, name = ''): string | undefined => cookieBannerControlKind({ name, text });

describe('cookie banner control labels', () => {
  it.each([
    'Reject All',
    'Reject all cookies',
    'Decline',
    'Deny',
    'Refuse all',
    'Disagree and close',
    'Only necessary',
    'Necessary cookies only',
    'Use necessary cookies only',
    'Accept only essential cookies',
    'Continue without accepting',
    'I don’t accept',
    'Alle ablehnen',
    'Tout refuser',
    'Rechazar todo',
  ])('reads %j as a reject', (label) => {
    expect(kind(label)).toBe('reject');
  });

  it.each(['Manage options', 'Cookie Settings', 'MORE OPTIONS', 'Customize', 'Let me choose', 'Einstellungen'])(
    'reads %j as opening a second layer',
    (label) => {
      expect(kind(label)).toBe('settings');
    },
  );

  it.each(['Accept All Cookies', 'Allow all', 'I agree', 'OK', 'Got it!', 'Tout accepter'])(
    'reads %j as an accept',
    (label) => {
      expect(kind(label)).toBe('accept');
    },
  );

  it.each([
    'Reject all and subscribe for $2.99/month',
    // A preference centre's category heading, never a reject.
    'Strictly necessary cookies',
    'Decline invitation',
    'Learn more',
    'Cookie policy',
    '',
  ])('reads %j as none of them', (label) => {
    expect(kind(label)).toBeUndefined();
  });

  it('reads the visible words, sets icons aside, and lets a name describe but never contradict them', () => {
    expect(kind('✕ Reject all')).toBe('reject');
    expect(kind('Cookie Settings', 'Cookie Settings, opens the preference centre dialog')).toBe('settings');
    expect(kind('', 'Reject all')).toBe('reject');
    expect(kind('Accept all', 'Reject all')).toBeUndefined();
  });
});

const control = (id: number, text: string, facts: Partial<CookieBannerControlRead> = {}): CookieBannerControlRead => ({
  id,
  name: '',
  text,
  selected: null,
  navigates: false,
  foreignSubmit: false,
  ...facts,
});
const region = (
  controls: readonly CookieBannerControlRead[],
  facts: Partial<CookieBannerRegionRead> = {},
): CookieBannerRegionRead => ({ platform: null, whole: false, cookies: true, parent: null, controls, ...facts });

describe('choosing banners in a frame', () => {
  it('presses a platform’s own reject before a labelled one, and falls back to labels where the platform names none', () => {
    expect(
      chooseCookieBanners(
        [
          region(
            [
              control(0, 'Reject all'),
              control(1, 'Continue with essentials', { selected: 'reject' }),
              control(2, 'Settings', { selected: 'settings' }),
            ],
            { platform: 'sourcepoint' },
          ),
          region([control(3, 'MORE OPTIONS'), control(4, 'REJECT ALL'), control(5, 'AGREE')], {
            platform: 'quantcast',
          }),
        ],
        false,
      ),
    ).toEqual([
      { region: 0, reject: 1, settings: 2 },
      { region: 1, reject: 4, settings: 3 },
    ]);
  });

  it('counts a generic region only when it speaks of cookies and offers a consent choice', () => {
    expect(
      chooseCookieBanners(
        [
          region([control(0, 'Reject all')], { cookies: false }),
          region([control(1, 'Order now')]),
          region([control(2, 'Accept')]),
        ],
        false,
      ),
    ).toEqual([{ region: 2 }]);
  });

  it('never presses a link to another page or a submit of a form outside the banner, yet still reports the banner', () => {
    expect(
      chooseCookieBanners(
        [
          region([
            control(0, 'Reject all', { foreignSubmit: true }),
            control(1, 'Manage options', { navigates: true }),
            control(2, 'Accept all'),
          ]),
        ],
        false,
      ),
    ).toEqual([{ region: 0 }]);
  });

  it('reads a child frame’s whole document only when the frame sits where a banner does', () => {
    const regions = [region([control(0, 'Reject all')], { whole: true })];
    expect(chooseCookieBanners(regions, false)).toEqual([]);
    expect(chooseCookieBanners(regions, true)).toEqual([{ region: 0, reject: 0 }]);
  });

  it('takes the innermost of nested banner regions', () => {
    expect(
      chooseCookieBanners(
        [
          region([control(0, 'Accept all'), control(1, 'Reject all')]),
          region([control(1, 'Reject all')], { parent: 0 }),
        ],
        false,
      ),
    ).toEqual([{ region: 1, reject: 1 }]);
  });
});

describe('the host’s next step on a page load', () => {
  const layered = { settings: 3 };
  const rejecting = { reject: 7 };

  it('presses a reject before it opens any second layer', () => {
    expect(nextCookieBannerStep([], { opened: false })).toEqual({ kind: 'none' });
    expect(nextCookieBannerStep([layered, rejecting], { opened: false })).toEqual({
      kind: 'reject',
      banner: rejecting,
      control: 7,
    });
  });

  it('opens a second layer once per page load, then leaves the banner to the agent', () => {
    expect(nextCookieBannerStep([layered], { opened: false })).toEqual({ kind: 'open', banner: layered, control: 3 });
    expect(nextCookieBannerStep([layered], { opened: true })).toEqual({ kind: 'report', status: 'no_reject_option' });
  });

  it('after its one reject on a page load, only reports a banner, even one it could reject again', () => {
    for (const after of ['reappeared', 'reject_failed', 'no_reject_option'] as const)
      expect(nextCookieBannerStep([rejecting], { after, opened: false })).toEqual({ kind: 'report', status: after });
  });
});

it('settles nothing off the web or in a context not prepared for isolated-world reads', async () => {
  const newCDPSession = vi.fn();
  const page = (url: string) =>
    ({ isClosed: () => false, url: () => url, context: () => ({ newCDPSession }) }) as unknown as Page;
  expect(await settleCookieBanners(page('about:blank'))).toBeUndefined();
  expect(await settleCookieBanners(page('https://news.example/'))).toBeUndefined();
  expect(newCDPSession).not.toHaveBeenCalled();
});
