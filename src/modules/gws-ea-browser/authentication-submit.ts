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
export interface NativeFieldFacts {
  name: string;
  type: string;
  autocomplete: string;
  /** Neither can be changed by a fill: a read-only or disabled field only displays what the account already is. */
  readonly: boolean;
  disabled: boolean;
}
/** A credential-form node as the isolated world reads it: the node itself, its form if any, and any submitter override. */
export interface NativeCredentialFacts {
  origin: string;
  tag: string;
  id: string;
  name: string;
  type: string;
  autocomplete: string;
  /** The site marks the node required (`required` or `aria-required`), as read in the isolated world. */
  required: boolean;
  override: { action: string; method: string; target: string } | null;
  form: { action: string; method: string; target: string; fields: NativeFieldFacts[] } | null;
}
export interface NativeCredentialBinding {
  frameId: string;
  loaderId: string;
  controlBackendNodeId: number;
  /** Null for a field or control outside any form: a JS-controlled, no-form flow. */
  formBackendNodeId: number | null;
  facts: NativeCredentialFacts;
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
  };
  const readCredentialNode = (node) => {
    const form = formFor(node);
    if (!node.isConnected || (form && !(form instanceof HTMLFormElement && form.isConnected))) return null;
    const overridden = ['formaction', 'formmethod', 'formtarget'].some(name => node.hasAttribute(name));
    return {
      origin: location.origin,
      tag: node.tagName, id: node.id || '', name: typeof node.name === 'string' ? node.name : '',
      type: typeof node.type === 'string' ? node.type : '', autocomplete: node.getAttribute('autocomplete') || '',
      required: node.required === true || node.getAttribute('aria-required') === 'true',
      override: overridden ? { action: node.formAction, method: node.formMethod, target: node.formTarget } : null,
      form: form ? {
        action: formProperty(form, 'action'), method: formProperty(form, 'method'), target: formProperty(form, 'target'),
        fields: Array.from(formProperty(form, 'elements'), field => ({
          name: field.name || '', type: field.type || '', autocomplete: field.getAttribute('autocomplete') || '',
          readonly: field.readOnly === true, disabled: field.matches(':disabled')
        }))
      } : null
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

/**
 * Every native write and activation runs here: a CDP session on the frame's
 * own target, the bound document still loaded, and the bound nodes resolved
 * by backend identity into this module's isolated world, where page scripts
 * cannot reach the prototypes the operation calls. Any failure before the
 * operation runs refuses with `refused`; the operation owns its own errors.
 */
async function withBoundNodes<T>(
  frame: Frame,
  document: { readonly frameId: string; readonly loaderId: string },
  backendNodeIds: readonly number[],
  refused: T,
  operation: (session: CDPSession, objectIds: readonly string[]) => Promise<T>,
): Promise<T> {
  let attached: Awaited<ReturnType<typeof attachFrameSession>>;
  try {
    attached = await attachFrameSession(frame);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Renderer errors refuse the operation without exposing protocol prose.
  } catch (_error) {
    return refused;
  }
  const { session } = attached;
  const objectGroup = `gws-ea-auth-${randomUUID()}`;
  try {
    const objectIds: string[] = [];
    try {
      const { frameTree } = await session.send('Page.getFrameTree');
      const selected = findFrame(frameTree, document.frameId);
      if (!selected || selected.frame.loaderId !== document.loaderId) return refused;
      const { executionContextId } = await session.send('Page.createIsolatedWorld', {
        frameId: document.frameId,
        worldName,
      });
      for (const backendNodeId of backendNodeIds) {
        const resolved = await session.send('DOM.resolveNode', { backendNodeId, executionContextId, objectGroup });
        if (!resolved.object.objectId) return refused;
        objectIds.push(resolved.object.objectId);
      }
      // eslint-disable-next-line no-catch-all/no-catch-all -- A vanished frame or node must refuse without exposing protocol prose.
    } catch (_error) {
      return refused;
    }
    return await operation(session, objectIds);
  } finally {
    await session.send('Runtime.releaseObjectGroup', { objectGroup }).catch(() => undefined);
    await session.detach().catch(() => undefined);
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
  return withBoundNodes(
    frame,
    field,
    [field.controlBackendNodeId, field.formBackendNodeId, submit.controlBackendNodeId],
    false,
    async (session, objects) => {
      try {
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
      }
    },
  );
}

export type CredentialFillResult = 'filled' | 'not_inserted' | 'changed';
export type CredentialActivationResult = 'activated' | 'disabled' | 'changed' | 'uncertain';

/** The credential group the browser chose: its fields, in value order, and the control that activates them. */
export interface NativeCredentialGroup {
  readonly fields: readonly NativeCredentialBinding[];
  readonly control: NativeCredentialBinding;
  /** A signup's required terms checkbox in the same form, checked just before activation. */
  readonly terms?: NativeCredentialBinding;
}

/** Shared by the fill and the activation: the bound document, origin, nodes and facts, all unchanged. */
const credentialGroupSource = `
  ${readControlSource}
  // A show-password toggle turns a password field into text and back, and a controlled form enables its
  // controls and marks them required as it fills: none of that changes what the group binds.
  const shape = (facts) => JSON.stringify(facts, (key, value) =>
    key === 'readonly' || key === 'disabled' || key === 'required' ? undefined
      : key === 'type' && value === 'text' ? 'password' : value);
  const same = (left, right) => shape(left) === shape(right);
  const valueOf = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value');
  const checkedOf = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'checked');
  const bound = (control, expectedControl, expectedFields, form, fields, expectedTerms, terms) =>
    location.protocol === 'https:' && control.ownerDocument === document &&
    same(readCredentialNode(control), expectedControl) &&
    fields.length === expectedFields.length &&
    fields.every((field, index) => field instanceof HTMLInputElement && field.ownerDocument === document &&
      !field.matches(':disabled') && !field.readOnly && formFor(field) === form &&
      same(readCredentialNode(field), expectedFields[index])) &&
    (expectedTerms === null ? terms === null
      : terms instanceof HTMLInputElement && terms.ownerDocument === document && terms.type === 'checkbox' &&
        !terms.matches(':disabled') && formFor(terms) === form && same(readCredentialNode(terms), expectedTerms));
  const holds = (fields, values) => fields.every((field, index) => valueOf.get.call(field) === values[index]);`;
const credentialParameters = 'expectedControl, expectedFields, values, expectedTerms, form, terms, ...fields';

/** Resolved as `credentialNodes` orders them: the control, the shared form and terms box when there are any, then each field. */
function credentialArguments(group: NativeCredentialGroup, values: readonly string[], objects: readonly string[]) {
  const formless = group.fields[0].formBackendNodeId === null;
  let next = 1;
  const form = formless ? { value: null } : { objectId: objects[next++] };
  const terms = group.terms ? { objectId: objects[next++] } : { value: null };
  return [
    { value: group.control.facts },
    { value: group.fields.map((field) => field.facts) },
    { value: values },
    { value: group.terms?.facts ?? null },
    form,
    terms,
    ...objects.slice(next).map((objectId) => ({ objectId })),
  ];
}

function credentialNodes(group: NativeCredentialGroup): number[] | undefined {
  const [first] = group.fields;
  if (
    !first ||
    [...group.fields, ...(group.terms ? [group.terms] : [])].some(
      (field) =>
        field.frameId !== group.control.frameId ||
        field.loaderId !== group.control.loaderId ||
        field.formBackendNodeId !== first.formBackendNodeId ||
        field.facts.origin !== group.control.facts.origin,
    ) ||
    (group.control.formBackendNodeId !== null && group.control.formBackendNodeId !== first.formBackendNodeId)
  )
    return undefined;
  return [
    group.control.controlBackendNodeId,
    ...(first.formBackendNodeId === null ? [] : [first.formBackendNodeId]),
    ...(group.terms ? [group.terms.controlBackendNodeId] : []),
    ...group.fields.map((field) => field.controlBackendNodeId),
  ];
}

/**
 * Inserts one credential group atomically: every node, the document, origin
 * and form are revalidated and every value is set through the native setter
 * in one synchronous renderer call, before any page callback can run. Only
 * then are input and change events dispatched, so controlled (JS) forms see
 * the values; their callbacks may run arbitrary site code (KTD7). Focus is
 * irrelevant throughout. `not_inserted` means nothing reached the page.
 */
export async function fillNativeCredentialGroup(
  frame: Frame,
  group: NativeCredentialGroup,
  values: readonly string[],
  assertActive: () => Promise<void>,
): Promise<CredentialFillResult> {
  const nodes = credentialNodes(group);
  if (!nodes || values.length !== group.fields.length) return 'not_inserted';
  return withBoundNodes(frame, group.control, nodes, 'not_inserted', async (session, objects) => {
    let started = false;
    try {
      await assertActive();
      started = true;
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: objects[0],
        returnByValue: true,
        arguments: credentialArguments(group, values, objects),
        functionDeclaration: `function (${credentialParameters}) {
          ${credentialGroupSource}
          const intact = () => bound(this, expectedControl, expectedFields, form, fields, expectedTerms, terms);
          if (!intact()) return 'not_inserted';
          fields.forEach((field, index) => valueOf.set.call(field, values[index]));
          if (!holds(fields, values)) return 'changed';
          for (const field of fields) {
            EventTarget.prototype.dispatchEvent.call(field, new InputEvent('input', {
              bubbles: true, composed: true, inputType: 'insertReplacementText'
            }));
            EventTarget.prototype.dispatchEvent.call(field, new Event('change', { bubbles: true }));
          }
          return intact() && holds(fields, values) ? 'filled' : 'changed';
        }`,
      });
      const value: unknown = result.result.value;
      if (result.exceptionDetails) return 'changed';
      return value === 'filled' || value === 'not_inserted' || value === 'changed' ? value : 'changed';
      // eslint-disable-next-line no-catch-all/no-catch-all -- Never expose renderer exceptions, which may contain a credential value.
    } catch (_error) {
      // Once the call may have started, values may be in the page.
      return started ? 'changed' : 'not_inserted';
    }
  });
}

/**
 * Checks a signup's bound terms box through its own click, once, when it is
 * not already checked, so the site's handlers see the acceptance; then
 * verifies the box holds it. Any other box is never touched.
 */
async function checkTermsBox(
  session: CDPSession,
  group: NativeCredentialGroup,
  values: readonly string[],
  objects: readonly string[],
): Promise<boolean> {
  try {
    const result = await session.send('Runtime.callFunctionOn', {
      objectId: objects[0],
      returnByValue: true,
      arguments: credentialArguments(group, values, objects),
      functionDeclaration: `function (${credentialParameters}) {
        ${credentialGroupSource}
        if (!terms || !bound(this, expectedControl, expectedFields, form, fields, expectedTerms, terms) ||
            !holds(fields, values)) return false;
        if (!checkedOf.get.call(terms)) HTMLElement.prototype.click.call(terms);
        return checkedOf.get.call(terms) === true;
      }`,
    });
    return !result.exceptionDetails && result.result.value === true;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Never expose renderer exceptions, which may contain a credential value.
  } catch (_error) {
    return false;
  }
}

/**
 * Activates the bound control exactly once, by its own node and through the
 * isolated world's click, after revalidating the group and that every field
 * still holds its value; a bound terms box is checked just before, in its own
 * call, so the site sees it first. A native form submits natively; a
 * JS-controlled or no-form control runs its own handlers. `uncertain` means
 * the click may have run; `disabled` and `changed` mean it did not.
 */
export async function activateNativeCredentialControl(
  frame: Frame,
  group: NativeCredentialGroup,
  values: readonly string[],
  assertActive: () => Promise<void>,
): Promise<CredentialActivationResult> {
  const nodes = credentialNodes(group);
  if (!nodes || values.length !== group.fields.length) return 'changed';
  return withBoundNodes(frame, group.control, nodes, 'changed', async (session, objects) => {
    await assertActive();
    if (group.terms && !(await checkTermsBox(session, group, values, objects))) return 'changed';
    await assertActive();
    try {
      const result = await session.send('Runtime.callFunctionOn', {
        objectId: objects[0],
        returnByValue: true,
        arguments: credentialArguments(group, values, objects),
        functionDeclaration: `function (${credentialParameters}) {
          ${credentialGroupSource}
          if (!bound(this, expectedControl, expectedFields, form, fields, expectedTerms, terms) || !holds(fields, values) ||
              (terms && checkedOf.get.call(terms) !== true)) return 'changed';
          if (this.matches(':disabled') || this.getAttribute('aria-disabled') === 'true') return 'disabled';
          // A native GET submission would carry the values in its address; one no page handler took over is cancelled.
          const address = (event) => {
            if (form && event.target === form && formProperty(form, 'method') === 'get') event.preventDefault();
          };
          addEventListener('submit', address);
          try {
            HTMLElement.prototype.click.call(this);
          } finally {
            removeEventListener('submit', address);
          }
          return 'activated';
        }`,
      });
      const value: unknown = result.result.value;
      if (result.exceptionDetails) return 'uncertain';
      return value === 'activated' || value === 'disabled' || value === 'changed' ? value : 'uncertain';
      // eslint-disable-next-line no-catch-all/no-catch-all -- The click may have run; never expose renderer prose.
    } catch (_error) {
      return 'uncertain';
    }
  });
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

interface InspectedNode<Facts> {
  frameId: string;
  loaderId: string;
  controlBackendNodeId: number;
  formBackendNodeId: number | null;
  facts: Facts;
}

/** Transfer exact DOM identity between public APIs without mutable DOM markers. */
async function inspectNativeNode<Facts>(
  element: ElementHandle,
  frame: Frame,
  reader: 'readControl' | 'readCredentialNode',
): Promise<InspectedNode<Facts> | undefined> {
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
        return slot.count === 1 && slot.control ? ${reader}(slot.control) : null;
      })()`,
    });
    const facts = factsResult.result.value as Facts | null | undefined;
    if (factsResult.exceptionDetails || !facts) return undefined;
    const ids: Array<number | null> = [];
    for (const name of ['control', 'form'] as const) {
      const captured = await session.send('Runtime.evaluate', {
        contextId,
        objectGroup: eventName,
        expression: `globalThis[${JSON.stringify(eventName)}].${name}`,
      });
      // Only a credential node may stand outside any form.
      if (name === 'form' && reader === 'readCredentialNode' && captured.result.subtype === 'null') {
        ids.push(null);
        continue;
      }
      if (!captured.result.objectId) return undefined;
      const { node } = await session.send('DOM.describeNode', { objectId: captured.result.objectId });
      ids.push(node.backendNodeId);
    }
    if (ids[0] === null) return undefined;
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

export async function inspectNativeAuthenticationControl(
  element: ElementHandle,
  frame: Frame,
): Promise<NativeAuthenticationBinding | undefined> {
  const inspected = await inspectNativeNode<NativeAuthenticationFacts>(element, frame, 'readControl');
  if (!inspected || inspected.formBackendNodeId === null) return undefined;
  return { ...inspected, formBackendNodeId: inspected.formBackendNodeId };
}

/** The same exact-node handoff for a credential field or control, which may stand outside any form. */
export function inspectNativeCredentialControl(
  element: ElementHandle,
  frame: Frame,
): Promise<NativeCredentialBinding | undefined> {
  return inspectNativeNode<NativeCredentialFacts>(element, frame, 'readCredentialNode');
}

/** Resolve native identities into an isolated world; revalidate and submit in one synchronous call. */
export async function submitNativeAuthenticationForm(
  frame: Frame,
  binding: NativeAuthenticationBinding,
  assertActive?: () => Promise<void>,
): Promise<boolean> {
  return withBoundNodes(
    frame,
    binding,
    [binding.controlBackendNodeId, binding.formBackendNodeId],
    false,
    async (session, [controlObjectId, formObjectId]) => {
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
    },
  );
}
