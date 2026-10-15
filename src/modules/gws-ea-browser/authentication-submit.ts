import { randomUUID } from 'node:crypto';
import { selectors, type BrowserContext, type CDPSession, type ElementHandle, type Frame } from 'playwright-core';

const worldName = 'gws-ea-native-authentication';
// Unlike ElementHandle.evaluate/dispatchEvent, a contentScript selector runs in
// Playwright's isolated utility world. The selector receives the exact handle as
// its root; its only input is an unpredictable host event name, never JavaScript.
const selectorSource = `(() => {
    const query = (root, eventName) => {
      if (!/^gws-ea-auth-[a-f0-9-]{36}$/.test(eventName)) return null;
      EventTarget.prototype.dispatchEvent.call(root, new Event(eventName, {
        bubbles: false, composed: false, cancelable: false
      }));
      return root;
    };
    return { query, queryAll: (root, eventName) => {
      const result = query(root, eventName);
      return result ? [result] : [];
    }};
  })()`;
const contextSelectors = new WeakMap<BrowserContext, Promise<string>>();

/** CDP default contexts need registration after connecting, before creating pages. */
export async function prepareAuthenticationIsolation(context: BrowserContext): Promise<void> {
  let registered = contextSelectors.get(context);
  if (!registered) {
    const name = `gws-ea-native-authentication-${randomUUID()}`;
    registered = selectors.register(name, selectorSource, { contentScript: true }).then(() => name);
    contextSelectors.set(context, registered);
  }
  await registered;
}

export interface NativeAuthenticationFacts {
  origin: string;
  action: string;
  method: string;
  target: string;
  submit: boolean;
  fields: { name: string; type: string; autocomplete: string }[];
}
export interface NativeAuthenticationBinding {
  frameId: string;
  loaderId: string;
  controlBackendNodeId: number;
  formBackendNodeId: number;
  facts: NativeAuthenticationFacts;
}
interface NativeFrameTree {
  frame: { id: string; loaderId: string; url: string };
  childFrames?: NativeFrameTree[];
}

// Native getters also avoid HTMLFormElement's named-control property clobbering.
const readControlSource = `
  const formFor = (control) => {
    const prototype = control instanceof HTMLButtonElement ? HTMLButtonElement.prototype
      : control instanceof HTMLInputElement ? HTMLInputElement.prototype : null;
    return prototype && Object.getOwnPropertyDescriptor(prototype, 'form').get.call(control);
  };
  const formProperty = (form, name) => Object.getOwnPropertyDescriptor(HTMLFormElement.prototype, name).get.call(form);
  const readControl = (control) => {
    const form = formFor(control);
    if (!control.isConnected || !(form instanceof HTMLFormElement) || !form.isConnected) return null;
    const target = formProperty(form, 'target');
    return {
      origin: location.origin,
      action: formProperty(form, 'action'),
      method: formProperty(form, 'method'),
      target,
      submit: !control.matches(':disabled') && control.type === 'submit' && (!target || target === '_self'),
      fields: Array.from(formProperty(form, 'elements'), field => ({
        name: field.name || '', type: field.type || '', autocomplete: field.getAttribute('autocomplete') || ''
      }))
    };
  };`;

async function attachFrameSession(frame: Frame): Promise<{ session: CDPSession; owner: Frame }> {
  let owner = frame;
  for (;;) {
    try {
      return { session: await frame.page().context().newCDPSession(owner), owner };
    } catch (error) {
      const parent = owner.parentFrame();
      if (!parent || !(error instanceof Error) || !error.message.includes('does not have a separate CDP session'))
        throw error;
      // In-process frames belong to their nearest independently targeted ancestor.
      owner = parent;
    }
  }
}

function chosenFrame(tree: NativeFrameTree, frame: Frame, owner: Frame): NativeFrameTree | undefined {
  const path: string[] = [];
  let current: Frame | null = frame;
  while (current && current !== owner) {
    path.unshift(current.url());
    current = current.parentFrame();
  }
  if (current !== owner || tree.frame.url !== owner.url()) return undefined;
  let candidates = [tree];
  for (const url of path)
    candidates = candidates.flatMap(
      (candidate) => candidate.childFrames?.filter((child) => child.frame.url === url) ?? [],
    );
  return candidates.length === 1 ? candidates[0] : undefined;
}

function findFrame(tree: NativeFrameTree, id: string): NativeFrameTree | undefined {
  if (tree.frame.id === id) return tree;
  for (const child of tree.childFrames ?? []) {
    const found = findFrame(child, id);
    if (found) return found;
  }
  return undefined;
}

