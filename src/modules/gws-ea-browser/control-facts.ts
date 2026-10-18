/**
 * What the host reads before it classifies an action: the control's facts and the page's transaction signal,
 * read in an isolated world in every frame, so page script cannot rewrite what the classifier sees.
 */
import { randomUUID } from 'node:crypto';
import type { CDPSession, ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';

import { isolationSelector } from './authentication-submit.js';
import { PROTOCOL_READ_TIMEOUT_MS, withinTime } from './page-targets.js';

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
}

/** Prices, recurring charges, trials and billing, in a label or anywhere on a page. */
export const moneyTerms =
  /(?:[$€£¥]\s?\d|\b\d+(?:[.,]\d{1,2})?\s?(?:usd|eur|gbp|dollars?|euros?|pounds?)\b|\bper\s+(?:month|year|week|day)\b|\/\s?(?:mo|month|yr|year)\b|\b(?:subscriptions?|free\s+trial|trial\s+period|billing|billed|recurring|auto-?renew\w*|membership\s+fees?)\b)/iu;

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

/**
 * Processor frames that take payment details or an express payment, by host and path. Metrics, messaging,
 * address and sign-in frames from the same processors are not payment methods.
 */
const PAYMENT_FRAME =
  /^(?:js\.stripe\.com\/v3\/elements-inner-(?![\w-]*(?:messag|address|authentication|affirm|afterpay|klarna))|checkout\.stripe\.com\/|[\w-]+\.adyen\.com\/checkoutshopper\/(?:securedfields|assets\/html)\/|assets\.braintreegateway\.com\/web\/[\w.-]+\/html\/hosted-fields-frame|(?:www\.)?paypal\.com\/smart\/(?:card-fields|buttons))/iu;
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

const WORLD = 'gws-ea-control-facts';
const LIBRARY = '__gwsEaControlFacts';
/** Reading a whole document can take longer than one protocol answer. */
const READ_TIMEOUT_MS = 5_000;

/**
 * The isolated-world half of every read: plain JavaScript, installed once into each frame's isolated world.
 * Every prototype it calls is the isolated world's own, so page script cannot answer for it.
 */
const librarySource = String.raw`(sources) => {
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
  const scan = (frameOwners, framePayments) => {
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
      region: {
        dialog: Boolean(dialog),
        transaction,
        modalOrder: Boolean(dialog && modal(dialog) && container(dialog).spoken),
        freeText: members.some((element) => freeTextField(element) && holdsText(element)),
        commits: transaction || members.some(bookingField) || re.commitName.test(nameOf(node)) ||
          members.some((element) => element.matches(BUTTON) && visible(element) && re.commitName.test(nameOf(element))),
        accountFields: members.some(accountField),
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
  return { scan, arm, disarm, received, read };
}`;

const vocabularySources: Readonly<Record<string, string>> = Object.fromEntries(
  Object.entries(PAGE_VOCABULARY).map(([key, pattern]) => [key, pattern.source]),
);

/** What one frame's document shows, read in its isolated world. */
interface FrameScan {
  readonly transaction: boolean;
  readonly moneyTerms: boolean;
  readonly feeTerms: boolean;
  readonly paymentFields: boolean;
  readonly signedIn: boolean;
  readonly accountHeading: boolean;
  readonly chatOwners: readonly boolean[];
}
/** A frame one of the read's sessions hosts, with the isolated world the reader is installed in. */
interface HostedFrame {
  readonly id: string;
  readonly parentId?: string;
  readonly url: string;
  readonly session: CDPSession;
  readonly context: number;
  scan?: FrameScan;
  chatOwner?: boolean;
}
interface FrameTreeNode {
  frame: { id: string; parentId?: string; url: string };
  childFrames?: FrameTreeNode[];
}

/** The page could not be read in an isolated world, so nothing about the control is known. */
export class ControlFactsUnavailableError extends Error {
  constructor() {
    super('The control could not be read in an isolated world');
  }
}

