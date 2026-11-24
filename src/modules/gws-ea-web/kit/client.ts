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
 *
 * On a phone, menus and the confirmation dialog are bottom sheets: a tap outside, Cancel or a downward drag on
 * the sheet's grab area slides one away, while a key or a chosen item closes it at once. The page's heading
 * moves into the app bar once it scrolls under it.
 */
const KIT_SCRIPT = String.raw`
  let busy = false;
  let pendingForm;
  const openers = new WeakMap();
  const confirmDialog = document.getElementById('confirm-dialog');
  const announcer = document.getElementById('announcer');
  const FOCUSABLE = 'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])';
  const phone = matchMedia('(max-width: 719px)');
  const calm = matchMedia('(prefers-reduced-motion: reduce)');
  const appbar = document.querySelector('.shell');
  const appbarTitle = document.querySelector('.appbar-title');
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
  // A sheet's own Cancel exists only on a phone, so a hidden item is never a stop.
  function menuItems(menu) {
    return [...menu.querySelectorAll('[role="menuitem"]')].filter(item => !item.disabled && item.getClientRects().length > 0);
  }
  // Slides a sheet down from wherever a drag left it; anywhere a sheet is not shown, or motion is unwanted, it just closes.
  function slideAway(sheet, done) {
    if (!phone.matches || calm.matches) { done(); return; }
    sheet.dataset.closing = '';
    sheet.style.transform = 'translateY(100%)';
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      sheet.removeEventListener('transitionend', ended);
      delete sheet.dataset.closing;
      sheet.style.transform = '';
      done();
    };
    const ended = event => { if (event.target === sheet && event.propertyName === 'transform') finish(); };
    sheet.addEventListener('transitionend', ended);
    setTimeout(finish, 400);
  }
  function closeMenus(restore, slide = false) {
    document.querySelectorAll('[data-menu-button][aria-expanded="true"]').forEach(button => {
      button.setAttribute('aria-expanded', 'false');
      const menu = menuOf(button);
      const hide = () => {
        // Opened again while it slid away: it stays.
        if (button.getAttribute('aria-expanded') === 'true') return;
        menu.hidden = true;
        if (!document.querySelector('[data-menu-button][aria-expanded="true"]')) delete document.body.dataset.sheet;
      };
      if (slide && phone.matches && !calm.matches) {
        document.body.dataset.sheet = 'closing';
        slideAway(menu, hide);
      } else hide();
      if (restore) button.focus();
    });
  }
  function openMenu(button, last = false) {
    closeMenus(false);
    button.setAttribute('aria-expanded', 'true');
    const menu = menuOf(button);
    menu.hidden = false;
    document.body.dataset.sheet = 'open';
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
  function closeDialog(dialog, slide = false) {
    if (!dialog.open || dialog.dataset.closing !== undefined) return;
    if (slide) { slideAway(dialog, () => closeDialog(dialog)); return; }
    dialog.close();
    if (dialog === confirmDialog) pendingForm = undefined;
    const opener = openers.get(dialog);
    openers.delete(dialog);
    const active = document.activeElement;
    if (opener?.isConnected && (!active || active === document.body || dialog.contains(active))) opener.focus();
  }
  // The heading's text follows it into the app bar, which shows it only once the heading has scrolled beneath.
  let titleWatch;
  function watchTitle() {
    titleWatch?.disconnect();
    delete appbar.dataset.condensed;
    const heading = document.querySelector('main h1');
    appbarTitle.textContent = heading?.textContent ?? '';
    if (!heading || !('IntersectionObserver' in window)) return;
    titleWatch = new IntersectionObserver(([entry]) => {
      if (entry.isIntersecting) delete appbar.dataset.condensed;
      else appbar.dataset.condensed = '';
    }, { rootMargin: '-60px 0px 0px 0px' });
    titleWatch.observe(heading);
  }
  watchTitle();
  async function send(form, options = {}) {
    if (busy) return;
    busy = true;
    const data = Object.fromEntries(new FormData(form));
    form.querySelectorAll('input[data-omit-unchanged]').forEach(input => {
      if (input.value === input.defaultValue.replace(/[\r\n]/g, '')) delete data[input.name];
    });
    const controls = [...document.querySelectorAll('button, input')].filter(control => !control.disabled);
    const submit = form.querySelector('button[type="submit"]');
    const updateLabel = options.pendingLabel !== false && Boolean(submit);
    const label = updateLabel ? submit.textContent : '';
    if (updateLabel) submit.textContent = submit.dataset.pendingLabel || 'Saving…';
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
        message('That didn’t go through. Reload the page and try again.', true);
        return;
      }
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      const saved = response.headers.get('${PAGE_SAVED_HEADER}') === 'true';
      if (!next || (!response.ok && !saved)) {
        uncertain = response.status >= 500 || !next;
        message(page.getElementById('outcome')?.textContent ||
          'That change couldn’t be confirmed. Reload the page to check it before trying again.', uncertain || response.status === 409);
        return;
      }
      const swap = () => {
        document.querySelector('main').replaceWith(next);
        document.title = page.title;
        const locationHeader = response.headers.get('${PAGE_LOCATION_HEADER}');
        if (locationHeader) history.replaceState(null, '', locationHeader);
        watchTitle();
      };
      if (!options.keepScroll && document.startViewTransition && !calm.matches) await document.startViewTransition(swap).updateCallbackDone;
      else swap();
      if (options.afterSwap) {
        options.afterSwap(data);
      } else {
        const outcome = document.getElementById('outcome');
        (outcome.textContent ? outcome : next).focus();
        window.scrollTo({ top: 0, behavior: 'instant' });
      }
    } catch {
      uncertain = true;
      message('That change couldn’t be confirmed. Reload the page to check it before trying again.', true);
    } finally {
      busy = false;
      if (updateLabel) submit.textContent = label;
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
      label.textContent = 'Couldn’t copy';
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
    if (closing) { closeDialog(closing, true); return; }
    // A tap on a dialog's backdrop lands on the dialog itself, outside its box.
    if (event.target instanceof HTMLDialogElement && event.target.open) {
      const box = event.target.getBoundingClientRect();
      if (event.clientY < box.top || event.clientY > box.bottom || event.clientX < box.left || event.clientX > box.right) {
        closeDialog(event.target, true);
        return;
      }
    }
    if (event.target.closest('[data-menu-close]')) { closeMenus(true, true); return; }
    const menuButton = event.target.closest('[data-menu-button]');
    if (menuButton) {
      if (menuButton.getAttribute('aria-expanded') === 'true') closeMenus(false);
      else openMenu(menuButton);
      return;
    }
    if (event.target.closest('[role="menuitem"]')) closeMenus(false);
    else if (!event.target.closest('[role="menu"]')) closeMenus(false, true);
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
  // Dragging a sheet's grab area down follows the finger; a long or quick enough drag dismisses it.
  let drag;
  document.addEventListener('pointerdown', event => {
    if (!phone.matches || !(event.target instanceof Element)) return;
    const grab = event.target.closest('[data-sheet-grab]');
    const sheet = grab?.closest('[role="menu"], dialog');
    if (!sheet) return;
    drag = { sheet, id: event.pointerId, start: event.clientY, last: event.clientY, time: event.timeStamp, speed: 0 };
    sheet.style.transition = 'none';
    grab.setPointerCapture(event.pointerId);
  });
  document.addEventListener('pointermove', event => {
    if (!drag || event.pointerId !== drag.id) return;
    drag.speed = (event.clientY - drag.last) / Math.max(1, event.timeStamp - drag.time);
    drag.last = event.clientY;
    drag.time = event.timeStamp;
    drag.sheet.style.transform = 'translateY(' + Math.max(0, event.clientY - drag.start) + 'px)';
  });
  const endDrag = event => {
    if (!drag || event.pointerId !== drag.id) return;
    const { sheet, start, speed } = drag;
    drag = undefined;
    sheet.style.transition = '';
    const offset = Math.max(0, event.clientY - start);
    if (event.type === 'pointerup' && (offset > sheet.offsetHeight * 0.3 || speed > 0.5)) {
      if (sheet instanceof HTMLDialogElement) closeDialog(sheet, true);
      else closeMenus(false, true);
    } else sheet.style.transform = '';
  };
  document.addEventListener('pointerup', endDrag);
  document.addEventListener('pointercancel', endDrag);
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
