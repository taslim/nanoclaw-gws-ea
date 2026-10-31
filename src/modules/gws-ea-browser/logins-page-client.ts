/** No credential values are retained in browser storage, URLs, or the rendered page. */
export const LOGINS_PAGE_SCRIPT = String.raw`(() => {
  'use strict';
  let busy = false;
  let pending;
  const dialog = document.getElementById('remove-dialog');
  function clearPasswords() {
    document.querySelectorAll('input[type="password"]').forEach(input => { input.value = ''; });
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
  async function send(form) {
    if (busy) return;
    busy = true;
    const data = Object.fromEntries(new FormData(form));
    if (form.dataset.loginAction === 'update') {
      for (const name of ['title', 'site', 'username']) {
        const input = form.elements.namedItem(name);
        if (input instanceof HTMLInputElement && input.value === input.defaultValue.replace(/[\r\n]/g, '')) delete data[name];
      }
    }
    clearPasswords();
    let body = JSON.stringify(data);
    delete data.password;
    const controls = [...document.querySelectorAll('button, input')].filter(control => !control.disabled);
    const submit = form.querySelector('button[type="submit"]');
    const label = submit.textContent;
    submit.textContent = form.dataset.loginAction === 'remove' ? 'Removing…' : 'Saving…';
    controls.forEach(control => { control.disabled = true; });
    const links = [...document.querySelectorAll('a[data-navigation]')];
    links.forEach(link => { link.setAttribute('aria-disabled', 'true'); });
    document.querySelector('main').setAttribute('aria-busy', 'true');
    let uncertain = false;
    try {
      const operation = fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body,
        credentials: 'same-origin', cache: 'no-store',
      });
      body = '';
      const response = await operation;
      if (response.status === 404) {
        uncertain = true;
        message('This request could not be accepted. Reload the page and try again.', true);
        return;
      }
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      const saved = response.headers.get('x-logins-saved') === 'true';
      if (!next || (!response.ok && !saved)) {
        uncertain = response.status >= 500 || !next;
        message(page.getElementById('outcome')?.textContent ||
          'The request could not be confirmed. Reload the page before trying again.', uncertain || response.status === 409);
        return;
      }
      document.querySelector('main').replaceWith(next);
      document.title = page.title;
      history.replaceState(null, '', response.headers.get('x-logins-location'));
      const outcome = document.getElementById('outcome');
      (outcome.textContent ? outcome : next).focus();
      window.scrollTo({ top: 0, behavior: 'instant' });
    } catch {
      uncertain = true;
      message('The request could not be confirmed. Reload the page before trying again.', true);
    } finally {
      body = '';
      busy = false;
      submit.textContent = label;
      document.querySelector('main').removeAttribute('aria-busy');
      links.forEach(link => { link.removeAttribute('aria-disabled'); });
      if (!uncertain) controls.forEach(control => { control.disabled = false; });
    }
  }
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement) || !form.dataset.loginAction) return;
    event.preventDefault();
    if (busy) return;
    if (form.dataset.loginAction === 'remove') {
      pending = form;
      document.getElementById('remove-description').textContent = 'Remove the saved login for ' +
        form.dataset.site + ' (' + form.dataset.username + ')? This does not delete the account on the website. ' +
        'The browser may still be signed in. You can ask your assistant to sign out.';
      dialog.showModal();
      document.getElementById('cancel-remove').focus();
    } else void send(form);
  });
  document.getElementById('cancel-remove').addEventListener('click', () => { pending = undefined; dialog.close(); });
  dialog.addEventListener('cancel', () => { pending = undefined; });
  document.getElementById('confirm-remove').addEventListener('click', () => {
    const form = pending;
    pending = undefined;
    dialog.close();
    if (form) void send(form);
  });
  document.addEventListener('input', event => {
    if (!(event.target instanceof HTMLInputElement) || event.target.id !== 'login-search') return;
    const needle = event.target.value.trim().toLocaleLowerCase();
    let count = 0;
    document.querySelectorAll('[data-login-row]').forEach(row => {
      row.hidden = !row.dataset.search.includes(needle);
      if (!row.hidden) count += 1;
    });
    document.querySelectorAll('[data-site-group]').forEach(group => {
      group.hidden = ![...group.querySelectorAll('[data-login-row]')].some(row => !row.hidden);
    });
    document.getElementById('search-empty').hidden = count !== 0;
    document.getElementById('search-count').textContent = needle ? count + (count === 1 ? ' login found' : ' logins found') : '';
  });
  document.addEventListener('click', event => {
    if (busy && event.target instanceof Element && event.target.closest('a[data-navigation]')) event.preventDefault();
  });
  window.addEventListener('beforeunload', event => {
    if (!busy && !changed()) return;
    event.preventDefault();
    event.returnValue = '';
  });
  window.addEventListener('pagehide', clearPasswords);
  window.addEventListener('pageshow', event => { if (event.persisted) { clearPasswords(); location.reload(); } });
})();`;
