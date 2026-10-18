/**
 * The consent engine (KTD11, R15–R17, R19): the host makes every checkbox, switch, radio and select choice in a
 * form before any submission it performs or lets run, and the principal approves the exceptions.
 *
 * An isolated world lists every choice in the target form, or in a formless control's region (the region the
 * classifier reads), with its wording, state and links. The engine reads each wording for its meaning: a box that
 * only accepts the site's own terms is ticked, whatever its `required` attribute says; marketing, newsletters,
 * partner sharing, SMS and offers end opted out, inverted wording included; paid extras and donations are
 * unticked; and an agreement beyond the site's terms (another party's terms, named or linked, a waiver, an
 * attestation, a fee acknowledgement, a box bundling the terms with anything, a double negative, or an opt-in the
 * site requires) stops with `consent_required` unless the principal approved that exact wording on that site
 * before. Functional choices stay the agent's. The host acts with real clicks on the box or its label, then reads
 * again after the page settles: a choice the site will not keep stops, so the check before the press is what the
 * page holds then.
 *
 * Inside a purchase the agreements go on the purchase card instead, and an extra the site keeps selected
 * joins the facts the card shows as a charge.
 */
import { createHash, randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain, getDomainWithoutSuffix } from 'tldts';

import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isolationSelector } from './authentication-submit.js';
import {
  CHOICE_SOURCE,
  ControlFactsUnavailableError,
  frameGone,
  moneyTerms,
  record,
  type ToggledChoice,
} from './control-facts.js';
import {
  attachFrameTarget,
  bounded,
  frameTreeFrames,
  installReader,
  PROTOCOL_READ_TIMEOUT_MS,
  type IsolatedReader,
} from './page-targets.js';

// ---------------------------------------------------------------- what a choice's wording means

/** What the engine reads a choice's wording as. */
export type ConsentLabelKind =
  | 'terms'
  | 'marketing'
  | 'opt_out'
  | 'add_on'
  | 'agreement'
  | 'bundled'
  | 'double_negative'
  | 'functional';

/** The site's own terms: what a delegated signup accepts with the account. */
const siteTerms =
  /\b(?:terms(?:\s+(?:of\s+(?:service|use)|(?:and|&)\s+conditions))?|user\s+agreement|privacy\s+(?:policy|notice|statement))\b/iu;
/** What never rides along with a site's terms. */
const notSiteTerms =
  /\b(?:marketing|newsletters?|news|offers?|promotions?|promotional|partners?|third[\s-]+part(?:y|ies)|shar(?:e|ing)|advertis\w*|sponsors?|surveys?|updates|e-?mails?|sms|texts?|pay(?:ment|ments|ing)?|billing|billed|charges?|fees?|prices?|pricing|purchases?|orders?|sales?|trials?|subscri\w*|renew\w*|recurring|memberships?|plans?|cards?|credit|refunds?)\b|[$€£¥]/iu;

/** Every document a terms box names, to read whose each one is: terms, conditions, agreements, policies, notices. */
const termsDocuments =
  /\b(?:terms(?:\s+of\s+(?:service|use))?|conditions(?:\s+of\s+use)?|agreements?|polic(?:y|ies)|notices?|statements?)\b/giu;

/**
 * The words around a document a terms box names that say whose it is. A name is a capitalized word that is neither
 * one every sentence has nor one describing the document. Vocabulary is data: widen or narrow it here.
 */
const TERMS_OWNER_VOCABULARY = {
  /** A possessive, kept apart from the contractions that look like one. */
  possessive: /^(.+?)(?:'s|')$/u,
  contraction: /^(?:it|that|there|here|what|who|where|he|she|let)$/iu,
  /** The site naming itself: "our terms", "of your service". */
  selfPronoun: /^(?:our|your)$/iu,
  /** The site naming itself: "the site's terms", "the terms of the Company". */
  selfNoun: /^(?:site|website|store|shop|app|service|platform|company)$/iu,
  /** Another party named only by a pronoun. */
  otherPronoun: /^(?:their|its|his|her)$/iu,
  /** What follows "of" before whose document it is: "the terms of the …". */
  determiner: /^(?:the|this|these)$/iu,
  /** A word of a name: capitalized, or a brand's inner capital ("eBay"). */
  name: /^[\p{Lu}\p{N}]|^\p{Ll}+\p{Lu}/u,
  /** Capitalized words that are not names: what a sentence says around one. */
  notName:
    /^(?:the|a|an|this|these|that|those|our|your|my|i|we|you|to|and|or|of|with|by|for|in|on|at|from|as|under|per|all|any|both|each|every|please|yes|agree[ds]?|accept(?:s|ed)?|acknowledge[sd]?|consent|read|have|has|understood|understand|review(?:ed)?|confirm|view|see|open)$/iu,
  /** Capitalized words that describe a document, not whose it is. */
  descriptor:
    /^(?:general|standard|full|updated|current|latest|new|revised|applicable|following|relevant|complete|additional|supplemental|important|acceptable|end|website|web|site|online|services?|customers?|users?|members?|bookings?|reservations?|account|legal|platform|app|store|shop|community|global|master|basic|main|tickets?|events?|guests?|rental|hire|delivery|shipping|returns?|use|sale|carriage|business|entry|access|admission|participation|stay|licen[cs]es?|conditions|agreement|policy|privacy|cookies?|data)$/iu,
  /** What joins the words of one name. */
  joiner: /^[&+]$/u,
  /** A company's legal form after its name. */
  legalForm: /^(?:inc|llc|ltd|limited|corp|corporation|co|company|gmbh|plc|ag|sa|ab|bv|nv|pty|llp|lp)$/iu,
  /** Punctuation that ends a clause, which a name never crosses. */
  clauseEnd: /[,;:!?]/u,
} as const satisfies Record<string, RegExp>;

