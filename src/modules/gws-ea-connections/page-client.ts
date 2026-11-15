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
        kit.message('This request could not be accepted. Reload the page and try again.', true);
        return;
      }
      const data = await response.json();
      if (response.ok && typeof data.authorizationUrl === 'string' && data.authorizationUrl.startsWith('https://')) {
        leaving = true;
        location.assign(data.authorizationUrl);
        return;
      }
      kit.message(typeof data.error === 'string' ? data.error : 'Sign-in could not start. Try again.', response.status === 409);
    } catch {
      kit.message('Sign-in could not start. Reload the page and try again.', true);
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
    if (!(form instanceof HTMLFormElement) || !form.hasAttribute('data-sign-in')) return;
    event.preventDefault();
    void signIn(form);
  });
`;
