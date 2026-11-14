import { PAGE_LOCATION_HEADER, PAGE_SAVED_HEADER } from './headers.js';

/**
 * Behaviour every principal page shares. A form marked `data-send` posts its fields as same-origin JSON and
 * swaps in the `main` the server answers with; one that also carries `data-confirm-message` asks first in the
 * shell's confirmation dialog. While a change is in flight the page is locked, and leaving with a change in
 * flight or unsaved edits in a `data-track-changes` form asks first. After a response is lost the controls
 * stay locked, so an unconfirmed change is never sent twice.
 *
 * Dialogs keep focus inside while open and return it to the control that opened them. A `data-menu-button`
 * opens the `role="menu"` it controls, operated by arrow keys, Home, End and Escape. A `data-copy-from`
 * control copies the named element's text and reports the result in the shell's live region.
 */
const KIT_SCRIPT = String.raw`
  let busy = false;
  let pendingForm;
  const openers = new WeakMap();
  const confirmDialog = document.getElementById('confirm-dialog');
  const announcer = document.getElementById('announcer');
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  function focusables(root) {
    return [...root.querySelectorAll(FOCUSABLE)].filter(element => !element.disabled && element.getClientRects().length > 0);
  }
  function changed() {
    return [...document.querySelectorAll('form[data-track-changes] input:not([type="hidden"])')]
      .some(input => input.type === 'password' ? input.value !== '' : input.value !== input.defaultValue.replace(/[\r\n]/g, ''));
  }
  function message(text, reload = false) {
    const outcome = document.getElementById('outcome');
    outcome.hidden = false;
    outcome.dataset.error = 'true';
    outcome.setAttribute('role', 'alert');
    outcome.textContent = text;
    if (reload) {
      const link = document.createElement('a');
      link.href = location.pathname;
      link.textContent = 'Reload page';
      outcome.append(document.createTextNode(' '), link);
    }
    outcome.focus();
  }
  function announce(text) {
    announcer.textContent = '';
    setTimeout(() => { announcer.textContent = text; }, 50);
  }
  function menuOf(button) {
    return document.getElementById(button.getAttribute('aria-controls'));
  }
  function menuItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled);
  }
  function closeMenus(restore) {
    document.querySelectorAll('[data-menu-button][aria-expanded="true"]').forEach(button => {
      button.setAttribute('aria-expanded', 'false');
      menuOf(button).hidden = true;
      if (restore) button.focus();
    });
  }
  function openMenu(button, last = false) {
    closeMenus(false);
    button.setAttribute('aria-expanded', 'true');
    const menu = menuOf(button);
    menu.hidden = false;
    const items = menuItems(menu);
    (last ? items[items.length - 1] : items[0])?.focus();
  }
  // A control inside a menu is hidden once the menu closes, so focus returns to the menu's button.
  function returnPoint(control) {
    const menu = control?.closest('[role="menu"]');
    return menu ? document.querySelector('[data-menu-button][aria-controls="' + menu.id + '"]') : control;
  }
  function openDialog(dialog, opener, initial) {
    openers.set(dialog, returnPoint(opener ?? document.activeElement));
    closeMenus(false);
    dialog.showModal();
    (initial ?? focusables(dialog)[0])?.focus();
  }
  // The browser returns focus where it can; the opener takes it only if it was left nowhere.
  function closeDialog(dialog) {
    if (!dialog.open) return;
    dialog.close();
    if (dialog === confirmDialog) pendingForm = undefined;
    const opener = openers.get(dialog);
    openers.delete(dialog);
    const active = document.activeElement;
    if (opener?.isConnected && (!active || active === document.body || dialog.contains(active))) opener.focus();
  }
  async function send(form) {
    if (busy) return;
    busy = true;
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[data-omit-unchanged]').forEach(input => {
      if (input.value === input.defaultValue.replace(/[\r\n]/g, '')) delete data[input.name];
    });
    const controls = [...document.querySelectorAll('button, input')].filter(control => !control.disabled);
    const submit = form.querySelector('button[type="submit"]');
    const label = submit.textContent;
    submit.textContent = submit.dataset.pendingLabel || 'Saving…';
    controls.forEach(control => { control.disabled = true; });
    const links = [...document.querySelectorAll('a[data-navigation]')];
    links.forEach(link => { link.setAttribute('aria-disabled', 'true'); });
    document.querySelector('main').setAttribute('aria-busy', 'true');
    let uncertain = false;
    try {
      const response = await fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
        credentials: 'same-origin', cache: 'no-store',
      });
      if (response.status === 404) {
        uncertain = true;
        message('This request could not be accepted. Reload the page and try again.', true);
        return;
      }
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      const saved = response.headers.get('${PAGE_SAVED_HEADER}') === 'true';
      if (!next || (!response.ok && !saved)) {
        uncertain = response.status >= 500 || !next;
        message(page.getElementById('outcome')?.textContent ||
          'The request could not be confirmed. Reload the page before trying again.', uncertain || response.status === 409);
        return;
      }
      document.querySelector('main').replaceWith(next);
      document.title = page.title;
      history.replaceState(null, '', response.headers.get('${PAGE_LOCATION_HEADER}'));
      const outcome = document.getElementById('outcome');
      (outcome.textContent ? outcome : next).focus();
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      uncertain = true;
      message('The request could not be confirmed. Reload the page before trying again.', true);
    } finally {
      busy = false;
      submit.textContent = label;
      document.querySelector('main').removeAttribute('aria-busy');
      links.forEach(link => { link.removeAttribute('aria-disabled'); });
      if (!uncertain) controls.forEach(control => { control.disabled = false; });
    }
  }
  async function copy(button) {
    const source = document.getElementById(button.dataset.copyFrom);
    const label = button.querySelector('[data-copy-label]') ?? button;
    try {
      await navigator.clipboard.writeText(source.textContent);
      label.textContent = 'Copied';
      announce('Copied.');
    } catch {
      label.textContent = 'Copy failed';
      announce('Couldn’t copy. Select the text and copy it instead.');
    }
    setTimeout(() => { label.textContent = button.dataset.copyIdle; }, 2000);
  }
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-send')) return;
    event.preventDefault();
    if (busy) return;
    if (form.dataset.confirmMessage === undefined) { void send(form); return; }
    pendingForm = form;
    document.getElementById('confirm-heading').textContent = form.dataset.confirmTitle;
    document.getElementById('confirm-description').textContent = form.dataset.confirmMessage;
    const action = document.getElementById('confirm-action');
    action.textContent = form.dataset.confirmAction;
    openDialog(confirmDialog, event.submitter, document.getElementById('confirm-cancel'));
  });
  document.getElementById('confirm-action').addEventListener('click', () => {
    const form = pendingForm;
    closeDialog(confirmDialog);
    if (form) void send(form);
  });
  // Escape closes through the kit too, so every close returns focus at once. The close event cannot do it:
  // it may arrive late enough to find the dialog open again.
  document.addEventListener('cancel', event => {
    if (!(event.target instanceof HTMLDialogElement)) return;
    event.preventDefault();
    closeDialog(event.target);
  }, true);
  document.addEventListener('click', event => {
    if (!(event.target instanceof Element)) return;
    const closing = event.target.closest('[data-dialog-close]')?.closest('dialog');
    if (closing) { closeDialog(closing); return; }
    const menuButton = event.target.closest('[data-menu-button]');
    if (menuButton) {
      if (menuButton.getAttribute('aria-expanded') === 'true') closeMenus(false);
      else openMenu(menuButton);
      return;
    }
    if (!event.target.closest('[role="menu"]') || event.target.closest('[role="menuitem"]')) closeMenus(false);
    const copier = event.target.closest('[data-copy-from]');
    if (copier) { copier.dataset.copyIdle ??= (copier.querySelector('[data-copy-label]') ?? copier).textContent; void copy(copier); return; }
    if (busy && event.target.closest('a[data-navigation]')) event.preventDefault();
  });
  document.addEventListener('keydown', event => {
    const dialog = document.querySelector('dialog[open]');
    if (dialog && event.key === 'Tab') {
      const items = focusables(dialog);
      if (items.length === 0) { event.preventDefault(); return; }
      const first = items[0];
      const last = items[items.length - 1];
      const inside = dialog.contains(document.activeElement);
      if (event.shiftKey && (!inside || document.activeElement === first)) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && (!inside || document.activeElement === last)) { event.preventDefault(); first.focus(); }
      return;
    }
    if (!(event.target instanceof Element)) return;
    const menuButton = event.target.closest('[data-menu-button]');
    if (menuButton && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      openMenu(menuButton, event.key === 'ArrowUp');
      return;
    }
    const menu = event.target.closest('[role="menu"]');
    if (!menu) return;
    const items = menuItems(menu);
    const index = items.indexOf(event.target.closest('[role="menuitem"]'));
    const moves = { ArrowDown: index + 1, ArrowUp: index - 1, Home: 0, End: items.length - 1 };
    if (event.key in moves) {
      event.preventDefault();
      items[(moves[event.key] + items.length) % items.length]?.focus();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeMenus(true);
    } else if (event.key === 'Tab') closeMenus(true);
  });
  window.addEventListener('beforeunload', event => {
    if (!busy && !changed()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  // A page restored from the back-forward cache could show a change that has since been undone elsewhere.
  window.addEventListener('pageshow', event => { if (event.persisted) location.reload(); });
  const kit = { send, message, announce, openDialog, closeDialog, busy: () => busy };
`;

/** The page's own script runs after the kit's, in the same scope, and reaches it through `kit`. */
export function pageScript(page = ''): string {
  return `(() => {\n  'use strict';${KIT_SCRIPT}${page}\n})();`;
}
