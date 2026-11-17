import { classifyNavigationUrl, type ActionClass } from './control-policy.js';
import { readPageControlFacts, withheldField, type ControlFacts } from './control-facts.js';
import { browserActionRefs, type BrowserAction, type BrowserCommitmentContinuation } from './actions.js';
import { browserRefForElement, browserStructureFacts, type BrowserRef, type PinnedBrowserRef } from './observe.js';
import { browserPageReplayUrl, redactPageData } from './page-privacy.js';
import {
  ariaNodes,
  captureElementRole,
  captureSnapshotLocator,
  flatten,
  type StructuredBrowserLocator,
} from './locators.js';
import { checkpoint, type BrowserRecipeStep } from './recording.js';
import type { ElementHandle, Frame, JSHandle, Page } from 'playwright-core';
import { classifyActivation, type ActivationIntent } from './commit-classifier.js';

export interface CapturedBrowserCommitTarget {
  readonly element: ElementHandle;
  readonly frame: Frame;
  readonly documentHref: string;
  dispose(): Promise<void>;
}

/** The keyboard and recipe paths must identify the very same native submit control. */
export function browserKeyboardSubmitTarget(element: ElementHandle): Promise<JSHandle<unknown>> {
  return element.evaluateHandle((node) => {
    const e = node as unknown as { tagName: string; form?: { querySelector(selector: string): unknown } };
    return ['INPUT', 'TEXTAREA', 'SELECT'].includes(e.tagName)
      ? (e.form?.querySelector('button[type="submit"],input[type="submit"],button:not([type])') ?? null)
      : node;
  });
}

/** Retains an independent handle to the actual control refused with `purchase_control` across ref cleanup. */
export async function captureBrowserCommitTarget(
  element: ElementHandle | null | undefined,
): Promise<CapturedBrowserCommitTarget | undefined> {
  if (!element) return undefined;
  const handle = await element.evaluateHandle((node) => node).catch(() => undefined);
  const cloned = handle?.asElement();
  if (!cloned) {
    await handle?.dispose().catch(() => undefined);
    return undefined;
  }
  try {
    const frame = await cloned.ownerFrame();
    const state = await cloned
      .evaluate((node) => ({
        connected: (node as unknown as { isConnected?: boolean }).isConnected === true,
        href: (node as unknown as { ownerDocument?: { location?: { href?: string } } }).ownerDocument?.location?.href,
      }))
      .catch(() => undefined);
    if (!frame || !state?.connected || !state.href) {
      await cloned.dispose().catch(() => undefined);
      return undefined;
    }
    return {
      element: cloned,
      frame,
      documentHref: state.href,
      dispose: () => cloned.dispose().catch(() => undefined),
    };
  } catch {
    await cloned.dispose().catch(() => undefined);
    return undefined;
  }
}

/** Rebinds a captured commit control in the closing observation's generation, or reports that recovery is needed. */
export async function resolveObservedCommitTarget(
  page: Page,
  captured: CapturedBrowserCommitTarget | undefined,
  observationGeneration: number | undefined,
): Promise<BrowserCommitmentContinuation> {
  if (!captured || observationGeneration === undefined || page.isClosed()) return { status: 'changed' };
  try {
    const frame = await captured.element.ownerFrame();
    if (!frame || frame !== captured.frame) return { status: 'changed' };
    const current = await captured.element.evaluate((node) => ({
      connected: (node as unknown as { isConnected?: boolean }).isConnected === true,
      href: (node as unknown as { ownerDocument?: { location?: { href?: string } } }).ownerDocument?.location?.href,
    }));
    if (!current.connected || current.href !== captured.documentHref) return { status: 'changed' };
    const role = await captureElementRole(captured.element);
    const target = await browserRefForElement(page, captured.element, { role });
    return target.generation === observationGeneration ? { status: 'ready', target } : { status: 'changed' };
  } catch {
    return { status: 'changed' };
  }
}

