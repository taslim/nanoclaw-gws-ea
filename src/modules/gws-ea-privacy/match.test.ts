import { describe, expect, it } from 'vitest';

import {
  canonicalText,
  compilePrivateValue,
  findPrivateValue,
  streamOf,
  uncheckableReason,
  type PrivateValueKind,
} from './match.js';

function matches(kind: PrivateValueKind, value: string, ...parts: string[]): boolean {
  return findPrivateValue([compilePrivateValue(kind, value)], streamOf(parts)) !== undefined;
}

describe('private-value matching', () => {
  it.each([
    ['dots', 'Call me on 415.555.0134'],
    ['no separators', 'Number: 4155550134'],
    ['a country code', 'Reach them at +1 415 555 0134.'],
    ['brackets and dashes', '(415) 555-0134'],
    ['en dashes', '415–555–0134'],
    ['full-width digits', '４１５ ５５５ ０１３４'],
    ['Arabic-Indic digits', '٤١٥٥٥٥٠١٣٤'],
    ['a tel: link', '[call](tel:+14155550134)'],
    ['an extension after it', '415-555-0134 x12'],
    ['a time after it', 'call 415 555 0134 2pm tomorrow'],
  ])('finds a phone number written with %s', (_label, message) => {
    expect(matches('phone', '+1 (415) 555-0134', message)).toBe(true);
  });

  it('finds an international number in its national form', () => {
    expect(matches('phone', '+44 20 7946 0958', 'Ring 020 7946 0958')).toBe(true);
    expect(matches('phone', '+33 1 23 45 67 89', 'Le 01 23 45 67 89')).toBe(true);
  });

  it.each([
    ['case', '123 MAIN ST'],
    ['punctuation', '123-main-st.'],
    ['no space before the street', '123Main St'],
    ['zero-width characters', '123​ Ma‍in﻿ S⁠t'],
    ['a soft hyphen and a Hangul filler', '123 Ma­iㅤn St'],
    ['non-breaking spaces', '123 Main St'],
    ['mathematical letters', '\u{1D7CF}\u{1D7D0}\u{1D7D1} \u{1D40C}\u{1D41A}\u{1D422}\u{1D427} \u{1D412}\u{1D42D}'],
    ['diacritics', '123 Mäîn St'],
    ['percent-encoding', '123%20Main%20St'],
    ['double percent-encoding', 'https://maps.example/?q=123%2520Main%2520St'],
    ['encoded digits and plus signs', '%31%32%33+Main+St'],
  ])('finds an address written with %s', (_label, message) => {
    expect(matches('address', '123 Main St', message)).toBe(true);
  });

  it('reads Latin letters that do not decompose as their plain spellings', () => {
    expect(matches('address', '4 Søndergade, Aarhus', 'meet at 4 Sondergade')).toBe(true);
    expect(matches('address', '9 Gartenstrasse', '9 Gartenstraße')).toBe(true);
  });

  it.each([
    ['123 Main Street', 'Meet at 123 main st.'],
    ['123 Main St', 'Meet at 123 Main Street'],
    ['45 Oak Avenue', '45 oak ave'],
    ['9 Elm Road', '9 Elm Rd'],
    ['7 Harbor Boulevard', '7 harbor blvd'],
    ['12 North Park Lane', '12 N Park Ln'],
    ['Apt 5B, 9 Elm Road', 'Unit 5B, 9 Elm Rd'],
  ])('treats street-suffix and unit variants as equal: %s', (value, message) => {
    expect(matches('address', value, message)).toBe(true);
  });

  it('finds the street line of a full address on its own', () => {
    expect(matches('address', '123 Main Street, Springfield, IL 62701', 'How about 123 Main St?')).toBe(true);
  });

  it('finds an email address in any case and spacing', () => {
    expect(matches('email', 'Jane.Doe@Example.com', 'write to JANE.DOE @ example . com')).toBe(true);
    expect(matches('email', 'Jane.Doe@Example.com', '[mail](mailto:jane.doe@example.com)')).toBe(true);
  });

  it("finds another value's words, whole", () => {
    expect(matches('other', 'Theo', 'He has Theo’s recital that evening.')).toBe(true);
    expect(matches('other', 'Rosewood Clinic', 'an appointment at the Rosewood-Clinic')).toBe(true);
  });

  it('checks every part of a message as one text', () => {
    expect(matches('address', '123 Main Street', 'Re: 123 Main', 'Street is fine')).toBe(true);
  });

  it.each<[PrivateValueKind, string, string]>([
    ['other', 'Theo', 'The other day the one in Napa came up, and Theodore Vance agreed.'],
    ['other', 'Kate', 'Ok, ate early, so I can book at eleven; Kateri will host.'],
    ['other', 'Emma', 'Let them make the call. Thanks, Emmanuel.'],
    ['other', '4471', 'Ticket #44718; order 112-4471953; I can do 4:47 or 1:15.'],
    ['address', '12 Elm Road, Springfield', 'Our new office is at 112 Elm Road, Springfield.'],
    ['address', '5 Oak St, Riverton', 'Pickup at 15 Oak St, Riverton, or 1205 Oak St.'],
    ['phone', '+1 415 555 0134', 'Flight UA 415 departs 5:55 from gate 01, seat 34A.'],
    ['phone', '+1 415 555 0134', 'The invoice total is $1,555.01 plus $34.00 shipping.'],
    ['phone', '+1 415 555 0134', 'Booth 5550, hall 1, level 34; 50.134% upfront.'],
  ])('does not find a %s value made of other words or numbers: %s', (kind, value, message) => {
    expect(matches(kind, value, message)).toBe(false);
  });

  // Deliberate encodings no matcher can close, beside spelling a value out:
  // only an agent that holds the value can write them, and external-email
  // never holds one.
  it.each<[PrivateValueKind, string, string]>([
    ['address', '123 Main St', 'one two three Main St'],
    ['address', '123 Main St', '123 Маin Ѕt'],
    ['address', '123 Main St', '1 2 3 M a i n S t'],
    ['phone', '+1 415 555 0134', 'area 415, then 555, then 0134'],
  ])('leaves a deliberately encoded %s value as a known residual: %s', (kind, value, message) => {
    expect(matches(kind, value, message)).toBe(false);
  });

  it('passes unrelated text and matches nothing without values', () => {
    const compiled = [
      compilePrivateValue('address', '123 Main Street'),
      compilePrivateValue('phone', '+1 415 555 0134'),
      compilePrivateValue('other', 'Kidney transplant'),
    ];
    const message = streamOf(['Tuesday at 3pm works. Room 12, building 3, dial-in 555 0199.']);
    expect(findPrivateValue(compiled, message)).toBeUndefined();
    expect(findPrivateValue([], streamOf(['123 Main Street']))).toBeUndefined();
  });

  it('refuses values too short or too long to check reliably', () => {
    expect(uncheckableReason('other', 'IBS')).toMatch(/at least 4 letters or digits/);
    expect(uncheckableReason('phone', '555-01')).toMatch(/7 to 15 digits/);
    expect(uncheckableReason('phone', '+1 415 555 0134 0000 1')).toMatch(/7 to 15 digits/);
    expect(uncheckableReason('email', 'not an address')).toMatch(/email address/);
    expect(uncheckableReason('other', 'x'.repeat(300))).toMatch(/too long/);
    expect(uncheckableReason('address', '123 Main Street')).toBeUndefined();
  });

  it('canonicalizes to letters and digits only', () => {
    expect(canonicalText('  123 Main Street, Apt 5 ')).toBe('123mainst5');
    expect(canonicalText('Straße')).toBe('strasse');
  });
});
