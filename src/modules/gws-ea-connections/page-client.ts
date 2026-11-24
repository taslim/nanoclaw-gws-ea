/**
 * Runs inside the page kit's script.
 * - Sign-in starts with a same-origin POST that answers the server's authorization URL.
 * - Tool approval toggles update optimistically in place via same-origin JSON (no full-page lock or re-sort jump).
 * - While a connected app's tools are still being sorted, lightweight same-origin polling updates rows live in place
 *   and stops automatically once settled.
 */
export const CONNECTIONS_PAGE_SCRIPT = String.raw`
  if (new URLSearchParams(location.search).has('outcome')) history.replaceState(null, '', location.pathname);
  let signingIn = false;
  const inFlightToggles = new Set();
  let needsPostToggleSync = false;
  let pollTimer;
  let pollGeneration = 0;

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
        kit.message('That didn’t go through. Reload and try again.', true);
        return;
      }
      const data = await response.json();
      if (response.ok && typeof data.authorizationUrl === 'string' && data.authorizationUrl.startsWith('https://')) {
        leaving = true;
        location.assign(data.authorizationUrl);
        return;
      }
      kit.message(typeof data.error === 'string' ? data.error : 'Couldn’t open sign-in. Try again.', response.status === 409);
    } catch {
      kit.message('Couldn’t open sign-in. Reload and try again.', true);
    } finally {
      signingIn = false;
      document.querySelector('main').removeAttribute('aria-busy');
      if (!leaving) {
        submit.textContent = label;
        controls.forEach(control => { control.disabled = false; });
      }
    }
  }

  function updateTallies(root) {
    const rows = [...root.querySelectorAll('[data-tool-row]')];
    const checking = rows.some(row => row.dataset.toolState === 'checking') || root.dataset.toolsPolling === 'true';
    const askCount = rows.filter(row => row.dataset.toolState === 'ask_first').length;
    const autoCount = rows.filter(row => row.dataset.toolState === 'just_do').length;
    const desktopTally = root.querySelector('[data-tools-tally]');
    const mobileTally = root.querySelector('[data-tools-mobile-tally]');
    if (desktopTally) {
      const text = checking ? '' : rows.length === 0 ? 'No tools' : askCount + ' ask first · ' + autoCount + ' auto';
      desktopTally.textContent = text;
      desktopTally.hidden = !text;
    }
    if (mobileTally) {
      const text = checking ? '' : rows.length === 0 ? '0 tools' : askCount + ' on · ' + autoCount + ' off';
      mobileTally.textContent = text;
      mobileTally.hidden = !text;
    }
  }

  function applyRowVisual(row, state) {
    const isChecking = state === 'checking';
    const isAskFirst = state !== 'just_do';
    const nextLabel = isAskFirst ? 'just_do' : 'ask_first';
    row.dataset.toolState = state;
    row.classList.toggle('is-checking', isChecking);
    const labelInput = row.querySelector('input[name="label"]');
    if (labelInput) labelInput.value = nextLabel;
    const button = row.querySelector('button[role="switch"]');
    if (button) {
      button.setAttribute('aria-checked', isAskFirst ? 'true' : 'false');
      const stateNode = button.querySelector('.switch-state');
      if (stateNode) stateNode.textContent = isChecking ? 'Checking…' : isAskFirst ? 'Ask first' : 'Auto';
    }
  }

  function applyRowDescription(row, description, isChecking) {
    const descNode = row.querySelector('[data-tool-desc]');
    if (!descNode) return;
    if (isChecking) {
      descNode.textContent = '';
      descNode.classList.add('tool-shimmer');
      descNode.setAttribute('aria-hidden', 'true');
      descNode.hidden = false;
      return;
    }
    descNode.classList.remove('tool-shimmer');
    descNode.removeAttribute('aria-hidden');
    if (description) {
      descNode.textContent = description;
      descNode.hidden = false;
    } else {
      descNode.textContent = '';
      descNode.hidden = true;
    }
  }

  function buildToolRowElement(appId, tool) {
    const isChecking = tool.label === null || tool.unsettled === true;
    const isAskFirst = tool.label !== 'just_do';
    const nextLabel = isAskFirst ? 'just_do' : 'ask_first';
    const li = document.createElement('li');
    li.className = isChecking ? 'row tool-row is-checking' : 'row tool-row';
    li.dataset.toolRow = tool.name;
    li.dataset.toolHash = tool.definitionHash;
    li.dataset.toolState = isChecking ? 'checking' : isAskFirst ? 'ask_first' : 'just_do';

    const info = document.createElement('div');
    info.className = 'tool-info';
    const head = document.createElement('div');
    head.className = 'tool-head';
    const title = document.createElement('span');
    title.className = 'tool-title';
    title.textContent = tool.displayName || tool.name;
    const slug = document.createElement('code');
    slug.className = 'tool-slug';
    slug.textContent = tool.name;
    head.append(title, slug);

    const desc = document.createElement('span');
    desc.className = 'tool-desc';
    desc.dataset.toolDesc = '';
    info.append(head, desc);

    const form = document.createElement('form');
    form.className = 'tool-control';
    form.method = 'post';
    form.action = '/connections/tool-label';
    form.setAttribute('data-tool-switch', '');
    for (const [name, value] of [
      ['id', appId],
      ['tool', tool.name],
      ['label', nextLabel],
      ['definitionHash', tool.definitionHash],
    ]) {
      const input = document.createElement('input');
      input.type = 'hidden';
      input.name = name;
      input.value = value;
      form.append(input);
    }

    const button = document.createElement('button');
    button.className = 'switch';
    button.type = 'submit';
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', isAskFirst ? 'true' : 'false');
    button.setAttribute('aria-label', 'Ask first for ' + (tool.displayName || tool.name) + ' (' + tool.name + ')');
    button.dataset.switchName = tool.name;
    const stateSpan = document.createElement('span');
    stateSpan.className = 'switch-state';
    stateSpan.textContent = isChecking ? 'Checking…' : isAskFirst ? 'Ask first' : 'Auto';
    const track = document.createElement('span');
    track.className = 'switch-track';
    track.setAttribute('aria-hidden', 'true');
    const thumb = document.createElement('span');
    thumb.className = 'switch-thumb';
    track.append(thumb);
    button.append(stateSpan, track);
    form.append(button);

    li.append(info, form);
    applyRowDescription(li, tool.description || '', isChecking);
    return li;
  }

  function renderBadgeInto(slot, status, hasUnsorted, needsReview) {
    if (!slot) return;
    slot.textContent = '';
    const span = document.createElement('span');
    if (status && status !== 'connected') {
      span.className = status === 'needs_reconnecting' ? 'badge badge-warning' : 'badge';
      span.textContent = status === 'needs_reconnecting' ? 'Needs reconnecting' : 'Not connected';
    } else if (hasUnsorted) {
      span.className = 'badge badge-checking';
      span.textContent = 'Checking…';
    } else if (needsReview) {
      span.className = 'badge badge-warning';
      span.textContent = 'Needs review';
    } else {
      span.className = 'badge badge-success';
      span.textContent = 'Reviewed';
    }
    slot.append(span);
  }

  function renderRecoveryBox(body, text, href, buttonLabel, primary) {
    body.textContent = '';
    const box = document.createElement('div');
    box.className = 'tools-empty';
    box.dataset.toolsEmpty = '';
    const p = document.createElement('p');
    p.textContent = text;
    const link = document.createElement('a');
    link.className = primary ? 'button button-primary' : 'button button-secondary';
    link.href = href;
    link.setAttribute('data-navigation', '');
    link.textContent = buttonLabel;
    box.append(p, link);
    body.append(box);
  }

  function restoreToolsFocus(body, focusedTool) {
    const switches = [...body.querySelectorAll('button[role="switch"][data-switch-name]')];
    const match = focusedTool ? switches.find(btn => btn.dataset.switchName === focusedTool) : undefined;
    const fallback = match || switches[0] || document.querySelector('main .back-link') || document.querySelector('main');
    if (fallback instanceof HTMLElement) fallback.focus({ preventScroll: true });
  }

  function applyToolsStatus(root, payload) {
    const appId = root.dataset.toolsApp;
    const wasPolling = root.dataset.toolsPolling === 'true';
    const isConnected = payload.status === 'connected';
    const stillChecking = isConnected && (!payload.pinned || payload.hasUnsorted === true);
    root.dataset.toolsPolling = stillChecking ? 'true' : 'false';
    if (typeof payload.listHash === 'string') root.dataset.toolsListHash = payload.listHash;

    const body = root.querySelector('[data-tools-body]');
    if (!payload.pinned && !isConnected && body) {
      const reconnect = payload.status === 'needs_reconnecting';
      renderRecoveryBox(
        body,
        reconnect ? 'Reconnect this app to load its tools.' : 'Connect this app to load its tools.',
        '/connections/app/' + encodeURIComponent(appId) + '/connect',
        reconnect ? 'Reconnect' : 'Connect',
        true,
      );
    } else if (payload.pinned && body) {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      if (tools.length === 0) {
        body.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'tools-empty';
        empty.dataset.toolsEmpty = '';
        empty.textContent = 'No tools listed by this app.';
        body.append(empty);
      } else {
        let list = root.querySelector('[data-tools-list]');
        const isSkeleton = Boolean(list?.querySelector('.skeleton-row'));
        const existingRows = new Map([...root.querySelectorAll('[data-tool-row]')].map(row => [row.dataset.toolRow, row]));
        const needsRebuild = !list || isSkeleton || existingRows.size !== tools.length || tools.some(tool => !existingRows.has(tool.name));
        if (needsRebuild) {
          const activeEl = document.activeElement;
          const activeInBody = activeEl instanceof Element && body.contains(activeEl);
          const focusedTool = activeInBody ? activeEl.closest('[data-tool-row]')?.dataset.toolRow : undefined;
          const card = document.createElement('div');
          card.className = 'tools-card';
          const head = document.createElement('div');
          head.className = 'tools-card-head';
          head.setAttribute('aria-hidden', 'true');
          const hLeft = document.createElement('span');
          hLeft.textContent = 'Tool';
          const hRight = document.createElement('span');
          hRight.textContent = 'Ask before running';
          head.append(hLeft, hRight);
          list = document.createElement('ul');
          list.className = 'list tools-list';
          list.dataset.toolsList = '';
          for (const tool of tools) list.append(buildToolRowElement(appId, tool));
          card.append(head, list);
          body.textContent = '';
          body.append(card);
          if (activeInBody) restoreToolsFocus(body, focusedTool);
        } else {
          for (const tool of tools) {
            const row = existingRows.get(tool.name);
            if (!row) continue;
            if (inFlightToggles.has(tool.name)) {
              needsPostToggleSync = true;
              continue;
            }
            const isChecking = tool.label === null || tool.unsettled === true;
            const state = isChecking ? 'checking' : tool.label === 'just_do' ? 'just_do' : 'ask_first';
            row.dataset.toolHash = tool.definitionHash;
            const hashInput = row.querySelector('input[name="definitionHash"]');
            if (hashInput) hashInput.value = tool.definitionHash;
            applyRowVisual(row, state);
            applyRowDescription(row, tool.description || '', isChecking);
          }
        }
      }
    }

    renderBadgeInto(root.querySelector('[data-tools-badge]'), payload.status, stillChecking, payload.needsReview === true);
    updateTallies(root);

    const showReview = Boolean(isConnected && payload.pinned && !stillChecking && payload.needsReview === true && payload.listHash);
    root.querySelectorAll('[data-review-form]').forEach(form => {
      const hashInput = form.querySelector('[data-review-list-hash]');
      if (hashInput && typeof payload.listHash === 'string') hashInput.value = payload.listHash;
      form.hidden = !showReview;
    });

    if (wasPolling && !stillChecking) {
      kit.announce(showReview ? 'Tools ready to review.' : isConnected ? 'Tools checked.' : 'App is not connected.');
    }
    return stillChecking;
  }

  function showUnavailableTools(root) {
    root.dataset.toolsPolling = 'false';
    const badge = root.querySelector('[data-tools-badge]');
    if (badge) badge.textContent = '';
    const desktopTally = root.querySelector('[data-tools-tally]');
    if (desktopTally) {
      desktopTally.textContent = '';
      desktopTally.hidden = true;
    }
    const mobileTally = root.querySelector('[data-tools-mobile-tally]');
    if (mobileTally) {
      mobileTally.textContent = '';
      mobileTally.hidden = true;
    }
    root.querySelectorAll('[data-review-form]').forEach(form => { form.hidden = true; });
    const body = root.querySelector('[data-tools-body]');
    if (body) renderRecoveryBox(body, 'This app isn’t available right now.', '/connections', 'All apps', false);
  }

  async function fetchToolsStatusOnce(root) {
    const appId = root.dataset.toolsApp;
    if (!appId || !root.isConnected) return null;
    try {
      const response = await fetch('/connections/app/' + encodeURIComponent(appId) + '/tools-status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!root.isConnected) return null;
      if (response.status === 404) {
        stopToolsPolling();
        showUnavailableTools(root);
        return 'not_found';
      }
      if (!response.ok) return 'error';
      const payload = await response.json();
      if (!root.isConnected) return null;
      return applyToolsStatus(root, payload) ? 'checking' : 'settled';
    } catch {
      return 'error';
    }
  }

  function stopToolsPolling() {
    pollGeneration += 1;
    if (pollTimer) {
      clearTimeout(pollTimer);
      pollTimer = undefined;
    }
  }

  function startToolsPolling() {
    stopToolsPolling();
    const root = document.querySelector('[data-tools-app]');
    if (!root || root.dataset.toolsPolling !== 'true') return;
    const appId = root.dataset.toolsApp;
    const gen = pollGeneration;
    let consecutiveErrors = 0;

    const schedule = delayMs => {
      if (gen !== pollGeneration) return;
      pollTimer = setTimeout(() => { void tick(); }, delayMs);
    };

    const tick = async () => {
      if (gen !== pollGeneration) return;
      if (document.visibilityState === 'hidden') {
        schedule(1500);
        return;
      }
      const currentRoot = document.querySelector('[data-tools-app]');
      if (!currentRoot || currentRoot.dataset.toolsApp !== appId || currentRoot.dataset.toolsPolling !== 'true') {
        stopToolsPolling();
        return;
      }
      const status = await fetchToolsStatusOnce(currentRoot);
      if (gen !== pollGeneration) return;
      if (status === 'checking') {
        consecutiveErrors = 0;
        schedule(1500);
      } else if (status === 'settled' || status === 'not_found' || status === null) {
        stopToolsPolling();
      } else {
        consecutiveErrors += 1;
        schedule(Math.min(8000, 1500 * (consecutiveErrors + 1)));
      }
    };

    schedule(800);
  }

  async function toggleToolSwitch(form) {
    if (signingIn || kit.busy()) return;
    const root = form.closest('[data-tools-app]');
    const row = form.closest('[data-tool-row]');
    if (!root || !row) {
      void kit.send(form, { pendingLabel: false, keepScroll: true });
      return;
    }
    const data = Object.fromEntries(new FormData(form));
    const toolName = typeof data.tool === 'string' ? data.tool : '';
    const nextLabel = data.label === 'just_do' ? 'just_do' : 'ask_first';
    if (!toolName || inFlightToggles.has(toolName)) return;

    const prevState = row.dataset.toolState || (nextLabel === 'just_do' ? 'ask_first' : 'just_do');
    const prevDescHidden = row.querySelector('[data-tool-desc]')?.hidden ?? true;
    const prevDescText = row.querySelector('[data-tool-desc]')?.textContent ?? '';
    const wasChecking = prevState === 'checking';

    inFlightToggles.add(toolName);
    applyRowVisual(row, nextLabel);
    if (wasChecking) applyRowDescription(row, '', false);
    updateTallies(root);

    const titleText = row.querySelector('.tool-title')?.textContent?.trim() || toolName;
    let shouldReconcile = false;
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (response.ok) {
        const result = await response.json().catch(() => null);
        const confirmed = result && (result.label === 'ask_first' || result.label === 'just_do') ? result.label : nextLabel;
        applyRowVisual(row, confirmed);
        updateTallies(root);
        if (root.isConnected) {
          const outcome = document.getElementById('outcome');
          if (outcome && outcome.dataset.error === 'true') {
            outcome.textContent = '';
            outcome.hidden = true;
          }
          kit.announce(titleText + ': ' + (confirmed === 'ask_first' ? 'Ask first' : 'Auto'));
        }
        return;
      }
      if (response.status >= 500) {
        shouldReconcile = true;
      } else {
        applyRowVisual(row, prevState);
        if (wasChecking) applyRowDescription(row, prevDescText, true);
        else if (!prevDescHidden) applyRowDescription(row, prevDescText, false);
        updateTallies(root);
      }
      const errBody = await response.json().catch(() => null);
      const errText = errBody && typeof errBody.error === 'string' ? errBody.error : 'Couldn’t save that change. Reload and try again.';
      if (root.isConnected) kit.message(errText, response.status === 409 || response.status >= 500);
    } catch {
      shouldReconcile = true;
      if (root.isConnected) kit.message('Couldn’t save that change. Reload and try again.', true);
    } finally {
      inFlightToggles.delete(toolName);
      if ((shouldReconcile || needsPostToggleSync) && inFlightToggles.size === 0 && root.isConnected) {
        needsPostToggleSync = false;
        void fetchToolsStatusOnce(root);
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
      void toggleToolSwitch(form);
    }
  });

  document.addEventListener('kit:swap', () => { startToolsPolling(); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const root = document.querySelector('[data-tools-app]');
      if (root && root.dataset.toolsPolling === 'true') startToolsPolling();
    }
  });
  startToolsPolling();
`;
