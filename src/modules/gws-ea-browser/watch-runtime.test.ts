import type { Page } from 'playwright-core';
import { expect, it } from 'vitest';
import { observePage } from './observe.js';
import { normalizeWatchRegion, watchCheckFailure } from './watch-runtime.js';

/** A page the host observed: sixty listings, more than one snapshot holds, then `ending` as its last line. */
async function observedListings(ending: string): Promise<{ page: Page; snapshot: string }> {
  const tree = [
    ...Array.from({ length: 60 }, (_value, index) => ({
      role: 'region',
      name: `Listing ${index + 1}`,
      ref: `e${10 + index}`,
      text: 'Garden flat near the river with morning light. '.repeat(8),
    })),
    { role: 'paragraph', ref: 'e99', text: ending },
  ];
  const page = {
    url: () => 'https://larder.example/tables',
    on() {},
    frames: () => [],
    locator: () => ({ ariaSnapshotJSON: async () => tree }),
  } as unknown as Page;
  return { page, snapshot: (await observePage(page)).snapshot };
}

it('carries a check’s stop reasons into site backoff instead of treating challenges as ordinary drift', async () => {
  const { page } = await observedListings('Book a table');
  expect(watchCheckFailure({ reason: 'challenge' }, page)).toEqual({ status: 'blocked' });
  expect(watchCheckFailure({ reason: 'sign_in_wall' }, page)).toEqual({ status: 'blocked' });
  expect(watchCheckFailure({ reason: 'site_busy' }, page)).toEqual({ status: 'site_busy' });
  expect(watchCheckFailure({ reason: 'navigation_failed' }, page)).toEqual({ status: 'failed' });
});

it('finds a challenge in the whole page read when the agent’s cut of it leaves the challenge out', async () => {
  const { page, snapshot } = await observedListings('Please verify you are human to continue browsing.');
  expect(snapshot).not.toContain('verify you are human');
  expect(watchCheckFailure({ reason: 'timeout' }, page)).toEqual({ status: 'blocked' });
});

it('compares a region without its countdowns, viewers, clocks, relative times, tallies and link addresses', () => {
  const view = (served: number, slots: string): string =>
    [
      '- region "Available tables":',
      `  - paragraph: Offer ends in 0${served}:4${served}`,
      `  - paragraph: ${10 + served} people viewing`,
      `  - paragraph: Updated 7:1${served} PM · ${served + 2} others are looking at this`,
      `  - paragraph: Last checked ${served} minutes ago`,
      `  - text: Booked ${served + 20} times today · 19:4${served}:0${served}`,
      `  - paragraph: Releases in ${served}h 1${served}m`,
      '  - list:',
      ...slots
        .split(',')
        .flatMap((slot) => [
          '    - listitem:',
          `      - link "${slot}":`,
          `        - /url: /book?slot=${slot}&session=${served}`,
        ]),
    ].join('\n');
  const first = normalizeWatchRegion(view(1, '7:30 PM,19:45'));
  // A slot's own time, on either clock, is availability: it stays.
  expect(first).toBe(
    [
      '- region "Available tables":',
      '  - paragraph: Offer',
      '  - list:',
      '    - listitem:',
      '      - link "7:30 PM":',
      '    - listitem:',
      '      - link "19:45":',
    ].join('\n'),
  );
  expect(normalizeWatchRegion(view(2, '7:30 PM,19:45'))).toBe(first);
  expect(normalizeWatchRegion(view(3, '7:30 PM,20:00'))).not.toBe(first);
});

it('keeps what surrounds volatile text and a slot that a booking word sits beside', () => {
  expect(normalizeWatchRegion('- paragraph: 7:30 PM · 8:00 PM · 12 people viewing · 9:00 PM')).toBe(
    '- paragraph: 7:30 PM · 8:00 PM · 9:00 PM',
  );
  expect(normalizeWatchRegion('- paragraph: 3 people viewing · Bar seats only')).toBe('- paragraph: Bar seats only');
  expect(normalizeWatchRegion('- button "Book now 7:30 PM"')).toBe('- button "Book now 7:30 PM"');
  expect(normalizeWatchRegion('- button "7:00 PM" [disabled]')).not.toBe(normalizeWatchRegion('- button "7:00 PM"'));
  expect(normalizeWatchRegion('- paragraph: Only 2 tables left')).toBe('- paragraph: Only 2 tables left');
});
