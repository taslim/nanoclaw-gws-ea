import { getGwsEaProfile } from '../../gws-ea-profile/db.js';
import { principalPages, type PrincipalPageMount, type WebMountPath } from '../mounts.js';
import { pageScript } from './client.js';
import { escapeHtml, icon, type IconName } from './html.js';
import { KIT_STYLE } from './style.js';

export interface ShellPage {
  readonly title: string;
  readonly path: WebMountPath;
  readonly icon?: IconName;
}
export interface Shell {
  readonly assistantName: string;
  /** Home first, then every other principal page in registration order. */
  readonly pages: readonly ShellPage[];
}

/** Read per request, so a renamed assistant or a newly registered page shows on the next load. */
export async function readShell(pages: readonly PrincipalPageMount[] = principalPages()): Promise<Shell> {
  const profile = await getGwsEaProfile();
  return {
    assistantName: profile.assistant_display_name ?? 'Your assistant',
    pages: [...pages]
      .sort((left, right) => Number(right.path === '/') - Number(left.path === '/'))
      .map(({ title, path, icon: pageIcon }) => ({ title, path, ...(pageIcon ? { icon: pageIcon } : {}) })),
  };
}

export interface PrincipalPage {
  readonly shell: Shell;
  /** The registered page this document belongs to, marked as current in the navigation and the phone's tab bar. */
  readonly page: WebMountPath;
  /** This view's title; the document title adds the page's. */
  readonly title: string;
  readonly view: string;
  readonly narrow?: boolean;
  readonly outcome: string;
  readonly error: boolean;
  /** Trusted markup: every value in it must already be escaped. */
  readonly content: string;
  readonly noscript?: string;
  readonly style?: string;
  /** Runs inside the kit's script scope; see `pageScript`. */
  readonly script?: string;
}

function navigation(shell: Shell, current: WebMountPath): string {
  return `<nav class="shell-nav" aria-label="Pages"><ul>${shell.pages
    .map(
      ({ title, path, icon: pageIcon }) =>
        `<li><a href="${escapeHtml(path)}" data-navigation${path === current ? ' aria-current="page"' : ''}>${icon(pageIcon ?? 'apps', 'tab-icon')}<span>${escapeHtml(title)}</span></a></li>`,
    )
    .join('')}</ul></nav>`;
}

/**
 * A menu button and the menu it opens. Items are `role="menuitem"` controls with `tabindex="-1"`, which the
 * kit's script moves focus between. On a phone the menu is a sheet: it names what it acts on and ends with
 * Cancel, both of which a desktop dropdown leaves out.
 */
export function renderMenu(id: string, label: string, items: readonly string[], subject = ''): string {
  const sheetTop = `<div class="sheet-grab" data-sheet-grab aria-hidden="true">${subject ? `<p class="sheet-title">${escapeHtml(subject)}</p>` : ''}</div>`;
  const cancel =
    '<button class="sheet-cancel" type="button" role="menuitem" tabindex="-1" data-menu-close>Cancel</button>';
  return `<div class="menu"><button class="button icon-button" type="button" data-menu-button aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeHtml(id)}" aria-label="${escapeHtml(label)}">${icon('more')}</button><div role="menu" id="${escapeHtml(id)}" aria-label="${escapeHtml(label)}" hidden>${sheetTop}${items.join('')}${cancel}</div></div>`;
}

export type BadgeTone = 'neutral' | 'success' | 'warning' | 'accent';

/** A pill that names a status in words; the tone only repeats it. A label that is not a status has no dot. */
export function renderBadge(label: string, tone: BadgeTone = 'neutral', status = true): string {
  const classes = ['badge', ...(tone === 'neutral' ? [] : [`badge-${tone}`]), ...(status ? [] : ['badge-plain'])];
  return `<span class="${classes.join(' ')}">${escapeHtml(label)}</span>`;
}

/** `metadata` and `action` are trusted markup. */
export function renderPageHeading(title: string, metadata = '', action = ''): string {
  return `<div class="page-heading"><div><h1>${escapeHtml(title)}</h1>${metadata ? `<div class="page-metadata">${metadata}</div>` : ''}</div>${action}</div>`;
}

/** Named for where it goes, so it reads the same wherever it appears. */
export function renderBackLink(href: string, label: string): string {
  return `<a class="back-link" href="${escapeHtml(href)}" data-navigation>${icon('chevron-back')}<span>${escapeHtml(label)}</span></a>`;
}

/** `action` is trusted markup. */
export function renderEmptyState(title: string, iconName: IconName, action = '', extraClass = '', id = ''): string {
  return `<section class="empty-state${extraClass ? ` ${extraClass}` : ''}"${id ? ` id="${escapeHtml(id)}" hidden` : ''}><span class="empty-icon">${icon(iconName)}</span><h2>${escapeHtml(title)}</h2>${action}</section>`;
}

/** Copies the text of the element with `sourceId`; the result is announced as well as shown. */
export function renderCopyButton(sourceId: string, label: string): string {
  return `<button class="button button-secondary" type="button" data-copy-from="${escapeHtml(sourceId)}" aria-label="${escapeHtml(label)}"><span data-copy-label>Copy</span></button>`;
}

function initial(name: string): string {
  return ([...name.trim()][0] ?? '•').toLocaleUpperCase();
}

export function renderPrincipalPage(spec: PrincipalPage, nonce: string): string {
  const { shell } = spec;
  const pageTitle = shell.pages.find(({ path }) => path === spec.page)?.title;
  const title = [spec.title, ...(pageTitle && pageTitle !== spec.title ? [pageTitle] : []), shell.assistantName]
    .map(escapeHtml)
    .join(' · ');
  const attribute = escapeHtml(nonce);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover"><meta name="color-scheme" content="light dark"><meta name="theme-color" content="#ffffff" media="(prefers-color-scheme: light)"><meta name="theme-color" content="#0b0b0c" media="(prefers-color-scheme: dark)"><title>${title}</title><style nonce="${attribute}">${KIT_STYLE}${spec.style ?? ''}</style></head><body><header class="shell"><p class="shell-name"><span class="shell-mark" aria-hidden="true">${escapeHtml(initial(shell.assistantName))}</span><span>${escapeHtml(shell.assistantName)}</span></p><p class="appbar-title" aria-hidden="true"></p>${navigation(shell, spec.page)}</header><main tabindex="-1" data-view="${escapeHtml(spec.view)}"${spec.narrow ? ' data-width="narrow"' : ''}><p id="outcome" role="${spec.error ? 'alert' : 'status'}" tabindex="-1" data-error="${spec.error}"${spec.outcome ? '' : ' hidden'}>${escapeHtml(spec.outcome)}</p>${spec.content}${spec.noscript ? `<noscript><p class="field-hint">${escapeHtml(spec.noscript)}</p></noscript>` : ''}</main><p id="announcer" class="sr-only" role="status" aria-live="polite"></p><dialog id="confirm-dialog" aria-labelledby="confirm-heading" aria-describedby="confirm-description"><div class="sheet-grab" data-sheet-grab aria-hidden="true"></div><h2 id="confirm-heading"></h2><p id="confirm-description"></p><div class="dialog-actions"><button class="button button-secondary" type="button" id="confirm-cancel" data-dialog-close>Cancel</button><button class="button button-danger" type="button" id="confirm-action"></button></div></dialog><script nonce="${attribute}">${pageScript(spec.script)}</script></body></html>`;
}