// Vocabulary is data: widen or narrow it here, never by changing the order the engine decides in.
const CONSENT_VOCABULARY = {
  marketing:
    /\b(?:marketing|newsletters?|offers?|promotions?|promotional|promos?|deals|discounts?|coupons?|news|announcements?|(?:e-?mail|sms|text|product|occasional|weekly|monthly)\s+updates?|updates?\s+(?:from|about|on)|keep\s+me\s+(?:informed|posted|updated|in\s+the\s+loop)|partners?|affiliates?|third[\s-]+part(?:y|ies)|sponsors?|advertis\w*|ads|surveys?|sms|text\s+messages?|texts|whatsapp|push\s+notifications?|(?:e-?mail|text|call|contact|message)\s+me|be\s+contacted|hear\s+from|mailing\s+list|subscribe\s+to|sign\s+me\s+up)\b/iu,
  sharing:
    /\b(?:sell|shar(?:e|ing)|disclos(?:e|ing|ure)|transfer)\b[^.;]{0,40}?\b(?:data|information|info|details)\b|\bdata\s+(?:sharing|sales?)\b/iu,
  /** A paid extra or a donation. */
  addOn:
    /\b(?:donat(?:e|es|ion|ions)|charit(?:y|ies|able)|round(?:ing)?\s+up|tip|gratuity|insurance|insure|protection\s+plan|protect\s+(?:this|my|your)\s+(?:order|purchase|trip|booking)|warrant(?:y|ies)|gift\s+wrap(?:ping)?|carbon\s+(?:offset|neutral)|add-?on|extended\s+(?:warranty|protection|coverage))\b/iu,
  /** Only a donation or a tip is an extra in a group of options; a priced option is what is bought. */
  donation: /\b(?:donat(?:e|es|ion|ions)|charit(?:y|ies|able)|round(?:ing)?\s+up|tip|gratuity)\b/iu,
  amount: /(?:[$€£¥₹₩]\s?\d|\d(?:[\d,.]*\d)?\s?(?:[€£¥]|\b(?:usd|eur|gbp|cad|aud|nzd|jpy|chf|inr|mxn|sgd|hkd)\b))/iu,
  waiver:
    /\b(?:waivers?|waive[sd]?|hold\s+harmless|indemnif\w*|releases?\s+(?:\w+\s+){0,4}?(?:from|of)\s+(?:all\s+|any\s+)?(?:liability|claims)|assum(?:e|es|ption\s+of)\s+(?:all\s+|the\s+)?risks?|liability|arbitration|class\s+action)\b/iu,
  attestation:
    /\b(?:i\s+am\s+(?:at\s+least\s+|over\s+|older\s+than\s+)?\d{2}|i'm\s+(?:at\s+least\s+|over\s+)?\d{2}|(?:at\s+least|over|aged?)\s+\d{2}\b|\d{2}\s*(?:\+|years?\s+(?:old|of\s+age)|or\s+(?:older|over))|(?:legal|drinking|minimum)\s+age|of\s+(?:legal\s+)?age|(?:certify|attest|declare|affirm|swear)\b|confirm\s+(?:that\s+)?(?:i|we|the|this|my|all)\b|under\s+penalty|true\s+and\s+(?:accurate|correct|complete)|eligib(?:le|ility))/iu,
  acknowledges: /\b(?:acknowledge[sd]?|understand|accept(?:s|ed)?|agree[sd]?|consent|authori[sz]e)\b/iu,
  fee: /\b(?:fees?|charges?|charged|penalt(?:y|ies)|deposits?|non-?refundable|no-?shows?|cancell?ation|refunds?|surcharges?|pre-?authori[sz]ation)\b/iu,
  consents: /\b(?:agree[sd]?|consent(?:s|ed)?|accept(?:s|ed)?|acknowledge[sd]?|authori[sz]e[sd]?)\b/iu,
  /** Words that say the opposite of what follows them; two make a double negative. */
  negation:
    /\b(?:do\s+not|does\s+not|did\s+not|would\s+not|rather\s+not|prefer\s+not|[a-z]+n't|not|never|no|none|opt[\s-]?out|unsubscribe|un-?(?:tick|check|select)|deselect|decline|refuse|stop|exclude|miss(?:ing)?|lose|losing)\b/giu,
  /** Reassurance about later choices, which says nothing about this box. */
  reassurance:
    /\bno\s+spam\b[^.;,)]*|\byou\s+(?:can|may)\s+(?:always\s+)?(?:unsubscribe|opt[\s-]?out|change\s+your\s+mind)\b[^.;)]*|\b(?:unsubscribe|opt[\s-]?out)\s+(?:at\s+)?any\s*time\b|\bwe(?:\s+will|'ll)?\s+never\s+(?:share|sell|spam|rent|pass)\b[^.;)]*|\bwe\s+won't\s+(?:share|sell|spam|rent|pass)\b[^.;)]*|\(optional\)/giu,
  /** A billing address is where a card is billed, never a charge. */
  billingDetails: /\bbilling\s+(?:address|details|info(?:rmation)?|name|phone|zip|post(?:al\s+)?code)\b/giu,
  /** A radio option or select option that declines. */
  declines:
    /^(?:no\b|none\b|nope\b|not\s+now\b|never\b|decline|opt[\s-]?out|unsubscribe|i\s+(?:do\s+not|don't)\b|do\s+not\b|don't\b|\$?0(?:[.,]00)?$)/iu,
  /** A radio option or select option that agrees. */
  affirms: /^(?:yes\b|yep\b|sure\b|ok(?:ay)?\b|i\s+(?:do|agree|accept|consent|confirm)\b|agree\b|accept\b|confirm\b)/iu,
} as const satisfies Record<string, RegExp>;

/** Wording as the engine keys it: compatibility forms and spacing normalized, the words themselves unchanged. */
export function normalizeConsentWording(text: string): string {
  return text.normalize('NFKC').replace(/\s+/gu, ' ').trim();
}

/** The wording as the vocabulary reads it: one apostrophe, without reassurance about later choices. */
function readable(text: string): string {
  return normalizeConsentWording(text)
    .replace(/[‘’ʼ´`]/gu, "'")
    .replace(CONSENT_VOCABULARY.reassurance, ' ');
}

/**
 * Whether a box's wording accepts only the site's terms of service, terms and conditions, user agreement or
 * privacy policy. Marketing, data sharing and every money term keep their own authority.
 */
function termsConsentLabel(label: string): boolean {
  return siteTerms.test(label) && !notSiteTerms.test(label) && !moneyTerms.test(label);
}

/** The words of a stretch of wording, without the quotes, brackets and full stops around them. */
function wordsOf(text: string): string[] {
  return text
    .split(/\s+/u)
    .map((token) => token.replace(/^[("'“[]+|[)"”\].]+$/gu, ''))
    .filter(Boolean);
}

/**
 * Whose terms a wording names: a possessive just before a document it names ("Klarna's Terms", "the seller's
 * terms"), a name directly before it ("the PayPal User Agreement"), or a name after "of" ("the terms of Afterpay").
 * The site naming itself ("our terms", "the site's terms", "the terms of this site") names no one; another party
 * named only as "their" is ''.
 */
function termsOwners(words: string): string[] {
  const vocabulary = TERMS_OWNER_VOCABULARY;
  /** Whom a word names as owner ("Klarna" in "Klarna's"); none for a contraction or any other word. */
  const possessorOf = (token: string): string | undefined => {
    const possessor = vocabulary.possessive.exec(token)?.[1];
    return possessor !== undefined && !vocabulary.contraction.test(possessor) ? possessor : undefined;
  };
  /** The words of one name, read away from the document: capitalized words, joined by & or +. */
  const nameRun = (tokens: readonly string[]): string[] => {
    const run: string[] = [];
    for (const token of tokens) {
      const joins = vocabulary.joiner.test(token) && run.length > 0;
      if (!joins && (!vocabulary.name.test(token) || vocabulary.notName.test(token))) break;
      run.push(token);
    }
    while (run.length && vocabulary.joiner.test(run[run.length - 1])) run.pop();
    return run;
  };
  /** A run's name without the words describing the document, or none when nothing else is left. */
  const named = (run: readonly string[]): string | undefined => {
    const name = run.filter((token) => !vocabulary.descriptor.test(token));
    return name.some((token) => !vocabulary.joiner.test(token)) ? name.join(' ') : undefined;
  };
  const owners: string[] = [];
  for (const match of words.matchAll(termsDocuments)) {
    const back = wordsOf(words.slice(0, match.index).split(vocabulary.clauseEnd).at(-1) ?? '').reverse();
    const ahead = wordsOf(words.slice(match.index + match[0].length).split(vocabulary.clauseEnd)[0] ?? '');
    // A possessive or another's pronoun within three words before it, else a name directly before it.
    const near = back
      .slice(0, 3)
      .findIndex((token) => vocabulary.otherPronoun.test(token) || possessorOf(token) !== undefined);
    const possessor = near === -1 ? undefined : possessorOf(back[near]);
    if (near === -1) {
      const before = named(nameRun(back).reverse());
      if (before !== undefined) owners.push(before);
    } else if (possessor === undefined) owners.push('');
    else if (!vocabulary.selfNoun.test(possessor)) {
      const name = nameRun([possessor, ...back.slice(near + 1)]).reverse();
      owners.push(name.length ? name.join(' ') : possessor);
    }
    // A name after "of".
    if (ahead[0]?.toLowerCase() !== 'of') continue;
    const after = vocabulary.determiner.test(ahead[1] ?? '') ? ahead.slice(2) : ahead.slice(1);
    if (vocabulary.otherPronoun.test(after[0] ?? '')) owners.push('');
    else if (!vocabulary.selfPronoun.test(after[0] ?? '') && !vocabulary.selfNoun.test(after[0] ?? '')) {
      const name = named(nameRun(after));
      if (name !== undefined) owners.push(name);
    }
  }
  return owners;
}

/** Whether a party a wording names is the site: its name, legal form aside, is the site's own name. */
function siteNamed(owner: string, site: string): boolean {
  const own = getDomainWithoutSuffix(site, { allowPrivateDomains: true });
  if (!own || !owner) return false;
  const { legalForm, joiner } = TERMS_OWNER_VOCABULARY;
  const squash = (text: string): string => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');
  const words = owner.split(' ').map((token) => token.replace(/\.$/u, ''));
  const name = [...words];
  while (name.length > 1 && [legalForm, joiner].some((form) => form.test(name.at(-1) ?? ''))) name.pop();
  return [words, name]
    .flatMap((form) => [form.join(' '), form.join(' ').replace(/[&+]/gu, ' and ')])
    .some((form) => squash(form) === squash(own));
}

/** A registrable domain, as the principal sees a site; a host with none, such as an address, is itself. */
function registrableSite(hostname: string): string {
  return getDomain(hostname, { allowPrivateDomains: true }) ?? hostname;
}

/** The site a link leads to, or none for a link that leads to no site (a script or a mail address). */
function linkedSite(link: string): string | undefined {
  try {
    const url = new URL(link);
    return url.protocol === 'http:' || url.protocol === 'https:' ? registrableSite(url.hostname) : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}

/** Where a choice is read: the page's site, and the addresses its wording, question and description link to. */
export interface ConsentPlace {
  /** The site the page belongs to, whatever frame holds the choice (KTD7). */
  readonly site: string;
  readonly links: readonly string[];
}

/**
 * Whether terms are the site's own (R15): every party the wording names is the site, and every link in the
 * wording or its description stays on the site. Read with no site, any named party is another's.
 */
function siteOwnTerms(words: string, place: ConsentPlace | undefined): boolean {
  const site = place?.site ?? '';
  return (
    termsOwners(words).every((owner) => siteNamed(owner, site)) &&
    (place?.links ?? []).every((link) => {
      const linked = linkedSite(link);
      return linked === undefined || linked === site;
    })
  );
}

function negations(label: string): number {
  return [...label.replace(/\bno[\s-]?shows?\b/giu, 'noshow').matchAll(CONSENT_VOCABULARY.negation)].length;
}

/**
 * What a box's wording asks, read for its meaning (KTD11). The order decides the most binding reading first:
 * a double negative or a box bundling the site's terms with anything else cannot be read safely, an agreement
 * outranks an extra, an extra outranks marketing, and a box with no consent vocabulary is functional. Terms
 * that name or link to another party than the site the page belongs to are an agreement.
 */
export function classifyConsentLabel(label: string, place?: ConsentPlace): ConsentLabelKind {
  const words = readable(label);
  const vocabulary = CONSENT_VOCABULARY;
  const terms = siteTerms.test(words);
  const marketing = vocabulary.marketing.test(words) || vocabulary.sharing.test(words);
  const priced = vocabulary.amount.test(words);
  const binding =
    vocabulary.waiver.test(words) ||
    vocabulary.attestation.test(words) ||
    (vocabulary.acknowledges.test(words) && (vocabulary.fee.test(words) || priced));
  const money =
    priced ||
    vocabulary.addOn.test(words) ||
    (!marketing && moneyTerms.test(words.replace(vocabulary.billingDetails, ' ')));
  const consenting = vocabulary.consents.test(words);
  if (!terms && !marketing && !money && !binding && !consenting) return 'functional';
  const negated = negations(words);
  if (negated >= 2 || (terms && negated > 0) || (money && !binding && negated > 0)) return 'double_negative';
  if (terms) {
    if (binding || marketing || money || !termsConsentLabel(words)) return 'bundled';
    return siteOwnTerms(words, place) ? 'terms' : 'agreement';
  }
  if (binding) return 'agreement';
  if (money) return 'add_on';
  if (marketing) return negated ? 'opt_out' : 'marketing';
  return 'agreement';
}

/** What a group of options asks, from its question, or from its options' own wording when the question says nothing. */
function classifyGroup(question: string, options: readonly string[], place?: ConsentPlace): ConsentLabelKind {
  const asked = classifyConsentLabel(question, place);
  const kinds =
    asked === 'functional'
      ? options.map((option) => {
          const kind = classifyConsentLabel(option, place);
          return kind === 'add_on' && !CONSENT_VOCABULARY.donation.test(readable(option)) ? 'functional' : kind;
        })
      : [asked === 'add_on' && !CONSENT_VOCABULARY.donation.test(readable(question)) ? 'functional' : asked];
  const order: readonly ConsentLabelKind[] = [
    'double_negative',
    'bundled',
    'agreement',
    'terms',
    'marketing',
    'opt_out',
    'add_on',
  ];
  return order.find((kind) => kinds.includes(kind)) ?? 'functional';
}

/** Whether a click on this choice is the consent engine's to make: any choice but a functional one (KTD1 step 4). */
export function consentClassChoice(choice: ToggledChoice): boolean {
  switch (choice.kind) {
    case 'checkbox':
    case 'switch':
      return classifyConsentLabel(choice.label) !== 'functional';
    case 'radio':
      return classifyGroup(choice.group ?? '', [choice.label]) !== 'functional';
    case 'select':
      return classifyGroup(choice.label, choice.options ?? []) !== 'functional';
  }
}

// ---------------------------------------------------------------- what the engine decides for a form

export interface ConsentOption {
  readonly label: string;
  readonly selected: boolean;
}
/** One choice in the form, as the isolated world reads it. */
export interface ConsentChoice {
  readonly id: number;
  readonly kind: ToggledChoice['kind'];
  /** A box's or switch's wording, a radio option's, or a select's question. */
  readonly label: string;
  /** A radio option's question. */
  readonly group?: string;
  /** The radio group the option answers with its siblings. */
  readonly name?: string;
  /** The addresses its wording, question and description link to. */
  readonly links: readonly string[];
  readonly checked: boolean;
  readonly required: boolean;
  readonly disabled: boolean;
  /** A select's options. */
  readonly options?: readonly ConsentOption[];
}
/** A choice to set: a box, switch or radio option to this state, or a select to this option. */
export type ConsentSetting =
  | { readonly id: number; readonly checked: boolean }
  | { readonly id: number; readonly option: number };
/** Wording only the principal can agree to, and the choice that agreeing ticks. */
export interface ConsentItem {
  readonly id: number;
  readonly wording: string;
  readonly kind: ConsentLabelKind;
}
export type ConsentDecision =
  | {
      readonly status: 'ready';
      readonly set: ConsentSetting[];
      /** Inside a purchase: every agreement the submission carries, approved or awaiting the card. */
      readonly agreements: string[];
      /** Inside a purchase: the paid extras the submission carries. */
      readonly addOns: string[];
    }
  | { readonly status: 'consent_required'; readonly items: ConsentItem[] }
  | { readonly status: 'add_on'; readonly addOns: string[] };
export interface ConsentContext {
  /** The wordings the principal agreed to on this site and frame origin. */
  readonly granted: ReadonlySet<string>;
  /**
   * The site the page belongs to, its top document's registrable domain: the only party whose own terms a box may
   * accept, even inside another party's frame (R15, KTD7).
   */
  readonly site: string;
  readonly purchase: boolean;
  /** Choices the host already set that did not hold. */
  readonly kept?: ReadonlySet<number>;
}

/** The one option a test picks out, or undefined when none or several do. */
function single(options: readonly ConsentOption[], test: (option: ConsentOption) => boolean): number | undefined {
  const matching = options.flatMap((option, index) => (test(option) ? [index] : []));
  return matching.length === 1 ? matching[0] : undefined;
}
const declines = (option: ConsentOption): boolean =>
  CONSENT_VOCABULARY.declines.test(readable(option.label)) || classifyConsentLabel(option.label) === 'opt_out';
const affirms = (option: ConsentOption): boolean => CONSENT_VOCABULARY.affirms.test(readable(option.label));

/** What the engine does with each choice in a form (KTD11), given the principal's grants. */
export function decideConsent(choices: readonly ConsentChoice[], context: ConsentContext): ConsentDecision {
  const set: ConsentSetting[] = [];
  const items: ConsentItem[] = [];
  const agreements: string[] = [];
  const addOns: string[] = [];
  const held = (id: number, disabled: boolean): boolean => disabled || context.kept?.has(id) === true;
  /** Wording that needs the principal: a stop, or inside a purchase a line on the card. */
  const ask = (item: ConsentItem): void => {
    if (context.purchase) agreements.push(item.wording);
    else items.push(item);
  };
  const agreed = (wording: string): void => {
    if (context.purchase) agreements.push(wording);
  };
  const { site } = context;
  const decidedGroups = new Set<string>();
  for (const choice of choices) {
    if (choice.kind === 'checkbox' || choice.kind === 'switch') {
      const kind = classifyConsentLabel(choice.label, { site, links: choice.links });
      const wording = normalizeConsentWording(choice.label);
      const granted = context.granted.has(wording);
      let want: boolean;
      switch (kind) {
        case 'functional':
          continue;
        case 'terms':
        case 'opt_out':
          want = true;
          break;
        case 'add_on':
          want = choice.required;
          if (want) addOns.push(wording);
          break;
        case 'marketing':
          if (choice.required && !granted) {
            ask({ id: choice.id, wording, kind });
            continue;
          }
          want = granted;
          if (granted) agreed(wording);
          break;
        case 'agreement':
        case 'bundled':
        case 'double_negative':
          if (!granted) {
            ask({ id: choice.id, wording, kind });
            continue;
          }
          want = true;
          agreed(wording);
          break;
      }
      if (choice.checked === want) continue;
      if (!held(choice.id, choice.disabled)) set.push({ id: choice.id, checked: want });
      // A choice the host cannot set: an extra the site keeps is a charge, and an opt-in it keeps an agreement.
      else if (kind === 'add_on') addOns.push(wording);
      else if (kind === 'marketing' || kind === 'opt_out') ask({ id: choice.id, wording, kind });
      continue;
    }
    const group =
      choice.kind === 'radio'
        ? choices.filter(
            (other) => other.kind === 'radio' && (other.name ?? `#${other.id}`) === (choice.name ?? `#${choice.id}`),
          )
        : [choice];
    const key = choice.kind === 'radio' ? `radio:${choice.name ?? `#${choice.id}`}` : `select:${choice.id}`;
    if (decidedGroups.has(key)) continue;
    decidedGroups.add(key);
    const question = choice.kind === 'radio' ? (choice.group ?? '') : choice.label;
    const options: readonly ConsentOption[] =
      choice.kind === 'radio'
        ? group.map((option) => ({ label: option.label, selected: option.checked }))
        : (choice.options ?? []);
    const kind = classifyGroup(
      question,
      options.map((option) => option.label),
      { site, links: group.flatMap((option) => option.links) },
    );
    if (kind === 'functional') continue;
    const affirming = single(options, affirms);
    const wording = normalizeConsentWording(question) || normalizeConsentWording(options[affirming ?? 0]?.label ?? '');
    const selected = options.findIndex((option) => option.selected);
    const required = group.some((option) => option.required);
    const granted = context.granted.has(wording);
    let target: number | undefined;
    switch (kind) {
      case 'terms':
        target = affirming;
        break;
      case 'marketing':
      case 'opt_out':
      case 'add_on':
        if (kind !== 'add_on' && granted && affirming !== undefined) {
          target = affirming;
          agreed(wording);
          break;
        }
        // A question asked the other way round ("Do you NOT want offers?") opts out with its Yes.
        target = classifyConsentLabel(question) === 'opt_out' ? affirming : single(options, declines);
        if (target === undefined && selected !== -1) {
          if (kind === 'add_on') addOns.push(normalizeConsentWording(options[selected].label));
          else ask({ id: choice.id, wording, kind });
          continue;
        }
        if (target === undefined && required && kind !== 'add_on') {
          ask({ id: choice.id, wording, kind });
          continue;
        }
        break;
      case 'agreement':
      case 'bundled':
      case 'double_negative':
        if (!granted || affirming === undefined) {
          ask({ id: choice.id, wording, kind });
          continue;
        }
        target = affirming;
        agreed(wording);
        break;
    }
    if (target === undefined || target === selected) continue;
    const id = choice.kind === 'radio' ? group[target].id : choice.id;
    if (
      !held(
        id,
        group.some((option) => option.disabled),
      )
    )
      set.push(choice.kind === 'radio' ? { id, checked: true } : { id, option: target });
    else if (kind === 'add_on') addOns.push(normalizeConsentWording(options[selected]?.label ?? wording));
    else if (kind !== 'terms') ask({ id, wording, kind });
  }
  if (!context.purchase) {
    if (items.length) return { status: 'consent_required', items };
    if (addOns.length) return { status: 'add_on', addOns };
  }
  return { status: 'ready', set, agreements, addOns };
}

// ---------------------------------------------------------------- reading the form in an isolated world

const WORLD = 'gws-ea-consent';
const LIBRARY = '__gwsEaConsent';
/** How long the page has to undo a choice before the host reads it again. */
const SETTLE_MS = 200;
const PRESS_TIMEOUT_MS = 2_000;

/**
 * The isolated-world half: plain JavaScript holding the choice reader, the region rule the classifier reads
 * (control-facts), the exact-node handoff in both directions, and where a press lands on a box or its label.
 */
const librarySource = String.raw`(() => {
  ${CHOICE_SOURCE}
  const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name).get;
  const formElements = (form) => Array.from(getter(HTMLFormElement, 'elements').call(form));
  const associated = [HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFieldSetElement,
    HTMLOutputElement, HTMLObjectElement];
  const formOf = (node) => {
    const type = associated.find((candidate) => node instanceof candidate);
    if (type) return getter(type, 'form').call(node);
    for (let current = node; current; current = choiceParent(current)) if (current instanceof HTMLFormElement) return current;
    return null;
  };
  const isField = (element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement;
  const editable = (element) => element instanceof HTMLElement && element.isContentEditable &&
    !(choiceParent(element) instanceof HTMLElement && choiceParent(element).isContentEditable);
  const BUTTON = 'button,input[type="submit" i],input[type="button" i],input[type="image" i],[role="button" i]';
  const pressable = (element) => element.matches(BUTTON) ||
    (element instanceof HTMLAnchorElement && (element.getAttribute('href') || '').trim().startsWith('#'));
  const dialogOf = (node) => {
    for (let current = node; current; current = choiceParent(current)) {
      const dialog = current instanceof HTMLDialogElement ? current.open : /^(?:alert)?dialog$/u.test(choiceRole(current));
      if (dialog && choiceShown(current)) return current;
    }
    return null;
  };
  // The classifier's region for a control: its form, or the nearest element grouping a formless control with
  // what it presses (a field for a button, a control to press for a field), bounded by an open dialog.
  const regionOf = (node) => {
    const form = formOf(node);
    if (form) return { form, members: [...new Set([...choiceDescendants(form), ...formElements(form)])] };
    const limit = dialogOf(node) || document.body || document.documentElement;
    const entry = isField(node) || editable(node);
    let region = limit;
    for (let current = choiceParent(node); current; current = choiceParent(current)) {
      if (choiceDescendants(current).some((element) => element !== node &&
        (entry ? pressable(element) : isField(element) || editable(element)))) {
        region = current;
        break;
      }
      if (current === limit) break;
    }
    const members = [region];
    const visit = (element) => {
      for (const child of choiceChildren(element))
        if (!(child instanceof HTMLFormElement)) {
          members.push(child);
          visit(child);
        }
    };
    visit(region);
    return { form: null, members };
  };
  // The exact-node handoff: each handed node, in the order the host handed it.
  const slots = new Map();
  const arm = (eventName) => {
    const slot = { nodes: [], roots: [document] };
    for (let index = 0; index < slot.roots.length; index++)
      for (const element of slot.roots[index].querySelectorAll('*')) if (element.shadowRoot) slot.roots.push(element.shadowRoot);
    slot.listener = (event) => { slot.nodes.push(event.target); };
    for (const root of slot.roots) root.addEventListener(eventName, slot.listener, true);
    slots.set(eventName, slot);
    return true;
  };
  const disarm = (eventName) => {
    const slot = slots.get(eventName);
    if (slot) for (const root of slot.roots) root.removeEventListener(eventName, slot.listener, true);
    return slots.delete(eventName);
  };
  const received = (eventName) => (slots.has(eventName) ? slots.get(eventName).nodes.length : 0);
  let choices = [];
  // What narrows the host's search for a choice's handle; the handed node is checked here, never trusted by itself.
  const hint = (choice) => ({
    element: choice instanceof HTMLInputElement ? 'input' : choice instanceof HTMLSelectElement ? 'select' : 'role',
    id: choice.id || '',
    name: choice.getAttribute('name') || '',
    role: choiceRole(choice),
  });
  const read = (controlEvent) => {
    const control = slots.get(controlEvent);
    if (!control || control.nodes.length !== 1 || !control.nodes[0].isConnected) return null;
    const { form, members } = regionOf(control.nodes[0]);
    choices = members.filter((element) => choiceKind(element));
    const groupName = (choice) => {
      const group = choiceMembers(choice);
      return choice instanceof HTMLInputElement && choice.name ? 'name:' + choice.name : 'group:' + choices.indexOf(group[0]);
    };
    return {
      origin: location.origin,
      form: form ? { action: getter(HTMLFormElement, 'action').call(form), method: getter(HTMLFormElement, 'method').call(form) } : null,
      fields: (form ? formElements(form) : members.filter(isField)).map((field) => ({ name: field.name || '', type: field.type || '' })),
      choices: choices.map((choice, id) => {
        const kind = choiceKind(choice);
        const group = kind === 'radio' ? choiceMembers(choice) : [choice];
        return {
          id,
          kind,
          label: choiceLabel(choice),
          links: choiceLinks(choice),
          ...(kind === 'radio' ? { group: choiceGroup(choice), name: groupName(choice) } : {}),
          ...(kind === 'select' ? { options: Array.from(choice.options, (option) => ({
            label: choiceSquash(option.label || option.text), selected: option.selected })) } : {}),
          checked: choice instanceof HTMLInputElement ? choice.checked : kind !== 'select' && choice.getAttribute('aria-checked') === 'true',
          required: group.some((member) => member.required === true || member.getAttribute('aria-required') === 'true'),
          disabled: choice.matches(':disabled') || choice.getAttribute('aria-disabled') === 'true',
          hint: hint(choice),
        };
      }),
    };
  };
  // Which handed nodes are the choice and which its labels, in the order the host handed them.
  const identify = (eventName, choiceId) => {
    const slot = slots.get(eventName);
    const choice = choices[choiceId];
    if (!slot || !choice) return null;
    const labels = choice.labels ? Array.from(choice.labels) : [];
    return slot.nodes.map((node) => (node === choice ? 'choice' : labels.includes(node) ? 'label' : 'other'));
  };
  const handedNode = (eventName, index) => {
    const slot = slots.get(eventName);
    const node = slot && slot.nodes[index];
    return node && node.isConnected ? node : null;
  };
  const hit = (x, y) => {
    let element = document.elementFromPoint(x, y);
    while (element && element.shadowRoot) {
      const inner = element.shadowRoot.elementFromPoint(x, y);
      if (!inner || inner === element) break;
      element = inner;
    }
    return element;
  };
  // Whether a handed node shows a box a press could land on.
  const shown = (eventName, index) => {
    const target = handedNode(eventName, index);
    if (!target || !choiceShown(target)) return false;
    const box = target.getBoundingClientRect();
    return box.width >= 1 && box.height >= 1;
  };
  // Where a press on the handed target lands on it and toggles exactly this choice, and nothing else that acts.
  const point = (eventName, index, choiceId) => {
    const choice = choices[choiceId];
    const target = handedNode(eventName, index);
    if (!choice || !target) return null;
    const box = target.getBoundingClientRect();
    if (box.width < 1 || box.height < 1) return null;
    for (const [fx, fy] of [[0.5, 0.5], [0.1, 0.5], [0.9, 0.5], [0.5, 0.2], [0.5, 0.8], [0.03, 0.5]]) {
      const landed = hit(box.left + box.width * fx, box.top + box.height * fy);
      if (!landed || !choiceWithin(target, landed) || toggledBy(landed) !== choice) continue;
      let acts = false;
      for (let current = landed; current && current !== target; current = choiceParent(current))
        if (current !== choice && (choicePresses(current) || choiceKind(current))) acts = true;
      if (!acts) return { x: box.width * fx, y: box.height * fy };
    }
    return null;
  };
  return { arm, disarm, received, read, identify, shown, point };
})()`;

const READER: IsolatedReader = { world: WORLD, global: LIBRARY, source: librarySource };

/** What narrows the host's search for a choice's handle: its element, and its id, name and role. */
interface ChoiceHint {
  readonly element: 'input' | 'select' | 'role';
  readonly id: string;
  readonly name: string;
  readonly role: string;
}
interface ConsentRead {
  readonly origin: string;
  readonly form: { readonly action: string; readonly method: string } | null;
  readonly fields: ReadonlyArray<{ readonly name: string; readonly type: string }>;
  readonly choices: ReadonlyArray<ConsentChoice & { readonly hint: ChoiceHint }>;
}

const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);
const integer = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isInteger(value) ? value : undefined;
const KINDS: ReadonlySet<unknown> = new Set(['checkbox', 'switch', 'radio', 'select']);
const HINT_ELEMENTS: ReadonlySet<unknown> = new Set(['input', 'select', 'role']);

