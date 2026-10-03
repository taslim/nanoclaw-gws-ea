import { describe, expect, it } from 'vitest';

import {
  canonicalText,
  compilePrivateValue,
  findPrivateValue,
  HISTORY_DIGIT_LENGTH,
  HISTORY_TEXT_LENGTH,
  streamOf,
  uncheckableReason,
  type PrivateValueKind,
} from './match.js';

function matches(kind: PrivateValueKind, value: string, ...messages: string[]): boolean {
  const compiled = [compilePrivateValue(kind, value)];
  let history = { text: '', digits: '' };
  for (const message of messages) {
    const current = streamOf([message]);
    if (findPrivateValue(compiled, current, history)) return true;
    history = {
      text: (history.text + current.text).slice(-HISTORY_TEXT_LENGTH),
      digits: (history.digits + current.digits).slice(-HISTORY_DIGIT_LENGTH),
    };
  }
  return false;
}

describe('private-value matching', () => {
  it.each([
    ['dots', 'Call me on 415.555.0134'],
    ['no separators', 'Number: 4155550134'],
    ['a country code', 'Reach them at +1 415 555 0134.'],
    ['brackets and dashes', '(415) 555-0134'],
    ['full-width digits', '４１５ ５５５ ０１３４'],
    ['Arabic-Indic digits', '٤١٥٥٥٥٠١٣٤'],
    ['words between the groups', 'area 415, then 555, then 0134'],
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
    ['spacing', '1 2 3 M a i n  S t'],
    ['zero-width characters', '123​ Ma‍in﻿ S⁠t'],
    ['a soft hyphen and a Hangul filler', '123 Ma­iㅤn St'],
    ['Cyrillic lookalikes', '123 Маin Ѕt'],
    ['Greek lookalikes', '123 Μαιn Sτ'],
    ['mathematical letters', '\u{1D7CF}\u{1D7D0}\u{1D7D1} \u{1D40C}\u{1D41A}\u{1D422}\u{1D427} \u{1D412}\u{1D42D}'],
    ['diacritics', '123 Mäîn St'],
    ['percent-encoding', '123%20Main%20St'],
    ['double percent-encoding', 'https://maps.example/?q=123%2520Main%2520St'],
    ['encoded digits and plus signs', '%31%32%33+Main+St'],
  ])('finds an address written with %s', (_label, message) => {
    expect(matches('address', '123 Main St', message)).toBe(true);
  });

  it.each([
    ['123 Main Street', 'Meet at 123 main st.'],
    ['123 Main St', 'Meet at 123 Main Street'],
    ['45 Oak Avenue', '45 oak ave'],
    ['9 Elm Road', '9 Elm Rd'],
    ['7 Harbor Boulevard', '7 harbor blvd'],
    ['12 North Park Lane', '12 N Park Ln'],
  ])('treats street-suffix variants as equal: %s', (value, message) => {
    expect(matches('address', value, message)).toBe(true);
  });

  it('finds the street line of a full address on its own', () => {
    expect(matches('address', '123 Main Street, Springfield, IL 62701', 'How about 123 Main St?')).toBe(true);
  });

  it('finds an email address in any case and spacing', () => {
    expect(matches('email', 'Jane.Doe@Example.com', 'write to JANE.DOE @ example . com')).toBe(true);
  });

  it('finds a value split across messages, and only across adjacent text', () => {
    expect(matches('address', '123 Main Street', 'We could meet at 123', 'Main St if that works')).toBe(true);
    expect(matches('phone', '415 555 0134', 'The first part is 415 55', 'and the rest is 5 0134')).toBe(true);
    expect(matches('address', '123 Main Street', 'Room 123', 'Main hall it is')).toBe(false);
  });

  it('does not refuse new text for a value that sits wholly in earlier text', () => {
    const compiled = [compilePrivateValue('address', '123 Main St')];
    const history = streamOf(['Old note: 123 Main St']);
    expect(findPrivateValue(compiled, streamOf(['Thanks, see you then.']), history)).toBeUndefined();
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

  it('returns the value that matched, for its kind', () => {
    const compiled = [
      compilePrivateValue('address', '123 Main Street'),
      compilePrivateValue('other', 'Kidney transplant'),
    ];
    expect(findPrivateValue(compiled, streamOf(['after my KIDNEY-transplant']))?.kind).toBe('other');
  });

  it('checks every part of a message as one stream', () => {
    const compiled = [compilePrivateValue('address', '123 Main Street')];
    expect(findPrivateValue(compiled, streamOf(['Re: 123 Main', 'Street is fine']))).toBeDefined();
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
