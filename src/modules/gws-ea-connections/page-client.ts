/**
 * Runs inside the page kit's script. A sign-in starts with a same-origin POST that answers the server's sign-in
 * address, which the page then opens: form submission could be sent cross-site, and CSP `form-action` would not
 * govern the redirect anyway. A sign-in's outcome arrives once in the address and is removed at once, so a reload
 * shows nothing.
 */
export const CONNECTIONS_PAGE_SCRIPT = String.raw`
  if (new URLSearchParams(location.search).has('outcome')) history.replaceState(null, '', location.pathname);
  let signingIn = false;
  async function signIn(form) {
    if (signingIn || kit.busy()) return;
    signingIn = true;
    const submit = form.querySelector('button[type="submit"]');
    const label = submit.textContent;
    submit.textContent = submit.dataset.pendingLabel || 'Opening sign-in…';
    // Read before disabling: a disabled control is left out of the form's data.
    const body = JSON.stringify(Object.fromEntries(new FormData(form)));
    const controls = [...document.querySelectorAll('button, input')].filter(control => !control.disabled);
    controls.forEach(control => { control.disabled = true; });
    document.querySelector('main').setAttribute('aria-busy', 'true');
    let leaving = false;
    try {
      const response = await fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body,
        credentials: 'same-origin', cache: 'no-store',
      });
      if (response.status === 404) {
        kit.message('That didn’t go through. Reload the page and try again.', true);
        return;
      }
      const data = await response.json();
      if (response.ok && typeof data.authorizationUrl === 'string' && data.authorizationUrl.startsWith('https://')) {
        leaving = true;
        location.assign(data.authorizationUrl);
        return;
      }
      kit.message(typeof data.error === 'string' ? data.error : 'Couldn’t open the sign-in. Try again.', response.status === 409);
    } catch {
      kit.message('Couldn’t open the sign-in. Reload the page and try again.', true);
    } finally {
      signingIn = false;
      document.querySelector('main').removeAttribute('aria-busy');
      if (!leaving) {
        submit.textContent = label;
        controls.forEach(control => { control.disabled = false; });
      }
    }
  }
  document.addEventListener('submit', event => {
    const form = event.target;
    if (!(form instanceof HTMLFormElement)) return;
    if (form.hasAttribute('data-sign-in')) {
      event.preventDefault();
      void signIn(form);
      return;
    }
    if (form.hasAttribute('data-tool-switch')) {
      event.preventDefault();
      void toggleTool(form);
    }
  });
  let toggling = false;
  async function toggleTool(form) {
    if (toggling || signingIn || kit.busy()) return;
    toggling = true;
    const data = Object.fromEntries(new FormData(form));
    const toolName = typeof data.tool === 'string' ? data.tool : '';
    const nextLabel = data.label === 'ask_first' ? 'Ask first' : 'Just do it';
    const controls = [...document.querySelectorAll('button, input')].filter(control => !control.disabled);
    controls.forEach(control => { control.disabled = true; });
    document.querySelector('main').setAttribute('aria-busy', 'true');
    let uncertain = false;
    try {
      const response = await fetch(form.action, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin', cache: 'no-store',
      });
      if (response.status === 404) {
        uncertain = true;
        kit.message('That didn’t go through. Reload the page and try again.', true);
        return;
      }
      const page = new DOMParser().parseFromString(await response.text(), 'text/html');
      const next = page.querySelector('main');
      if (!next || !response.ok) {
        uncertain = response.status >= 500 || !next;
        kit.message(page.getElementById('outcome')?.textContent || 'Couldn’t save that change. Reload and try again.', uncertain || response.status === 409);
        return;
      }
      document.querySelector('main').replaceWith(next);
      document.title = page.title;
      const moved = [...document.querySelectorAll('button[data-switch-name]')].find(button => button.dataset.switchName === toolName);
      moved?.focus();
      kit.announce(toolName ? toolName + ': ' + nextLabel : nextLabel);
    } catch {
      uncertain = true;
      kit.message('Couldn’t save that change. Reload the page and try again.', true);
    } finally {
      toggling = false;
      document.querySelector('main').removeAttribute('aria-busy');
      if (!uncertain) controls.forEach(control => { control.disabled = false; });
    }
  }
`;
