/**
 * Cookie banners (KTD12, R18): before each observation the browser agent receives, the host rejects a cookie
 * banner wherever it can see a reject option, and otherwise tells the agent the banner is there.
 *
 * The rules are data: one per consent platform, naming its banner, its reject-all control and the control that
 * opens its second layer, plus a generic rule for any dialog or banner region that speaks of cookies, whose
 * controls are known by their labels. An isolated world in every frame reads the banners, open shadow roots and
 * cross-site consent frames included, so page script cannot fake what the host sees. The host presses with a
 * real click, keeping its hit-target check, and only a control that cannot leave the page or submit a form
 * outside its banner and that the classifier reads as ordinary. Then it waits for the banner to close. Each page
 * load gets one reject and one second layer at most: a banner that comes back, or will not close, is reported
 * and never pressed again there.
 */
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

import type { ElementHandle, Page } from 'playwright-core';

import { isolationSelector } from './authentication-submit.js';
import { activateControl, BrowserActivationError } from './commit-classifier.js';
import { frameGone, record } from './control-facts.js';
import {
  bounded,
  installReaders,
  openTargetSessions,
  PROTOCOL_READ_TIMEOUT_MS,
  type HostedFrame,
  type IsolatedReader,
} from './page-targets.js';

// ---------------------------------------------------------------- the rules

export type CookieBannerPlatform =
  | 'onetrust'
  | 'cookiebot'
  | 'didomi'
  | 'usercentrics'
  | 'trustarc'
  | 'quantcast'
  | 'sourcepoint';

/** How the host recognizes one consent platform's banner and presses its reject. */
interface CookieBannerRule {
  readonly platform: CookieBannerPlatform;
  /** The platform's banner and second-layer regions, by CSS selector. */
  readonly banner: string;
  /** Its reject-all controls, on either layer. Without one, the controls' labels decide. */
  readonly reject?: string;
  /** The control that opens its second layer. Without one, the controls' labels decide. */
  readonly settings?: string;
}

/** Rules are data: add or narrow a platform here, never by changing how the host presses. */
const COOKIE_BANNER_RULES: readonly CookieBannerRule[] = [
  {
    platform: 'onetrust',
    banner: '#onetrust-banner-sdk, #onetrust-pc-sdk',
    reject: '#onetrust-reject-all-handler, .ot-pc-refuse-all-handler',
    settings: '#onetrust-pc-btn-handler',
  },
  {
    platform: 'cookiebot',
    banner: '#CybotCookiebotDialog',
    reject: '#CybotCookiebotDialogBodyButtonDecline, #CybotCookiebotDialogBodyLevelButtonLevelOptinDeclineAll',
    settings: '#CybotCookiebotDialogBodyLevelButtonCustomize',
  },
  {
    platform: 'didomi',
    banner: '#didomi-notice, #didomi-popup',
    reject: '#didomi-notice-disagree-button, .didomi-continue-without-agreeing',
    settings: '#didomi-notice-learn-more-button',
  },
  {
    platform: 'usercentrics',
    // Its banner renders inside the host's open shadow root.
    banner: '#usercentrics-root, #usercentrics-cmp-ui',
    reject: '[data-testid="uc-deny-all-button"]',
    settings: '[data-testid="uc-more-button"]',
  },
  {
    platform: 'trustarc',
    banner: '#truste-consent-track',
    reject: '#truste-consent-required',
    settings: '#truste-show-consent',
  },
  // Its buttons carry no stable names: "Reject all", "Disagree" and "More options" find them by label.
  { platform: 'quantcast', banner: '#qc-cmp2-ui' },
  {
    platform: 'sourcepoint',
    // Its message is a frame of its own, whose controls are named by choice type.
    banner: 'body:has([class*="sp_choice_type_"])',
    reject: '.sp_choice_type_13, .sp_choice_type_REJECT_ALL',
    settings: '.sp_choice_type_12',
  },
];

/** What a banner control does, read from its label. */
export type CookieBannerControlKind = 'reject' | 'settings' | 'accept';

/** Whole labels, in a few common languages besides English, each anchored at both ends. */
const labels = (alternatives: readonly string[]): RegExp => new RegExp(`^(?:${alternatives.join('|')})$`, 'iu');
const necessary = String.raw`(?:strictly\s+)?(?:necessary|essential|required)`;

