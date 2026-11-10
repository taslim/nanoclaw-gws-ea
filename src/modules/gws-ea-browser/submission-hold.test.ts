import { describe, expect, it } from 'vitest';

import { carriesSecret, holdRefusesRequest, readTexts, sentForms, type PlacedHold } from './submission-hold.js';

const SECRET = 'Tr0ub4dor&3';
const hold: PlacedHold = { onSite: { site: 'shop.example', values: [SECRET] }, forms: sentForms([SECRET]) };
const percent = (value: string): string =>
  [...Buffer.from(value, 'utf8')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');

function leaves(url: string, body = ''): boolean {
  return holdRefusesRequest(hold, { url, method: 'POST', body }, 'collector.example', () => readTexts([url, body]));
}

describe('a held value leaving for another site', () => {
  it('is caught in every form a page script commonly sends it', () => {
    const base64 = Buffer.from(SECRET).toString('base64');
    for (const sent of [
      SECRET,
      encodeURIComponent(SECRET),
      new URLSearchParams({ v: SECRET }).toString().slice(2),
      base64,
      base64.replace(/=+$/u, ''),
      Buffer.from(SECRET).toString('base64url'),
    ])
      expect(leaves(`https://collector.example/beacon?v=${sent}`)).toBe(true);
    expect(leaves('https://collector.example/beacon', JSON.stringify({ password: SECRET }))).toBe(true);
    expect(leaves('https://collector.example/beacon', 'event=view')).toBe(false);
  });

  it('is caught when an invalid escape elsewhere in the address would stop a whole-text decode', () => {
    expect(leaves(`https://collector.example/${percent(SECRET)}/x?bad=%FF`)).toBe(true);
    expect(leaves(`https://collector.example/c?value=${percent(SECRET)}&bad=%E0%A4`)).toBe(true);
    expect(carriesSecret(new URL(`https://collector.example/${percent(SECRET)}#%FF`), [SECRET])).toBe(true);
  });

  it('stays on the site, and refuses a body the gate could not read', () => {
    expect(
      holdRefusesRequest(hold, { url: `https://www.shop.example/?v=${SECRET}`, method: 'POST' }, 'shop.example', () =>
        readTexts([SECRET]),
      ),
    ).toBe(false);
    expect(
      holdRefusesRequest(hold, { url: 'https://collector.example/', method: 'POST' }, 'collector.example', () => []),
    ).toBe(true);
  });
});
