import type { CDPSession, ElementHandle, Frame, Page } from 'playwright-core';
import { getDomain } from 'tldts';
import { invalidArgs } from '../../cli/delivery-action.js';
import { isRecord } from '../../gws-ea/validation.js';

export interface BrowserObservation {
  generation: number;
  url: string;
  snapshot: string;
  delta?: { removed: string[]; added: string[] };
  site?: { origin: string; untrusted: true; [key: string]: unknown };
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
  secrets: Set<string>;
  activeSecrets: Set<string>;
  observedSites: Set<string>;
  unboundSecretDocuments: Set<string>;
  secretDocumentLoaders: Set<string>;
}
const pages = new WeakMap<Page, PageObservationState>();

function stateFor(page: Page): PageObservationState {
  let state = pages.get(page);
  if (!state) {
    state = {
      generation: 0,
      url: '',
      snapshot: '',
      secrets: new Set(),
      activeSecrets: new Set(),
      observedSites: new Set(),
      unboundSecretDocuments: new Set(),
      secretDocumentLoaders: new Set(),
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

/** Secret values stay host-only, including after a field was cleared or navigation completed. */
export function registerPageSecret(page: Page, value: string): void {
  if (!value) return;
  const state = stateFor(page);
  state.secrets.add(value);
  state.activeSecrets.add(value);
  state.unboundSecretDocuments.add(value);
}
export function releasePageSecret(page: Page, value: string): void {
  stateFor(page).activeSecrets.delete(value);
}

const documentSessions = new WeakMap<Page, Promise<CDPSession>>();
interface DocumentTree {
  frame: { loaderId: string };
  childFrames?: DocumentTree[];
}
async function documentLoaders(page: Page): Promise<Set<string>> {
  let attached = documentSessions.get(page);
  if (!attached) {
    attached = page.context().newCDPSession(page);
    documentSessions.set(page, attached);
    page.once('close', () => {
      documentSessions.delete(page);
      void attached?.then((session) => session.detach()).catch(() => undefined);
    });
  }
  const session = await attached;
  const tree = await session.send('Page.getFrameTree');
  const loaders = new Set<string>();
  const visit = (node: DocumentTree): void => {
    if (node.frame.loaderId) loaders.add(node.frame.loaderId);
    node.childFrames?.forEach(visit);
  };
  visit(tree.frameTree);
  return loaders;
}

/** Bind taint to native document identities before inserting a value or consuming a bearer URL.
 * All current frames are tainted: same-origin scripts and postMessage can copy a value into another frame's canvas.
 * Loader IDs remain remembered for the page lifetime, including a back/forward-cache restoration.
 */
export async function bindPageSecretDocuments(page: Page, value: string): Promise<void> {
  const state = stateFor(page);
  const loaders = await documentLoaders(page);
  for (const loader of loaders) state.secretDocumentLoaders.add(loader);
  if (loaders.size) state.unboundSecretDocuments.delete(value);
}
export function redactPageText(page: Page, text: string): string {
  let result = text;
  for (const value of [...stateFor(page).secrets].sort((a, b) => b.length - a.length))
    result = result.split(value).join('[redacted]');
  return result.replace(
    /https?:\/\/[^\s"<>]*(?:[?&#](?:token|code|key|ticket|auth|secret|credential|signature|access_token|id_token)=)[^\s"<>]*/giu,
    '[redacted URL]',
  );
}

/** Host-owned inspection, never an agent-supplied expression or field-read tool. */
async function collectSecretFields(page: Page): Promise<boolean> {
  let present = false;
  for (const frame of page.frames()) {
    const values: unknown = await frame.evaluate(
      `Array.from(document.querySelectorAll('input')).filter(e => e.type === 'password' || /(?:one-time-code|cc-|credit-card)/i.test(e.autocomplete || '') || /(?:otp|verification.?code|security.?code)/i.test(e.name + ' ' + e.id)).map(e => e.value).filter(Boolean)`,
    );
    if (!Array.isArray(values)) continue;
    for (const value of values)
      if (typeof value === 'string' && value) {
        registerPageSecret(page, value);
        await bindPageSecretDocuments(page, value);
        present = true;
      }
  }
  return present;
}

export async function pageHasSecret(page: Page): Promise<boolean> {
  const state = stateFor(page);
  if ((await collectSecretFields(page)) || state.activeSecrets.size || state.unboundSecretDocuments.size) return true;
  if (!state.secretDocumentLoaders.size) return false;
  try {
    const loaders = await documentLoaders(page);
    return !loaders.size || [...loaders].some((loader) => state.secretDocumentLoaders.has(loader));
  } catch (_error) {
    return true;
  }
}

export async function observePage(page: Page, assertActive?: () => Promise<void>): Promise<BrowserObservation> {
  await collectSecretFields(page);
  const state = stateFor(page);
  const url = redactPageText(page, page.url());
  // This is the only snapshot producer. Every call invalidates all earlier refs.
  ++state.generation;
  const snapshot = redactPageText(page, await page.locator('body').ariaSnapshot({ mode: 'ai' }));
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
    if (current.protocol === 'https:' && domain && !state.observedSites.has(domain) && siteInfoProviders.length) {
      site = { origin: current.origin, untrusted: true };
      for (const provider of siteInfoProviders) Object.assign(site, await provider(page, current.origin, assertActive));
      site = JSON.parse(redactPageText(page, JSON.stringify(site))) as BrowserObservation['site'];
      state.observedSites.add(domain);
    }
  } catch (_error) {
    /* Optional site metadata cannot prevent a redacted observation. */
  }
  return { generation: state.generation, url, snapshot, ...(delta ? { delta } : {}), ...(site ? { site } : {}) };
}

/** Structured host checkpoints replace native refs just like agent observations do. */
export async function snapshotBrowserStructure(
  page: Page,
): Promise<{ generation: number; url: string; tree: unknown }> {
  await collectSecretFields(page);
  const generation = ++stateFor(page).generation;
  const tree: unknown = await page.locator('body').ariaSnapshotJSON({ mode: 'ai' });
  return {
    generation,
    url: redactPageText(page, page.url()),
    tree: JSON.parse(redactPageText(page, JSON.stringify(tree))) as unknown,
  };
}

export class BrowserRefError extends Error {
  constructor(readonly reason: 'stale_ref' | 'not_actionable') {
    super(reason);
  }
}

/** Resolve the entire batch before another snapshot can replace e1 with a different element. */
export async function pinBrowserRefs(page: Page, refs: readonly BrowserRef[]): Promise<Map<string, PinnedBrowserRef>> {
  const state = stateFor(page);
  if (refs.some((ref) => ref.generation !== state.generation || !BROWSER_REF_PATTERN.test(ref.ref)))
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
  } catch (_error) {
    for (const value of pinned.values()) await value.element.dispose();
    throw new BrowserRefError('stale_ref');
  }
}

export async function disposeBrowserRefs(refs: ReadonlyMap<string, PinnedBrowserRef>): Promise<void> {
  for (const ref of refs.values()) await ref.element.dispose().catch(() => undefined);
}