const bounded = <T>(work: Promise<T>, ms = PROTOCOL_READ_TIMEOUT_MS): Promise<T> => withinTime(work, ms);
const record = (value: unknown): Record<string, unknown> | undefined =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
const flag = (value: unknown): boolean => value === true;
const text = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** A frame that went away mid-read: it has nothing left to read. */
function frameGone(error: unknown): boolean {
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

function parseScan(value: unknown): FrameScan | undefined {
  const scan = record(value);
  if (!scan || !Array.isArray(scan.chatOwners)) return undefined;
  return {
    transaction: flag(scan.transaction),
    moneyTerms: flag(scan.moneyTerms),
    feeTerms: flag(scan.feeTerms),
    paymentFields: flag(scan.paymentFields),
    signedIn: flag(scan.signedIn),
    accountHeading: flag(scan.accountHeading),
    chatOwners: scan.chatOwners.map(flag),
  };
}

function parseControl(value: unknown): Omit<ControlFacts, 'transaction'> | undefined {
  const facts = record(value);
  const region = record(facts?.region);
  const name = text(facts?.name);
  const tag = text(facts?.tag);
  const role = text(facts?.role);
  const type = text(facts?.type);
  if (!facts || !region || name === undefined || !tag || role === undefined || type === undefined) return undefined;
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
    region: {
      dialog: flag(region.dialog),
      transaction: flag(region.transaction),
      modalOrder: flag(region.modalOrder),
      freeText: flag(region.freeText),
      commits: flag(region.commits),
      accountFields: flag(region.accountFields),
    },
  };
}

/** One CDP session per target: the page's, and each out-of-process frame's. */
async function openSessions(page: Page): Promise<Map<Frame, CDPSession>> {
  const sessions = new Map<Frame, CDPSession>();
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const opened = await Promise.allSettled([
    bounded(page.context().newCDPSession(page)),
    ...frames.map((frame) => bounded(page.context().newCDPSession(frame))),
  ]);
  let failed = false;
  opened.forEach((attempt, index) => {
    const frame = index === 0 ? page.mainFrame() : frames[index - 1];
    if (attempt.status === 'fulfilled') sessions.set(frame, attempt.value);
    // An in-process frame shares its local root's session; a frame gone meanwhile has nothing to read.
    else if (
      index === 0 ||
      !(
        (attempt.reason instanceof Error && attempt.reason.message.includes('does not have a separate CDP session')) ||
        frame.isDetached()
      )
    )
      failed = true;
  });
  if (failed) {
    await Promise.all([...sessions.values()].map((session) => session.detach().catch(() => undefined)));
    throw new ControlFactsUnavailableError();
  }
  return sessions;
}

/**
 * Every frame each session hosts, with a fresh isolated world holding the reader. A frame that went away
 * meanwhile is left out; any other failure fails the read.
 */
async function hostedFrames(sessions: Iterable<CDPSession>): Promise<Map<string, HostedFrame>> {
  const tree = new Map<string, Omit<HostedFrame, 'context'>>();
  for (const session of sessions) {
    const { frameTree } = await bounded(session.send('Page.getFrameTree'));
    const visit = (node: FrameTreeNode): void => {
      if (!tree.has(node.frame.id))
        tree.set(node.frame.id, {
          id: node.frame.id,
          ...(node.frame.parentId ? { parentId: node.frame.parentId } : {}),
          url: node.frame.url,
          session,
        });
      node.childFrames?.forEach(visit);
    };
    visit(frameTree);
  }
  const frames = new Map<string, HostedFrame>();
  await Promise.all(
    [...tree.values()].map(async (hosted) => {
      try {
        const { executionContextId } = await bounded(
          hosted.session.send('Page.createIsolatedWorld', { frameId: hosted.id, worldName: WORLD }),
        );
        const installed = await bounded(
          hosted.session.send('Runtime.evaluate', {
            contextId: executionContextId,
            expression: `globalThis.${LIBRARY} = (${librarySource})(${JSON.stringify(vocabularySources)}); true`,
            returnByValue: true,
          }),
        );
        if (installed.exceptionDetails || installed.result.value !== true) throw new ControlFactsUnavailableError();
        frames.set(hosted.id, { ...hosted, context: executionContextId });
      } catch (error) {
        if (!frameGone(error)) throw error;
      }
    }),
  );
  return frames;
}

