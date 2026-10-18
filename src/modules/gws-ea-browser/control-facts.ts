/**
 * What the host reads before it classifies an action: the control's facts and the page's transaction signal,
 * read in an isolated world in every frame, so page script cannot rewrite what the classifier sees.
 */
import { randomUUID } from 'node:crypto';
import type { CDPSession, ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';

import { SECRET_AUTOCOMPLETE, SECRET_DESCRIPTION } from './authentication-signatures.js';
import { isolationSelector } from './authentication-submit.js';
import {
  bounded,
  installReaders,
  openTargetSessions,
  PROTOCOL_READ_TIMEOUT_MS,
  type HostedFrame,
  type IsolatedReader,
} from './page-targets.js';

/** What the control's own form or dialog holds, read with the control. */
export interface ControlRegion {
  /** The control sits in an open dialog. */
  readonly dialog: boolean;
  /**
   * The control's form, or the open dialog around it, or for a control in neither its document outside every
   * form and dialog, shows a total or a charge together with a payment method.
   */
  readonly transaction: boolean;
  /** An open modal dialog around the control speaks of an order, a payment or an amount. */
  readonly modalOrder: boolean;
  /**
   * Free text rides with the control's press: a nonempty textarea or contenteditable in its form, or for a
   * formless control a nonempty textarea, contenteditable or non-search text input beside it.
   */
  readonly freeText: boolean;
  /** The region books or orders: it is a transaction, holds booking fields, or one of its controls names a commit. */
  readonly commits: boolean;
  /** The region holds email, phone, password or payment fields. */
  readonly accountFields: boolean;
  /**
   * The control's form holds a field for a password, a code or payment details: only the host's own sign-in and
   * credential paths submit such a form.
   */
  readonly secretFields: boolean;
}

/**
 * The choice a click would toggle (KTD1 step 4): a label's control, the choice inside a clicked label or styled
 * wrapper, or the nearest checkbox, switch or radio around the target; a select for a selection.
 */
export interface ToggledChoice {
  readonly kind: 'checkbox' | 'switch' | 'radio' | 'select';
  /** The choice's own wording as the page shows it: a box's label, a radio option's, a select's. */
  readonly label: string;
  /** A radio option's question: its group's legend or label. */
  readonly group?: string;
  /** A select's options, in order. */
  readonly options?: readonly string[];
}

/** The facts the classifier decides from. */
export interface ControlFacts {
  name: string;
  visibleLabel?: string;
  formMethod?: string;
  formAction?: string;
  authenticationForm?: boolean;
  role: string;
  tag: string;
  type: string;
  href: string | null;
  /** The control runs page script in place of navigating: a fragment link or an inline click handler. */
  scripted?: boolean;
  /** A form, open dialog or formless document in some frame shows a total or a charge together with a payment method. */
  transaction: boolean;
  /** Prices, recurring charges, trials or billing anywhere on the page, read by the host. */
  moneyTerms?: boolean;
  /** A fee, deposit, hold or penalty with an amount anywhere on the page. */
  feeTerms?: boolean;
  /** The control's document is a signed-in account page. */
  accountPage?: boolean;
  /** The control sits in a chat widget's frame. */
  chatFrame?: boolean;
  region?: ControlRegion;
  /** The choice the action would toggle, when it toggles one. */
  toggles?: ToggledChoice;
  /**
   * The control is a field for payment details (a card number, security code or expiry, by its own name, label or
   * autocomplete), or any field inside a processor's payment frame. Nothing is ever typed or chosen there (R12).
   */
  cardEntry?: boolean;
}

/** Prices, recurring charges, trials and billing, in a label or anywhere on a page. */
export const moneyTerms =
  /(?:[$€£¥]\s?\d|\b\d+(?:[.,]\d{1,2})?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\bper\s+(?:month|year|week|day)\b|\/\s?(?:mo|month|yr|year)\b|\b(?:subscriptions?|free\s+trial|trial\s+period|billing|billed|recurring|auto-?renew\w*|membership\s+fees?)\b)/iu;

/** Input types that take no typed or chosen text. */
const NO_TEXT_ENTRY = /^(?:hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/u;

/**
 * What the host recognizes in a page's text, fields and controls. Vocabulary is data: widen or narrow it
 * here, never by changing the order the classifier decides in.
 */
const PAGE_VOCABULARY = {
  moneyTerms,
  /** A total or an amount due now; a subtotal is not one. */
  total:
    /(?<!\bsub[\s-]?)\btotal\b|\bamount\s+(?:due|to\s+pay|payable)\b|\b(?:due|payable)\s+(?:now|today|at\s+(?:booking|checkout))\b|\bbalance\s+due\b|\byou(?:'ll|\s+will)?\s+pay\b/iu,
  /** A fee, deposit, hold or charge a press can commit to. */
  charge: /\b(?:fees?|charges?|deposits?|holds?|penalty|penalties|surcharges?|non-?refundable)\b/iu,
  amount:
    /(?:[$€£¥₹₩]|\b(?:usd|eur|gbp|cad|aud|nzd|jpy|chf|inr|mxn|sgd|hkd)\b)\s?\d|\d(?:[\d,.]*\d)?\s?(?:[€£¥]|\b(?:usd|eur|gbp|cad|aud|nzd|jpy|chf|inr|mxn|sgd|hkd)\b)/iu,
  /** A saved payment method as a page shows it: a card with its last four digits. */
  savedCard:
    /\b(?:visa|master\s?card|amex|american\s+express|discover|diners(?:\s+club)?|jcb|unionpay|maestro|card)\b.{0,24}?(?:ending(?:\s+in)?|ends\s+in|[•*·x]{2,}|\.{3,})\s*\d{4}\b|\bending\s+in\s+\d{4}\b|[•*·]{3,}\s?\d{4}\b/iu,
  /** A card-entry field, by its name, id or autocomplete token. */
  cardField:
    /(?:^|[^a-z])(?:cc-(?:number|csc|exp(?:-month|-year)?)|card.?(?:number|num|cvc|cvv)|cardnumber|cvc|cvv)(?:[^a-z]|$)/iu,
  /**
   * A field for payment details, by its name, id, autocomplete, label or placeholder: a card's number, holder,
   * security code or expiry. Wider than `cardField`, which proves a payment method is on the page.
   */
  cardEntry:
    /(?:^|[^a-z])(?:cc-[a-z-]+|card.?(?:number|num|no|holder|cvc|cvv|csc|code|security|expir\w*|exp)|cardnumber|(?:credit|debit).?card|cvc|cvv2?|csc|exp-?date|mm\s*\/\s*yy)(?:[^a-z]|$)/iu,
  /** A gift card's or voucher's code, which a checkout applies like a coupon: no card details. */
  giftCard: /gift|voucher/iu,
  /** Input types that take no typed or chosen text. */
  noTextEntry: NO_TEXT_ENTRY,
  /** What marks a field's value as a credential, code or payment secret (authentication-signatures owns these). */
  secretAutocomplete: SECRET_AUTOCOMPLETE,
  secretField: SECRET_DESCRIPTION,
  /** An express-pay button. Pay Later messaging is text, never a button, so it is no payment method. */
  expressPay:
    /\b(?:apple|google|shop|amazon|samsung)\s?pay\b|\bg\s?pay\b|\bpaypal\b|\bvenmo\b|\bklarna\b|\bafterpay\b|\baffirm\b|\bpay\s+with\s+link\b/iu,
  orderWords: /\b(?:orders?|purchase|payment|pay|charged?|booking|reservation|subscription|checkout)\b/iu,
  /** A control that commits a booking or an order, in whose form free text is a booking or order note. */
  commitName:
    /\b(?:buy|pay|purchase|order|checkout|check\s*out|reserve|reservation|book(?:ing)?|subscribe|donate|bid|register|rsvp|wait\s*list|waitlist|notify\s+me)\b/iu,
  bookingField:
    /(?:^|[^a-z])(?:party|guests?|covers|adults|children|kids|tickets?|quantity|qty|check.?in|check.?out|arrival|departure|nights|seats?)(?:[^a-z]|$)/iu,
  /** A lookup field: a formless one holds a query, never free text. */
  search:
    /search|query|(?:^|[^a-z])q(?:[^a-z]|$)|find|look.?up|keyword|zip|postal|post.?code|location|city|address|destination|where/iu,
  accountField:
    /(?:^|[^a-z])(?:e-?mail|phone|mobile|tel|password|passwd|card.?number|cardnumber|cvc|cvv)(?:[^a-z]|$)/iu,
  signOut: /^(?:sign|log)[\s-]?(?:out|off)\b|^logout$/iu,
  signOutRoute: /(?:log|sign)-?(?:out|off)(?:[/?#.]|$)/iu,
  accountHeading:
    /\b(?:account|profile|settings|preferences|security|personal\s+(?:info|information|details)|(?:login|sign.?in)\s*(?:&|and)\s*security)\b/iu,
  chatOwner: /\b(?:chat|messenger|messaging|live\s*chat|conversations?|support\s+widget)\b/iu,
} as const satisfies Record<string, RegExp>;

/** A saved payment method as a page shows it, and an express-pay button's name, as the classifier reads both. */
export const PAYMENT_VOCABULARY = {
  savedCard: PAGE_VOCABULARY.savedCard,
  expressPay: PAGE_VOCABULARY.expressPay,
} as const;

/**
 * Processor frames that take payment details or an express payment, by host and path. Metrics, messaging,
 * address and sign-in frames from the same processors are not payment methods.
 */
const PAYMENT_FRAME =
  /^(?:js\.stripe\.com\/v3\/elements-inner-(?![\w-]*(?:messag|address|authentication|affirm|afterpay|klarna))|checkout\.stripe\.com\/|[\w-]+\.adyen\.com\/checkoutshopper\/(?:securedfields|assets\/html)\/|assets\.braintreegateway\.com\/web\/[\w.-]+\/html\/hosted-fields-frame|(?:www\.)?paypal\.com\/smart\/(?:card-fields|buttons))/iu;
/**
 * Payment processors, by registrable domain or host: their APIs take a payment from page script, a payment
 * frame's included, and their own pages take a merchant's payment. Vocabulary is data: widen or narrow it here.
 */
const PAYMENT_PROCESSORS: readonly string[] = [
  'stripe.com',
  'stripe.network',
  'adyen.com',
  'adyenpayments.com',
  'braintreegateway.com',
  'braintree-api.com',
  'paypal.com',
  'squareup.com',
  'squareupsandbox.com',
  'checkout.com',
  'klarna.com',
  'klarnaservices.com',
  'affirm.com',
  'afterpay.com',
  'clearpay.co.uk',
  'authorize.net',
  'worldpay.com',
  'cybersource.com',
  'mollie.com',
  'razorpay.com',
  'shop.app',
  'pay.shopify.com',
  'pay.google.com',
  'payments.google.com',
  'pay.amazon.com',
  'payments.amazon.com',
  'pay-api.amazon.com',
];

/** Whether a host belongs to a payment processor. */
export function paymentProcessorHost(host: string): boolean {
  const name = host.toLowerCase();
  return PAYMENT_PROCESSORS.some((processor) => name === processor || name.endsWith(`.${processor}`));
}

/** Chat-widget providers, recognized for a child frame only. */
const CHAT_PROVIDERS: ReadonlySet<string> = new Set([
  'intercom.io',
  'intercomcdn.com',
  'zdassets.com',
  'zopim.com',
  'drift.com',
  'driftt.com',
  'livechatinc.com',
  'tawk.to',
  'crisp.chat',
  'olark.com',
  'freshchat.com',
  'gorgias.chat',
  'tidio.co',
  'tidiochat.com',
]);
/** A site's own account area. */
const ACCOUNT_PATH =
  /(?:^|\/)(?:account|accounts|my-?account|profile|settings|preferences|security|user|me|wallet|payment-?methods?)(?:[/.]|$)/iu;

/**
 * How an isolated world reads a choice, shared by the classifier's reader and the consent engine's
 * (consent.ts), so both read the same wording for the same box. Plain JavaScript statements: a choice's kind,
 * the choice a click toggles, its wording as the page shows it, and where that wording links. Visible text only;
 * a box with none is named by its accessible name, then its field name.
 */
export const CHOICE_SOURCE = String.raw`
  const choiceParent = (node) => (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement);
  const choiceSquash = (value) => (value || '').replace(/\s+/gu, ' ').trim();
  const choiceRole = (element) => (element.getAttribute('role') || '').trim().toLowerCase();
  const choiceChildren = (node) => [...(node.shadowRoot ? node.shadowRoot.children : []), ...node.children];
  const choiceDescendants = (root) => {
    const list = [];
    const visit = (node) => {
      for (const child of choiceChildren(node)) {
        list.push(child);
        visit(child);
      }
    };
    visit(root);
    return list;
  };
  const choiceWithin = (root, element) => {
    for (let current = element; current; current = choiceParent(current)) if (current === root) return true;
    return false;
  };
  // A checkbox, a switch, a radio option or a select; null for anything else.
  const choiceKind = (element) => {
    if (!(element instanceof Element)) return null;
    if (element instanceof HTMLInputElement) {
      if (element.type === 'checkbox') return choiceRole(element) === 'switch' || element.hasAttribute('switch') ? 'switch' : 'checkbox';
      return element.type === 'radio' ? 'radio' : null;
    }
    if (element instanceof HTMLSelectElement) return element.multiple ? null : 'select';
    const role = choiceRole(element);
    if (role === 'switch') return 'switch';
    if (role === 'radio' || role === 'menuitemradio') return 'radio';
    return role === 'checkbox' || role === 'menuitemcheckbox' ? 'checkbox' : null;
  };
  // An element whose click is its own: a link, a button or another field.
  const choicePresses = (element) => (element instanceof HTMLAnchorElement && element.hasAttribute('href')) ||
    element instanceof HTMLButtonElement || element instanceof HTMLInputElement || element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement ||
    /^(?:button|link|textbox|searchbox|combobox|menuitem|tab|option)$/u.test(choiceRole(element));
  // The one choice a styled wrapper holds with nothing else to press; null for none yet, undefined for a block
  // that holds several choices or other controls, which wraps no single box.
  const wrapped = (element) => {
    if (element instanceof HTMLFormElement || element instanceof HTMLFieldSetElement || element === document.body ||
      element === document.documentElement) return undefined;
    const inner = choiceDescendants(element);
    const held = inner.filter((candidate) => choiceKind(candidate));
    if (held.length > 1 || inner.some((candidate) => candidate !== held[0] && choicePresses(candidate))) return undefined;
    return held.length === 1 ? held[0] : null;
  };
  // The choice a click on node toggles: the node itself, a label's control, the nearest checkbox, switch or radio
  // around it, or the one choice a styled wrapper around it holds. A link or button owns its own click.
  const toggledBy = (node) => {
    if (!(node instanceof Element)) return null;
    if (choiceKind(node)) return node;
    if (choicePresses(node)) return null;
    for (let current = node; current; current = choiceParent(current)) {
      if (current !== node && choiceKind(current) && !(current instanceof HTMLSelectElement)) return current;
      if (current instanceof HTMLLabelElement) return current.control && choiceKind(current.control) ? current.control : null;
      if (current !== node && choicePresses(current)) return null;
      const box = wrapped(current);
      if (box !== null) return box || null;
    }
    return null;
  };
  const choiceShown = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  // The visible words under root, with blocks kept apart; fields' own text and skipped subtrees are left out.
  const choiceText = (root, skip) => {
    let text = '';
    const visit = (node) => {
      for (const child of [...(node.shadowRoot ? node.shadowRoot.childNodes : []), ...node.childNodes]) {
        if (child instanceof Text) {
          const holder = choiceParent(child);
          if (holder && choiceShown(holder)) text += child.data;
        } else if (child instanceof Element && !(child instanceof HTMLScriptElement) && !(child instanceof HTMLStyleElement) &&
          !(child instanceof HTMLSelectElement) && !(child instanceof HTMLTextAreaElement) && !(skip && skip(child))) {
          const block = !/^inline/u.test(getComputedStyle(child).display);
          if (block) text += ' ';
          visit(child);
          if (block) text += ' ';
        }
      }
    };
    visit(root);
    return choiceSquash(text);
  };
  // The elements an attribute such as aria-labelledby names by id.
  const choiceNamed = (element, attribute) => {
    const root = element.getRootNode();
    return (element.getAttribute(attribute) || '').split(/\s+/u).filter(Boolean)
      .map((id) => (root.getElementById ? root.getElementById(id) : null)).filter(Boolean);
  };
  const choiceReferenced = (element) =>
    choiceSquash(choiceNamed(element, 'aria-labelledby').map((target) => choiceText(target)).join(' '));
  const otherField = (choice, element) => element !== choice && (choiceKind(element) !== null ||
    element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLButtonElement);
  // A choice's wording and the elements it is read from: what labels it, its own words for a role, or the block
  // beside it that holds no other field. Wording from its attributes alone is read from no element.
  const choiceWording = (choice) => {
    const skip = (element) => element !== choice && choiceKind(element) !== null;
    let from = choiceNamed(choice, 'aria-labelledby');
    let text = choiceReferenced(choice);
    if (!text && choice.labels) {
      from = Array.from(choice.labels);
      text = choiceSquash(from.map((label) => choiceText(label, skip)).join(' '));
    }
    if (!text && !(choice instanceof HTMLInputElement) && !(choice instanceof HTMLSelectElement)) {
      from = [choice];
      text = choiceText(choice, skip);
    }
    for (let current = choiceParent(choice), depth = 0; !text && current && depth < 4; current = choiceParent(current), depth++) {
      if (current instanceof HTMLFormElement || current === document.body || choiceDescendants(current).some((element) => otherField(choice, element)))
        break;
      from = [current];
      text = choiceText(current, skip);
    }
    if (text) return { text, from };
    return { text: choiceSquash(choice.getAttribute('aria-label') || choice.getAttribute('title') || '') ||
      choiceSquash((choice.getAttribute('name') || choice.id || '').replace(/[_-]+/gu, ' ')), from: [] };
  };
  const choiceLabel = (choice) => choiceWording(choice).text;
  // The options answering one question: same-named radios of one form or formless root, or one radiogroup's radios.
  const choiceMembers = (choice) => {
    if (choice instanceof HTMLInputElement) {
      if (!choice.name) return [choice];
      const form = choice.form;
      const scope = form ? Array.from(Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, 'elements').get.call(form))
        : Array.from(choice.getRootNode().querySelectorAll('input'));
      return scope.filter((element) => element instanceof HTMLInputElement && element.type === 'radio' &&
        element.name === choice.name && element.form === form);
    }
    for (let current = choiceParent(choice); current; current = choiceParent(current))
      if (choiceRole(current) === 'radiogroup')
        return choiceDescendants(current).filter((element) => choiceKind(element) === 'radio' && !(element instanceof HTMLInputElement));
    return [choice];
  };
  // A radio option's question and the elements it is read from: a fieldset's legend, a radiogroup's label, or the
  // words of the block holding every option and no other field, else of the block just before the options.
  const choiceQuestion = (choice) => {
    const members = choiceMembers(choice);
    const own = (element) => members.includes(element) || (element instanceof HTMLLabelElement && members.includes(element.control));
    for (let current = choiceParent(choice); current; current = choiceParent(current)) {
      if (current instanceof HTMLFieldSetElement) {
        const legend = Array.from(current.children).find((element) => element instanceof HTMLLegendElement);
        if (legend) return { text: choiceText(legend), from: [legend] };
      }
      if (choiceRole(current) === 'radiogroup' || choiceRole(current) === 'group') {
        const referenced = choiceReferenced(current);
        if (referenced) return { text: referenced, from: choiceNamed(current, 'aria-labelledby') };
        const named = choiceSquash(current.getAttribute('aria-label') || '');
        if (named) return { text: named, from: [] };
      }
      if (!members.every((member) => choiceWithin(current, member))) continue;
      const fields = choiceDescendants(current).some((element) => !members.includes(element) && otherField(null, element));
      if (!fields && !(current instanceof HTMLFormElement) && current !== document.body) {
        const text = choiceText(current, own);
        if (text) return { text, from: [current] };
        continue;
      }
      let block = members[0];
      while (block && choiceParent(block) !== current) block = choiceParent(block);
      for (let previous = block && block.previousElementSibling; previous; previous = previous.previousElementSibling) {
        if (choiceKind(previous) || choiceDescendants(previous).some((element) => otherField(null, element))) break;
        const text = choiceText(previous);
        if (text) return { text, from: [previous] };
      }
      return { text: '', from: [] };
    }
    return { text: '', from: [] };
  };
  const choiceGroup = (choice) => choiceQuestion(choice).text;
  // Where a choice's wording, its question and its description link to, as absolute addresses: whose terms a box
  // accepts (consent.ts).
  const choiceLinks = (choice) => {
    const from = [...choiceWording(choice).from, ...choiceNamed(choice, 'aria-describedby'),
      ...(choiceKind(choice) === 'radio' ? choiceQuestion(choice).from : [])];
    const links = new Set();
    for (const element of from.flatMap((source) => [source, ...choiceDescendants(source)]))
      if ((element instanceof HTMLAnchorElement || element instanceof HTMLAreaElement) && element.hasAttribute('href'))
        links.add(element.href);
    return [...links];
  };
  // What a click on node would toggle, as the classifier reads it.
  const toggledChoice = (node) => {
    const choice = toggledBy(node);
    const kind = choice && choiceKind(choice);
    if (!kind) return null;
    return {
      kind,
      label: choiceLabel(choice),
      ...(kind === 'radio' ? { group: choiceGroup(choice) } : {}),
      ...(kind === 'select' ? { options: Array.from(choice.options, (option) => choiceSquash(option.label || option.text)) } : {}),
    };
  };
`;

const WORLD = 'gws-ea-control-facts';
const LIBRARY = '__gwsEaControlFacts';
/** Reading a whole document can take longer than one protocol answer. */
const READ_TIMEOUT_MS = 5_000;

/**
 * The isolated-world half of every read: plain JavaScript, installed once into each frame's isolated world.
 * Every prototype it calls is the isolated world's own, so page script cannot answer for it.
 */
const librarySource = String.raw`(sources) => {
  ${CHOICE_SOURCE}
  const re = {};
  for (const key of Object.keys(sources)) re[key] = new RegExp(sources[key], 'iu');
  const getter = (type, name) => Object.getOwnPropertyDescriptor(type.prototype, name).get;
  // Native getters avoid HTMLFormElement's named-control property clobbering.
  const formProperty = (form, name) => getter(HTMLFormElement, name).call(form);
  const associated = [HTMLButtonElement, HTMLInputElement, HTMLSelectElement, HTMLTextAreaElement, HTMLFieldSetElement,
    HTMLOutputElement, HTMLObjectElement];
  const parentOf = (node) => (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement);
  const ancestry = (node) => {
    const list = [];
    for (let current = node; current; current = parentOf(current)) list.push(current);
    return list;
  };
  const formOf = (node) => {
    const type = associated.find((candidate) => node instanceof candidate);
    return type ? getter(type, 'form').call(node) : ancestry(node).find((element) => element instanceof HTMLFormElement) || null;
  };
  const shown = new Map();
  const visible = (element) => {
    if (!shown.has(element)) shown.set(element, element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true }));
    return shown.get(element);
  };
  const children = (node) => [...(node.shadowRoot ? node.shadowRoot.childNodes : []), ...node.childNodes];
  // Every element under root, open shadow roots included, in document order; skip prunes a subtree.
  const elements = (root, skip) => {
    const list = [];
    const visit = (node) => {
      for (const child of children(node))
        if (child instanceof Element && !(skip && skip(child))) {
          list.push(child);
          visit(child);
        }
    };
    visit(root);
    return list;
  };
  const squash = (value) => (value || '').replace(/\s+/gu, ' ').trim();
  // The visible text under root, one entry per text node, with each visible select's chosen option.
  const chunks = (root, skip) => {
    const list = [];
    const visit = (node) => {
      for (const child of children(node)) {
        if (child instanceof Text) {
          const holder = parentOf(child);
          const text = squash(child.data);
          if (text && holder && visible(holder)) list.push(text);
        } else if (!(child instanceof Element) || (skip && skip(child))) continue;
        else if (child instanceof HTMLSelectElement) {
          if (visible(child)) for (const option of child.selectedOptions) list.push(squash(option.text));
        } else if (!(child instanceof HTMLScriptElement) && !(child instanceof HTMLStyleElement)) visit(child);
      }
    };
    visit(root);
    return list.filter(Boolean);
  };
  const textOf = (element) => squash(element.textContent);
  const nameOf = (element) => {
    const root = element.getRootNode();
    const labelled = squash((element.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean)
      .map((id) => (root.getElementById ? root.getElementById(id) : null)).filter(Boolean).map(textOf).join(' '));
    const labels = element.labels ? squash(Array.from(element.labels, textOf).join(' ')) : '';
    const value = element instanceof HTMLInputElement && /^(?:submit|button|reset)$/u.test(element.type) ? element.value : '';
    return squash(element.getAttribute('aria-label')) || labelled || squash(element.getAttribute('title')) || labels ||
      textOf(element) || squash(value) || squash(element.getAttribute('alt'));
  };
  const BUTTON = 'button,input[type="submit" i],input[type="button" i],input[type="image" i],[role="button" i]';
  const isField = (element) => element instanceof HTMLInputElement || element instanceof HTMLSelectElement ||
    element instanceof HTMLTextAreaElement;
  const describe = (element) => [element.name, element.id, element.getAttribute('autocomplete'),
    element.getAttribute('aria-label'), element.getAttribute('placeholder')].filter(Boolean).join(' ');
  const cardField = (element) => element instanceof HTMLInputElement && element.type !== 'hidden' && visible(element) &&
    re.cardField.test([element.name, element.id, element.getAttribute('autocomplete')].join(' '));
  // A field that takes typed or chosen text: no button, box or file input.
  const textEntry = (element) => (element instanceof HTMLInputElement && !re.noTextEntry.test(element.type)) ||
    element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
  const labelsOf = (element) => (element.labels ? Array.from(element.labels, (label) => label.textContent).join(' ') : '');
  const cardEntryField = (element) => {
    const said = [describe(element), labelsOf(element)].join(' ');
    return textEntry(element) && re.cardEntry.test(said) && !re.giftCard.test(said);
  };
  // The same shape isSensitiveField reads on the host: a password type, or a secret by its autocomplete or names.
  const secretField = (element) => textEntry(element) && (element.type === 'password' ||
    re.secretAutocomplete.test(element.getAttribute('autocomplete') || '') || re.secretField.test(describe(element)));
  // A field holding a secret (KTD6): a password, a code or payment details, by its type, autocomplete, names or
  // labels, so a show-password toggle that made it a text field still counts.
  const secretValue = (element) => (secretField(element) || cardEntryField(element) ||
    (textEntry(element) && re.secretField.test(labelsOf(element)))) && typeof element.value === 'string' && element.value !== '';
  const isDialog = (element) => element instanceof HTMLDialogElement || /^(?:alert)?dialog$/iu.test(element.getAttribute('role') || '');
  const openDialog = (element) => isDialog(element) && (!(element instanceof HTMLDialogElement) || element.open) && visible(element);
  const modal = (dialog) => (dialog instanceof HTMLDialogElement && dialog.matches(':modal')) || dialog.getAttribute('aria-modal') === 'true';
  const boundary = (element) => element instanceof HTMLFormElement || isDialog(element);
  // The frames this document hosts, and whether each takes payment, as the host read them.
  let owners = [];
  let payments = [];
  const within = (root, element, skip) => {
    for (let current = parentOf(element); current; current = parentOf(current)) {
      if (current === root) return true;
      if (skip && skip(current)) return false;
    }
    return root === document;
  };
  const frameShown = (owner) => {
    if (!visible(owner)) return false;
    const box = owner.getBoundingClientRect();
    return box.width >= 8 && box.height >= 8 && box.right + scrollX > 0 && box.bottom + scrollY > 0;
  };
  const nearAmount = (text, index) => [text[index], text[index + 1], text[index + 2]]
    .some((value) => value !== undefined && re.amount.test(value));
  // One form, open dialog or formless document: whether it shows a total or a charge with a payment method.
  const container = (root, skip, associatedFields) => {
    const text = chunks(root, skip);
    const all = elements(root, skip);
    const due = text.some((value, index) => (re.total.test(value) || re.charge.test(value)) && nearAmount(text, index));
    const payment = text.some((value) => re.savedCard.test(value)) ||
      [...all, ...(associatedFields || [])].some(cardField) ||
      all.some((element) => element.matches(BUTTON) && visible(element) && re.expressPay.test(nameOf(element))) ||
      owners.some((owner, index) => payments[index] && within(root, owner, skip) && frameShown(owner));
    return {
      transaction: due && payment,
      spoken: text.some((value) => re.amount.test(value) || re.orderWords.test(value)),
    };
  };
  const formFields = (form) => Array.from(formProperty(form, 'elements'));
  const box = (element) => {
    const rect = element.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  };
  // The visible lines under root, block by block, each with the block it sits in. A control's own words name
  // the control, not a fact, so buttons are left out; a visible select contributes its chosen option.
  const lines = (root, limit) => {
    const list = [];
    let current = null;
    const flush = () => {
      if (current && current.text) list.push(current);
      current = null;
    };
    const add = (text, block) => {
      if (!text) return;
      if (current) current.text += ' ' + text;
      else current = { text, block };
    };
    const visit = (node, block) => {
      for (const child of children(node)) {
        if (list.length >= limit) return;
        if (child instanceof Text) {
          const holder = parentOf(child);
          if (holder && visible(holder)) add(squash(child.data), block);
        } else if (!(child instanceof Element) || child instanceof HTMLScriptElement || child instanceof HTMLStyleElement ||
          child instanceof HTMLTemplateElement || child.matches(BUTTON)) continue;
        else if (child instanceof HTMLSelectElement) {
          if (visible(child)) for (const option of child.selectedOptions) add(squash(option.text), block);
        } else {
          const inline = /^inline/u.test(getComputedStyle(child).display);
          if (!inline) flush();
          visit(child, inline ? block : child);
          if (!inline) flush();
        }
      }
    };
    visit(root, root);
    flush();
    return list.slice(0, limit);
  };
  const structuredData = () => elements(document)
    .filter((element) => element instanceof HTMLScriptElement && /^application\/ld\+json$/iu.test(element.type))
    .map((element) => (element.textContent || '').slice(0, 20000));
  const scan = (frameOwners, framePayments, detailed) => {
    owners = frameOwners;
    payments = framePayments;
    const all = elements(document);
    const containers = [
      ...all.filter((element) => element instanceof HTMLFormElement).map((form) => container(form, undefined, formFields(form))),
      ...all.filter(openDialog).map((dialog) => container(dialog)),
      container(document, boundary),
    ];
    const text = chunks(document);
    const named = (element) => element instanceof HTMLAnchorElement || element.matches(BUTTON) ||
      /^(?:link|menuitem)$/iu.test(element.getAttribute('role') || '');
    const heading = all.find((element) => element.tagName === 'H1' && visible(element));
    return {
      transaction: containers.some((facts) => facts.transaction),
      moneyTerms: re.moneyTerms.test(text.join('\n')),
      feeTerms: text.some((value, index) => re.charge.test(value) && nearAmount(text, index)),
      paymentFields: all.some(cardField),
      signedIn: all.some((element) => named(element) && (re.signOut.test(nameOf(element)) ||
        (element instanceof HTMLAnchorElement && re.signOutRoute.test(element.href)))),
      accountHeading: re.accountHeading.test(document.title) ||
        all.some((element) => /^H[12]$/u.test(element.tagName) && visible(element) && re.accountHeading.test(textOf(element))),
      chatOwners: frameOwners.map((owner) => re.chatOwner.test([owner.getAttribute('title'), owner.getAttribute('name'),
        owner.id, owner.getAttribute('aria-label')].filter(Boolean).join(' '))),
      // What a checkout read needs of the whole document: its words, wallets and payment entry, and its name.
      ...(detailed ? {
        lines: lines(document, 600).map((line) => line.text.slice(0, 500)),
        expressPay: all.filter((element) => element.matches(BUTTON) && visible(element) && re.expressPay.test(nameOf(element)))
          .map(nameOf),
        paymentEntry: all.some(cardField) || owners.some((owner, index) => payments[index] && frameShown(owner)),
        heading: heading ? squash(heading.textContent) : null,
        structured: structuredData(),
      } : {}),
    };
  };
  const searchLike = (element) => element.type === 'search' ||
    /^(?:searchbox|combobox)$/iu.test(element.getAttribute('role') || '') ||
    ancestry(element).some((node) => (node.getAttribute('role') || '').toLowerCase() === 'search') ||
    re.search.test(describe(element));
  const editableRoot = (element) => element instanceof HTMLElement && element.isContentEditable &&
    !(parentOf(element) instanceof HTMLElement && parentOf(element).isContentEditable);
  // Free text: a textarea, a contenteditable element, or a formless non-search text input.
  const freeTextField = (element) => element instanceof HTMLTextAreaElement || editableRoot(element) ||
    (element instanceof HTMLInputElement && element.type === 'text' && !formOf(element) && !searchLike(element));
  const holdsText = (element) => visible(element) && !element.disabled && !element.readOnly &&
    squash(element instanceof HTMLElement && element.isContentEditable ? element.innerText : element.value) !== '';
  const accountField = (element) => element instanceof HTMLInputElement &&
    !/^(?:hidden|submit|button|reset|image|checkbox|radio|file|range|color)$/u.test(element.type) &&
    !element.disabled && !element.readOnly && visible(element) &&
    (/^(?:email|tel|password)$/u.test(element.type) || re.accountField.test(describe(element)));
  const bookingField = (element) => isField(element) && element.type !== 'hidden' &&
    re.bookingField.test([describe(element), element.labels ? Array.from(element.labels, textOf).join(' ') : ''].join(' '));
  const pressable = (element) => element.matches(BUTTON) ||
    (element instanceof HTMLAnchorElement && (element.getAttribute('href') || '').trim().startsWith('#'));
  const control = (node) => {
    if (!(node instanceof Element) || !node.isConnected) return null;
    const form = formOf(node);
    const submitter = node instanceof HTMLButtonElement || node instanceof HTMLInputElement;
    const own = (name) => submitter && node.hasAttribute(name);
    const fields = form ? formFields(form) : [];
    const dialog = ancestry(node).find(openDialog) || null;
    const around = [];
    if (form) around.push(container(form, undefined, fields));
    if (dialog) around.push(container(dialog));
    if (!around.length) around.push(container(document, boundary));
    // A formless control's region is the nearest element around it that groups it with what it presses: a
    // field for a button, a control to press for a field. A search box and its button group on their own.
    const limit = dialog || document.body || document.documentElement;
    const entry = isField(node) || editableRoot(node);
    let region = limit;
    if (!form)
      for (const candidate of ancestry(node).slice(1)) {
        const inner = elements(candidate);
        if (inner.some((element) => element !== node && (entry ? pressable(element) : isField(element) || editableRoot(element)))) {
          region = candidate;
          break;
        }
        if (candidate === limit) break;
      }
    const members = form ? [...new Set([...elements(form), ...fields])]
      : [region, ...elements(region, (element) => element instanceof HTMLFormElement)];
    const transaction = around.some((facts) => facts.transaction);
    const rawHref = node instanceof HTMLAnchorElement || node instanceof HTMLAreaElement ? node.getAttribute('href') : null;
    return {
      name: nameOf(node),
      visibleLabel: textOf(node),
      formMethod: form ? (own('formmethod') ? node.formMethod : formProperty(form, 'method')) : undefined,
      formAction: form ? (own('formaction') ? node.formAction : formProperty(form, 'action')) : undefined,
      authenticationForm: Boolean(form && /^post$/iu.test(formProperty(form, 'method')) &&
        /^https:\/\/[^/]+\/(?:login|signin|sign-in|auth|session|sessions|account\/login)(?:[/?#]|$)/iu.test(formProperty(form, 'action')) &&
        fields.some((field) => field instanceof HTMLInputElement && (field.type === 'password' || field.type === 'email' ||
          /(?:one-time-code|username)/iu.test(field.getAttribute('autocomplete') || ''))) &&
        !fields.some((field) => /(?:^|\s)cc-/iu.test(field.getAttribute('autocomplete') || ''))),
      role: node.getAttribute('role') || '',
      tag: node.tagName.toLowerCase(),
      type: submitter || node instanceof HTMLSelectElement || node instanceof HTMLTextAreaElement ? node.type : node.getAttribute('type') || '',
      href: rawHref === null ? null : node.href,
      scripted: (rawHref !== null && rawHref.trim().startsWith('#')) || node.hasAttribute('onclick'),
      toggles: toggledChoice(node),
      cardEntry: cardEntryField(node),
      region: {
        dialog: Boolean(dialog),
        transaction,
        modalOrder: Boolean(dialog && modal(dialog) && container(dialog).spoken),
        freeText: members.some((element) => freeTextField(element) && holdsText(element)),
        commits: transaction || members.some(bookingField) || re.commitName.test(nameOf(node)) ||
          members.some((element) => element.matches(BUTTON) && visible(element) && re.commitName.test(nameOf(element))),
        accountFields: members.some(accountField),
        secretFields: fields.some(secretField),
      },
    };
  };
  // The exact-node handoff: the host's selector dispatches one unguessable event on the chosen node.
  const slots = new Map();
  const arm = (eventName) => {
    const slot = { count: 0, node: null, roots: [document] };
    for (let index = 0; index < slot.roots.length; index++)
      for (const element of slot.roots[index].querySelectorAll('*')) if (element.shadowRoot) slot.roots.push(element.shadowRoot);
    slot.listener = (event) => {
      slot.count++;
      slot.node = slot.count === 1 ? event.target : null;
    };
    for (const root of slot.roots) root.addEventListener(eventName, slot.listener, true);
    slots.set(eventName, slot);
    return true;
  };
  const disarm = (eventName) => {
    const slot = slots.get(eventName);
    if (slot) for (const root of slot.roots) root.removeEventListener(eventName, slot.listener, true);
    return slots.delete(eventName);
  };
  const received = (eventName) => (slots.has(eventName) ? slots.get(eventName).count : 0);
  const read = (eventName) => {
    const slot = slots.get(eventName);
    return slot && slot.count === 1 && slot.node ? control(slot.node) : null;
  };
  // What a field holds as the page shows it: a select's chosen options, a typed field's value, an editable's words.
  const shownValue = (element) => {
    if (element instanceof HTMLSelectElement) return squash(Array.from(element.selectedOptions, (option) => option.text).join(' '));
    if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) return element.value;
    return squash(element.innerText);
  };
  // A field as a checkout read reports it. A secret's or a card field's value is never read.
  const checkoutField = (element) => {
    const withheld = secretField(element) || cardEntryField(element);
    const choice = element instanceof HTMLInputElement && /^(?:checkbox|radio)$/u.test(element.type);
    const typed = element instanceof HTMLInputElement || element instanceof HTMLSelectElement || element instanceof HTMLTextAreaElement;
    return {
      tag: element.tagName.toLowerCase(),
      type: typed ? element.type : '',
      name: element.getAttribute('name') || '',
      autocomplete: element.getAttribute('autocomplete') || '',
      label: squash(labelsOf(element)) || squash(element.getAttribute('aria-label')) || squash(element.getAttribute('placeholder')),
      value: withheld ? null : shownValue(element),
      card: cardEntryField(element),
      secret: secretField(element),
      checked: choice ? element.checked : null,
    };
  };
  // The checkout around the handed control: its form, else the open dialog around it, else its document. Its
  // lines carry the box of the block each sits in, on this document's viewport.
  const checkout = (eventName) => {
    const slot = slots.get(eventName);
    const node = slot && slot.count === 1 ? slot.node : null;
    if (!(node instanceof Element) || !node.isConnected) return null;
    const form = formOf(node);
    const dialog = ancestry(node).find(openDialog) || null;
    const root = form || dialog || document.body || document.documentElement;
    const members = form ? [...new Set([...elements(form), ...formFields(form)])] : elements(root);
    return {
      kind: form ? 'form' : dialog ? 'dialog' : 'document',
      label: nameOf(node),
      controlBox: box(node),
      lines: lines(root, 400).map((line) => ({ text: line.text.slice(0, 2000), box: box(line.block) })),
      fields: members.filter((element) => (isField(element) || editableRoot(element)) && visible(element) &&
        !(element instanceof HTMLInputElement && /^(?:hidden|submit|button|reset|image|file|range|color)$/u.test(element.type)))
        .map(checkoutField),
      times: elements(root).filter((element) => element.tagName === 'TIME' && visible(element))
        .map((element) => ({ datetime: element.getAttribute('datetime') || '', text: squash(element.textContent) })),
    };
  };
  return { scan, arm, disarm, received, read, checkout, secretValue };
}`;

const vocabularySources: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PAGE_VOCABULARY).map(([key, pattern]) => [key, pattern.source]),
);

const READER: IsolatedReader = {
  world: WORLD,
  global: LIBRARY,
  source: `(${librarySource})(${JSON.stringify(vocabularySources)})`,
};

/** A box on its document's viewport, in CSS pixels. */
export interface CheckoutBox {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}
/** One visible line of a checkout, with the box of the block it sits in. */
export interface CheckoutLine {
  readonly text: string;
  readonly box: CheckoutBox;
}
/** A field in a checkout. A secret's or a card field's value is never read (null). */
export interface CheckoutField {
  readonly tag: string;
  readonly type: string;
  readonly name: string;
  readonly autocomplete: string;
  readonly label: string;
  readonly value: string | null;
  readonly card: boolean;
  readonly secret: boolean;
  /** A box's or a radio option's state; null for any other field. */
  readonly checked: boolean | null;
}
/** The checkout around a control: its form, else the open dialog around it, else its document (KTD3). */
export interface CheckoutRegion {
  readonly kind: 'form' | 'dialog' | 'document';
  /** The control's own accessible name. */
  readonly label: string;
  /** The control's box on its document's viewport. */
  readonly controlBox: CheckoutBox;
  readonly lines: readonly CheckoutLine[];
  readonly fields: readonly CheckoutField[];
  /** Each visible `time` element: its machine-readable datetime and its words. */
  readonly times: ReadonlyArray<{ readonly datetime: string; readonly text: string }>;
}
/** What one frame's document shows, for a checkout read. */
export interface CheckoutFrame {
  readonly url: string;
  /** The page's own top-level document. */
  readonly top: boolean;
  readonly lines: readonly string[];
  /** The names of its visible express-pay buttons. */
  readonly expressPay: readonly string[];
  /** It holds a visible card field or a visible processor payment frame. */
  readonly paymentEntry: boolean;
  /** It shows a sign-out control. */
  readonly signedIn: boolean;
  /** Its first visible top-level heading. */
  readonly heading: string | null;
  /** Its schema.org JSON-LD, as text. */
  readonly structured: readonly string[];
}
/** A checkout as the host reads it around a control, every part in an isolated world. */
export interface CheckoutRead {
  readonly facts: ControlFacts;
  readonly region: CheckoutRegion;
  /** The address of the control's frame. */
  readonly frameUrl: string;
  readonly frames: readonly CheckoutFrame[];
}

/** What one frame's document shows, read in its isolated world. */
interface FrameScan {
  readonly transaction: boolean;
  readonly moneyTerms: boolean;
  readonly feeTerms: boolean;
  readonly paymentFields: boolean;
  readonly signedIn: boolean;
  readonly accountHeading: boolean;
  readonly chatOwners: readonly boolean[];
  /** The whole document's facts a checkout read needs; read only for one. */
  readonly page?: Omit<CheckoutFrame, 'url' | 'top' | 'signedIn'>;
}
/** A hosted frame, with what its scan found and whether its owner element names a chat widget. */
interface ScannedFrame extends HostedFrame {
  scan?: FrameScan;
  chatOwner?: boolean;
}
/** A node of a target's pierced DOM tree: its own children, its shadow roots of every mode, a frame's document. */
interface PiercedNode {
  backendNodeId: number;
  localName: string;
  /** The frame a frame owner holds. */
  frameId?: string;
  children?: PiercedNode[];
  shadowRoots?: PiercedNode[];
  contentDocument?: PiercedNode;
}

/** The page could not be read in an isolated world, so nothing about the control is known. */
export class ControlFactsUnavailableError extends Error {
  constructor() {
    super('The control could not be read in an isolated world');
  }
}

/** A read value as a plain object; undefined for null, an array or anything else. */
export const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const flag = (value: unknown): boolean => value === true;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A frame that went away mid-read: it has nothing left to read. */
export function frameGone(error: unknown): boolean {
  return (
    error instanceof Error &&
    /(?:No frame (?:for given id )?found|Frame with the given id was not found|Cannot find context|No node with given id)/iu.test(
      error.message,
    )
  );
}

function hostAndPath(raw: string): string | undefined {
  try {
    const url = new URL(raw);
    return url.protocol === 'https:' ? `${url.hostname}${url.pathname}` : undefined;
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return undefined;
  }
}

function chatProvider(raw: string): boolean {
  try {
    const domain = getDomain(new URL(raw).hostname, { allowPrivateDomains: true });
    return domain !== null && CHAT_PROVIDERS.has(domain);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}

function accountPath(raw: string): boolean {
  try {
    return ACCOUNT_PATH.test(new URL(raw).pathname);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return false;
  }
}

const texts = (value: unknown): string[] | undefined =>
  Array.isArray(value) && value.every((item) => typeof item === 'string') ? (value as string[]) : undefined;

function parseScan(value: unknown, detailed: boolean): FrameScan | undefined {
  const scan = record(value);
  if (!scan || !Array.isArray(scan.chatOwners)) return undefined;
  const lines = texts(scan.lines);
  const expressPay = texts(scan.expressPay);
  const structured = texts(scan.structured);
  if (detailed && (!lines || !expressPay || !structured)) return undefined;
  return {
    transaction: flag(scan.transaction),
    moneyTerms: flag(scan.moneyTerms),
    feeTerms: flag(scan.feeTerms),
    paymentFields: flag(scan.paymentFields),
    signedIn: flag(scan.signedIn),
    accountHeading: flag(scan.accountHeading),
    chatOwners: scan.chatOwners.map(flag),
    ...(detailed && lines && expressPay && structured
      ? {
          page: {
            lines,
            expressPay,
            paymentEntry: flag(scan.paymentEntry),
            heading: text(scan.heading) ?? null,
            structured,
          },
        }
      : {}),
  };
}

function parseBox(value: unknown): CheckoutBox | undefined {
  const raw = record(value);
  const numbers = [raw?.x, raw?.y, raw?.width, raw?.height];
  if (!numbers.every((number): number is number => typeof number === 'number' && Number.isFinite(number)))
    return undefined;
  const [x, y, width, height] = numbers;
  return { x, y, width, height };
}

function parseField(value: unknown): CheckoutField | undefined {
  const field = record(value);
  const strings = [field?.tag, field?.type, field?.name, field?.autocomplete, field?.label].map(text);
  if (!field || strings.some((item) => item === undefined)) return undefined;
  const [tag, type, name, autocomplete, label] = strings as string[];
  const fieldValue = field.value === null ? null : text(field.value);
  const checked = field.checked === null ? null : typeof field.checked === 'boolean' ? field.checked : undefined;
  if (fieldValue === undefined || checked === undefined) return undefined;
  return {
    tag,
    type,
    name,
    autocomplete,
    label,
    value: fieldValue,
    card: flag(field.card),
    secret: flag(field.secret),
    checked,
  };
}

/** The checkout region as read, or undefined; anything malformed fails the whole read. */
function parseRegion(value: unknown): CheckoutRegion | undefined {
  const region = record(value);
  const kind = region?.kind;
  const label = text(region?.label);
  const controlBox = parseBox(region?.controlBox);
  if (
    !region ||
    (kind !== 'form' && kind !== 'dialog' && kind !== 'document') ||
    label === undefined ||
    !controlBox ||
    !Array.isArray(region.lines) ||
    !Array.isArray(region.fields) ||
    !Array.isArray(region.times)
  )
    return undefined;
  const lines = region.lines.map((raw) => {
    const line = record(raw);
    const words = text(line?.text);
    const lineBox = parseBox(line?.box);
    return words !== undefined && lineBox ? { text: words, box: lineBox } : undefined;
  });
  const fields = region.fields.map(parseField);
  const times = region.times.map((raw) => {
    const time = record(raw);
    const datetime = text(time?.datetime);
    const words = text(time?.text);
    return datetime !== undefined && words !== undefined ? { datetime, text: words } : undefined;
  });
  if (lines.some((line) => !line) || fields.some((field) => !field) || times.some((time) => !time)) return undefined;
  return {
    kind,
    label,
    controlBox,
    lines: lines.filter((line) => line !== undefined),
    fields: fields.filter((field) => field !== undefined),
    times: times.filter((time) => time !== undefined),
  };
}

const TOGGLED_KINDS: ReadonlySet<unknown> = new Set(['checkbox', 'switch', 'radio', 'select']);

/** The toggled choice as read, or undefined for none; anything malformed fails the whole read. */
function parseToggled(value: unknown): ToggledChoice | null | undefined {
  if (value === null) return null;
  const choice = record(value);
  const label = text(choice?.label);
  if (!choice || !TOGGLED_KINDS.has(choice.kind) || label === undefined) return undefined;
  const group = text(choice.group);
  const options = Array.isArray(choice.options) ? choice.options.map(text) : undefined;
  if (options?.some((option) => option === undefined)) return undefined;
  return {
    kind: choice.kind as ToggledChoice['kind'],
    label,
    ...(group !== undefined ? { group } : {}),
    ...(options ? { options: options.filter((option) => option !== undefined) } : {}),
  };
}

function parseControl(value: unknown): Omit<ControlFacts, 'transaction'> | undefined {
  const facts = record(value);
  const region = record(facts?.region);
  const name = text(facts?.name);
  const tag = text(facts?.tag);
  const role = text(facts?.role);
  const type = text(facts?.type);
  const toggles = parseToggled(facts?.toggles);
  if (
    !facts ||
    !region ||
    name === undefined ||
    !tag ||
    role === undefined ||
    type === undefined ||
    toggles === undefined
  )
    return undefined;
  const formMethod = text(facts.formMethod);
  const formAction = text(facts.formAction);
  return {
    name,
    visibleLabel: text(facts.visibleLabel) ?? '',
    ...(formMethod !== undefined ? { formMethod } : {}),
    ...(formAction !== undefined ? { formAction } : {}),
    authenticationForm: flag(facts.authenticationForm),
    role,
    tag,
    type,
    href: text(facts.href) ?? null,
    scripted: flag(facts.scripted),
    ...(toggles ? { toggles } : {}),
    cardEntry: flag(facts.cardEntry),
    region: {
      dialog: flag(region.dialog),
      transaction: flag(region.transaction),
      modalOrder: flag(region.modalOrder),
      freeText: flag(region.freeText),
      commits: flag(region.commits),
      accountFields: flag(region.accountFields),
      secretFields: flag(region.secretFields),
    },
  };
}

/**
 * One CDP session per target: the page's, and each out-of-process frame's. A frame gone meanwhile has nothing to
 * read; any other frame that cannot be opened fails the read.
 */
async function openSessions(page: Page): Promise<Map<Frame, CDPSession>> {
  const sessions = await openTargetSessions(page, (frame) => frame.isDetached());
  if (!sessions) throw new ControlFactsUnavailableError();
  return sessions;
}

/**
 * Every frame each session hosts, with a fresh isolated world holding the reader. A frame that went away
 * meanwhile is left out; any other failure fails the read.
 */
async function hostedFrames(sessions: Iterable<CDPSession>): Promise<ReadonlyMap<string, ScannedFrame>> {
  return (await installReaders(sessions, READER, { unreadTree: false, unreadFrame: frameGone })).frames;
}

/**
 * Scans every frame, children before parents, so each parent knows which of its frames take payment. `detailed`
 * reads each whole document for a checkout too.
 */
async function scanFrames(
  frames: ReadonlyMap<string, ScannedFrame>,
  objectGroup: string,
  detailed: boolean,
): Promise<void> {
  const depth = (hosted: ScannedFrame): number => {
    let levels = 0;
    for (let parent = hosted.parentId; parent; parent = frames.get(parent)?.parentId) levels++;
    return levels;
  };
  const ordered = [...frames.values()].sort((left, right) => depth(right) - depth(left));
  for (const hosted of ordered) {
    const owners: Array<{ child: ScannedFrame; objectId: string }> = [];
    for (const child of frames.values()) {
      if (child.parentId !== hosted.id) continue;
      try {
        const { backendNodeId } = await bounded(hosted.session.send('DOM.getFrameOwner', { frameId: child.id }));
        const { object } = await bounded(
          hosted.session.send('DOM.resolveNode', { backendNodeId, executionContextId: hosted.context, objectGroup }),
        );
        if (object.objectId) owners.push({ child, objectId: object.objectId });
      } catch (error) {
        // A frame removed meanwhile has no owner left to place.
        if (!frameGone(error)) throw error;
      }
    }
    const payments = owners.map(({ child }) => {
      const address = hostAndPath(child.url);
      return (address !== undefined && PAYMENT_FRAME.test(address)) || child.scan?.paymentFields === true;
    });
    const result = await bounded(
      hosted.session.send('Runtime.callFunctionOn', {
        executionContextId: hosted.context,
        functionDeclaration: `function (payments, detailed, ...owners) { return globalThis.${LIBRARY}.scan(owners, payments, detailed); }`,
        arguments: [{ value: payments }, { value: detailed }, ...owners.map(({ objectId }) => ({ objectId }))],
        returnByValue: true,
      }),
      READ_TIMEOUT_MS,
    );
    const scan = result.exceptionDetails ? undefined : parseScan(result.result.value, detailed);
    if (!scan) throw new ControlFactsUnavailableError();
    hosted.scan = scan;
    owners.forEach(({ child }, index) => {
      child.chatOwner = scan.chatOwners[index] === true;
    });
  }
}

/**
 * Hands the exact element into the isolated world of the frame that holds it and reads it there. Every frame
 * its session hosts listens, so sibling frames with the same address are told apart by the node itself.
 */
async function readHandedControl(
  element: ElementHandle,
  frame: Frame,
  sessions: ReadonlyMap<Frame, CDPSession>,
  frames: ReadonlyMap<string, ScannedFrame>,
  selector: string,
  checkout: boolean,
): Promise<{ hosted: ScannedFrame; facts: Omit<ControlFacts, 'transaction'>; region?: CheckoutRegion }> {
  let owner: Frame | null = frame;
  while (owner && !sessions.has(owner)) owner = owner.parentFrame();
  const session = owner ? sessions.get(owner) : undefined;
  const candidates = [...frames.values()].filter((hosted) => hosted.session === session);
  if (!session || !candidates.length) throw new ControlFactsUnavailableError();
  const eventName = `gws-ea-auth-${randomUUID()}`;
  const call = (hosted: ScannedFrame, method: 'arm' | 'disarm' | 'received' | 'read' | 'checkout') =>
    bounded(
      session.send('Runtime.evaluate', {
        contextId: hosted.context,
        expression: `globalThis.${LIBRARY}.${method}(${JSON.stringify(eventName)})`,
        returnByValue: true,
      }),
      method === 'read' || method === 'checkout' ? READ_TIMEOUT_MS : PROTOCOL_READ_TIMEOUT_MS,
    );
  try {
    for (const hosted of candidates) await call(hosted, 'arm');
    const handed = await element.$(`${selector}=${eventName}`);
    await handed?.dispose();
    const counts = await Promise.all(
      candidates.map(async (hosted) => {
        const answer = await call(hosted, 'received');
        return answer.exceptionDetails ? undefined : answer.result.value;
      }),
    );
    const held = candidates.flatMap((hosted, index) => (counts[index] === 0 ? [] : [{ hosted, count: counts[index] }]));
    if (held.length !== 1 || held[0].count !== 1) throw new ControlFactsUnavailableError();
    const answer = await call(held[0].hosted, 'read');
    const facts = answer.exceptionDetails ? undefined : parseControl(answer.result.value);
    if (!facts) throw new ControlFactsUnavailableError();
    if (!checkout) return { hosted: held[0].hosted, facts };
    const read = await call(held[0].hosted, 'checkout');
    const region = read.exceptionDetails ? undefined : parseRegion(read.result.value);
    if (!region) throw new ControlFactsUnavailableError();
    return { hosted: held[0].hosted, facts, region };
  } finally {
    await Promise.all(candidates.map((hosted) => call(hosted, 'disarm').catch(() => undefined)));
  }
}

/**
 * Reads a control and the page around it in isolated worlds: the control's own facts and region, and the
 * transaction signal across the main frame, every child frame and every open dialog. Throws
 * ControlFactsUnavailableError when any part cannot be read; nothing is ever guessed.
 */
export async function readPageControlFacts(page: Page, element: ElementHandle): Promise<ControlFacts> {
  return (await readIsolated(page, element, false)).facts;
}

/**
 * Reads a checkout around a control (KTD4): the control's facts, its form, dialog or document line by line with
 * its fields, and every frame's words, wallets and payment entry, all in isolated worlds. Throws
 * ControlFactsUnavailableError when any part cannot be read; nothing is ever guessed.
 */
export async function readCheckoutRegion(page: Page, element: ElementHandle): Promise<CheckoutRead> {
  const read = await readIsolated(page, element, true);
  if (!read.checkout) throw new ControlFactsUnavailableError();
  return { facts: read.facts, ...read.checkout };
}

/**
 * Whether any field on the page holds a secret (KTD6): a password, a code or payment details, in every frame and
 * every shadow root, closed ones included. Each target's pierced DOM tree finds the fields, and each field's
 * value is read in its frame's isolated world, so page script cannot answer for it. Throws
 * ControlFactsUnavailableError when any part cannot be read; nothing is ever guessed.
 */
export async function pageHoldsSecretValue(page: Page): Promise<boolean> {
  const objectGroup = `gws-ea-secret-scan-${randomUUID()}`;
  const sessions = await openSessions(page);
  try {
    const frames = await hostedFrames(sessions.values());
    for (const session of sessions.values()) {
      const [{ frameTree }, { root }] = await Promise.all([
        bounded(session.send('Page.getFrameTree')),
        bounded(session.send('DOM.getDocument', { depth: -1, pierce: true }), READ_TIMEOUT_MS),
      ]);
      // Each text field by the frame whose document holds it; another target's frame is that target's to read.
      const fields = new Map<string, number[]>();
      const visit = (node: PiercedNode, frameId: string): void => {
        if (node.localName === 'input' || node.localName === 'textarea')
          fields.set(frameId, [...(fields.get(frameId) ?? []), node.backendNodeId]);
        for (const child of [...(node.children ?? []), ...(node.shadowRoots ?? [])]) visit(child, frameId);
        if (node.contentDocument && node.frameId) visit(node.contentDocument, node.frameId);
      };
      visit(root, frameTree.frame.id);
      for (const [frameId, nodes] of fields) {
        const hosted = frames.get(frameId);
        if (!hosted || hosted.session !== session) throw new ControlFactsUnavailableError();
        const handed: Array<{ objectId: string }> = [];
        for (const backendNodeId of nodes) {
          const { object } = await bounded(
            session.send('DOM.resolveNode', { backendNodeId, executionContextId: hosted.context, objectGroup }),
          );
          if (!object.objectId) throw new ControlFactsUnavailableError();
          handed.push({ objectId: object.objectId });
        }
        const result = await bounded(
          session.send('Runtime.callFunctionOn', {
            executionContextId: hosted.context,
            functionDeclaration: `function (...fields) { return fields.some((field) => globalThis.${LIBRARY}.secretValue(field)); }`,
            arguments: handed,
            returnByValue: true,
          }),
          READ_TIMEOUT_MS,
        );
        if (result.exceptionDetails || typeof result.result.value !== 'boolean')
          throw new ControlFactsUnavailableError();
        if (result.result.value) return true;
      }
    }
    return false;
  } catch (_error) {
    // A scan that cannot complete proves nothing about the page.
    throw new ControlFactsUnavailableError();
  } finally {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
        await session.detach().catch(() => undefined);
      }),
    );
  }
}

async function readIsolated(
  page: Page,
  element: ElementHandle,
  checkout: boolean,
): Promise<{ facts: ControlFacts; checkout?: Omit<CheckoutRead, 'facts'> }> {
  const selector = isolationSelector(page.context());
  const frame = await element.ownerFrame();
  if (!selector || !frame || frame.page() !== page) throw new ControlFactsUnavailableError();
  const objectGroup = `gws-ea-control-facts-${randomUUID()}`;
  const sessions = await openSessions(page);
  try {
    const frames = await hostedFrames(sessions.values());
    await scanFrames(frames, objectGroup, checkout);
    const { hosted, facts, region } = await readHandedControl(
      element,
      frame,
      sessions,
      frames,
      await selector,
      checkout,
    );
    const scans = [...frames.values()].flatMap((candidate) => (candidate.scan ? [candidate.scan] : []));
    // The control's frame and every frame around it below the page: a chat widget anywhere there speaks.
    const chain: ScannedFrame[] = [];
    let current: ScannedFrame | undefined = hosted;
    while (current?.parentId) {
      chain.push(current);
      current = frames.get(current.parentId);
    }
    // A field inside a processor's payment frame takes payment details, whatever it is called.
    const paymentFrame = chain.some((candidate) => {
      const address = hostAndPath(candidate.url);
      return address !== undefined && PAYMENT_FRAME.test(address);
    });
    const controlFacts: ControlFacts = {
      ...facts,
      cardEntry:
        facts.cardEntry === true ||
        (paymentFrame &&
          (facts.tag === 'select' ||
            facts.tag === 'textarea' ||
            (facts.tag === 'input' && !NO_TEXT_ENTRY.test(facts.type)))),
      transaction: scans.some((scan) => scan.transaction),
      moneyTerms: scans.some((scan) => scan.moneyTerms),
      feeTerms: scans.some((scan) => scan.feeTerms),
      accountPage: hosted.scan?.signedIn === true && (accountPath(hosted.url) || hosted.scan.accountHeading),
      chatFrame: chain.some((candidate) => candidate.chatOwner === true || chatProvider(candidate.url)),
    };
    if (!region) return { facts: controlFacts };
    const checkoutFrames = [...frames.values()].map((candidate): CheckoutFrame => {
      const read = candidate.scan?.page;
      if (!candidate.scan || !read) throw new ControlFactsUnavailableError();
      return { url: candidate.url, top: !candidate.parentId, signedIn: candidate.scan.signedIn, ...read };
    });
    return { facts: controlFacts, checkout: { region, frameUrl: hosted.url, frames: checkoutFrames } };
  } catch (_error) {
    // Any read that cannot complete leaves the control unknown, never guessed.
    throw new ControlFactsUnavailableError();
  } finally {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
        await session.detach().catch(() => undefined);
      }),
    );
  }
}