function parseHint(value: unknown): ChoiceHint | undefined {
  const hint = record(value);
  const id = text(hint?.id);
  const name = text(hint?.name);
  const role = text(hint?.role);
  if (!hint || !HINT_ELEMENTS.has(hint.element) || id === undefined || name === undefined || role === undefined)
    return undefined;
  return { element: hint.element as ChoiceHint['element'], id, name, role };
}

/** The read as the world returned it; anything malformed is no read at all. */
function parseRead(value: unknown): ConsentRead | undefined {
  const read = record(value);
  const origin = text(read?.origin);
  if (!read || !origin || !Array.isArray(read.fields) || !Array.isArray(read.choices)) return undefined;
  const form = read.form === null ? null : record(read.form);
  const action = text(form?.action);
  const method = text(form?.method);
  if (form !== null && (action === undefined || method === undefined)) return undefined;
  const fields = read.fields.map((raw) => {
    const field = record(raw);
    const name = text(field?.name);
    const type = text(field?.type);
    return name === undefined || type === undefined ? undefined : { name, type };
  });
  const choices = read.choices.map((raw) => {
    const choice = record(raw);
    const id = integer(choice?.id);
    const label = text(choice?.label);
    const links: unknown = choice?.links;
    const linkList = Array.isArray(links) ? links.map((link: unknown) => text(link)) : undefined;
    const hint = parseHint(choice?.hint);
    if (
      !choice ||
      id === undefined ||
      !KINDS.has(choice.kind) ||
      label === undefined ||
      !linkList ||
      linkList.some((link) => link === undefined) ||
      !hint ||
      typeof choice.checked !== 'boolean' ||
      typeof choice.required !== 'boolean' ||
      typeof choice.disabled !== 'boolean'
    )
      return undefined;
    const group = text(choice.group);
    const name = text(choice.name);
    const options = Array.isArray(choice.options)
      ? choice.options.map((rawOption) => {
          const option = record(rawOption);
          const optionLabel = text(option?.label);
          return optionLabel === undefined || typeof option?.selected !== 'boolean'
            ? undefined
            : { label: optionLabel, selected: option.selected };
        })
      : undefined;
    if (options?.some((option) => option === undefined)) return undefined;
    return {
      id,
      kind: choice.kind as ConsentChoice['kind'],
      label,
      links: linkList.filter((link) => link !== undefined),
      ...(group !== undefined ? { group } : {}),
      ...(name !== undefined ? { name } : {}),
      checked: choice.checked,
      required: choice.required,
      disabled: choice.disabled,
      ...(options ? { options: options.filter((option) => option !== undefined) } : {}),
      hint,
    };
  });
  if (fields.some((field) => field === undefined) || choices.some((choice) => choice === undefined)) return undefined;
  return {
    origin,
    form: form === null || action === undefined || method === undefined ? null : { action, method },
    fields: fields.filter((field) => field !== undefined),
    choices: choices.filter((choice) => choice !== undefined),
  };
}

