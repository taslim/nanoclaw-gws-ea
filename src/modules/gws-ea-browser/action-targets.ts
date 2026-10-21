import type { ControlFacts } from './control-facts.js';
import { browserActionRefs } from './actions.js';
import { browserStructureFacts } from './observe.js';
import { browserPageReplayUrl, redactPageText } from './page-privacy.js';
import {
  ariaNodes,
  flatten,
  checkpointUrl,
  captureSnapshotLocator,
  type StructuredBrowserLocator,
} from './locators.js';
import type { BrowserRecipeStep } from './recording.js';
import type { ElementHandle, JSHandle, Page } from 'playwright-core';
import { isSensitiveField } from './authentication-signatures.js';
import {
  classifyActivation,
  classifyControlFacts,
  classifyNavigationUrl,
  readControlFacts,
  type ActivationIntent,
} from './commit-classifier.js';
import type { BrowserRef, PinnedBrowserRef } from './observe.js';
import type { BrowserAction } from './actions.js';

export async function isSecretBrowserField(target: Pick<PinnedBrowserRef, 'element'>): Promise<boolean> {
  const facts = await target.element.evaluate((node) => {
    const e = node as unknown as { getAttribute(name: string): string | null };
    const read = (name: string): string => e.getAttribute(name) ?? '';
    return {
      type: read('type'),
      autocomplete: read('autocomplete'),
      name: read('name'),
      id: read('id'),
      label: read('aria-label'),
      placeholder: read('placeholder'),
    };
  });
  return isSensitiveField(facts);
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

/**
 * Whether a target only reads: an ordinary control or field, on no transaction page, outside any form that
 * submits by anything but GET. Its replay loads GET documents only (KTD2), so a script that posts is refused.
 */
async function readOnlyTarget(page: Page, target: PinnedBrowserRef, kind: ActivationIntent['kind']): Promise<boolean> {
  if (await isSecretBrowserField(target)) return false;
  const facts = await readControlFacts(page, target.element);
  if (facts.transaction || facts.cardEntry || (await classifyActivation(page, target.element, kind)) !== 'ordinary')
    return false;
  return facts.formMethod === undefined || facts.formMethod.toLowerCase() === 'get';
}
/**
 * A read-only replay acts by the open rule, restricted to GET navigation: watches replay these without the
 * agent. Uploads and downloads never read only.
 */
export async function isReadOnlyBrowserAction(
  page: Page,
  action: BrowserAction,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<boolean> {
  const targets: Array<{ ref: BrowserRef; kind: ActivationIntent['kind'] }> = [];
  switch (action.kind) {
    case 'navigate':
      return classifyNavigationUrl(action.url) === 'ordinary';
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

/** Preparation projects existing core observation/native binding facts, with no browser operation or await. */
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
    const heading = flatten(ariaNodes(snapshot.tree)).find((node) => node.role === 'heading')?.name;
    const targets = browserActionRefs(action).map((ref, index) => {
      const target = refs.get(ref.ref);
      if (!target) throw new Error('Target unavailable');
      return persistedTargets?.[index] ?? captureSnapshotLocator(target, snapshot.tree);
    });
    const step = {
      action: structuredClone(action),
      targets,
      before: { url: checkpointUrl(snapshot.replayUrl), ...(heading ? { heading } : {}) },
      readOnly: false,
    };
    return redactPageText(page, JSON.stringify(step)) === JSON.stringify(step) ? structuredClone(step) : undefined;
  } catch {
    return undefined;
  }
}

/** Finish safe replay facts from the checks execution already needed, never a second inspection. */
export function enrichBrowserActionFacts(
  page: Page,
  prepared: BrowserRecipeStep | undefined,
  controls: ReadonlyMap<string, ControlFacts>,
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
      const facts = controls.get(targets[index].ref);
      const frameUrl = step.targets[index]?.frameUrls.at(-1);
      if (!facts || facts.secretEntry || !frameUrl) return undefined;
      step.inputs.push({ name: facts.inputName ?? '', origin: new URL(facts.formAction ?? frameUrl).origin });
    }
    const submits =
      action.kind === 'select' ||
      action.kind === 'click' ||
      (action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)) ||
      (action.kind === 'form_input' && action.submit);
    const submitRef = targets[action.kind === 'form_input' ? targets.length - 1 : 0];
    const submit = submitRef ? controls.get(submitRef.ref) : undefined;
    if (submits && submit) {
      if (action.kind === 'click' && submit.href) step.clickHref = submit.href;
      if (submit.formMethod?.toLowerCase() === 'get') step.getSubmissionFields = [...(submit.formFieldNames ?? [])];
    }
    step.readOnly =
      !['upload', 'download'].includes(action.kind) &&
      targets.every((ref) => {
        const facts = controls.get(ref.ref);
        return (
          facts &&
          !facts.secretEntry &&
          !facts.cardEntry &&
          !facts.transaction &&
          classifyControlFacts(
            facts,
            action.kind === 'select'
              ? 'select'
              : action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)
                ? 'submit'
                : 'click',
          ) === 'ordinary' &&
          (facts.formMethod === undefined || facts.formMethod.toLowerCase() === 'get')
        );
      });
    return redactPageText(page, JSON.stringify(step)) === JSON.stringify(step) ? step : undefined;
  } catch {
    return undefined;
  }
}
