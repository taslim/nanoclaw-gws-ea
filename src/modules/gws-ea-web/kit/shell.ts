import { getGwsEaProfile } from '../../gws-ea-profile/db.js';
import { principalPages, type PrincipalPageMount, type WebMountPath } from '../mounts.js';
import { pageScript } from './client.js';
import { escapeHtml } from './html.js';
import { KIT_STYLE } from './style.js';

export interface ShellPage {
  readonly title: string;
  readonly path: WebMountPath;
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
      .map(({ title, path }) => ({ title, path })),
  };
}

export interface PrincipalPage {
  readonly shell: Shell;
  /** The registered page this document belongs to, marked as current in the navigation. */
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
      ({ title, path }) =>
        `<li><a href="${escapeHtml(path)}" data-navigation${path === current ? ' aria-current="page"' : ''}>${escapeHtml(title)}</a></li>`,
    )
    .join('')}</ul></nav>`;
}

/**
 * A menu button and the menu it opens. Items are `role="menuitem"` controls with `tabindex="-1"`, which the
 * kit's script moves focus between.
 */
export function renderMenu(id: string, label: string, items: readonly string[]): string {
  return `<div class="menu"><button class="button button-secondary" type="button" data-menu-button aria-haspopup="menu" aria-expanded="false" aria-controls="${escapeHtml(id)}">${escapeHtml(label)}</button><div role="menu" id="${escapeHtml(id)}" aria-label="${escapeHtml(label)}" hidden>${items.join('')}</div></div>`;
}

/** Copies the text of the element with `sourceId`; the result is announced as well as shown. */
export function renderCopyButton(sourceId: string, label: string): string {
  return `<button class="button button-secondary" type="button" data-copy-from="${escapeHtml(sourceId)}" aria-label="${escapeHtml(label)}"><span data-copy-label>Copy</span></button>`;
}

export function renderPrincipalPage(spec: PrincipalPage, nonce: string): string {
  const { shell } = spec;
  const pageTitle = shell.pages.find(({ path }) => path === spec.page)?.title;
  const title = [spec.title, ...(pageTitle && pageTitle !== spec.title ? [pageTitle] : []), shell.assistantName]
    .map(escapeHtml)
    .join(' · ');
  const attribute = escapeHtml(nonce);
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><title>${title}</title><style nonce="${attribute}">${KIT_STYLE}${spec.style ?? ''}</style></head><body><header class="shell"><p class="shell-name">${escapeHtml(shell.assistantName)}</p>${navigation(shell, spec.page)}</header><main tabindex="-1" data-view="${escapeHtml(spec.view)}"${spec.narrow ? ' data-width="narrow"' : ''}><p id="outcome" role="${spec.error ? 'alert' : 'status'}" tabindex="-1" data-error="${spec.error}"${spec.outcome ? '' : ' hidden'}>${escapeHtml(spec.outcome)}</p>${spec.content}${spec.noscript ? `<noscript><p class="field-hint">${escapeHtml(spec.noscript)}</p></noscript>` : ''}</main><p id="announcer" class="sr-only" role="status" aria-live="polite"></p><dialog id="confirm-dialog" aria-labelledby="confirm-heading" aria-describedby="confirm-description"><h2 id="confirm-heading"></h2><p id="confirm-description"></p><div class="dialog-actions"><button class="button button-secondary" type="button" id="confirm-cancel" data-dialog-close>Cancel</button><button class="button button-danger" type="button" id="confirm-action"></button></div></dialog><script nonce="${attribute}">${pageScript(spec.script)}</script></body></html>`;
}