/** One read of the form, and the isolated world it was read in, for setting its choices. */
interface ConsentRound {
  readonly read: ConsentRead;
  readonly frame: Frame;
  call(expression: string): Promise<unknown>;
  /** Hands the exact node into the world under `eventName`. */
  hand(element: ElementHandle, eventName: string): Promise<void>;
  close(): Promise<void>;
}

/**
 * Hands the control into a fresh isolated world of each frame its session hosts, keeps the one world that
 * received it, and reads the control's form there. Any part that cannot complete fails the read; nothing is
 * guessed.
 */
async function readRound(page: Page, control: ElementHandle): Promise<ConsentRound> {
  const selector = isolationSelector(page.context());
  const frame = await control.ownerFrame();
  if (!selector || !frame || frame.page() !== page) throw new ControlFactsUnavailableError();
  const name = await selector;
  // The CDP session of the frame's own target, or of the nearest ancestor an in-process frame shares.
  const attached = await attachFrameTarget(frame, PROTOCOL_READ_TIMEOUT_MS);
  if (!attached) throw new ControlFactsUnavailableError();
  const { session } = attached;
  const close = async (): Promise<void> => {
    await session.detach().catch(() => undefined);
  };
  try {
    const { frameTree } = await bounded(session.send('Page.getFrameTree'));
    const contexts: number[] = [];
    for (const { id } of frameTreeFrames(frameTree)) {
      try {
        const contextId = await installReader(session, id, READER);
        if (contextId === undefined) throw new ControlFactsUnavailableError();
        contexts.push(contextId);
      } catch (error) {
        if (!frameGone(error)) throw error;
      }
    }
    const callIn = async (contextId: number, expression: string): Promise<unknown> => {
      const answer = await bounded(
        session.send('Runtime.evaluate', {
          contextId,
          expression: `globalThis.${LIBRARY}.${expression}`,
          returnByValue: true,
        }),
      );
      if (answer.exceptionDetails) throw new ControlFactsUnavailableError();
      const value: unknown = answer.result.value;
      return value;
    };
    const hand = async (element: ElementHandle, eventName: string): Promise<void> => {
      const handed = await element.$(`${name}=${eventName}`);
      await handed?.dispose();
    };
    const controlEvent = `gws-ea-auth-${randomUUID()}`;
    for (const contextId of contexts) await callIn(contextId, `arm(${JSON.stringify(controlEvent)})`);
    await hand(control, controlEvent);
    const counts = await Promise.all(
      contexts.map((contextId) => callIn(contextId, `received(${JSON.stringify(controlEvent)})`)),
    );
    const holding = contexts.filter((_contextId, index) => counts[index] !== 0);
    if (holding.length !== 1 || counts[contexts.indexOf(holding[0])] !== 1) throw new ControlFactsUnavailableError();
    const [world] = holding;
    const read = parseRead(await callIn(world, `read(${JSON.stringify(controlEvent)})`));
    for (const contextId of contexts) await callIn(contextId, `disarm(${JSON.stringify(controlEvent)})`);
    if (!read) throw new ControlFactsUnavailableError();
    return { read, frame, call: (expression) => callIn(world, expression), hand, close };
  } catch (_error) {
    await close();
    // A form that cannot be read whole is never guessed at.
    throw new ControlFactsUnavailableError();
  }
}