/** Vocabulary is data: widen or narrow it here, never by changing the order the host decides in. */
const BANNER_VOCABULARY = {
  /** A region's own words that make it a cookie banner. */
  cookies: /\bcookies?\b|\btrackers\b|\btracking\s+technolog(?:y|ies)\b/iu,
  /** An element named as a consent banner by its id, class or label. */
  bannerName: /cookie|consent|gdpr|ccpa|privacy|\bcmp\b/iu,
  reject: labels([
    String.raw`(?:reject|decline|deny|refuse|disagree)(?:\s+(?:to\s+)?all)?(?:\s+(?:optional|non-?essential|additional))?(?:\s+cookies)?(?:\s*(?:and|&)\s*close)?`,
    String.raw`(?:i\s+)?(?:do\s+not|don't)\s+(?:accept|agree|consent)|i\s+(?:decline|refuse)`,
    String.raw`continue\s+without\s+(?:accepting|agreeing)`,
    String.raw`(?:(?:accept|allow|use|continue\s+with)\s+)?(?:only\s+)?${necessary}(?:\s+cookies)?\s+only`,
    String.raw`(?:(?:accept|allow|use|continue\s+with)\s+)?only\s+${necessary}(?:\s+cookies)?`,
    String.raw`(?:accept|allow|use)\s+${necessary}(?:\s+cookies)?`,
    String.raw`(?:alle\s+)?ablehnen|nur\s+(?:notwendige|essenzielle|erforderliche)(?:\s+cookies)?(?:\s+(?:akzeptieren|zulassen|erlauben))?`,
    String.raw`(?:tout\s+)?refuser(?:\s+tout)?|continuer\s+sans\s+accepter`,
    String.raw`rechazar(?:\s+tod[oa]s?)?|rifiuta(?:\s+tutto)?|(?:alles\s+)?weigeren|rejeitar(?:\s+tud[oa]s?)?`,
  ]),
  settings: labels([
    String.raw`(?:(?:manage|customi[sz]e|change|adjust|set|edit|review|show|view)\s+)?(?:(?:my|your)\s+)?(?:cookie|privacy|consent)\s+(?:options|settings|preferences|choices)`,
    String.raw`(?:manage|customi[sz]e|change|adjust|set|edit|review|show|view|more)\s+(?:(?:my|your)\s+)?(?:options|settings|preferences|choices|purposes|cookies)`,
    String.raw`options|settings|preferences|customi[sz]e|let\s+me\s+choose`,
    String.raw`(?:cookie-)?einstellungen|anpassen|mehr\s+optionen|paramétrer|personnaliser|gérer\s+(?:les\s+)?(?:options|préférences|cookies)`,
    String.raw`configurar|personalizar|más\s+opciones|personalizza|gestisci\s+(?:le\s+)?(?:opzioni|preferenze)|instellingen|voorkeuren`,
  ]),
  accept: labels([
    String.raw`(?:(?:yes,?\s+)?i\s+)?(?:accept|agree|allow|consent)(?:\s+(?:to\s+)?(?:all|everything))?(?:\s+(?:all\s+)?cookies)?(?:\s*(?:and|&)\s*(?:close|continue|proceed))?`,
    String.raw`ok(?:ay)?|got\s+it|i\s+understand|understood`,
    String.raw`(?:alle\s+)?(?:akzeptieren|zulassen)|zustimmen|einverstanden|(?:tout\s+)?accepter(?:\s+tout)?|j'accepte`,
    String.raw`aceptar(?:\s+tod[oa]s?)?|accetta(?:\s+tutto)?|(?:alles\s+)?accepteren|aceitar(?:\s+tud[oa]s?)?`,
  ]),
} as const satisfies Record<string, RegExp>;