async function readOnlyTarget(page: Page, target: PinnedBrowserRef, kind: ActivationIntent['kind']): Promise<boolean> {
  const facts = await readPageControlFacts(page, target.element);
  if (
    withheldField(facts) ||
    facts.transaction ||
    (await classifyActivation(page, target.element, kind)) !== 'ordinary'
  )
    return false;
  return facts.formMethod === undefined || facts.formMethod.toLowerCase() === 'get';
}
/** The open rule restricted to GET navigation, because watches replay read-only actions without the agent. */
export async function isReadOnlyBrowserAction(
  page: Page,
  action: BrowserAction,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<boolean> {
  const targets: Array<{ ref: BrowserRef; kind: ActivationIntent['kind'] }> = [];
  switch (action.kind) {
    case 'navigate':
      return classifyNavigationUrl(action.url, 'document') === 'ordinary';
    case 'observe':
    case 'wait_for':
    case 'scroll':
    case 'screenshot':
      return true;
    case 'upload':
    case 'download':
      return false;
    case 'click':
    case 'type':
      targets.push({ ref: action, kind: 'click' });
      break;
    case 'select':
      targets.push({ ref: action, kind: 'select' });
      break;
    case 'key':
      targets.push({ ref: action, kind: /^(?:Shift\+)?Enter$/u.test(action.key) ? 'submit' : 'click' });
      break;
    case 'form_input':
      targets.push(...action.fields.map((field) => ({ ref: field, kind: 'click' as const })));
      if (action.submit) targets.push({ ref: action.submit, kind: 'submit' });
      break;
    default: {
      const unknown: never = action;
      throw new Error(`Unknown browser action ${JSON.stringify(unknown)}`);
    }
  }
  for (const { ref, kind } of targets) {
    const target = refs.get(ref.ref);
    if (!target || !(await readOnlyTarget(page, target, kind))) return false;
  }
  return true;
}

/** Projects only facts observation and native binding already hold; it performs no browser operation. */
export function prepareBrowserActionFacts(
  page: Page,
  action: BrowserAction,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
  persistedTargets?: readonly StructuredBrowserLocator[],
): BrowserRecipeStep | undefined {
  const snapshot =
    browserStructureFacts(page) ??
    (page.url() === 'about:blank' ? { generation: 0, replayUrl: browserPageReplayUrl(page), tree: [] } : undefined);
  if (!snapshot?.replayUrl) return undefined;
  try {
    const nodes = flatten(ariaNodes(snapshot.tree));
    const before = checkpoint(snapshot, nodes);
    const targets = browserActionRefs(action).map((ref, index) => {
      const target = refs.get(ref.ref);
      if (!target) throw new Error('Target unavailable');
      return persistedTargets?.[index] ?? captureSnapshotLocator(target, nodes);
    });
    const step = {
      action: structuredClone(action),
      targets,
      before,
      readOnly: false,
    };
    return JSON.stringify(redactPageData(page, step)) === JSON.stringify(step) ? structuredClone(step) : undefined;
  } catch {
    return undefined;
  }
}

export interface BrowserActionControl {
  readonly facts: ControlFacts;
  readonly classification: ActionClass;
}

/** Finish safe replay facts from the checks execution already needed, never a second inspection. */
export function enrichBrowserActionFacts(
  page: Page,
  prepared: BrowserRecipeStep | undefined,
  controls: ReadonlyMap<string, BrowserActionControl>,
): BrowserRecipeStep | undefined {
  try {
    if (!prepared) return undefined;
    const step = structuredClone(prepared);
    const { action } = step;
    const targets = browserActionRefs(action);
    const inputCount =
      action.kind === 'type' || action.kind === 'select' ? 1 : action.kind === 'form_input' ? action.fields.length : 0;
    step.inputs = [];
    for (let index = 0; index < inputCount; index++) {
      const facts = controls.get(targets[index].ref)?.facts;
      const frameUrl = step.targets[index]?.frameUrls.at(-1);
      if (!facts || withheldField(facts) || !frameUrl) return undefined;
      step.inputs.push({ name: facts.inputName ?? '', origin: new URL(facts.formAction ?? frameUrl).origin });
    }
    const submits =
      action.kind === 'select' ||
      action.kind === 'click' ||
      (action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)) ||
      (action.kind === 'form_input' && action.submit);
    const submitRef = targets[action.kind === 'form_input' ? targets.length - 1 : 0];
    const submit = submitRef ? controls.get(submitRef.ref)?.facts : undefined;
    if (submits && submit) {
      if (action.kind === 'click' && submit.href) step.clickHref = submit.href;
      if (submit.formMethod?.toLowerCase() === 'get') step.getSubmissionFields = [...(submit.formFieldNames ?? [])];
    }
    step.readOnly =
      !['upload', 'download'].includes(action.kind) &&
      targets.every((ref) => {
        const control = controls.get(ref.ref);
        if (!control) return false;
        const { facts, classification } = control;
        return (
          !withheldField(facts) &&
          !facts.transaction &&
          classification === 'ordinary' &&
          (facts.formMethod === undefined || facts.formMethod.toLowerCase() === 'get')
        );
      });
    return JSON.stringify(redactPageData(page, step)) === JSON.stringify(step) ? step : undefined;
  } catch {
    return undefined;
  }
}
