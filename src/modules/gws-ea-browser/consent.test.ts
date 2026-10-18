/** The consent engine's reading of a choice's wording, and what it decides for each choice (KTD11). */
import { describe, expect, it } from 'vitest';

import {
  classifyConsentLabel,
  consentClassChoice,
  decideConsent,
  normalizeConsentWording,
  termsConsentLabel,
  type ConsentChoice,
  type ConsentDecision,
} from './consent.js';

const box = (label: string, changes: Partial<ConsentChoice> = {}): ConsentChoice => ({
  id: 0,
  kind: 'checkbox',
  label,
  checked: false,
  required: false,
  disabled: false,
  ...changes,
});
const radio = (id: number, group: string, label: string, checked = false): ConsentChoice => ({
  id,
  kind: 'radio',
  name: 'choice',
  group,
  label,
  checked,
  required: false,
  disabled: false,
});
const decide = (choices: ConsentChoice[], granted: readonly string[] = [], purchase = false): ConsentDecision =>
  decideConsent(choices, { granted: new Set(granted.map(normalizeConsentWording)), purchase });

describe('the wording of a choice', () => {
  it('reads a box that only accepts the site’s terms or privacy policy as terms', () => {
    for (const label of [
      'I agree to the Terms of Service',
      'I accept the Terms and Conditions and the Privacy Policy',
      'I have read and agree to the User Agreement',
      'By creating an account you agree to our Terms & Conditions',
      'I agree to the terms of use',
    ]) {
      expect(termsConsentLabel(label)).toBe(true);
      expect(classifyConsentLabel(label)).toBe('terms');
    }
  });

  it('reads marketing, sharing and SMS opt-ins, and inverted opt-outs by their meaning', () => {
    for (const label of [
      'Send me offers',
      'Email me about new products and special offers',
      'I agree to receive marketing',
      'Sign me up for the newsletter (no spam, unsubscribe anytime)',
      'Share my information with partners',
      'Text me updates by SMS',
      'Keep me informed about events',
      'Yes, I would like to hear from Linen & Co',
    ])
      expect(classifyConsentLabel(label)).toBe('marketing');
    for (const label of [
      'Tick here if you do NOT want our newsletter',
      'I do not wish to receive marketing emails',
      'Don’t send me offers',
      'Opt out of partner offers',
      'Do not sell or share my personal information',
    ])
      expect(classifyConsentLabel(label)).toBe('opt_out');
  });

  it('cannot read a double negative or a box that bundles the terms with anything else', () => {
    for (const label of [
      'Uncheck this box if you do not want to receive offers',
      'I don’t want to miss out on deals',
      'Untick if you would prefer not to hear from us',
    ])
      expect(classifyConsentLabel(label)).toBe('double_negative');
    for (const label of [
      'I agree to the Terms and to receive marketing emails',
      'I accept the membership terms and recurring billing',
      'I agree to the Terms of Service and the liability waiver',
      'I have read the privacy policy and agree to receive offers',
    ])
      expect(classifyConsentLabel(label)).toBe('bundled');
  });

  it('reads waivers, attestations and fee acknowledgements as agreements, and paid extras as add-ons', () => {
    for (const label of [
      'I have read and accept the liability waiver',
      'I confirm I am 21 or older',
      'I certify that I am at least 18 years old',
      'I understand a $25 no-show fee applies',
      'I acknowledge the non-refundable cancellation policy',
      'I agree to the house rules',
    ])
      expect(classifyConsentLabel(label)).toBe('agreement');
    for (const label of [
      'Round up for charity ($0.58)',
      'Add a $1 donation to the Food Bank',
      'Add gift wrap for $4.99',
      'Protect this order with shipping insurance',
    ])
      expect(classifyConsentLabel(label)).toBe('add_on');
  });

  it('leaves functional choices to the agent', () => {
    for (const label of [
      'Same as billing address',
      'Remember me',
      'Keep me signed in',
      'Leave at door',
      'This is a gift',
      'Save this card for future purchases',
      'I’m not a robot',
      '',
    ])
      expect(classifyConsentLabel(label)).toBe('functional');
  });

  it('normalizes wording without changing it: spacing and compatibility forms only', () => {
    expect(normalizeConsentWording('  I confirm I am\n 21  or older ')).toBe('I confirm I am 21 or older');
    expect(normalizeConsentWording('I confirm I am 21 or older')).not.toBe(
      normalizeConsentWording('I confirm I am 18 or older'),
    );
  });

  it('treats a click on any choice the engine owns as consent-class, but not a functional or priced delivery choice', () => {
    expect(consentClassChoice({ kind: 'checkbox', label: 'Send me offers' })).toBe(true);
    expect(consentClassChoice({ kind: 'switch', label: 'Email me product news' })).toBe(true);
    expect(consentClassChoice({ kind: 'checkbox', label: 'I agree to the Terms of Service' })).toBe(true);
    expect(
      consentClassChoice({ kind: 'radio', label: 'No', group: 'Would you like to receive offers by email?' }),
    ).toBe(true);
    expect(consentClassChoice({ kind: 'checkbox', label: 'Same as billing address' })).toBe(false);
    expect(consentClassChoice({ kind: 'radio', label: 'Express delivery, $8.00', group: 'Delivery option' })).toBe(
      false,
    );
    expect(consentClassChoice({ kind: 'select', label: 'Size', options: ['S', 'M', 'L'] })).toBe(false);
  });
});

