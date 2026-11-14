/**
 * Runs inside the page kit's script, which owns sending changes and confirming removal. Passwords enter the
 * page only after a principal reveal and are cleared on hiding or leaving.
 */
export const LOGINS_PAGE_SCRIPT = String.raw`
  let revealGeneration = 0;
  let revealRequest;
  let revealTimer;
  function hidePassword() {
    revealGeneration += 1;
    revealRequest?.abort();
    revealRequest = undefined;
    clearTimeout(revealTimer);
    revealTimer = undefined;
    const value = document.getElementById('password-value');
    if (value) { value.textContent = ''; value.hidden = true; }
    const concealed = document.getElementById('password-concealed');
    if (concealed) { concealed.hidden = false; concealed.lastChild.textContent = 'Not shown'; }
    const button = document.getElementById('show-password');
    if (button) {
      button.textContent = 'Show password';
      button.setAttribute('aria-expanded', 'false');
      button.removeAttribute('aria-busy');
    }
    const hint = document.getElementById('password-reveal-hint');
    if (hint) hint.hidden = true;
  }
  async function revealPassword(button) {
    const value = document.getElementById('password-value');
    if (revealRequest || !value.hidden) { hidePassword(); return; }
    hidePassword();
    const generation = revealGeneration;
    const controller = new AbortController();
    revealRequest = controller;
    button.textContent = 'Hide password';
    button.setAttribute('aria-busy', 'true');
    document.getElementById('password-concealed').lastChild.textContent = 'Loading…';
    try {
      const response = await fetch('/logins/reveal', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ handle: button.dataset.handle, version: button.dataset.version }),
        credentials: 'same-origin', cache: 'no-store', signal: controller.signal,
      });
      if (generation !== revealGeneration) return;
      if (response.status === 404) {
        hidePassword();
        kit.message('This request could not be accepted. Reload the page and try again.', true);
        return;
      }
      const data = await response.json();
      if (generation !== revealGeneration || document.visibilityState !== 'visible') return;
      if (!response.ok || typeof data.password !== 'string') {
        hidePassword();
        kit.message(typeof data.error === 'string' ? data.error : 'The password could not be shown. Try again.', response.status === 409);
        return;
      }
      value.textContent = data.password;
      data.password = '';
      value.hidden = false;
      document.getElementById('password-concealed').hidden = true;
      document.getElementById('password-reveal-hint').hidden = false;
      button.setAttribute('aria-expanded', 'true');
      revealTimer = setTimeout(hidePassword, 30_000);
    } catch {
      if (generation !== revealGeneration) return;
      hidePassword();
      kit.message('The password could not be shown. Reload the page and try again.', true);
    } finally {
      if (generation === revealGeneration) {
        revealRequest = undefined;
        button.removeAttribute('aria-busy');
      }
    }
  }
  // Capturing runs before the kit sends or asks to confirm, so a shown password never outlives a change.
  document.addEventListener('submit', hidePassword, true);
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
    if (!(event.target instanceof Element)) return;
    const reveal = event.target.closest('#show-password');
    if (reveal && !kit.busy()) { void revealPassword(reveal); return; }
    if (event.target.closest('a[data-navigation]')) hidePassword();
  });
  document.addEventListener('visibilitychange', () => { if (document.visibilityState !== 'visible') hidePassword(); });
  window.addEventListener('pagehide', hidePassword);
  window.addEventListener('beforeunload', hidePassword);
`;
