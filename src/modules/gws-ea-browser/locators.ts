import type { ElementHandle, Frame, Locator, Page } from 'playwright-core';
import { isRecord } from '../../gws-ea/validation.js';
import type { PinnedBrowserRef } from './observe.js';

export class BrowserLocatorError extends Error {}

type BrowserRole = Parameters<Frame['getByRole']>[0];
const roles = new Set<BrowserRole>([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);
function isRole(value: string): value is BrowserRole {
  return roles.has(value as BrowserRole);
}
interface AriaNode {
  role: string;
  name: string;
  children: AriaNode[];
  ref?: string;
}
export function ariaNodes(raw: unknown): AriaNode[] {
  if (Array.isArray(raw)) return raw.flatMap(ariaNodes);
  if (!isRecord(raw)) return [];
  const children = ariaNodes(raw.children);
  return typeof raw.role === 'string'
    ? [
        {
          role: raw.role,
          name: typeof raw.name === 'string' ? raw.name : '',
          children,
          ...(typeof raw.ref === 'string' ? { ref: raw.ref } : {}),
        },
      ]
    : children;
}
export function flatten(nodes: readonly AriaNode[]): AriaNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
export interface StructuredBrowserLocator {
  role: BrowserRole;
  name: string;
  ordinal: number;
  count: number;
  framePath: number[];
  frameUrls: string[];
}

export function checkpointUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) return url.href;
  url.searchParams.sort();
  return `${url.origin}${url.pathname}${url.search}`;
}
function framePath(frame: Frame): { framePath: number[]; frameUrls: string[] } {
  const path: number[] = [];
  const urls: string[] = [];
  let current: Frame | null = frame;
  while (current) {
    urls.unshift(checkpointUrl(current.url()));
    const parent: Frame | null = current.parentFrame();
    if (parent) {
      const ordinal = parent.childFrames().indexOf(current);
      if (ordinal < 0) throw new BrowserLocatorError('Detached frame');
      path.unshift(ordinal);
    }
    current = parent;
  }
  return { framePath: path, frameUrls: urls };
}
export async function captureLocator(
  target: PinnedBrowserRef,
  nodes: readonly AriaNode[],
): Promise<StructuredBrowserLocator> {
  const visited = new Set<string>();
  for (const node of nodes) {
    if (!isRole(node.role)) continue;
    const key = JSON.stringify([node.role, node.name]);
    if (visited.has(key)) continue;
    visited.add(key);
    const matches = target.frame.getByRole(node.role, { name: node.name, exact: true });
    const ordinal = await matches.evaluateAll((elements, element) => elements.indexOf(element), target.element);
    if (ordinal >= 0)
      return {
        role: node.role,
        name: node.name,
        ordinal,
        count: await matches.count(),
        ...framePath(target.frame),
      };
  }
  throw new BrowserLocatorError('No structured accessible locator for this target');
}
/** The roles a host-found control can carry: what a press can be aimed at. */
const PRESS_ROLES: readonly BrowserRole[] = ['button', 'link', 'menuitem', 'tab', 'option'];
/**
 * A host-found control's structured locator (KTD4): its role and accessible name as Playwright reads them, its
 * ordinal among their matches, and its frame path, so `resolveLocator` finds it again on a later read.
 */
export async function captureElementLocator(element: ElementHandle): Promise<StructuredBrowserLocator> {
  const frame = await element.ownerFrame();
  if (!frame) throw new BrowserLocatorError('Detached element');
  for (const role of PRESS_ROLES) {
    const all = frame.getByRole(role);
    const index = await all.evaluateAll((elements, target) => elements.indexOf(target), element);
    if (index < 0) continue;
    const [node] = ariaNodes(await all.nth(index).ariaSnapshotJSON({ timeout: 1_000 }));
    if (node?.role !== role) continue;
    const name = node.name;
    const matches = frame.getByRole(role, { name, exact: true });
    const ordinal = await matches.evaluateAll((elements, target) => elements.indexOf(target), element);
    if (ordinal >= 0) return { role, name, ordinal, count: await matches.count(), ...framePath(frame) };
  }
  throw new BrowserLocatorError('No structured accessible locator for this element');
}
/** The element a structured locator names, as a Playwright locator: its frames and its matches' count unchanged. */
export async function locateStructured(
  page: Page,
  target: StructuredBrowserLocator,
  checkMainUrl = true,
): Promise<Locator> {
  let frame = page.mainFrame();
  if (checkMainUrl && checkpointUrl(frame.url()) !== target.frameUrls[0])
    throw new BrowserLocatorError('Frame changed');
  for (let index = 0; index < target.framePath.length; index++) {
    const child = frame.childFrames()[target.framePath[index]];
    if (!child || checkpointUrl(child.url()) !== target.frameUrls[index + 1])
      throw new BrowserLocatorError('Frame changed');
    frame = child;
  }
  const matches = frame.getByRole(target.role, { name: target.name, exact: true });
  if ((await matches.count()) !== target.count) throw new BrowserLocatorError('Accessible element count changed');
  return matches.nth(target.ordinal);
}
export async function resolveLocator(
  page: Page,
  target: StructuredBrowserLocator,
  checkMainUrl = true,
): Promise<ElementHandle> {
  const element = await (await locateStructured(page, target, checkMainUrl)).elementHandle({ timeout: 1_000 });
  if (!element) throw new BrowserLocatorError('Element is absent');
  return element;
}

/** The existing core snapshot already owns exact accessible names, counts and native target identities. */
export function captureSnapshotLocator(target: PinnedBrowserRef, tree: unknown): StructuredBrowserLocator {
  const nodes = flatten(ariaNodes(tree));
  const node = nodes.find((candidate) => candidate.ref === target.ref);
  if (!node || !isRole(node.role)) throw new BrowserLocatorError('Snapshot target is unavailable');
  const framePrefix = (ref: string | undefined): string | undefined =>
    ref ? (/^(f\d+)?e\d+$/u.exec(ref)?.[1] ?? '') : undefined;
  const matches = nodes.filter(
    (candidate) =>
      candidate.role === node.role &&
      candidate.name === node.name &&
      framePrefix(candidate.ref) === framePrefix(node.ref),
  );
  return {
    role: node.role,
    name: node.name,
    ordinal: matches.indexOf(node),
    count: matches.length,
    ...framePath(target.frame),
  };
}
