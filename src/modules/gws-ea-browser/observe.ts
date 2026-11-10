import type { ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { invalidArgs } from '../../cli/delivery-action.js';
import { isRecord } from '../../gws-ea/validation.js';
import { httpsOrigin } from './authentication-signatures.js';
import {
  browserDocumentIdentity,
  browserPageReplayUrl,
  collectSecretFields,
  mainDocumentLoader,
  redactPageText,
  redactPageData,
  type BrowserReplayUrl,
} from './page-privacy.js';
import type { CookieBannerReport } from './cookie-banners.js';
import { withinTime } from './page-targets.js';

/** A challenge is a blocked public read, including when it changed a recipe checkpoint. */
export function hasBrowserChallenge(snapshot: string): boolean {
  return /(?:captcha|verify (?:that )?you are human|access denied|unusual traffic|checking your browser)/iu.test(
    snapshot,
  );
}

interface BrowserObservationBase {
  generation: number;
  url: string;
  site?: { origin: string; untrusted: true; [key: string]: unknown };
  /** What the host did about a cookie banner just before this observation; absent when none showed. */
  cookie_banner?: CookieBannerReport;
}
export interface BrowserSnapshotObservation extends BrowserObservationBase {
  snapshot: string;
  delta?: never;
}
/** Lines added and removed since the agent's last whole-page snapshot; refs on unchanged lines stay current. */
interface BrowserDeltaObservation extends BrowserObservationBase {
  delta: { removed: string[]; added: string[] };
  snapshot?: never;
}
export type BrowserObservation = BrowserSnapshotObservation | BrowserDeltaObservation;
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
/** What keeps an observation's refs current: its main-frame document, and no navigation of the frame a ref is in. */
interface RefScope {
  readonly mainNavigations: number;
  /** Absent when it could not be read; then any main-frame navigation counts as a new document. */
  readonly mainDocument: string | undefined;
  readonly frames: ReadonlyMap<Frame, number>;
}
interface PageObservationState {
  generation: number;
  /** The agent's last whole-page snapshot and its address, which a delta is measured from. */
  url: string;
  presented: string;
  /** The latest page read uncut, for host checks. */
  text: string;
  siteOriginsKey?: string;
  structure?: BrowserStructure;
  scope?: RefScope;
}
export interface BrowserStructure {
  readonly generation: number;
  readonly url: string;
  readonly tree: unknown;
  readonly replayUrl?: BrowserReplayUrl;
}

/** The most an agent's snapshot holds, in characters: well inside the agent's tool output limit on busy pages. */
export const BROWSER_SNAPSHOT_BUDGET = 12_000;
/** Kept within the budget for listing what was cut. */
const CUT_LIST_ROOM = 2_000;
const CUT_NAME_LENGTH = 60;
const DIALOG_ROLES = new Set(['dialog', 'alertdialog']);
const NO_NODES: ReadonlySet<AriaNode> = new Set();
const OWN_REF = /\[ref=(?:f\d+)?e\d+\]/u;

type AriaNode = Record<string, unknown> & { role: string };
function isAriaNode(value: unknown): value is AriaNode {
  return isRecord(value) && typeof value.role === 'string';
}
function ariaNodes(value: unknown): AriaNode[] {
  if (Array.isArray(value)) return value.flatMap(ariaNodes);
  return isAriaNode(value) ? [value] : [];
}

function nodeLabel(node: AriaNode): string {
  let label = node.role;
  if (typeof node.name === 'string' && node.name) label += ` ${JSON.stringify(node.name)}`;
  for (const name of ['checked', 'disabled', 'expanded', 'active', 'invalid', 'level', 'pressed', 'selected']) {
    const value = node[name];
    if (value === true) label += ` [${name}]`;
    else if (typeof value === 'string' || typeof value === 'number') label += ` [${name}=${JSON.stringify(value)}]`;
  }
  if (typeof node.ref === 'string') label += ` [ref=${node.ref}]`;
  if (node.cursor === 'pointer') label += ' [cursor=pointer]';
  return label;
}
function nodeProperties(node: AriaNode, indent: string): string[] {
  return ['url', 'placeholder'].flatMap((key) =>
    typeof node[key] === 'string' ? [`${indent}  - /${key}: ${JSON.stringify(node[key])}`] : [],
  );
}

/** Page text stays JSON-quoted, so it can never read as a line of its own. */
function presentNode(node: AriaNode, depth: number, shownElsewhere: ReadonlySet<AriaNode>): string[] {
  const indent = '  '.repeat(depth);
  if (node.role === 'text') return [`${indent}- text: ${JSON.stringify(String(node.text ?? ''))}`];
  const label = nodeLabel(node);
  const properties = nodeProperties(node, indent);
  const children = ariaNodes(node.children)
    .filter((child) => !shownElsewhere.has(child))
    .flatMap((child) => presentNode(child, depth + 1, shownElsewhere));
  if (!properties.length && !children.length && typeof node.text === 'string')
    return [`${indent}- ${label}: ${JSON.stringify(node.text)}`];
  return [
    `${indent}- ${label}${properties.length || children.length ? ':' : ''}`,
    ...properties,
    ...(typeof node.text === 'string' ? [`${indent}  - text: ${JSON.stringify(node.text)}`] : children),
  ];
}
function presentNodes(nodes: readonly AriaNode[]): string {
  return nodes.flatMap((node) => presentNode(node, 0, NO_NODES)).join('\n');
}
function textSize(lines: readonly string[]): number {
  return lines.reduce((total, line) => total + line.length + 1, 0);
}

function cutLabel(node: AriaNode): string {
  const name =
    typeof node.name === 'string' && node.name
      ? ` ${JSON.stringify(node.name.length > CUT_NAME_LENGTH ? `${node.name.slice(0, CUT_NAME_LENGTH)}…` : node.name)}`
      : '';
  return `${node.role}${name} [ref=${String(node.ref)}]`;
}

/** Shallow parts first: whatever goes unlisted sits inside a part whose ref the snapshot shows. */
function cutList(cut: ReadonlyArray<{ node: AriaNode; depth: number }>): string[] {
  if (!cut.length) return [];
  const listed = cut.filter(({ node }) => typeof node.ref === 'string').sort((a, b) => a.depth - b.depth);
  const lines = ['# Cut to fit. To read a part, observe with within set to its ref:'];
  let used = textSize(lines);
  let shown = 0;
  for (const { node } of listed) {
    const line = `#   ${cutLabel(node)}`;
    if (used + line.length + 1 > CUT_LIST_ROOM - 80) break;
    lines.push(line);
    used += line.length + 1;
    shown++;
  }
  if (shown < listed.length) lines.push(`#   …and ${listed.length - shown} more inside the parts shown above`);
  return lines;
}

/**
 * Bounds what the agent reads: an open dialog first, then the focused form, then the rest in page order. A part too
 * large for the space left is opened into its children; once the space is spent, the remaining parts are listed by
 * ref so a scoped read can reach every control.
 */
function compactSnapshot(roots: readonly AriaNode[], text: string): string {
  if (text.length <= BROWSER_SNAPSHOT_BUDGET) return text;
  const parents = new Map<AriaNode, AriaNode>();
  const order: AriaNode[] = [];
  const index = (node: AriaNode): void => {
    order.push(node);
    for (const child of ariaNodes(node.children)) {
      parents.set(child, node);
      index(child);
    }
  };
  roots.forEach(index);
  const ancestors = (node: AriaNode): AriaNode[] => {
    const found: AriaNode[] = [];
    for (let parent = parents.get(node); parent; parent = parents.get(parent)) found.push(parent);
    return found;
  };
  const isDialog = (node: AriaNode): boolean => DIALOG_ROLES.has(node.role);
  const dialog = order.filter((node) => isDialog(node) && !ancestors(node).some(isDialog)).at(-1);
  // A focused body reads as an active generic; only a focused control has a form worth leading with.
  const focus = order.filter((node) => node.active === true && node.role !== 'generic').at(-1);
  let form: AriaNode | undefined;
  if (focus && !(dialog && ancestors(focus).includes(dialog))) {
    for (const node of [focus, ...ancestors(focus)]) {
      if (textSize(presentNode(node, 0, NO_NODES)) > BROWSER_SNAPSHOT_BUDGET / 3) break;
      form = node;
      if (node.role === 'form') break;
    }
  }
  const leading = [dialog, form].filter((node): node is AriaNode => node !== undefined);
  const shownElsewhere = new Set(leading);
  const room = BROWSER_SNAPSHOT_BUDGET - CUT_LIST_ROOM;
  const lines: string[] = [];
  const cut: Array<{ node: AriaNode; depth: number }> = [];
  let used = 0;
  let spent = false;
  const visit = (node: AriaNode, depth: number): void => {
    if (spent) {
      cut.push({ node, depth });
      return;
    }
    const rendered = presentNode(node, depth, shownElsewhere);
    if (used + textSize(rendered) <= room) {
      lines.push(...rendered);
      used += textSize(rendered);
      return;
    }
    const indent = '  '.repeat(depth);
    const header = [`${indent}- ${nodeLabel(node)}:`, ...nodeProperties(node, indent)];
    const children =
      typeof node.text === 'string' ? [] : ariaNodes(node.children).filter((child) => !shownElsewhere.has(child));
    if (children.length && used + textSize(header) <= room) {
      lines.push(...header);
      used += textSize(header);
      for (const child of children) visit(child, depth + 1);
      return;
    }
    spent = true;
    cut.push({ node, depth });
  };
  for (const node of leading) visit(node, 0);
  for (const node of roots) if (!shownElsewhere.has(node)) visit(node, 0);
  return [...lines, ...cutList(cut)].join('\n');
}

function findRef(nodes: readonly AriaNode[], ref: string): AriaNode | undefined {
  for (const node of nodes) {
    if (node.ref === ref) return node;
    const found = findRef(ariaNodes(node.children), ref);
    if (found) return found;
  }
  return undefined;
}

/** Immutable safe facts from the most recent core observation; never refreshes refs or reads a page. */
export function browserStructureFacts(page: Page): BrowserStructure | undefined {
  const { structure, scope } = stateFor(page);
  return structure?.replayUrl &&
    scope &&
    structure.replayUrl === browserPageReplayUrl(page) &&
    navigationsFor(page).main === scope.mainNavigations
    ? structuredClone(structure)
    : undefined;
}
const pages = new WeakMap<Page, PageObservationState>();

function stateFor(page: Page): PageObservationState {
  let state = pages.get(page);
  if (!state) {
    state = {
      generation: 0,
      url: '',
      presented: '',
      text: '',
    };
    pages.set(page, state);
  }
  return state;
}

interface FrameNavigations {
  main: number;
  readonly frames: WeakMap<Frame, number>;
}
const navigations = new WeakMap<Page, FrameNavigations>();
/** Counted from a page's first snapshot; a ref compares only counts taken after it. */
function navigationsFor(page: Page): FrameNavigations {
  let counts = navigations.get(page);
  if (!counts) {
    const created: FrameNavigations = { main: 0, frames: new WeakMap() };
    page.on('framenavigated', (frame) => {
      created.frames.set(frame, (created.frames.get(frame) ?? 0) + 1);
      if (frame === page.mainFrame()) created.main++;
    });
    navigations.set(page, created);
    counts = created;
  }
  return counts;
}

/** A same-document navigation, such as a route change, keeps the main frame's document and every ref with it. */
async function mainDocumentCurrent(page: Page, scope: RefScope): Promise<boolean> {
  if (navigationsFor(page).main === scope.mainNavigations) return true;
  if (!scope.mainDocument) return false;
  return (await mainDocumentLoader(page).catch(() => undefined)) === scope.mainDocument;
}

/**
 * The iframe refs enclosing the frame whose refs carry `prefix`, outermost first; empty for the main frame, which
 * carries a prefix of its own once its page has had other frames.
 */
function framePath(nodes: readonly AriaNode[], prefix: string, path: readonly string[] = []): string[] | undefined {
  for (const node of nodes) {
    if (typeof node.ref !== 'string') continue;
    if (node.ref.startsWith(`${prefix}e`)) return [...path];
    const found = framePath(ariaNodes(node.children), prefix, node.role === 'iframe' ? [...path, node.ref] : path);
    if (found) return found;
  }
  return undefined;
}

/** A frame's own navigation, or any enclosing frame's, ends its refs; another frame's, such as an ad's, does not. */
async function frameCurrent(page: Page, tree: unknown, scope: RefScope, prefix: string): Promise<boolean> {
  const path = framePath(ariaNodes(tree), prefix);
  if (!path) return false;
  const counts = navigationsFor(page);
  for (const ref of path) {
    const element = await page
      .getByRef(ref)
      .elementHandle({ timeout: 1_000 })
      .catch(() => null);
    if (!element) return false;
    try {
      const frame = await element.contentFrame();
      if (!frame || scope.frames.get(frame) !== (counts.frames.get(frame) ?? 0)) return false;
    } finally {
      await element.dispose();
    }
  }
  return true;
}

async function refsCurrent(page: Page, refs: readonly BrowserRef[]): Promise<boolean> {
  const state = stateFor(page);
  const { structure, scope, generation } = state;
  if (
    !structure ||
    !scope ||
    refs.some((ref) => ref.generation !== generation || !BROWSER_REF_PATTERN.test(ref.ref)) ||
    !(await mainDocumentCurrent(page, scope))
  )
    return false;
  const prefixes = new Set(refs.flatMap((ref) => /^(f\d+)e\d+$/u.exec(ref.ref)?.[1] ?? []));
  for (const prefix of prefixes) if (!(await frameCurrent(page, structure.tree, scope, prefix))) return false;
  return state.generation === generation && state.scope === scope;
}

/** The latest page read uncut, for host checks such as challenge detection; agents receive the compact snapshot. */
export function observedPageText(page: Page): string {
  return stateFor(page).text;
}

interface BrowserSiteInfo {
  recipes?(origin: string): Promise<Record<string, unknown>>;
  vault?(origins: readonly string[], assertActive: () => Promise<void>): Promise<Record<string, unknown>>;
}
let siteInfo: BrowserSiteInfo = {};
/** Set by the composition; neither reader receives a Page or a native handle. */
export function configureBrowserSiteInfo(readers: BrowserSiteInfo): void {
  siteInfo = readers;
}

export interface ObservePageOptions {
  /** What the host did about a cookie banner just before this observation, for it to report. */
  readonly cookieBanner?: CookieBannerReport | undefined;
  readonly remaining?: () => number;
  readonly signal?: AbortSignal;
  /** A ref from the latest observation: present only that part of the page. */
  readonly within?: BrowserRef;
}

/** Allows optional site metadata up to ten seconds, reserving a second for the required answer. */
async function optionalSiteInfo(
  work: (assertActive: () => Promise<void>) => Promise<Record<string, unknown>>,
  unavailable: Record<string, unknown>,
  assertActive: (() => Promise<void>) | undefined,
  options: ObservePageOptions,
): Promise<Record<string, unknown>> {
  const allowance = Math.min(10_000, Math.max(0, (options.remaining?.() ?? 11_000) - 1_000));
  if (!allowance || options.signal?.aborted) return unavailable;
  let active = true;
  let stop: (() => void) | undefined;
  const interrupted = new Promise<never>((_resolve, reject) => {
    stop = () => reject(new Error('Site metadata interrupted'));
    options.signal?.addEventListener('abort', stop, { once: true });
  });
  const check = async (): Promise<void> => {
    if (!active || options.signal?.aborted) throw new Error('Site metadata allowance ended');
    await assertActive?.();
    if (!active || options.signal?.aborted) throw new Error('Site metadata allowance ended');
  };
  try {
    return await withinTime(Promise.race([Promise.resolve().then(() => work(check)), interrupted]), allowance);
  } catch {
    return unavailable;
  } finally {
    active = false;
    if (stop) options.signal?.removeEventListener('abort', stop);
  }
}

interface PageRead {
  readonly observation: BrowserObservationBase;
  readonly snapshot: string;
  /** Against the agent's last whole-page snapshot of the same address, when the caller asked for changes. */
  readonly delta?: { removed: string[]; added: string[] };
}

async function readPage(
  page: Page,
  assertActive: (() => Promise<void>) | undefined,
  options: ObservePageOptions,
  changes: boolean,
): Promise<PageRead> {
  const state = stateFor(page);
  if (options.within && !(await refsCurrent(page, [options.within]))) throw new BrowserRefError('stale_ref');
  const structure = await snapshotBrowserStructure(page);
  const url = structure.url;
  const roots = ariaNodes(structure.tree);
  state.text = presentNodes(roots);
  let snapshot: string;
  let delta: PageRead['delta'];
  if (options.within) {
    const part = findRef(roots, options.within.ref);
    if (!part) throw new BrowserRefError('not_actionable');
    snapshot = compactSnapshot([part], presentNodes([part]));
  } else {
    snapshot = compactSnapshot(roots, state.text);
    if (changes && state.url === url && state.presented) {
      // Counted, not deduplicated: one of two identical lines going away is a change too.
      const counts = new Map<string, number>();
      for (const line of state.presented.split('\n')) counts.set(line, (counts.get(line) ?? 0) - 1);
      for (const line of snapshot.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
      const changed = [...counts].filter(([, count]) => count !== 0);
      const removed = changed.filter(([, count]) => count < 0).map(([line]) => line);
      const added = changed.filter(([, count]) => count > 0).map(([line]) => line);
      // A changed line without its own ref cannot be placed, as text repeats across a page: show the snapshot.
      if (changed.every(([line]) => OWN_REF.test(line))) delta = { removed, added };
    }
    state.url = url;
    state.presented = snapshot;
  }
  let site: BrowserObservationBase['site'];
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
    if (
      current.protocol === 'https:' &&
      domain &&
      state.siteOriginsKey !== originsKey &&
      (siteInfo.recipes || siteInfo.vault)
    ) {
      site = { origin: current.origin, untrusted: true };
      const { recipes: readRecipes, vault: readVault } = siteInfo;
      const [recipes, vault] = await Promise.all([
        readRecipes
          ? optionalSiteInfo(
              () => readRecipes(current.origin),
              { recipes_status: 'unavailable' },
              assertActive,
              options,
            )
          : Promise.resolve<Record<string, unknown>>({}),
        readVault
          ? optionalSiteInfo(
              (check) => readVault([...origins], check),
              { vault_status: 'vault_unavailable' },
              assertActive,
              options,
            )
          : Promise.resolve<Record<string, unknown>>({}),
      ]);
      Object.assign(site, recipes, vault);
      site = redactPageData(page, site) as BrowserObservationBase['site'];
      if (!recipes.recipes_status && !vault.vault_status) state.siteOriginsKey = originsKey;
    }
  } catch (_error) {
    /* Optional site metadata cannot prevent a redacted observation. */
  }
  return {
    observation: {
      generation: structure.generation,
      url,
      ...(site ? { site } : {}),
      ...(options.cookieBanner ? { cookie_banner: options.cookieBanner } : {}),
    },
    snapshot,
    ...(delta ? { delta } : {}),
  };
}

/** An explicit look: always the compact snapshot, of the whole page or of the part `within` names. */
export async function observePage(
  page: Page,
  assertActive?: () => Promise<void>,
  options: ObservePageOptions = {},
): Promise<BrowserSnapshotObservation> {
  const { observation, snapshot } = await readPage(page, assertActive, options, false);
  const { generation, url, ...rest } = observation;
  return { generation, url, snapshot, ...rest };
}

/** The look after other actions: only what changed, when that is much shorter than the snapshot. */
export async function observePageChanges(
  page: Page,
  assertActive?: () => Promise<void>,
  options: Omit<ObservePageOptions, 'within'> = {},
): Promise<BrowserObservation> {
  const { observation, snapshot, delta } = await readPage(page, assertActive, options, true);
  const { generation, url, ...rest } = observation;
  return delta && JSON.stringify(delta).length * 2 < snapshot.length
    ? { generation, url, delta, ...rest }
    : { generation, url, snapshot, ...rest };
}

/** Map only structured native candidates to a real current public ref; display text never supplies identities. */
export async function browserRefForElement(
  page: Page,
  element: ElementHandle,
  target: { role: string; name?: string },
): Promise<BrowserRef> {
  const state = stateFor(page);
  const { structure, scope, generation } = state;
  if (!structure || !scope || !(await mainDocumentCurrent(page, scope))) throw new BrowserRefError('stale_ref');
  const refs = (tree: unknown): string[] => {
    if (Array.isArray(tree)) return tree.flatMap(refs);
    if (!isRecord(tree)) return [];
    const current =
      tree.role === target.role &&
      (target.name === undefined || tree.name === target.name) &&
      typeof tree.ref === 'string' &&
      BROWSER_REF_PATTERN.test(tree.ref)
        ? [tree.ref]
        : [];
    return [...current, ...refs(tree.children)];
  };
  for (const ref of refs(structure.tree)) {
    if (await page.getByRef(ref).evaluate((node, other) => node === other, element)) {
      if (state.generation !== generation || state.scope !== scope || !(await mainDocumentCurrent(page, scope)))
        throw new BrowserRefError('stale_ref');
      return { ref, generation };
    }
  }
  throw new BrowserRefError('not_actionable');
}

/** An ancillary native snapshot replaces Playwright's ref map even if its caller later fails. */
export function invalidateBrowserRefs(page: Page): void {
  const state = stateFor(page);
  state.generation++;
  state.scope = undefined;
  state.structure = undefined;
}

/** Structured host checkpoints replace native refs just like agent observations do. */
export async function snapshotBrowserStructure(page: Page): Promise<BrowserStructure> {
  await collectSecretFields(page);
  const state = stateFor(page);
  const counts = navigationsFor(page);
  const generation = ++state.generation;
  const document = browserDocumentIdentity(page);
  const scope: RefScope = {
    mainNavigations: counts.main,
    mainDocument: await mainDocumentLoader(page).catch(() => undefined),
    frames: new Map(page.frames().map((frame) => [frame, counts.frames.get(frame) ?? 0])),
  };
  const tree: unknown = await page.locator('body').ariaSnapshotJSON({ mode: 'ai' });
  // Any frame's navigation during the read may have brought a document the secret-field scan never saw.
  if (document !== browserDocumentIdentity(page)) throw new BrowserRefError('stale_ref');
  const structure = {
    generation,
    url: redactPageText(page, page.url()),
    tree: redactPageData(page, tree),
    replayUrl: browserPageReplayUrl(page),
  };
  state.scope = scope;
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
  if (refs.length && !(await refsCurrent(page, refs))) throw new BrowserRefError('stale_ref');
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
