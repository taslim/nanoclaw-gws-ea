import type { ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { invalidArgs } from '../../cli/delivery-action.js';
import { isRecord } from '../../gws-ea/validation.js';
import { httpsOrigin } from './authentication-signatures.js';
import {
  browserDocumentIdentity,
  browserPageReplayUrl,
  collectSecretFields,
  redactPageText,
  type BrowserDocumentIdentity,
  type BrowserReplayUrl,
} from './page-privacy.js';
import type { CookieBannerReport } from './cookie-banners.js';

/** A challenge is a blocked public read, including when it changed a recipe checkpoint. */
export function hasBrowserChallenge(snapshot: string): boolean {
  return /(?:captcha|verify (?:that )?you are human|access denied|unusual traffic|checking your browser)/iu.test(
    snapshot,
  );
}

export interface BrowserObservation {
  generation: number;
  url: string;
  snapshot: string;
  delta?: { removed: string[]; added: string[] };
  site?: { origin: string; untrusted: true; [key: string]: unknown };
  /** What the host did about a cookie banner just before this observation (R18); absent when none showed. */
  cookie_banner?: CookieBannerReport;
}
export interface BrowserRef {
  ref: string;
  generation: number;
}

export const BROWSER_REF_PATTERN = /^(?:f\d+)?e\d+$/u;

export function readBrowserRef(raw: unknown, message: string): BrowserRef {
  if (
    !isRecord(raw) ||
    Object.keys(raw).some((key) => !['ref', 'generation'].includes(key)) ||
    typeof raw.ref !== 'string' ||
    !BROWSER_REF_PATTERN.test(raw.ref) ||
    !Number.isInteger(raw.generation) ||
    Number(raw.generation) < 1
  )
    throw invalidArgs(message);
  return { ref: raw.ref, generation: Number(raw.generation) };
}
export interface PinnedBrowserRef extends BrowserRef {
  element: ElementHandle;
  frame: Frame;
}
interface PageObservationState {
  generation: number;
  url: string;
  snapshot: string;
  siteOriginsKey?: string;
  structure?: BrowserStructure;
  document?: BrowserDocumentIdentity;
}
export interface BrowserStructure {
  readonly generation: number;
  readonly url: string;
  readonly tree: unknown;
  readonly replayUrl?: BrowserReplayUrl;
}

/** Presentation of the supported structured snapshot. Refs come from that same native snapshot. */
function presentStructure(tree: unknown, depth = 0): string[] {
  if (Array.isArray(tree)) return tree.flatMap((node) => presentStructure(node, depth));
  if (!isRecord(tree) || typeof tree.role !== 'string') return [];
  const indent = '  '.repeat(depth);
  if (tree.role === 'text') return [`${indent}- text: ${JSON.stringify(String(tree.text ?? ''))}`];
  let label = tree.role;
  if (typeof tree.name === 'string' && tree.name) label += ` ${JSON.stringify(tree.name)}`;
  for (const name of ['checked', 'disabled', 'expanded', 'active', 'invalid', 'level', 'pressed', 'selected']) {
    const value = tree[name];
    if (value === true) label += ` [${name}]`;
    else if (typeof value === 'string' || typeof value === 'number') label += ` [${name}=${JSON.stringify(value)}]`;
  }
  if (typeof tree.ref === 'string') label += ` [ref=${tree.ref}]`;
  if (tree.cursor === 'pointer') label += ' [cursor=pointer]';
  const properties = ['url', 'placeholder'].flatMap((key) =>
    typeof tree[key] === 'string' ? [`${indent}  - /${key}: ${JSON.stringify(tree[key])}`] : [],
  );
  const children = presentStructure(tree.children, depth + 1);
  if (!properties.length && !children.length && typeof tree.text === 'string')
    return [`${indent}- ${label}: ${JSON.stringify(tree.text)}`];
  return [
    `${indent}- ${label}${properties.length || children.length ? ':' : ''}`,
    ...properties,
    ...(typeof tree.text === 'string' ? [`${indent}  - text: ${JSON.stringify(tree.text)}`] : children),
  ];
}

/** Immutable safe facts from the most recent core observation; never refreshes refs or reads a page. */
export function browserStructureFacts(page: Page): BrowserStructure | undefined {
  const state = stateFor(page);
  return state.structure?.replayUrl &&
    state.structure.replayUrl === browserPageReplayUrl(page) &&
    state.document === browserDocumentIdentity(page)
    ? structuredClone(state.structure)
    : undefined;
}
const pages = new WeakMap<Page, PageObservationState>();

function stateFor(page: Page): PageObservationState {
  let state = pages.get(page);
  if (!state) {
    state = {
      generation: 0,
      url: '',
      snapshot: '',
    };
    pages.set(page, state);
  }
  return state;
}

type BrowserSiteInfoProvider = (
  page: Page,
  origin: string,
  assertActive?: () => Promise<void>,
) => Promise<Record<string, unknown>>;
const siteInfoProviders: BrowserSiteInfoProvider[] = [];
/** Host-owned optional enrichment. It receives an origin only and never page-authored instructions. */
export function registerBrowserSiteInfoProvider(provider: BrowserSiteInfoProvider): void {
  siteInfoProviders.push(provider);
}

export interface ObservePageOptions {
  /** What the host did about a cookie banner just before this observation (R18), for it to report. */
  readonly cookieBanner?: CookieBannerReport | undefined;
}

export async function observePage(
  page: Page,
  assertActive?: () => Promise<void>,
  options: ObservePageOptions = {},
): Promise<BrowserObservation> {
  const state = stateFor(page);
  const structure = await snapshotBrowserStructure(page);
  const url = structure.url;
  const snapshot = presentStructure(structure.tree).join('\n');
  const previous = new Set(state.snapshot.split('\n'));
  const current = new Set(snapshot.split('\n'));
  const delta =
    state.url === url && state.snapshot
      ? {
          removed: [...previous].filter((line) => !current.has(line)),
          added: [...current].filter((line) => !previous.has(line)),
        }
      : undefined;
  state.url = url;
  state.snapshot = snapshot;
  let site: BrowserObservation['site'];
  try {
    const current = new URL(page.url());
    const domain = getDomain(current.hostname, { allowPrivateDomains: true });
    // A login iframe attached after the page's first observation brings its own origin's vault items.
    const origins = new Set([current.origin]);
    for (const frame of page.frames()) {
      const origin = httpsOrigin(frame.url());
      if (origin) origins.add(origin.origin);
    }
    const originsKey = JSON.stringify([current.origin, [...origins].sort()]);
    if (current.protocol === 'https:' && domain && state.siteOriginsKey !== originsKey && siteInfoProviders.length) {
      site = { origin: current.origin, untrusted: true };
      for (const provider of siteInfoProviders) Object.assign(site, await provider(page, current.origin, assertActive));
      site = JSON.parse(redactPageText(page, JSON.stringify(site))) as BrowserObservation['site'];
      state.siteOriginsKey = originsKey;
    }
  } catch (_error) {
    /* Optional site metadata cannot prevent a redacted observation. */
  }
  return {
    generation: state.generation,
    url,
    snapshot,
    ...(delta ? { delta } : {}),
    ...(site ? { site } : {}),
    ...(options.cookieBanner ? { cookie_banner: options.cookieBanner } : {}),
  };
}

/** Structured host checkpoints replace native refs just like agent observations do. */
export async function snapshotBrowserStructure(page: Page): Promise<BrowserStructure> {
  await collectSecretFields(page);
  const state = stateFor(page);
  const generation = ++state.generation;
  const document = browserDocumentIdentity(page);
  const tree: unknown = await page.locator('body').ariaSnapshotJSON({ mode: 'ai' });
  if (document !== browserDocumentIdentity(page)) throw new BrowserRefError('stale_ref');
  const structure = {
    generation,
    url: redactPageText(page, page.url()),
    tree: JSON.parse(redactPageText(page, JSON.stringify(tree))) as unknown,
    replayUrl: browserPageReplayUrl(page),
  };
  state.document = document;
  state.structure = structure;
  return structuredClone(structure);
}

export class BrowserRefError extends Error {
  constructor(readonly reason: 'stale_ref' | 'not_actionable') {
    super(reason);
  }
}

/** Resolve the entire batch before another snapshot can replace e1 with a different element. */
export async function pinBrowserRefs(page: Page, refs: readonly BrowserRef[]): Promise<Map<string, PinnedBrowserRef>> {
  const state = stateFor(page);
  if (
    refs.length &&
    (state.document !== browserDocumentIdentity(page) ||
      refs.some((ref) => ref.generation !== state.generation || !BROWSER_REF_PATTERN.test(ref.ref)))
  )
    throw new BrowserRefError('stale_ref');
  const pinned = new Map<string, PinnedBrowserRef>();
  try {
    for (const ref of refs) {
      if (pinned.has(ref.ref)) continue;
      const element = await page.getByRef(ref.ref).elementHandle({ timeout: 1_000 });
      const frame = await element?.ownerFrame();
      if (!element || !frame) throw new BrowserRefError('not_actionable');
      pinned.set(ref.ref, { ...ref, element, frame });
    }
    return pinned;
  } catch (error) {
    for (const value of pinned.values()) await value.element.dispose();
    throw error;
  }
}

export async function disposeBrowserRefs(refs: ReadonlyMap<string, PinnedBrowserRef>): Promise<void> {
  for (const ref of refs.values()) await ref.element.dispose().catch(() => undefined);
}