/** A page-supplied value as a quoted CSS string. */
const cssString = (value: string): string => `"${value.replace(/[\\"]/gu, '\\$&').replace(/\n/gu, '\\a ')}"`;

/** Where the choice may be in the frame: a few candidates the isolated world then checks one by one. */
function candidates(hint: ChoiceHint): string {
  if (hint.id) return `[id=${cssString(hint.id)}]`;
  if (hint.element === 'role') return `[role=${cssString(hint.role)}]`;
  const element = hint.element === 'select' ? 'select' : 'input';
  return hint.name
    ? `${element}[name=${cssString(hint.name)}]`
    : hint.element === 'select'
      ? 'select'
      : 'input[type="checkbox" i], input[type="radio" i]';
}

/**
 * Handles for one choice and its labels, found by the choice's hint and each confirmed in the isolated world as
 * that choice or one of its labels; anything else found is set aside.
 */
async function choiceHandles(
  round: ConsentRound,
  choice: ConsentRead['choices'][number],
): Promise<{
  eventName: string;
  targets: Array<{ handle: ElementHandle; index: number; role: 'choice' | 'label' }>;
  dispose(): Promise<void>;
}> {
  const found = await round.frame.$$(candidates(choice.hint));
  const labels = [
    ...(choice.hint.id ? await round.frame.$$(`label[for=${cssString(choice.hint.id)}]`) : []),
    ...(await Promise.all(found.map((handle) => handle.$$('xpath=ancestor::label')))).flat(),
  ];
  const handles = [...found, ...labels];
  const eventName = `gws-ea-auth-${randomUUID()}`;
  const dispose = async (): Promise<void> => {
    await round.call(`disarm(${JSON.stringify(eventName)})`).catch(() => undefined);
    await Promise.all(handles.map((handle) => handle.dispose().catch(() => undefined)));
  };
  await round.call(`arm(${JSON.stringify(eventName)})`);
  for (const handle of handles) await round.hand(handle, eventName);
  const roles: unknown = await round.call(`identify(${JSON.stringify(eventName)}, ${choice.id})`);
  const targets: Array<{ handle: ElementHandle; index: number; role: 'choice' | 'label' }> = [];
  if (Array.isArray(roles) && roles.length === handles.length)
    handles.forEach((handle, index) => {
      const role: unknown = roles[index];
      if (role === 'choice' || role === 'label') targets.push({ handle, index, role });
    });
  // The choice itself first, then its labels; one node handed twice is pressed once.
  const unique = targets.filter(
    (target, position) => targets.findIndex((other) => other.index === target.index) === position,
  );
  unique.sort((left, right) => (left.role === right.role ? 0 : left.role === 'choice' ? -1 : 1));
  return { eventName, targets: unique, dispose };
}

