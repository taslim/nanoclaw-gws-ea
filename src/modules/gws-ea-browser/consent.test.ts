/** The consent engine's reading of a choice's wording, and what it decides for each choice (KTD11). */
import { describe, expect, it } from 'vitest';

import {
  classifyConsentLabel,
  consentClassChoice,
  decideConsent,
  normalizeConsentWording,
  type ConsentChoice,
  type ConsentDecision,
} from './consent.js';

const box = (label: string, changes: Partial<ConsentChoice> = {}): ConsentChoice => ({
  id: 0,
  kind: 'checkbox',
  label,
  links: [],
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
  links: [],
  checked,
  required: false,
  disabled: false,
});
/** The site the page belongs to. */
const SITE = 'shop.example';
const decide = (choices: ConsentChoice[], granted: readonly string[] = []): ConsentDecision =>
  decideConsent(choices, { granted: new Set(granted.map(normalizeConsentWording)), purchase: false, site: SITE });

describe('the wording of a choice', () => {
  it('reads a box that only accepts the site’s terms or privacy policy as terms, and one that bundles them with anything else as bundled', () => {
    for (const label of [
      'I agree to the Terms of Service',
      'I accept the Terms and Conditions and the Privacy Policy',
      'I have read and agree to the User Agreement',
      'I agree to the Terms & Conditions',
      'By creating an account you agree to our Terms & Conditions',
      'I agree to the terms of use',
    ])
      expect(classifyConsentLabel(label), label).toBe('terms');
    for (const [label, kind] of [
      ['Send me marketing emails', 'marketing'],
      ['Share my data with partners', 'marketing'],
      ['I agree to the Terms of Service and to receive newsletters', 'bundled'],
      ['I agree to the Terms and to special offers', 'bundled'],
      ['I agree to the Privacy Policy and data sharing with third parties', 'bundled'],
      ['I agree to the subscription terms', 'bundled'],
      ['I agree to the Terms and authorize recurring billing', 'bundled'],
      ['I accept the membership terms', 'bundled'],
      ['I agree to the payment terms', 'bundled'],
      ['I agree to the Terms of Service and the free trial', 'bundled'],
      ['I agree to the Terms; my plan renews automatically at $10/month', 'bundled'],
      ['I agree to the Terms and to receive marketing emails', 'bundled'],
      ['I accept the membership terms and recurring billing', 'bundled'],
      ['I agree to the Terms of Service and the liability waiver', 'bundled'],
      ['I have read the privacy policy and agree to receive offers', 'bundled'],
    ] as const)
      expect(classifyConsentLabel(label), label).toBe(kind);
  });

  it('reads another company’s terms as an agreement, and terms the site names as its own as terms', () => {
    const shop = { site: 'shop.example', links: [] };
    for (const label of [
      "I agree to Klarna's Terms of Service",
      'I accept PayPal’s User Agreement',
      "I agree to Afterpay's Terms and Conditions",
      "I agree to Klarna Bank AB's General Terms",
      'I agree to the Klarna Terms of Service',
      'I accept the terms of Afterpay',
      'I agree to the Terms of Service of Klarna Bank AB',
      'I accept the seller’s terms',
      'I agree to their Terms of Service',
      "I agree to the Terms of Service and Stripe's Connected Account Agreement",
      'I agree to the Terms of Service and the Stripe Services Agreement',
    ])
      expect(classifyConsentLabel(label, shop), label).toBe('agreement');
    const pottery = { site: 'hale-pottery.example', links: [] };
    for (const label of [
      "I agree to Hale Pottery's Terms of Service",
      'I agree to the Hale Pottery Terms of Use',
      'I agree to the Terms and Conditions of Hale Pottery Ltd.',
      "I agree to the site's Terms",
      'I agree to the terms of this site',
      'I Agree To The General Terms And Conditions',
      'By creating an account you agree to our Terms & Conditions and Privacy Policy',
      'I agree to the Terms of Use and the Acceptable Use Policy, and have read the Privacy Notice',
    ])
      expect(classifyConsentLabel(label, pottery), label).toBe('terms');
    expect(classifyConsentLabel("I agree to Klarna's Terms of Service", { site: 'klarna.com', links: [] })).toBe(
      'terms',
    );
  });

  it('reads terms whose wording or description links to another site as an agreement, and links within the site as its terms', () => {
    const terms = 'I agree to the Terms of Service';
    expect(classifyConsentLabel(terms, { site: 'shop.example', links: ['https://pay.example/legal/terms'] })).toBe(
      'agreement',
    );
    expect(
      classifyConsentLabel(terms, {
        site: 'shop.example',
        links: ['https://shop.example/terms', 'https://www.shop.example/terms', 'https://pay.example/user-agreement'],
      }),
    ).toBe('agreement');
    expect(
      classifyConsentLabel(terms, {
        site: 'shop.example',
        links: [
          'https://shop.example/terms',
          'https://help.shop.example/privacy#cookies',
          'javascript:void(0)',
          'mailto:help@shop.example',
        ],
      }),
    ).toBe('terms');
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

  it('cannot read a double negative', () => {
    for (const label of [
      'Uncheck this box if you do not want to receive offers',
      'I don’t want to miss out on deals',
      'Untick if you would prefer not to hear from us',
    ])
      expect(classifyConsentLabel(label)).toBe('double_negative');
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
    expect(normalizeConsentWording('I confirm I am ２１ or older')).toBe('I confirm I am 21 or older');
    // The words, their case and their punctuation are the wording the principal approves.
    expect(normalizeConsentWording('I agree to Klarna’s “Terms”')).toBe('I agree to Klarna’s “Terms”');
  });

  it('reads a click on a radio option by its question, and on a select by its question and options', () => {
    expect(
      consentClassChoice({ kind: 'radio', label: 'No', group: 'Would you like to receive offers by email?' }),
    ).toBe(true);
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

  it('ticks terms linked within the site and another company’s terms the principal agreed to, and stops for another company’s terms asked as a question', () => {
    const klarna = "I agree to Klarna's Terms of Service";
    expect(
      decide([box('I accept the terms and privacy policy', { links: ['https://www.shop.example/legal/terms'] })]),
    ).toEqual({ status: 'ready', set: [{ id: 0, checked: true }], agreements: [], addOns: [] });
    // Once the principal agrees to that wording on the site, it is ticked without asking again.
    expect(decide([box(klarna, { required: true })], [klarna])).toEqual({
      status: 'ready',
      set: [{ id: 0, checked: true }],
      agreements: [],
      addOns: [],
    });
    // Another company's terms asked as a Yes/No pair stop until the principal agrees.
    const question = 'Do you accept the PayPal User Agreement?';
    expect(decide([radio(0, question, 'Yes'), radio(1, question, 'No')])).toEqual({
      status: 'consent_required',
      items: [{ id: 0, wording: question, kind: 'agreement' }],
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
          links: [],
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
    for (const [wording, kind, changes] of [
      ['I agree to receive marketing', 'marketing', { required: true }],
      ['I have read and accept the liability waiver', 'agreement', {}],
      ['I confirm I am 21 or older', 'agreement', { required: true }],
      ['I agree to the Terms and to receive marketing emails', 'bundled', { required: true }],
      ['Uncheck this box if you do not want to receive offers', 'double_negative', { checked: true }],
    ] as const)
      expect(decide([box(wording, changes)])).toEqual({
        status: 'consent_required',
        items: [{ id: 0, wording, kind }],
      });
  });
});
