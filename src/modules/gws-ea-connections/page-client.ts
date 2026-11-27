/** Runs inside the page kit's script. */
export const CONNECTIONS_PAGE_SCRIPT = String.raw`
  const initialOutcome = new URLSearchParams(location.search).get('outcome');
  if (initialOutcome && initialOutcome !== 'approved' && initialOutcome !== 'declined') {
    history.replaceState(null, '', location.pathname);
  }
  let signingIn = false;
  const inFlightToggles = new Set();
  const uncertainTools = new Set();
  let needsPostToggleSync = false;
  let mutationEpoch = 0;
  let pollTimer;
  let reconcileTimer;
  let pollGeneration = 0;
  let reconcileGeneration = 0;
  let deviceTimer;
  let deviceGeneration = 0;

  function stopDevicePolling() {
    deviceGeneration += 1;
    if (deviceTimer) {
      clearTimeout(deviceTimer);
      deviceTimer = undefined;
    }
  }

  function startDevicePolling() {
    stopDevicePolling();
    const root = document.querySelector('[data-device-sign-in]');
    if (!root || root.dataset.deviceState !== 'waiting') return;
    const appId = root.dataset.deviceSignIn;
    const gen = deviceGeneration;
    const schedule = () => {
      if (gen === deviceGeneration) deviceTimer = setTimeout(() => { void tick(); }, 2000);
    };
    const tick = async () => {
      if (gen !== deviceGeneration || !root.isConnected) return;
      if (document.visibilityState === 'hidden') return schedule();
      try {
        const response = await fetch('/connections/app/' + encodeURIComponent(appId) + '/sign-in-status', {
          method: 'GET', headers: { Accept: 'application/json' }, credentials: 'same-origin', cache: 'no-store',
        });
        if (gen !== deviceGeneration || !root.isConnected) return;
        if (response.status === 404) {
          location.assign('/connections');
          return;
        }
        if (response.ok) {
          const data = await response.json();
          if (gen !== deviceGeneration || !root.isConnected) return;
          if (data.status === 'connected') {
            location.assign('/connections?outcome=connected');
            return;
          }
          // A sign-in started again from another tab has its own address and phrase.
          const shownPhrase = root.querySelector('#device-phrase')?.textContent;
          const shownAddress = root.querySelector('#device-address')?.getAttribute('href');
          if (data.status !== 'waiting' || data.phrase !== shownPhrase || data.verificationUrl !== shownAddress) {
            location.assign(location.pathname);
            return;
          }
        }
      } catch {
        // A missed check is retried on the next one.
      }
      schedule();
    };
    schedule();
  }

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
      if (response.ok && typeof data.location === 'string' && data.location.startsWith('/connections/')) {
        leaving = true;
        location.assign(data.location);
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
      if (stateNode) stateNode.textContent = isChecking ? 'Checking…' : isAskFirst ? 'Ask first' : row.dataset.autoText || 'Auto';
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
    li.dataset.autoText = tool.autoText || 'Auto';

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
    button.disabled = uncertainTools.has(tool.name);
    button.setAttribute('role', 'switch');
    button.setAttribute('aria-checked', isAskFirst ? 'true' : 'false');
    button.setAttribute('aria-label', 'Ask first for ' + (tool.displayName || tool.name) + ' (' + tool.name + ')');
    button.dataset.switchName = tool.name;
    const stateSpan = document.createElement('span');
    stateSpan.className = 'switch-state';
    stateSpan.textContent = isChecking ? 'Checking…' : isAskFirst ? 'Ask first' : li.dataset.autoText;
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

  function syncReviewHashes(root, listHash, labelsHash) {
    root.querySelectorAll('[data-review-form]').forEach(form => {
      const listInput = form.querySelector('[data-review-list-hash]');
      if (listInput && typeof listHash === 'string') listInput.value = listHash;
      const labelsInput = form.querySelector('[data-review-labels-hash]');
      if (labelsInput && typeof labelsHash === 'string') labelsInput.value = labelsHash;
    });
  }

  function findToolRow(root, toolName) {
    return [...root.querySelectorAll('[data-tool-row]')].find(row => row.dataset.toolRow === toolName) || null;
  }

  function syncReviewLock(root) {
    const locked = inFlightToggles.size > 0 || uncertainTools.size > 0 || needsPostToggleSync;
    root.querySelectorAll('[data-review-form] button[type="submit"]').forEach(button => {
      if (button instanceof HTMLButtonElement) button.disabled = locked;
    });
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
      const activeInBody = document.activeElement instanceof Element && body.contains(document.activeElement);
      uncertainTools.clear();
      const reconnect = payload.status === 'needs_reconnecting';
      renderRecoveryBox(
        body,
        reconnect ? 'Reconnect this app to load its tools.' : 'Connect this app to load its tools.',
        '/connections/app/' + encodeURIComponent(appId) + '/connect',
        reconnect ? 'Reconnect' : 'Connect',
        true,
      );
      if (activeInBody) restoreToolsFocus(body, undefined);
    } else if (payload.pinned && body) {
      const tools = Array.isArray(payload.tools) ? payload.tools : [];
      if (tools.length === 0) {
        const activeInBody = document.activeElement instanceof Element && body.contains(document.activeElement);
        uncertainTools.clear();
        body.textContent = '';
        const empty = document.createElement('div');
        empty.className = 'tools-empty';
        empty.dataset.toolsEmpty = '';
        empty.textContent = 'No tools listed by this app.';
        body.append(empty);
        if (activeInBody) restoreToolsFocus(body, undefined);
      } else {
        let list = root.querySelector('[data-tools-list]');
        const isSkeleton = Boolean(list?.querySelector('.skeleton-row'));
        const existingRows = new Map([...root.querySelectorAll('[data-tool-row]')].map(row => [row.dataset.toolRow, row]));
        const needsRebuild = !list || isSkeleton || existingRows.size !== tools.length || tools.some(tool => !existingRows.has(tool.name));
        if (needsRebuild) {
          const activeEl = document.activeElement;
          const activeInBody = activeEl instanceof Element && body.contains(activeEl);
          const focusedTool = activeInBody ? activeEl.closest('[data-tool-row]')?.dataset.toolRow : undefined;
          const present = new Set(tools.map(tool => tool.name));
          for (const name of [...uncertainTools]) {
            if (!present.has(name) || !inFlightToggles.has(name)) uncertainTools.delete(name);
          }
          if (inFlightToggles.size > 0) needsPostToggleSync = true;
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
          for (const tool of tools) {
            const existing = inFlightToggles.has(tool.name) ? existingRows.get(tool.name) : undefined;
            list.append(existing || buildToolRowElement(appId, tool));
          }
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
            uncertainTools.delete(tool.name);
            const button = row.querySelector('button[role="switch"]');
            if (button instanceof HTMLButtonElement) button.disabled = false;
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

    const fullyRenderedSnapshot = inFlightToggles.size === 0;
    if (fullyRenderedSnapshot) {
      needsPostToggleSync = false;
    }

    renderBadgeInto(root.querySelector('[data-tools-badge]'), payload.status, stillChecking, payload.needsReview === true);
    updateTallies(root);

    const showReview = Boolean(isConnected && payload.pinned && !stillChecking && payload.needsReview === true && payload.listHash);
    if (fullyRenderedSnapshot) {
      syncReviewHashes(root, payload.listHash, payload.labelsHash);
    }
    root.querySelectorAll('[data-review-form]').forEach(form => {
      form.hidden = !showReview;
    });
    syncReviewLock(root);

    if (wasPolling && !stillChecking) {
      kit.announce(showReview ? 'Tools ready to review.' : isConnected ? 'Tools checked.' : 'App is not connected.');
    }
    return stillChecking;
  }

  function showUnavailableTools(root) {
    root.dataset.toolsPolling = 'false';
    uncertainTools.clear();
    needsPostToggleSync = false;
    cancelReconciliation();
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
    if (body) {
      const activeInBody = document.activeElement instanceof Element && body.contains(document.activeElement);
      renderRecoveryBox(body, 'This app isn’t available right now.', '/connections', 'All apps', false);
      if (activeInBody) restoreToolsFocus(body, undefined);
    }
  }

  async function fetchToolsStatusOnce(root) {
    const appId = root.dataset.toolsApp;
    if (!appId || !root.isConnected) return null;
    const startedEpoch = mutationEpoch;
    try {
      const response = await fetch('/connections/app/' + encodeURIComponent(appId) + '/tools-status', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!root.isConnected) return null;
      if (startedEpoch !== mutationEpoch) return 'stale';
      if (response.status === 404) {
        stopToolsPolling();
        showUnavailableTools(root);
        return 'missing';
      }
      if (!response.ok) return 'error';
      const payload = await response.json();
      if (!root.isConnected) return null;
      if (startedEpoch !== mutationEpoch) return 'stale';
      return applyToolsStatus(root, payload) ? 'checking' : 'settled';
    } catch {
      return startedEpoch !== mutationEpoch ? 'stale' : 'error';
    }
  }

  function clearReconcileTimer() {
    if (reconcileTimer) {
      clearTimeout(reconcileTimer);
      reconcileTimer = undefined;
    }
  }

  function cancelReconciliation() {
    reconcileGeneration += 1;
    clearReconcileTimer();
  }

  function reconcileToolsStatus(root, attempt = 0) {
    reconcileGeneration += 1;
    clearReconcileTimer();
    const gen = reconcileGeneration;
    void (async () => {
      const status = await fetchToolsStatusOnce(root);
      if (gen !== reconcileGeneration || !root.isConnected) return;
      if (status === 'stale') return;
      if (status === 'checking') {
        startToolsPolling();
        return;
      }
      if (status === 'settled' || status === 'missing' || status === null) {
        stopToolsPolling();
        return;
      }
      if (attempt < 2) {
        reconcileTimer = setTimeout(() => { reconcileToolsStatus(root, attempt + 1); }, 1500 * (attempt + 1));
      } else {
        for (const name of uncertainTools) {
          const stateNode = [...root.querySelectorAll('[data-tool-row]')].find(r => r.dataset.toolRow === name)?.querySelector('.switch-state');
          if (stateNode) stateNode.textContent = 'Unconfirmed';
        }
        kit.message('Couldn’t confirm the saved state. Reload the page before changing tools again.', true);
      }
    })();
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
      if ((status === 'checking' || status === 'settled' || status === 'missing') && !needsPostToggleSync && uncertainTools.size === 0) {
        cancelReconciliation();
      }
      if (status === 'checking' || status === 'stale') {
        consecutiveErrors = 0;
        schedule(1500);
      } else if (status === 'settled' || status === 'missing' || status === null) {
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
    if (!toolName || inFlightToggles.has(toolName) || uncertainTools.has(toolName)) return;

    const prevState = row.dataset.toolState || (nextLabel === 'just_do' ? 'ask_first' : 'just_do');
    const prevDescHidden = row.querySelector('[data-tool-desc]')?.hidden ?? true;
    const prevDescText = row.querySelector('[data-tool-desc]')?.textContent ?? '';
    const wasChecking = prevState === 'checking';

    mutationEpoch += 1;
    inFlightToggles.add(toolName);
    needsPostToggleSync = true;
    cancelReconciliation();
    applyRowVisual(row, nextLabel);
    if (wasChecking) applyRowDescription(row, '', false);
    updateTallies(root);
    syncReviewLock(root);

    const titleText = row.querySelector('.tool-title')?.textContent?.trim() || toolName;
    const markUncertain = () => {
      uncertainTools.add(toolName);
      const liveRow = findToolRow(root, toolName);
      if (liveRow) {
        liveRow.dataset.toolState = 'checking';
        liveRow.classList.add('is-checking');
        const button = liveRow.querySelector('button[role="switch"]');
        if (button instanceof HTMLButtonElement) {
          button.disabled = true;
          const stateNode = button.querySelector('.switch-state');
          if (stateNode) stateNode.textContent = 'Checking…';
        }
      }
      updateTallies(root);
      syncReviewLock(root);
    };
    try {
      const response = await fetch(form.action, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify(data),
        credentials: 'same-origin',
        cache: 'no-store',
      });
      const liveRow = findToolRow(root, toolName);
      if (response.ok) {
        const result = await response.json().catch(() => null);
        const confirmed = result && (result.label === 'ask_first' || result.label === 'just_do') ? result.label : nextLabel;
        if (liveRow) applyRowVisual(liveRow, confirmed);
        updateTallies(root);
        if (root.isConnected) {
          const outcome = document.getElementById('outcome');
          if (outcome && outcome.dataset.error === 'true') {
            outcome.textContent = '';
            outcome.hidden = true;
          }
          kit.announce(titleText + ': ' + (confirmed === 'ask_first' ? 'Ask first' : (liveRow && liveRow.dataset.autoText) || 'Auto'));
        }
        return;
      }
      if (response.status >= 500) {
        markUncertain();
      } else {
        if (liveRow) {
          applyRowVisual(liveRow, prevState);
          if (wasChecking) applyRowDescription(liveRow, prevDescText, true);
          else if (!prevDescHidden) applyRowDescription(liveRow, prevDescText, false);
        }
        updateTallies(root);
      }
      const errBody = await response.json().catch(() => null);
      const errText = errBody && typeof errBody.error === 'string' ? errBody.error : 'Couldn’t save that change. Reload and try again.';
      if (root.isConnected) kit.message(errText, response.status === 409 || response.status >= 500);
    } catch {
      markUncertain();
      if (root.isConnected) kit.message('Couldn’t save that change. Reload and try again.', true);
    } finally {
      inFlightToggles.delete(toolName);
      mutationEpoch += 1;
      syncReviewLock(root);
      if (needsPostToggleSync && inFlightToggles.size === 0 && root.isConnected) {
        reconcileToolsStatus(root);
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

  document.addEventListener('kit:swap', () => {
    inFlightToggles.clear();
    uncertainTools.clear();
    needsPostToggleSync = false;
    mutationEpoch += 1;
    cancelReconciliation();
    startToolsPolling();
    startDevicePolling();
  });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
      const root = document.querySelector('[data-tools-app]');
      if (root && root.dataset.toolsPolling === 'true') startToolsPolling();
    }
  });
  startToolsPolling();
  startDevicePolling();
`;