/** Scans every frame, children before parents, so each parent knows which of its frames take payment. */
async function scanFrames(frames: ReadonlyMap<string, HostedFrame>, objectGroup: string): Promise<void> {
  const depth = (hosted: HostedFrame): number => {
    let levels = 0;
    for (let parent = hosted.parentId; parent; parent = frames.get(parent)?.parentId) levels++;
    return levels;
  };
  const ordered = [...frames.values()].sort((left, right) => depth(right) - depth(left));
  for (const hosted of ordered) {
    const owners: Array<{ child: HostedFrame; objectId: string }> = [];
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
        functionDeclaration: `function (payments, ...owners) { return globalThis.${LIBRARY}.scan(owners, payments); }`,
        arguments: [{ value: payments }, ...owners.map(({ objectId }) => ({ objectId }))],
        returnByValue: true,
      }),
      READ_TIMEOUT_MS,
    );
    const scan = result.exceptionDetails ? undefined : parseScan(result.result.value);
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
  frames: ReadonlyMap<string, HostedFrame>,
  selector: string,
): Promise<{ hosted: HostedFrame; facts: Omit<ControlFacts, 'transaction'> }> {
  let owner: Frame | null = frame;
  while (owner && !sessions.has(owner)) owner = owner.parentFrame();
  const session = owner ? sessions.get(owner) : undefined;
  const candidates = [...frames.values()].filter((hosted) => hosted.session === session);
  if (!session || !candidates.length) throw new ControlFactsUnavailableError();
  const eventName = `gws-ea-auth-${randomUUID()}`;
  const call = (hosted: HostedFrame, method: 'arm' | 'disarm' | 'received' | 'read') =>
    bounded(
      session.send('Runtime.evaluate', {
        contextId: hosted.context,
        expression: `globalThis.${LIBRARY}.${method}(${JSON.stringify(eventName)})`,
        returnByValue: true,
      }),
      method === 'read' ? READ_TIMEOUT_MS : PROTOCOL_READ_TIMEOUT_MS,
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
    return { hosted: held[0].hosted, facts };
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
  const selector = isolationSelector(page.context());
  const frame = await element.ownerFrame();
  if (!selector || !frame || frame.page() !== page) throw new ControlFactsUnavailableError();
  const objectGroup = `gws-ea-control-facts-${randomUUID()}`;
  const sessions = await openSessions(page);
  try {
    const frames = await hostedFrames(sessions.values());
    await scanFrames(frames, objectGroup);
    const { hosted, facts } = await readHandedControl(element, frame, sessions, frames, await selector);
    const scans = [...frames.values()].flatMap((candidate) => (candidate.scan ? [candidate.scan] : []));
    // The control's frame and every frame around it below the page: a chat widget anywhere there speaks.
    const chain: HostedFrame[] = [];
    let current: HostedFrame | undefined = hosted;
    while (current?.parentId) {
      chain.push(current);
      current = frames.get(current.parentId);
    }
    return {
      ...facts,
      transaction: scans.some((scan) => scan.transaction),
      moneyTerms: scans.some((scan) => scan.moneyTerms),
      feeTerms: scans.some((scan) => scan.feeTerms),
      accountPage: hosted.scan?.signedIn === true && (accountPath(hosted.url) || hosted.scan.accountHeading),
      chatFrame: chain.some((candidate) => candidate.chatOwner === true || chatProvider(candidate.url)),
    };
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
