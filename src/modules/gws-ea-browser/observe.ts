import type { ElementHandle, Frame, Page } from 'playwright-core';

export interface BrowserObservation {
  generation: number;
  url: string;
  snapshot: string;
  delta?: { removed: string[]; added: string[] };
}
export interface BrowserRef {
  ref: string;
  generation: number;
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
}
const pages = new WeakMap<Page, PageObservationState>();

function stateFor(page: Page): PageObservationState {
  let state = pages.get(page);
  if (!state) {
    state = { generation: 0, url: '', snapshot: '', secrets: new Set(), activeSecrets: new Set() };
    pages.set(page, state);
  }
  return state;
}

/** Secret values stay host-only, including after a field was cleared or navigation completed. */
export function registerPageSecret(page: Page, value: string): void {
  if (!value) return;
  const state = stateFor(page);
  state.secrets.add(value);
  state.activeSecrets.add(value);
}
export function releasePageSecret(page: Page, value: string): void {
  stateFor(page).activeSecrets.delete(value);
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
        present = true;
      }
  }
  return present;
}

export async function pageHasSecret(page: Page): Promise<boolean> {
  return (await collectSecretFields(page)) || stateFor(page).activeSecrets.size > 0;
}

export async function observePage(page: Page): Promise<BrowserObservation> {
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
  return { generation: state.generation, url, snapshot, ...(delta ? { delta } : {}) };
}

export class BrowserRefError extends Error {
  constructor(readonly reason: 'stale_ref' | 'not_actionable') {
    super(reason);
  }
}

/** Resolve the entire batch before another snapshot can replace e1 with a different element. */
export async function pinBrowserRefs(page: Page, refs: readonly BrowserRef[]): Promise<Map<string, PinnedBrowserRef>> {
  const state = stateFor(page);
  if (refs.some((ref) => ref.generation !== state.generation || !/^e\d+$/u.test(ref.ref)))
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