/**
 * Sets one choice as a person would: a real click on the box when the press lands on it, else on one of its
 * labels where the press toggles it and nothing else; a select by its option. A press that cannot land leaves
 * the choice as it was, for the next read to report.
 */
async function setChoice(round: ConsentRound, setting: ConsentSetting): Promise<void> {
  const choice = round.read.choices[setting.id];
  if (!choice) return;
  const { eventName, targets, dispose } = await choiceHandles(round, choice);
  try {
    if ('option' in setting) {
      const select = targets.find((target) => target.role === 'choice');
      if (select)
        await select.handle
          .selectOption({ index: setting.option }, { timeout: PRESS_TIMEOUT_MS })
          .catch(() => undefined);
      return;
    }
    for (const target of targets) {
      // A box hidden behind its styled label cannot be pressed; its label still can.
      if ((await round.call(`shown(${JSON.stringify(eventName)}, ${target.index})`)) !== true) continue;
      const scrolled = await target.handle
        .scrollIntoViewIfNeeded({ timeout: PRESS_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      const position = scrolled
        ? record(await round.call(`point(${JSON.stringify(eventName)}, ${target.index}, ${choice.id})`))
        : undefined;
      if (typeof position?.x !== 'number' || typeof position.y !== 'number') continue;
      const pressed = await target.handle
        .click({ position: { x: position.x, y: position.y }, timeout: PRESS_TIMEOUT_MS })
        .then(() => true)
        .catch(() => false);
      if (pressed) return;
    }
  } finally {
    await dispose();
  }
}

// ---------------------------------------------------------------- the pass

/** An agreement a submission carries: its frame origin and exact wording, keyed with the site. */
export interface ConsentAgreement {
  readonly origin: string;
  readonly wording: string;
}
/** What the pass found that only the principal can agree to, with where it was found. */
export interface ConsentStopFacts {
  readonly site: string;
  readonly origin: string;
  readonly fingerprint: string;
  readonly items: readonly ConsentItem[];
}
/** A recorded stop, as the browser agent hears it: the id it asks the principal with, and what it names. */
export interface ConsentStopView {
  readonly stop_id: string | null;
  readonly site: string;
  readonly wording: string;
}
export type ConsentPassResult =
  | {
      readonly status: 'ready';
      /** Inside a purchase: the agreements the submission carries, for the card. */
      readonly agreements: readonly ConsentAgreement[];
      /** Inside a purchase: the paid extras the submission carries, for the card. */
      readonly addOns: readonly string[];
    }
  | { readonly status: 'consent_required'; readonly stops: readonly ConsentStopView[] }
  | { readonly status: 'add_on'; readonly addOns: readonly string[] };

/** The job a stop belongs to, and the database its stops and the principal's grants live in. */
export interface ConsentScope {
  readonly jobId: string;
  readonly db: DbDriver;
}
export interface ConsentPassOptions {
  /** Inside a purchase: agreements join the card instead of stopping, and kept extras join its facts. */
  readonly purchase?: boolean;
  /** Defaults to the job scope the page runs in. */
  readonly scope?: ConsentScope;
  readonly assertActive?: () => Promise<void>;
}

const scopes = new WeakMap<Page, ConsentScope>();

/** Runs a job's operation on its page, so every consent pass on that page records its stops for that job. */
export async function withConsentScope<T>(page: Page, scope: ConsentScope, operation: () => Promise<T>): Promise<T> {
  const previous = scopes.get(page);
  scopes.set(page, scope);
  try {
    return await operation();
  } finally {
    if (previous) scopes.set(page, previous);
    else scopes.delete(page);
  }
}

/** The site a page belongs to: its top document's registrable domain, as the principal sees it. */
function siteOf(page: Page): string {
  try {
    return registrableSite(new URL(page.mainFrame().url()).hostname);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    throw new ControlFactsUnavailableError();
  }
}

/** The form's shape, so a stop names the form it was found in: where it goes and what it holds. */
function fingerprint(read: ConsentRead): string {
  const shape = {
    origin: read.origin,
    action: read.form ? read.form.action.replace(/[?#].*$/u, '') : null,
    method: read.form?.method.toLowerCase() ?? null,
    fields: read.fields.map((field) => `${field.type}:${field.name}`).sort(),
  };
  return createHash('sha256').update(JSON.stringify(shape)).digest('hex');
}

/**
 * The one consent check before every submission (KTD11): reads the control's form, makes every choice the
 * engine owns with real clicks, waits for the page to settle and reads again, so what it answers is what the
 * page holds just before the press. `ready` lets the press go; outside a purchase, `consent_required` names
 * the recorded stops and `add_on` an extra the press would buy. Nothing is pressed here.
 */
export async function runConsentPass(
  page: Page,
  control: ElementHandle,
  options: ConsentPassOptions = {},
): Promise<ConsentPassResult> {
  const scope = options.scope ?? scopes.get(page);
  const purchase = options.purchase === true;
  const site = siteOf(page);
  const decide = async (round: ConsentRound, kept?: ReadonlySet<number>): Promise<ConsentDecision> =>
    decideConsent(round.read.choices, {
      granted: await liveConsentGrants(scope?.db ?? getDb(), site, round.read.origin),
      purchase,
      site,
      ...(kept ? { kept } : {}),
    });
  const answer = async (round: ConsentRound, decision: ConsentDecision): Promise<ConsentPassResult> => {
    switch (decision.status) {
      case 'ready':
        return {
          status: 'ready',
          agreements: decision.agreements.map((wording) => ({ origin: round.read.origin, wording })),
          addOns: decision.addOns,
        };
      case 'add_on':
        return decision;
      case 'consent_required':
        return {
          status: 'consent_required',
          stops: await recordConsentStops(scope, {
            site,
            origin: round.read.origin,
            fingerprint: fingerprint(round.read),
            items: decision.items,
          }),
        };
    }
  };
  const first = await readRound(page, control);
  try {
    const decision = await decide(first);
    if (decision.status !== 'ready' || !decision.set.length) return await answer(first, decision);
    for (const setting of decision.set) {
      await options.assertActive?.();
      await setChoice(first, setting);
    }
  } finally {
    await first.close();
  }
  await sleep(SETTLE_MS);
  await options.assertActive?.();
  const second = await readRound(page, control);
  try {
    const decision = await decide(second);
    if (decision.status !== 'ready' || !decision.set.length) return await answer(second, decision);
    // What the host set and the page undid is the page's own choice now: only the principal can keep it.
    return await answer(second, await decide(second, new Set(decision.set.map((setting) => setting.id))));
  } finally {
    await second.close();
  }
}

/** A submission stopped for wording only the principal can agree to (`consent_required`). */
export class BrowserConsentStop extends Error {
  readonly reason = 'consent_required';
  constructor(readonly stops: readonly ConsentStopView[]) {
    super('consent_required');
  }
}

// ---------------------------------------------------------------- stops and the principal's grants

const STOPS = 'gws_ea_browser_consent_stops';
const GRANTS = 'gws_ea_browser_consent_grants';

export interface ConsentStop {
  id: string;
  job_id: string;
  site: string;
  origin: string;
  wording: string;
  kind: 'marketing' | 'opt_out' | 'agreement' | 'bundled' | 'double_negative';
  form_fingerprint: string;
  status: 'open' | 'requested' | 'approved' | 'rejected' | 'expired' | 'withdrawn';
  approval_id: string | null;
  created_at: string;
  requested_at: string | null;
  decided_at: string | null;
}
export interface ConsentGrant {
  id: string;
  site: string;
  origin: string;
  wording: string;
  approval_id: string;
  principal_user_id: string;
  created_at: string;
  withdrawn_at: string | null;
}

/**
 * Records one stop per wording for the job, reusing an open one for the same form: the id the browser agent
 * asks the principal with. With no job, nothing can be asked, and the stop carries no id.
 */
export async function recordConsentStops(
  scope: ConsentScope | undefined,
  stop: ConsentStopFacts,
): Promise<ConsentStopView[]> {
  const views: ConsentStopView[] = [];
  for (const item of stop.items) {
    const kind = item.kind;
    if (
      kind !== 'marketing' &&
      kind !== 'opt_out' &&
      kind !== 'agreement' &&
      kind !== 'bundled' &&
      kind !== 'double_negative'
    )
      continue;
    if (!scope) {
      views.push({ stop_id: null, site: stop.site, wording: item.wording });
      continue;
    }
    const id = await scope.db.transaction(async () => {
      const open = await scope.db.get<{ id: string }>(
        `SELECT id FROM ${STOPS} WHERE job_id = ? AND site = ? AND origin = ? AND wording = ? AND form_fingerprint = ? AND status = 'open'`,
        scope.jobId,
        stop.site,
        stop.origin,
        item.wording,
        stop.fingerprint,
      );
      if (open) return open.id;
      const created = randomUUID();
      await scope.db.run(
        `INSERT INTO ${STOPS}(id,job_id,site,origin,wording,kind,form_fingerprint,status,created_at) VALUES(?,?,?,?,?,?,?,'open',?)`,
        created,
        scope.jobId,
        stop.site,
        stop.origin,
        item.wording,
        kind,
        stop.fingerprint,
        new Date().toISOString(),
      );
      return created;
    });
    views.push({ stop_id: id, site: stop.site, wording: item.wording });
  }
  return views;
}

export function getConsentStop(db: DbDriver, id: string): Promise<ConsentStop | undefined> {
  return db.get<ConsentStop>(`SELECT * FROM ${STOPS} WHERE id = ?`, id);
}

/** The wordings the principal agreed to on this site in this frame origin, none withdrawn. */
export async function liveConsentGrants(db: DbDriver, site: string, origin: string): Promise<Set<string>> {
  if (!(await db.hasTable(GRANTS))) return new Set();
  const rows = await db.all<{ wording: string }>(
    `SELECT wording FROM ${GRANTS} WHERE site = ? AND origin = ? AND withdrawn_at IS NULL`,
    site,
    origin,
  );
  return new Set(rows.map((row) => row.wording));
}

/** Whether every agreement a purchase carries stands approved on its site. */
export async function agreementsGranted(
  db: DbDriver,
  site: string,
  agreements: readonly ConsentAgreement[],
): Promise<boolean> {
  for (const agreement of agreements)
    if (!(await liveConsentGrants(db, site, agreement.origin)).has(agreement.wording)) return false;
  return true;
}

/**
 * The principal's standing agreement to one exact wording on one site and frame origin. Idempotent: a replayed
 * approval, or a wording already agreed, records nothing new.
 */
export async function recordConsentGrant(
  db: DbDriver,
  grant: { site: string; origin: string; wording: string; approvalId: string; principalUserId: string },
): Promise<void> {
  const id = `consent-${createHash('sha256')
    .update(`${grant.approvalId}\0${grant.site}\0${grant.origin}\0${grant.wording}`)
    .digest('hex')}`;
  await db.run(
    `INSERT INTO ${GRANTS}(id,site,origin,wording,approval_id,principal_user_id,created_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    id,
    grant.site,
    grant.origin,
    grant.wording,
    grant.approvalId,
    grant.principalUserId,
    new Date().toISOString(),
  );
}
