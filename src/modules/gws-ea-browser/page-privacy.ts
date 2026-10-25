import type { CDPSession, Page } from 'playwright-core';
import { ControlFactsUnavailableError, readPageSecretValues } from './control-facts.js';

interface PagePrivacyState {
  secrets: Set<string>;
  activeSecrets: Set<string>;
  unboundSecretDocuments: Set<string>;
  secretDocumentLoaders: Set<string>;
}
const pages = new WeakMap<Page, PagePrivacyState>();
const documentIdentity = Symbol('browser document');
export interface BrowserDocumentIdentity {
  readonly [documentIdentity]: true;
}
const documents = new WeakMap<Page, BrowserDocumentIdentity>();

/** Native navigation invalidates every document-bound fact, including a same-URL reload or a frame replacement. */
export function browserDocumentIdentity(page: Page): BrowserDocumentIdentity {
  let identity = documents.get(page);
  if (!identity) {
    identity = { [documentIdentity]: true };
    documents.set(page, identity);
    page.on('framenavigated', () => documents.set(page, { [documentIdentity]: true }));
  }
  return identity;
}
function stateFor(page: Page): PagePrivacyState {
  let state = pages.get(page);
  if (!state) {
    state = {
      secrets: new Set(),
      activeSecrets: new Set(),
      unboundSecretDocuments: new Set(),
      secretDocumentLoaders: new Set(),
    };
    pages.set(page, state);
  }
  return state;
}

/** Redaction only: unlike `registerPageSecret`, the value does not mark the page as possibly showing a secret. */
export function registerPageRedaction(page: Page, value: string): void {
  if (!value) return;
  const secrets = stateFor(page).secrets;
  secrets.add(value);
  secrets.add(encodeURIComponent(value));
}

/** Secret values stay host-only, including after a field was cleared or navigation completed. */
export function registerPageSecret(page: Page, value: string): void {
  if (!value) return;
  const state = stateFor(page);
  registerPageRedaction(page, value);
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
/**
 * The page target's tree omits out-of-process frames. Their documents need no entry: none outlives the main-frame
 * document it was created under, and that document is always in this tree.
 */
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

/**
 * Call before inserting a value or consuming a bearer URL. Every current frame is tainted, since same-origin scripts
 * and postMessage can copy a value into another frame's canvas. Loader IDs stay tainted for the page's lifetime,
 * a back/forward-cache restoration included.
 */
export async function bindPageSecretDocuments(page: Page, value: string): Promise<void> {
  const state = stateFor(page);
  const loaders = await documentLoaders(page);
  for (const loader of loaders) state.secretDocumentLoaders.add(loader);
  if (loaders.size) state.unboundSecretDocuments.delete(value);
}
function redactText(text: string, secrets: readonly string[]): string {
  let result = text;
  for (const value of secrets) result = result.split(value).join('[redacted]');
  return result.replace(
    /https?:\/\/[^\s"<>]*(?:[?&#](?:[\w-]*token|code|key|ticket|auth|secret|credential|signature|reservation)=)[^\s"<>]*/giu,
    '[redacted URL]',
  );
}

export function redactPageText(page: Page, text: string): string {
  return redactText(
    text,
    [...stateFor(page).secrets].sort((a, b) => b.length - a.length),
  );
}

/** Case-insensitive: URL parsing lowercases the hostname a diagnostic records. */
export function pageHostnameIsPrivate(page: Page, hostname: string): boolean {
  const canonical = hostname.toLowerCase();
  return [...stateFor(page).secrets].some((secret) => canonical.includes(secret.toLowerCase()));
}

/** Redacts host-read structured values before serialization, keeping object keys and JSON syntax intact. */
export function redactPageData(page: Page, value: unknown): unknown {
  const secrets = [...stateFor(page).secrets].sort((a, b) => b.length - a.length);
  const visit = (item: unknown): unknown => {
    if (typeof item === 'string') return redactText(item, secrets);
    if (Array.isArray(item)) return item.map((child: unknown) => visit(child));
    if (typeof item === 'object' && item !== null) {
      const fields = item as Record<string, unknown>;
      return Object.fromEntries(Object.entries(fields).map(([key, child]) => [key, visit(child)]));
    }
    return item;
  };
  return visit(value);
}

declare const replayUrl: unique symbol;
export type BrowserReplayUrl = string & { readonly [replayUrl]: true };

/** Read from the native page, never from presentation text; undefined when redaction would change it. */
export function browserPageReplayUrl(page: Page): BrowserReplayUrl | undefined {
  const raw = page.url();
  if (!URL.canParse(raw) || redactPageText(page, raw) !== raw) return undefined;
  return new URL(raw).href as BrowserReplayUrl;
}

/** Registers each secret field's value for redaction and taints the current documents; true when it found one. */
export async function collectSecretFields(page: Page): Promise<boolean> {
  if (!page.frames().length) return false;
  const values = await readPageSecretValues(page);
  for (const value of values) {
    registerPageRedaction(page, value);
    stateFor(page).unboundSecretDocuments.add(value);
    await bindPageSecretDocuments(page, value);
  }
  return values.length > 0;
}

async function hostSecretOnPage(page: Page): Promise<boolean> {
  const state = stateFor(page);
  if (state.activeSecrets.size || state.unboundSecretDocuments.size) return true;
  if (!state.secretDocumentLoaders.size) return false;
  try {
    const loaders = await documentLoaders(page);
    return !loaders.size || [...loaders].some((loader) => state.secretDocumentLoaders.has(loader));
  } catch (_error) {
    return true;
  }
}

export async function pageHasSecret(page: Page): Promise<boolean> {
  return (await collectSecretFields(page)) || (await hostSecretOnPage(page));
}

/**
 * Whether a picture could show a secret: active exposure, observed or filled document taint, or an isolated-world
 * scan of every frame, shadow roots included, finds a field holding one. A scan that cannot complete counts as
 * finding one.
 */
export async function pageMayShowSecret(page: Page): Promise<boolean> {
  if (await hostSecretOnPage(page)) return true;
  try {
    return await collectSecretFields(page);
  } catch (error) {
    if (error instanceof ControlFactsUnavailableError) return true;
    throw error;
  }
}
