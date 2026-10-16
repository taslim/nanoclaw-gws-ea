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
let latestRegisteredSelector: Promise<string> | undefined;

/** CDP default contexts need registration after connecting, before creating pages. */
export async function prepareAuthenticationIsolation(
  context: BrowserContext,
  inheritsRegisteredSelectors = false,
): Promise<void> {
  let registered = contextSelectors.get(context);
  if (!registered) {
    if (inheritsRegisteredSelectors && latestRegisteredSelector) registered = latestRegisteredSelector;
    else {
      const name = `gws-ea-native-authentication-${randomUUID()}`;
      registered = selectors.register(name, selectorSource, { contentScript: true }).then(() => name);
      latestRegisteredSelector = registered;
    }
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
  control: { tag: string; name: string; type: string; autocomplete: string };
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
      control: { tag: control.tagName, name: control.name || '', type: control.type || '', autocomplete: control.getAttribute('autocomplete') || '' },
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

/** The value is a protocol argument, never executable source or a Playwright call-log argument.
 * Node, document, origin and form validation and the native setter run atomically in the isolated world.
 * Ambient focus is irrelevant: another frame cannot redirect this write.
 */
export async function fillNativeAuthenticationField(
  frame: Frame,
  field: NativeAuthenticationBinding,
  submit: NativeAuthenticationBinding,
  value: string,
  assertActive: () => Promise<void>,
): Promise<boolean> {
  if (
    field.frameId !== submit.frameId ||
    field.loaderId !== submit.loaderId ||
    field.formBackendNodeId !== submit.formBackendNodeId ||
    field.facts.origin !== submit.facts.origin
  )
    return false;
  let attached: Awaited<ReturnType<typeof attachFrameSession>>;
  try {
    attached = await attachFrameSession(frame);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Renderer errors refuse the write without exposing protocol prose.
  } catch (_error) {
    return false;
  }
  const { session } = attached;
  const objectGroup = `gws-ea-auth-${randomUUID()}`;
  try {
    const { frameTree } = await session.send('Page.getFrameTree');
    const selected = findFrame(frameTree, field.frameId);
    if (!selected || selected.frame.loaderId !== field.loaderId) return false;
    const { executionContextId } = await session.send('Page.createIsolatedWorld', {
      frameId: field.frameId,
      worldName,
    });
    const objects: string[] = [];
    for (const backendNodeId of [field.controlBackendNodeId, field.formBackendNodeId, submit.controlBackendNodeId]) {
      const resolved = await session.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup });
      if (!resolved.object.objectId) return false;
      objects.push(resolved.object.objectId);
    }
    await assertActive();
    const result = await session.send('Runtime.callFunctionOn', {
      objectId: objects[0],
      returnByValue: true,
      arguments: [
        { objectId: objects[1] },
        { objectId: objects[2] },
        { value: field.facts },
        { value: submit.facts },
        { value },
      ],
      functionDeclaration: `function (form, submit, expectedField, expectedSubmit, value) {
        ${readControlSource}
        if (location.protocol !== 'https:' || location.origin !== expectedField.origin ||
            !(this instanceof HTMLInputElement) || this.ownerDocument !== document ||
            form.ownerDocument !== document || submit.ownerDocument !== document ||
            !this.isConnected || this.matches(':disabled') || this.readOnly ||
            formFor(this) !== form || formFor(submit) !== form ||
            JSON.stringify(readControl(this)) !== JSON.stringify(expectedField) ||
            JSON.stringify(readControl(submit)) !== JSON.stringify(expectedSubmit)) return false;
        const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
        descriptor.set.call(this, value);
        return descriptor.get.call(this) === value;
      }`,
    });
    return !result.exceptionDetails && result.result.value === true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Never expose renderer exceptions, which may contain a sign-in value.
  } catch (_error) {
    return false;
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    await session.detach().catch(() => undefined);
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