/** Transfer exact DOM identity between public APIs without mutable DOM markers. */
export async function inspectNativeAuthenticationControl(
  element: ElementHandle,
  frame: Frame,
): Promise<NativeAuthenticationBinding | undefined> {
  const registered = contextSelectors.get(frame.page().context());
  if (!registered) return undefined;
  const selectorName = await registered;
  let attached: Awaited<ReturnType<typeof attachFrameSession>>;
  try {
    attached = await attachFrameSession(frame);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Protocol errors refuse authentication without exposing page prose.
  } catch (_error) {
    return undefined;
  }
  const { session, owner } = attached;
  const eventName = `gws-ea-auth-${randomUUID()}`;
  let contextId: number | undefined;
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const selected = chosenFrame(frameTree, frame, owner);
    if (!selected?.frame.loaderId || (await element.ownerFrame()) !== frame) return undefined;
    const isolated = await session.send('Page.createIsolatedWorld', { frameId: selected.frame.id, worldName });
    contextId = isolated.executionContextId;
    await session.send('Runtime.evaluate', {
      contextId,
      expression: `(() => {
        ${readControlSource}
        const slot = { count: 0, control: null, form: null };
        slot.listener = event => {
          slot.count++;
          slot.control = slot.count === 1 ? event.target : null;
          slot.form = slot.control && formFor(slot.control);
        };
        slot.roots = [document];
        for (let index = 0; index < slot.roots.length; index++)
          for (const node of slot.roots[index].querySelectorAll('*'))
            if (node.shadowRoot) slot.roots.push(node.shadowRoot);
        globalThis[${JSON.stringify(eventName)}] = slot;
        for (const root of slot.roots) root.addEventListener(${JSON.stringify(eventName)}, slot.listener, true);
      })()`,
    });
    const handed = await element.$(`${selectorName}=${eventName}`);
    await handed?.dispose();
    const factsResult = await session.send('Runtime.evaluate', {
      contextId,
      returnByValue: true,
      expression: `(() => {
        ${readControlSource}
        const slot = globalThis[${JSON.stringify(eventName)}];
        return slot.count === 1 && slot.control ? readControl(slot.control) : null;
      })()`,
    });
    const facts = factsResult.result.value as NativeAuthenticationFacts | null | undefined;
    if (factsResult.exceptionDetails || !facts) return undefined;
    const ids: number[] = [];
    for (const name of ['control', 'form'] as const) {
      const captured = await session.send('Runtime.evaluate', {
        contextId,
        objectGroup: eventName,
        expression: `globalThis[${JSON.stringify(eventName)}].${name}`,
      });
      if (!captured.result.objectId) return undefined;
      const { node } = await session.send('DOM.describeNode', { objectId: captured.result.objectId });
      ids.push(node.backendNodeId);
    }
    return {
      frameId: selected.frame.id,
      loaderId: selected.frame.loaderId,
      controlBackendNodeId: ids[0],
      formBackendNodeId: ids[1],
      facts,
    };
    // eslint-disable-next-line no-catch-all/no-catch-all -- Protocol and selector errors must fail closed without leaking page prose.
  } catch (_error) {
    return undefined;
  } finally {
    if (contextId !== undefined)
      await session
        .send('Runtime.evaluate', {
          contextId,
          expression: `(() => {
          const slot = globalThis[${JSON.stringify(eventName)}];
          if (slot) for (const root of slot.roots) root.removeEventListener(${JSON.stringify(eventName)}, slot.listener, true);
          delete globalThis[${JSON.stringify(eventName)}];
        })()`,
        })
        .catch(() => undefined);
    await session.send('Runtime.releaseObjectGroup', { objectGroup: eventName }).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}

/** Resolve native identities into an isolated world; revalidate and submit in one synchronous call. */
export async function submitNativeAuthenticationForm(
  frame: Frame,
  binding: NativeAuthenticationBinding,
  assertActive?: () => Promise<void>,
): Promise<boolean> {
  let attached: Awaited<ReturnType<typeof attachFrameSession>>;
  try {
    attached = await attachFrameSession(frame);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Protocol errors refuse authentication without exposing page prose.
  } catch (_error) {
    return false;
  }
  const { session } = attached;
  const objectGroup = `gws-ea-auth-${randomUUID()}`;
  try {
    let controlObjectId: string | undefined;
    let formObjectId: string | undefined;
    try {
      const { frameTree } = await session.send('Page.getFrameTree');
      const selected = findFrame(frameTree, binding.frameId);
      if (!selected || selected.frame.loaderId !== binding.loaderId) return false;
      const { executionContextId } = await session.send('Page.createIsolatedWorld', {
        frameId: binding.frameId,
        worldName,
      });
      const control = await session.send('DOM.resolveNode', {
        backendNodeId: binding.controlBackendNodeId,
        executionContextId,
        objectGroup,
      });
      const form = await session.send('DOM.resolveNode', {
        backendNodeId: binding.formBackendNodeId,
        executionContextId,
        objectGroup,
      });
      controlObjectId = control.object.objectId;
      formObjectId = form.object.objectId;
      if (!controlObjectId || !formObjectId) return false;
      // eslint-disable-next-line no-catch-all/no-catch-all -- A vanished frame or node must refuse submission without exposing protocol prose.
    } catch (_error) {
      return false;
    }
    await assertActive?.();
    try {
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: controlObjectId,
        returnByValue: true,
        arguments: [{ objectId: formObjectId }, { value: binding.facts }],
        functionDeclaration: `function (form, expected) {
          ${readControlSource}
          const facts = readControl(this);
          if (!facts || !facts.submit || formFor(this) !== form ||
              JSON.stringify(facts) !== JSON.stringify(expected)) return false;
          HTMLFormElement.prototype.submit.call(form);
          return true;
        }`,
      });
      return !result.exceptionDetails && result.result.value === true;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Native submission errors are a refusal, never agent-visible page prose.
    } catch (_error) {
      return false;
    }
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    await session.detach().catch(() => undefined);
  }
}