/** A label as the vocabulary reads it: compatibility forms, spacing and surrounding marks and icons set aside. */
function readableLabel(label: string): string {
  return label
    .normalize('NFKC')
    .replace(/[‘’ʼ´`]/gu, "'")
    .replace(/\s+/gu, ' ')
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

function labelKind(label: string): CookieBannerControlKind | undefined {
  const words = readableLabel(label);
  if (!words) return undefined;
  if (BANNER_VOCABULARY.reject.test(words)) return 'reject';
  if (BANNER_VOCABULARY.settings.test(words)) return 'settings';
  return BANNER_VOCABULARY.accept.test(words) ? 'accept' : undefined;
}

/**
 * What a banner control does, by its visible words, or by its accessible name when it shows none. A name that
 * says something else makes the control unknown, so no page can hide one choice behind another's words.
 */
export function cookieBannerControlKind(control: { name: string; text: string }): CookieBannerControlKind | undefined {
  const [shown, other] = control.text.trim() ? [control.text, control.name] : [control.name, ''];
  const kind = labelKind(shown);
  const named = labelKind(other);
  return kind && (!named || named === kind) ? kind : undefined;
}

// ---------------------------------------------------------------- what the host decides

/** One control in a banner region, as the isolated world read it. */
export interface CookieBannerControlRead {
  readonly id: number;
  /** Its accessible name: aria-label, aria-labelledby, value or title. */
  readonly name: string;
  /** Its visible words. */
  readonly text: string;
  /** What its platform rule's own selector names it. */
  readonly selected: 'reject' | 'settings' | null;
  /** A link to another document. */
  readonly navigates: boolean;
  /** A submit control whose form lies outside the region. */
  readonly foreignSubmit: boolean;
}
/** One candidate banner region, as the isolated world read it. */
export interface CookieBannerRegionRead {
  readonly platform: CookieBannerPlatform | null;
  /** A child frame's whole document. */
  readonly whole: boolean;
  /** Its visible words speak of cookies. */
  readonly cookies: boolean;
  /** The nearest candidate region around it, by index. */
  readonly parent: number | null;
  readonly controls: readonly CookieBannerControlRead[];
}
/** A banner the host found in one frame: its region and the controls it would press, by their ids there. */
export interface CookieBannerChoice {
  readonly region: number;
  readonly reject?: number;
  readonly settings?: number;
}

/**
 * The banners among a frame's candidate regions: every platform region, and each generic region that speaks of
 * cookies and offers a consent choice, the innermost where such regions nest. A child frame's whole document
 * counts only when its frame sits where a banner does (`framed`). A control that leaves the page or submits a
 * form outside its banner is never one the host would press.
 */
export function chooseCookieBanners(regions: readonly CookieBannerRegionRead[], framed: boolean): CookieBannerChoice[] {
  const kinds = regions.map((region) => region.controls.map(cookieBannerControlKind));
  const generic = regions.map(
    (region, index) =>
      region.platform === null &&
      region.cookies &&
      (!region.whole || framed) &&
      kinds[index].some((kind) => kind !== undefined),
  );
  const holdsBanner = new Set<number>();
  generic.forEach((qualifies, index) => {
    if (!qualifies) return;
    for (let parent = regions[index].parent; parent !== null; parent = regions[parent]?.parent ?? null)
      holdsBanner.add(parent);
  });
  return regions.flatMap((region, index): CookieBannerChoice[] => {
    if (region.platform === null && (!generic[index] || holdsBanner.has(index))) return [];
    const pressable = region.controls.flatMap((control, at) =>
      control.navigates || control.foreignSubmit ? [] : [{ control, kind: kinds[index][at] }],
    );
    const pick = (kind: 'reject' | 'settings'): number | undefined =>
      (
        pressable.find(({ control }) => control.selected === kind) ??
        pressable.find(({ control, kind: read }) => read === kind && control.selected === null)
      )?.control.id;
    const reject = pick('reject');
    const settings = pick('settings');
    return [
      {
        region: index,
        ...(reject !== undefined ? { reject } : {}),
        ...(settings !== undefined ? { settings } : {}),
      },
    ];
  });
}

/**
 * What the host did about a cookie banner before an observation (R18):
 * - `rejected`: it pressed the banner's reject and the banner closed;
 * - `no_reject_option`: a banner shows with no reject the host can press, on either layer, so the agent chooses;
 * - `reappeared`: a banner shows again after the host rejected one on this page load, and it does not press again;
 * - `reject_failed`: the host's reject could not land or the banner stayed, and it does not press again on this
 *   page load.
 */
export type CookieBannerStatus = 'rejected' | 'no_reject_option' | 'reappeared' | 'reject_failed';
export interface CookieBannerReport {
  readonly status: CookieBannerStatus;
}

/** What the host did on one page load: its one reject's outcome, if any, and whether it opened a second layer. */
export interface CookieBannerLoad {
  after?: Exclude<CookieBannerStatus, 'rejected'>;
  opened: boolean;
}
export type CookieBannerStep<Banner> =
  | { readonly kind: 'none' }
  | { readonly kind: 'reject' | 'open'; readonly banner: Banner; readonly control: number }
  | { readonly kind: 'report'; readonly status: Exclude<CookieBannerStatus, 'rejected'> };

/**
 * The host's next step on a page load: after its one reject, any banner is only reported; before it, a reject
 * the host can see is pressed, else a second layer it has not opened yet, else the banner is the agent's.
 */
export function nextCookieBannerStep<Banner extends Pick<CookieBannerChoice, 'reject' | 'settings'>>(
  banners: readonly Banner[],
  load: Readonly<CookieBannerLoad>,
): CookieBannerStep<Banner> {
  if (!banners.length) return { kind: 'none' };
  if (load.after) return { kind: 'report', status: load.after };
  for (const banner of banners)
    if (banner.reject !== undefined) return { kind: 'reject', banner, control: banner.reject };
  if (!load.opened)
    for (const banner of banners)
      if (banner.settings !== undefined) return { kind: 'open', banner, control: banner.settings };
  return { kind: 'report', status: 'no_reject_option' };
}

// ---------------------------------------------------------------- reading banners in an isolated world

const WORLD = 'gws-ea-cookie-banners';
const LIBRARY = '__gwsEaCookieBanners';
/** Reading a whole document can take longer than one protocol answer. */
const READ_TIMEOUT_MS = 5_000;
const PRESS_TIMEOUT_MS = 2_000;
/** How long a pressed banner, or a second layer, has to answer. */
const ANSWER_WAIT_MS = 2_000;
/** How long a closed banner has to finish fading out of the page before the observation. */
const FADE_WAIT_MS = 500;
const POLL_MS = 100;

/**
 * The isolated-world half: plain JavaScript holding the banner reader, the frame-owner reader and the exact-node
 * handoff. Every prototype it calls is the isolated world's own, so page script cannot answer for it.
 */
const librarySource = String.raw`(sources) => {
  const rules = sources.rules;
  const cookieWords = new RegExp(sources.cookies, 'iu');
  const bannerName = new RegExp(sources.bannerName, 'iu');
  const CONTROL = 'button,input[type="button" i],input[type="submit" i],input[type="image" i],[role="button" i],a';
  const MAX_REGIONS = 24;
  const MAX_CONTROLS = 60;
  const TEXT_LIMIT = 4000;
  const parentOf = (node) => (node.parentNode instanceof ShadowRoot ? node.parentNode.host : node.parentElement);
  const childrenOf = (node) => [...(node.shadowRoot ? node.shadowRoot.children : []), ...node.children];
  // Every element under root, open shadow roots included, in document order.
  const descendants = (root) => {
    const list = [];
    const visit = (node) => {
      for (const child of childrenOf(node)) {
        list.push(child);
        visit(child);
      }
    };
    visit(root);
    return list;
  };
  const within = (root, node) => {
    for (let current = node; current; current = parentOf(current)) if (current === root) return true;
    return false;
  };
  const squash = (value) => (value || '').replace(/\s+/gu, ' ').trim();
  const role = (element) => (element.getAttribute('role') || '').trim().toLowerCase();
  const rendered = (element) => element.checkVisibility({ checkVisibilityCSS: true });
  const visible = (element) => element.checkVisibility({ checkOpacity: true, checkVisibilityCSS: true });
  const boxed = (element) => {
    const box = element.getBoundingClientRect();
    return box.width >= 1 && box.height >= 1;
  };
  // A region is on the page while it, or something inside it, has a box: a shadow host can have none itself.
  const present = (element, seen) => element.isConnected && seen(element) &&
    (boxed(element) || descendants(element).some((inner) => seen(inner) && boxed(inner)));
  const shows = (element) => present(element, visible);
  // The visible words under root, open shadow roots included, up to a limit.
  const textOf = (root) => {
    const parts = [];
    let length = 0;
    const visit = (node) => {
      for (const child of [...(node.shadowRoot ? node.shadowRoot.childNodes : []), ...node.childNodes]) {
        if (length > TEXT_LIMIT) return;
        if (child instanceof Text) {
          const holder = parentOf(child);
          if (holder && visible(holder)) {
            parts.push(child.data);
            length += child.data.length;
          }
        } else if (child instanceof Element && !(child instanceof HTMLScriptElement) && !(child instanceof HTMLStyleElement))
          visit(child);
      }
    };
    visit(root);
    return squash(parts.join(' '));
  };
  const nameOf = (element) => {
    const root = element.getRootNode();
    const labelled = squash((element.getAttribute('aria-labelledby') || '').split(/\s+/u).filter(Boolean)
      .map((id) => (root.getElementById ? root.getElementById(id) : null)).filter(Boolean).map(textOf).join(' '));
    const value = element instanceof HTMLInputElement ? element.value : '';
    return squash(element.getAttribute('aria-label')) || labelled || squash(value) || squash(element.getAttribute('title'));
  };
  const wordsOf = (element) => squash(element.shadowRoot ? textOf(element) : element.innerText);
  const navigates = (element) => element instanceof HTMLAnchorElement && element.hasAttribute('href') &&
    !/^\s*(?:#|javascript:|$)/iu.test(element.getAttribute('href'));
  // A press that submits a form lying outside the region.
  const foreignSubmit = (element, region) => {
    const submits = (element instanceof HTMLButtonElement && element.type === 'submit') ||
      (element instanceof HTMLInputElement && /^(?:submit|image)$/u.test(element.type));
    return submits && Boolean(element.form) && !within(region, element.form);
  };
  const enabled = (element) => !element.matches(':disabled') && element.getAttribute('aria-disabled') !== 'true';
  const dialogLike = (element) => (element instanceof HTMLDialogElement ? element.open : /^(?:alert)?dialog$/u.test(role(element))) ||
    element.getAttribute('aria-modal') === 'true';
  const named = (element) => bannerName.test([element.id, element.getAttribute('class') || '', element.getAttribute('aria-label') || ''].join(' '));
  const pinned = (element) => /^(?:fixed|sticky)$/u.test(getComputedStyle(element).position);
  let regions = [];
  let controls = [];
  const controlsOf = (region, rule) => {
    const selected = (element) => (rule && rule.reject && element.matches(rule.reject) ? 'reject'
      : rule && rule.settings && element.matches(rule.settings) ? 'settings' : null);
    return descendants(region)
      .filter((element) => (element.matches(CONTROL) || selected(element)) && visible(element) && boxed(element) && enabled(element))
      .slice(0, MAX_CONTROLS)
      .map((element) => {
        let id = controls.indexOf(element);
        if (id === -1) id = controls.push(element) - 1;
        return { id, name: nameOf(element), text: wordsOf(element), selected: selected(element),
          navigates: navigates(element), foreignSubmit: foreignSubmit(element, region) };
      });
  };
  const speaks = (element) => cookieWords.test(textOf(element) + ' ' + (element.getAttribute('aria-label') || ''));
  // Every candidate region: each platform rule's shown banners, then, outside them all, a child frame's whole
  // document and each shown dialog, fixed or sticky element, or element named for consent, that speaks of cookies.
  const scan = () => {
    regions = [];
    controls = [];
    const all = descendants(document);
    const roots = [document, ...all.filter((element) => element.shadowRoot).map((element) => element.shadowRoot)];
    const found = [];
    for (const rule of rules)
      for (const root of roots)
        for (const element of root.querySelectorAll(rule.banner))
          if (!found.some((entry) => entry.element === element) && shows(element))
            found.push({ element, rule, cookies: speaks(element) });
    const platformRegions = found.map((entry) => entry.element);
    const overlaps = (element) => platformRegions.some((region) => within(region, element) || within(element, region));
    const body = document.body;
    if (window.parent !== window && body && !overlaps(body) && shows(body) && speaks(body))
      found.push({ element: body, whole: true, cookies: true });
    for (const element of all) {
      if (found.length >= MAX_REGIONS) break;
      if (!(element instanceof HTMLElement) || element === body || element === document.documentElement) continue;
      if ((dialogLike(element) || named(element) || pinned(element)) && !overlaps(element) && shows(element) && speaks(element))
        found.push({ element, cookies: true });
    }
    regions = found.map((entry) => entry.element);
    return found.map((entry, index) => {
      let parent = null;
      for (let current = parentOf(entry.element); current && parent === null; current = parentOf(current)) {
        const at = regions.indexOf(current);
        if (at !== -1 && at !== index) parent = at;
      }
      return {
        platform: entry.rule ? entry.rule.platform : null,
        whole: Boolean(entry.whole),
        cookies: entry.cookies,
        parent,
        controls: controlsOf(entry.element, entry.rule),
      };
    });
  };
  // Whether a region read by the last scan still shows, has faded out but is still laid out, or is gone.
  const state = (index) => {
    const region = regions[index];
    if (!region || !present(region, rendered)) return 'gone';
    return shows(region) ? 'shown' : 'faded';
  };
  // A frame's owner element: whether it shows, and whether it sits where a banner does.
  const owner = (element) => {
    const box = element.getBoundingClientRect();
    const shown = element.isConnected && visible(element) && box.width >= 8 && box.height >= 8;
    let placed = bannerName.test([element.id, element.getAttribute('title') || '', element.getAttribute('name') || ''].join(' '));
    for (let current = element; current && !placed; current = parentOf(current))
      placed = current instanceof HTMLElement && (dialogLike(current) || pinned(current) || (current !== element && named(current)));
    return { shown, placed };
  };
  // The control's place from the document element down, each step an index among a node's shadow and light children.
  const path = (id) => {
    const steps = [];
    let node = controls[id];
    if (!node || !node.isConnected) return null;
    for (; node !== document.documentElement; node = parentOf(node)) {
      const parent = parentOf(node);
      if (!parent) return null;
      steps.unshift(childrenOf(parent).indexOf(node));
    }
    return steps;
  };
  // The exact-node handoff: the host's selector dispatches one unguessable event on the node it found.
  const slots = new Map();
  const arm = (eventName) => {
    const slot = { count: 0, node: null, roots: [document] };
    for (let index = 0; index < slot.roots.length; index++)
      for (const element of slot.roots[index].querySelectorAll('*')) if (element.shadowRoot) slot.roots.push(element.shadowRoot);
    slot.listener = (event) => {
      slot.count++;
      slot.node = event.target;
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
  const identify = (eventName, id) => {
    const slot = slots.get(eventName);
    return Boolean(slot) && slot.count === 1 && slot.node === controls[id];
  };
  return { scan, state, owner, path, arm, disarm, identify };
}`;

const librarySources = {
  rules: COOKIE_BANNER_RULES,
  cookies: BANNER_VOCABULARY.cookies.source,
  bannerName: BANNER_VOCABULARY.bannerName.source,
};

const READER: IsolatedReader = {
  world: WORLD,
  global: LIBRARY,
  source: `(${librarySource})(${JSON.stringify(librarySources)})`,
};

/** Finds the node at a path the isolated world read; the world then confirms it is the very node it chose. */
const WALK = `(steps) => {
  let node = document.documentElement;
  for (const step of steps) node = node && [...(node.shadowRoot ? node.shadowRoot.children : []), ...node.children][step];
  return node || null;
}`;

const PLATFORMS: ReadonlySet<unknown> = new Set(COOKIE_BANNER_RULES.map((rule) => rule.platform));
const SELECTED: ReadonlySet<unknown> = new Set(['reject', 'settings', null]);

function parseControl(value: unknown): CookieBannerControlRead | undefined {
  const control = record(value);
  if (
    !control ||
    !Number.isInteger(control.id) ||
    typeof control.name !== 'string' ||
    typeof control.text !== 'string' ||
    !SELECTED.has(control.selected) ||
    typeof control.navigates !== 'boolean' ||
    typeof control.foreignSubmit !== 'boolean'
  )
    return undefined;
  return {
    id: Number(control.id),
    name: control.name,
    text: control.text,
    selected: control.selected as CookieBannerControlRead['selected'],
    navigates: control.navigates,
    foreignSubmit: control.foreignSubmit,
  };
}

/** The regions as the world returned them; anything malformed is no read at all. */
function parseRegions(value: unknown): CookieBannerRegionRead[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const regions: CookieBannerRegionRead[] = [];
  for (const raw of value) {
    const region = record(raw);
    const controls = Array.isArray(region?.controls) ? region.controls.map(parseControl) : undefined;
    if (
      !region ||
      !controls ||
      controls.some((control) => control === undefined) ||
      (region.platform !== null && !PLATFORMS.has(region.platform)) ||
      typeof region.whole !== 'boolean' ||
      typeof region.cookies !== 'boolean' ||
      (region.parent !== null && !Number.isInteger(region.parent))
    )
      return undefined;
    regions.push({
      platform: region.platform as CookieBannerPlatform | null,
      whole: region.whole,
      cookies: region.cookies,
      parent: region.parent === null ? null : Number(region.parent),
      controls: controls.filter((control) => control !== undefined),
    });
  }
  return regions;
}

/** A child frame's owner element, resolved in its parent's world. */
interface FrameOwner {
  readonly parent: HostedFrame;
  readonly objectId: string;
}
/** A banner the host found, in its frame. */
interface FoundBanner extends CookieBannerChoice {
  readonly frame: HostedFrame;
}

/** One read of every frame's banners, with the isolated worlds it was read in, for pressing and verifying. */
interface BannerRound {
  /** The main frame's document: a new one is a new page load. */
  readonly loader: string;
  readonly banners: readonly FoundBanner[];
  /** Whether the banner still shows, has faded but is still laid out, or is gone, its frame's owners included. */
  state(banner: FoundBanner): Promise<'shown' | 'faded' | 'gone'>;
  /** A live handle on the control, confirmed in the banner's world as the very node read; undefined for none. */
  handle(banner: FoundBanner, control: number): Promise<ElementHandle | undefined>;
  close(): Promise<void>;
}

async function call(hosted: HostedFrame, expression: string, ms = PROTOCOL_READ_TIMEOUT_MS): Promise<unknown> {
  const answer = await bounded(
    hosted.session.send('Runtime.evaluate', {
      contextId: hosted.context,
      expression: `globalThis.${LIBRARY}.${expression}`,
      returnByValue: true,
    }),
    ms,
  );
  if (answer.exceptionDetails) throw new Error('The cookie-banner reader failed');
  const value: unknown = answer.result.value;
  return value;
}

/** A child frame's owner, resolved in its parent's world; undefined for the main frame or an unread parent. */
async function resolveOwner(
  frames: ReadonlyMap<string, HostedFrame>,
  child: HostedFrame,
  objectGroup: string,
): Promise<FrameOwner | undefined> {
  const parent = child.parentId ? frames.get(child.parentId) : undefined;
  if (!parent) return undefined;
  const { backendNodeId } = await bounded(parent.session.send('DOM.getFrameOwner', { frameId: child.id }));
  const { object } = await bounded(
    parent.session.send('DOM.resolveNode', { backendNodeId, executionContextId: parent.context, objectGroup }),
  );
  return object.objectId ? { parent, objectId: object.objectId } : undefined;
}

async function ownerFacts(owner: FrameOwner): Promise<{ shown: boolean; placed: boolean }> {
  const answer = await bounded(
    owner.parent.session.send('Runtime.callFunctionOn', {
      objectId: owner.objectId,
      functionDeclaration: `function () { return globalThis.${LIBRARY}.owner(this); }`,
      returnByValue: true,
    }),
  );
  const facts = answer.exceptionDetails ? undefined : record(answer.result.value);
  return { shown: facts?.shown === true, placed: facts?.placed === true };
}

/** Frame URLs as Playwright and the protocol both report them: without a fragment. */
const withoutFragment = (raw: string): string => raw.replace(/#.*$/u, '');

/** Reads every frame's banners once, keeping the sessions and worlds open until the round closes. */
async function readBanners(page: Page): Promise<BannerRound> {
  // One CDP session per target, the page's first; a frame that cannot be attached is not read.
  const sessions = await openTargetSessions(page, () => true);
  if (!sessions) throw new Error('The page has no session to read banners in');
  const objectGroup = `gws-ea-cookie-banners-${randomUUID()}`;
  const close = async (): Promise<void> => {
    await Promise.all(
      [...sessions.values()].map(async (session) => {
        await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
        await session.detach().catch(() => undefined);
      }),
    );
  };
  try {
    // Every frame the sessions host, each with a fresh isolated world holding the reader. A frame session or a
    // frame the host cannot read holds no banner it can press, so it is left unread.
    const { main, frames } = await installReaders(sessions.values(), READER, {
      unreadTree: true,
      unreadFrame: () => true,
    });
    if (!main || !frames.has(main.id)) throw new Error('The main frame could not be read for banners');
    const owners = new Map<string, FrameOwner>();
    const facts = new Map<string, { shown: boolean; placed: boolean }>();
    await Promise.all(
      [...frames.values()].map(async (hosted) => {
        try {
          const owner = await resolveOwner(frames, hosted, objectGroup);
          if (!owner) return;
          owners.set(hosted.id, owner);
          facts.set(hosted.id, await ownerFacts(owner));
          // eslint-disable-next-line no-catch-all/no-catch-all -- a frame whose owner cannot be read is not shown
        } catch (_error) {
          /* Left unshown. */
        }
      }),
    );
    // A frame shows when its owner shows and so does every frame around it; the main frame always does.
    const shownFrame = (hosted: HostedFrame | undefined): boolean =>
      hosted !== undefined &&
      (!hosted.parentId || (facts.get(hosted.id)?.shown === true && shownFrame(frames.get(hosted.parentId))));
    const banners: FoundBanner[] = [];
    await Promise.all(
      [...frames.values()].map(async (hosted) => {
        if (!shownFrame(hosted)) return;
        let regions: CookieBannerRegionRead[] | undefined;
        try {
          regions = parseRegions(await call(hosted, 'scan()', READ_TIMEOUT_MS));
        } catch (error) {
          if (!frameGone(error) && hosted.parentId === undefined) throw error;
        }
        for (const choice of chooseCookieBanners(regions ?? [], facts.get(hosted.id)?.placed === true))
          banners.push({ ...choice, frame: hosted });
      }),
    );
    // The main frame's banners first, then each frame's in the order the page's frames were read.
    const order = [...frames.keys()];
    banners.sort((left, right) => order.indexOf(left.frame.id) - order.indexOf(right.frame.id));
    const ownersShown = async (hosted: HostedFrame): Promise<boolean> => {
      for (let current: HostedFrame | undefined = hosted; current?.parentId; current = frames.get(current.parentId)) {
        const owner = owners.get(current.id);
        if (!owner || !(await ownerFacts(owner)).shown) return false;
      }
      return true;
    };
    return {
      loader: main.loaderId,
      banners,
      async state(banner) {
        try {
          // A frame whose owner left the page took its banner with it, its own session too.
          if (!(await ownersShown(banner.frame))) return 'gone';
          const state = await call(banner.frame, `state(${banner.region})`);
          return state === 'shown' || state === 'faded' ? state : 'gone';
          // eslint-disable-next-line no-catch-all/no-catch-all -- any other failed read leaves the banner standing
        } catch (error) {
          return frameGone(error) ? 'gone' : 'shown';
        }
      },
      async handle(banner, control) {
        const selector = isolationSelector(page.context());
        const steps = await call(banner.frame, `path(${control})`);
        if (!selector || !Array.isArray(steps) || !steps.every((step) => Number.isInteger(step))) return undefined;
        const name = await selector;
        for (const frame of page.frames()) {
          if (withoutFragment(frame.url()) !== withoutFragment(banner.frame.url)) continue;
          const found = await frame.evaluateHandle(`(${WALK})(${JSON.stringify(steps)})`);
          const element = found.asElement();
          if (!element) {
            await found.dispose();
            continue;
          }
          const eventName = `gws-ea-auth-${randomUUID()}`;
          let confirmed = false;
          try {
            await call(banner.frame, `arm(${JSON.stringify(eventName)})`);
            await (await element.$(`${name}=${eventName}`))?.dispose();
            confirmed = (await call(banner.frame, `identify(${JSON.stringify(eventName)}, ${control})`)) === true;
          } finally {
            await call(banner.frame, `disarm(${JSON.stringify(eventName)})`).catch(() => undefined);
            if (!confirmed) await element.dispose();
          }
          if (confirmed) return element;
        }
        return undefined;
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}

// ---------------------------------------------------------------- the pass

const loads = new WeakMap<Page, CookieBannerLoad & { readonly loader: string }>();

/** What the host already did on the page's current load; a new main document starts clean. */
function loadFor(page: Page, loader: string): CookieBannerLoad {
  let load = loads.get(page);
  if (load?.loader !== loader) {
    load = { loader, opened: false };
    loads.set(page, load);
  }
  return load;
}

/**
 * A real click on the control: found and confirmed in the isolated world, then pressed through the one
 * activation boundary every host press takes, which reads it fresh as ordinary and keeps Playwright's
 * hit-target check, never forced or dispatched.
 */
async function press(
  page: Page,
  round: BannerRound,
  banner: FoundBanner,
  control: number,
  assertActive?: () => Promise<void>,
): Promise<'pressed' | 'refused' | 'failed'> {
  let element: ElementHandle | undefined;
  try {
    const target = await round.handle(banner, control);
    element = target;
    if (!target) return 'failed';
    await activateControl(
      page,
      target,
      async () => {
        await assertActive?.();
        await target.click({ timeout: PRESS_TIMEOUT_MS });
      },
      undefined,
      { kind: 'click', assertActive, remaining: () => PRESS_TIMEOUT_MS },
    );
    return 'pressed';
    // eslint-disable-next-line no-catch-all/no-catch-all -- a press that cannot complete is a reject that failed
  } catch (error) {
    return error instanceof BrowserActivationError ? 'refused' : 'failed';
  } finally {
    await element?.dispose().catch(() => undefined);
  }
}

/** Whether the pressed banner closes in time, then a short wait for it to finish fading out of the page. */
async function closes(round: BannerRound, banner: FoundBanner): Promise<boolean> {
  const answered = Date.now() + ANSWER_WAIT_MS;
  let state = await round.state(banner);
  while (state === 'shown') {
    if (Date.now() >= answered) return false;
    await sleep(POLL_MS);
    state = await round.state(banner);
  }
  const faded = Date.now() + FADE_WAIT_MS;
  while (state === 'faded' && Date.now() < faded) {
    await sleep(POLL_MS);
    state = await round.state(banner);
  }
  return true;
}

/** After a second layer opens, reads again until a reject shows, every banner has gone, or the wait ends. */
async function awaitSecondLayer(page: Page, assertActive?: () => Promise<void>): Promise<BannerRound> {
  const until = Date.now() + ANSWER_WAIT_MS;
  for (;;) {
    await assertActive?.();
    const round = await readBanners(page);
    if (!round.banners.length || round.banners.some((banner) => banner.reject !== undefined) || Date.now() >= until)
      return round;
    await round.close();
    await sleep(POLL_MS);
  }
}

/**
 * The cookie-banner pass the host runs before an observation (R18), inside the job's operation so its clicks run
 * under the job's navigation guard. Answers what the observation reports, or undefined when no banner shows.
 * It never fails an observation: a page it cannot read keeps its banner for the agent.
 */
export async function settleCookieBanners(
  page: Page,
  assertActive?: () => Promise<void>,
): Promise<CookieBannerReport | undefined> {
  let round: BannerRound | undefined;
  try {
    if (page.isClosed() || !/^https?:/u.test(page.url()) || !isolationSelector(page.context())) return undefined;
    await assertActive?.();
    round = await readBanners(page);
    let load = loadFor(page, round.loader);
    // At most a second layer, then a reject: the loop ends within two presses.
    for (;;) {
      const step = nextCookieBannerStep(round.banners, load);
      switch (step.kind) {
        case 'none':
          return undefined;
        case 'report':
          return { status: step.status };
        case 'reject': {
          const pressed = await press(page, round, step.banner, step.control, assertActive);
          load.after = pressed === 'refused' ? 'no_reject_option' : 'reject_failed';
          if (pressed !== 'pressed' || !(await closes(round, step.banner))) return { status: load.after };
          load.after = 'reappeared';
          return { status: 'rejected' };
        }
        case 'open': {
          load.opened = true;
          if ((await press(page, round, step.banner, step.control, assertActive)) !== 'pressed')
            return { status: 'no_reject_option' };
          await round.close();
          round = undefined;
          round = await awaitSecondLayer(page, assertActive);
          // A second layer that loaded a new page is that page's own, already opened.
          load = loadFor(page, round.loader);
          load.opened = true;
          break;
        }
      }
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- a banner the host cannot settle stays on the page for the agent
  } catch (_error) {
    return undefined;
  } finally {
    await round?.close();
  }
}