describe('the engine’s decision for a form', () => {
  it('ticks a terms box whatever its required attribute says, and unticks a pre-ticked offers box', () => {
    expect(decide([box('I agree to the Terms of Service'), box('Send me offers', { id: 1, checked: true })])).toEqual({
      status: 'ready',
      set: [
        { id: 0, checked: true },
        { id: 1, checked: false },
      ],
      agreements: [],
      addOns: [],
    });
  });

  it('ticks an inverted opt-out, and leaves a functional box as it is', () => {
    expect(
      decide([
        box('Tick here if you do NOT want our newsletter'),
        box('Same as billing address', { id: 1, checked: true }),
      ]),
    ).toEqual({ status: 'ready', set: [{ id: 0, checked: true }], agreements: [], addOns: [] });
  });

  it('moves a Yes/No offers radio pair to No', () => {
    const group = 'Would you like to receive offers by email?';
    expect(decide([radio(0, group, 'Yes', true), radio(1, group, 'No')])).toEqual({
      status: 'ready',
      set: [{ id: 1, checked: true }],
      agreements: [],
      addOns: [],
    });
  });

  it('answers a question asked the other way round with Yes, and a question with no way to decline stops', () => {
    const inverted = 'Do you NOT want to receive offers?';
    expect(decide([radio(0, inverted, 'Yes'), radio(1, inverted, 'No', true)])).toEqual({
      status: 'ready',
      set: [{ id: 0, checked: true }],
      agreements: [],
      addOns: [],
    });
    const offers = 'How would you like to hear about offers?';
    expect(decide([radio(0, offers, 'By email', true), radio(1, offers, 'By text')])).toEqual({
      status: 'consent_required',
      items: [{ id: 0, wording: offers, kind: 'marketing' }],
    });
    // A select is decided the same way, by its option.
    expect(
      decide([
        {
          id: 0,
          kind: 'select',
          label: 'Marketing emails',
          options: [
            { label: 'Yes, send them', selected: true },
            { label: 'No thanks', selected: false },
          ],
          checked: false,
          required: false,
          disabled: false,
        },
      ]),
    ).toEqual({ status: 'ready', set: [{ id: 0, option: 1 }], agreements: [], addOns: [] });
  });

  it('stops for a required opt-in, a waiver, an attestation, a bundled box and a double negative', () => {
    for (const choice of [
      box('I agree to receive marketing', { required: true }),
      box('I have read and accept the liability waiver'),
      box('I confirm I am 21 or older', { required: true }),
      box('I agree to the Terms and to receive marketing emails', { required: true }),
      box('Uncheck this box if you do not want to receive offers', { checked: true }),
    ])
      expect(decide([choice])).toEqual({
        status: 'consent_required',
        items: [{ id: 0, wording: normalizeConsentWording(choice.label), kind: classifyConsentLabel(choice.label) }],
      });
  });

  it('ticks only the box whose exact wording the principal approved', () => {
    expect(
      decide(
        [box('I agree to receive marketing', { required: true }), box('Send me partner offers', { id: 1 })],
        ['I agree to receive marketing'],
      ),
    ).toEqual({ status: 'ready', set: [{ id: 0, checked: true }], agreements: [], addOns: [] });
    // Changed wording is a new question.
    expect(
      decide([box('I agree to receive marketing texts', { required: true })], ['I agree to receive marketing']),
    ).toMatchObject({ status: 'consent_required' });
  });

  it('puts agreements on a purchase’s card instead of stopping, and ticks the approved ones', () => {
    const attestation = box('I confirm I am 21 or older', { required: true });
    expect(decide([attestation], [], true)).toEqual({
      status: 'ready',
      set: [],
      agreements: ['I confirm I am 21 or older'],
      addOns: [],
    });
    expect(decide([attestation], ['I confirm I am 21 or older'], true)).toEqual({
      status: 'ready',
      set: [{ id: 0, checked: true }],
      agreements: ['I confirm I am 21 or older'],
      addOns: [],
    });
  });

  it('unticks a pre-ticked donation, and counts one the host could not untick as an add-on', () => {
    const donation = box('Round up for charity ($0.58)', { checked: true });
    expect(decide([donation])).toEqual({
      status: 'ready',
      set: [{ id: 0, checked: false }],
      agreements: [],
      addOns: [],
    });
    expect(decideConsent([donation], { granted: new Set(), purchase: true, kept: new Set([0]) })).toEqual({
      status: 'ready',
      set: [],
      agreements: [],
      addOns: ['Round up for charity ($0.58)'],
    });
    expect(decideConsent([donation], { granted: new Set(), purchase: false, kept: new Set([0]) })).toEqual({
      status: 'add_on',
      addOns: ['Round up for charity ($0.58)'],
    });
  });

  it('stops for an offers box the site keeps ticking after the host unticked it', () => {
    expect(
      decideConsent([box('Send me offers', { checked: true })], {
        granted: new Set(),
        purchase: false,
        kept: new Set([0]),
      }),
    ).toEqual({ status: 'consent_required', items: [{ id: 0, wording: 'Send me offers', kind: 'marketing' }] });
  });
});
