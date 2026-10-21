import { createHash, randomUUID } from 'node:crypto';
import type { ElementHandle, Frame, Locator, Page } from 'playwright-core';
import { invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { isRecord } from '../../gws-ea/validation.js';
import {
  classifyActivation,
  classifyNavigationUrl,
  readControlFacts,
  type ActivationIntent,
} from './commit-classifier.js';
import {
  browserActionRefs,
  browserKeyboardSubmitTarget,
  executeBrowserBatch,
  isSecretBrowserField,
  type BrowserAction,
  type BrowserBatchOptions,
} from './executor.js';
import { browserSite } from './leases.js';
import {
  disposeBrowserRefs,
  observePage,
  pinBrowserRefs,
  redactPageText,
  registerBrowserSiteInfoProvider,
  snapshotBrowserStructure,
  type BrowserObservation,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import type { BrowserExecutionContext, BrowserOperationContext, BrowserQueuedAction } from './actions.js';

type BrowserRole = Parameters<Frame['getByRole']>[0];
const roles = new Set<BrowserRole>([
  'alert',
  'alertdialog',
  'application',
  'article',
  'banner',
  'blockquote',
  'button',
  'caption',
  'cell',
  'checkbox',
  'code',
  'columnheader',
  'combobox',
  'complementary',
  'contentinfo',
  'definition',
  'deletion',
  'dialog',
  'directory',
  'document',
  'emphasis',
  'feed',
  'figure',
  'form',
  'generic',
  'grid',
  'gridcell',
  'group',
  'heading',
  'img',
  'insertion',
  'link',
  'list',
  'listbox',
  'listitem',
  'log',
  'main',
  'marquee',
  'math',
  'menu',
  'menubar',
  'menuitem',
  'menuitemcheckbox',
  'menuitemradio',
  'meter',
  'navigation',
  'none',
  'note',
  'option',
  'paragraph',
  'presentation',
  'progressbar',
  'radio',
  'radiogroup',
  'region',
  'row',
  'rowgroup',
  'rowheader',
  'scrollbar',
  'search',
  'searchbox',
  'separator',
  'slider',
  'spinbutton',
  'status',
  'strong',
  'subscript',
  'superscript',
  'switch',
  'tab',
  'table',
  'tablist',
  'tabpanel',
  'term',
  'textbox',
  'time',
  'timer',
  'toolbar',
  'tooltip',
  'tree',
  'treegrid',
  'treeitem',
]);
function isRole(value: string): value is BrowserRole {
  return roles.has(value as BrowserRole);
}
interface AriaNode {
  role: string;
  name: string;
  children: AriaNode[];
}
function ariaNodes(raw: unknown): AriaNode[] {
  if (Array.isArray(raw)) return raw.flatMap(ariaNodes);
  if (!isRecord(raw)) return [];
  const children = ariaNodes(raw.children);
  return typeof raw.role === 'string'
    ? [{ role: raw.role, name: typeof raw.name === 'string' ? raw.name : '', children }]
    : children;
}
function flatten(nodes: readonly AriaNode[]): AriaNode[] {
  return nodes.flatMap((node) => [node, ...flatten(node.children)]);
}
export interface StructuredBrowserLocator {
  role: BrowserRole;
  name: string;
  ordinal: number;
  count: number;
  framePath: number[];
  frameUrls: string[];
}
interface RecipeCheckpoint {
  url: string;
  heading?: string;
}
export interface BrowserRecipeStep {
  action: BrowserAction;
  targets: StructuredBrowserLocator[];
  before: RecipeCheckpoint;
  after?: RecipeCheckpoint;
  readOnly: boolean;
  stopReason?: string;
  saveError?: string;
  inputs?: Array<{ name: string; origin: string }>;
  getSubmissionFields?: string[];
  clickHref?: string;
}
export interface BrowserRecipeParameter {
  name: string;
  step: number;
  recordedValue: string;
  kind: 'value' | 'target_name';
  inputName?: string;
  origin?: string;
}
export interface BrowserRecipe {
  id: string;
  site: string;
  name: string;
  version: number;
  sourceJobId: string;
  firstAction: number;
  lastAction: number;
  parameters: BrowserRecipeParameter[];
  steps: BrowserRecipeStep[];
  readOnly: boolean;
}
interface RecipeRow {
  id: string;
  site: string;
  name: string;
  version: number;
  parameters_json: string;
  steps_json: string;
  read_only: number;
  source_job_id: string;
  first_action: number;
  last_action: number;
}
interface TraceRow {
  action_index: number;
  step_json: string;
}
interface SaveRecipeInput extends Record<string, unknown> {
  name: string;
  first_action: number;
  last_action: number;
  parameters: Array<{ name: string; action_index: number }>;
}
interface RunRecipeInput extends Record<string, unknown> {
  recipe_id: string;
  parameters: Record<string, string>;
}
function closed(raw: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(raw).some((key) => !allowed.includes(key))) throw invalidArgs('Unknown recipe field.');
}
export function validateSaveRecipe(raw: Record<string, unknown>): SaveRecipeInput {
  closed(raw, ['action', 'requestId', 'name', 'first_action', 'last_action', 'parameters', 'budget_ms']);
  if (
    typeof raw.name !== 'string' ||
    !raw.name.trim() ||
    !Number.isInteger(raw.first_action) ||
    Number(raw.first_action) < 0 ||
    !Number.isInteger(raw.last_action) ||
    Number(raw.last_action) < Number(raw.first_action) ||
    !Array.isArray(raw.parameters)
  )
    throw invalidArgs('Saving a recipe requires a task name and inclusive global action range.');
  const names = new Set<string>();
  const indices = new Set<number>();
  const parameters = raw.parameters.map((value) => {
    if (!isRecord(value)) throw invalidArgs('A recipe input must name one recorded action.');
    closed(value, ['name', 'action_index']);
    if (
      typeof value.name !== 'string' ||
      !value.name.trim() ||
      !Number.isInteger(value.action_index) ||
      Number(value.action_index) < Number(raw.first_action) ||
      Number(value.action_index) > Number(raw.last_action) ||
      names.has(value.name) ||
      indices.has(Number(value.action_index))
    )
      throw invalidArgs('Recipe input names and action bindings must be unique and within the saved range.');
    names.add(value.name);
    indices.add(Number(value.action_index));
    return { name: value.name, action_index: Number(value.action_index) };
  });
  return {
    name: raw.name.trim(),
    first_action: Number(raw.first_action),
    last_action: Number(raw.last_action),
    parameters,
  };
}
export function validateRunRecipe(raw: Record<string, unknown>): RunRecipeInput {
  closed(raw, ['action', 'requestId', 'recipe_id', 'parameters', 'budget_ms']);
  if (
    typeof raw.recipe_id !== 'string' ||
    !raw.recipe_id ||
    !isRecord(raw.parameters) ||
    Object.values(raw.parameters).some((value) => typeof value !== 'string')
  )
    throw invalidArgs('Running a recipe requires its id and named text inputs.');
  return { recipe_id: raw.recipe_id, parameters: raw.parameters as Record<string, string> };
}
function checkpointUrl(raw: string): string {
  const url = new URL(raw);
  if (!['http:', 'https:'].includes(url.protocol)) return url.href;
  url.searchParams.sort();
  return `${url.origin}${url.pathname}${url.search}`;
}
function checkpoint(snapshot: Awaited<ReturnType<typeof snapshotBrowserStructure>>): RecipeCheckpoint {
  const heading = flatten(ariaNodes(snapshot.tree)).find((node) => node.role === 'heading')?.name;
  return { url: checkpointUrl(snapshot.url), ...(heading ? { heading } : {}) };
}
async function framePath(frame: Frame): Promise<{ framePath: number[]; frameUrls: string[] }> {
  const path: number[] = [];
  const urls: string[] = [];
  let current: Frame | null = frame;
  while (current) {
    urls.unshift(checkpointUrl(current.url()));
    const parent: Frame | null = current.parentFrame();
    if (parent) {
      const ordinal = parent.childFrames().indexOf(current);
      if (ordinal < 0) throw new Error('Detached frame');
      path.unshift(ordinal);
    }
    current = parent;
  }
  return { framePath: path, frameUrls: urls };
}
async function captureLocator(target: PinnedBrowserRef, nodes: readonly AriaNode[]): Promise<StructuredBrowserLocator> {
  const visited = new Set<string>();
  for (const node of nodes) {
    if (!isRole(node.role)) continue;
    const key = JSON.stringify([node.role, node.name]);
    if (visited.has(key)) continue;
    visited.add(key);
    const matches = target.frame.getByRole(node.role, { name: node.name, exact: true });
    const ordinal = await matches.evaluateAll((elements, element) => elements.indexOf(element), target.element);
    if (ordinal >= 0)
      return {
        role: node.role,
        name: node.name,
        ordinal,
        count: await matches.count(),
        ...(await framePath(target.frame)),
      };
  }
  throw new Error('No structured accessible locator for this target');
}
/** The roles a host-found control can carry: what a press can be aimed at. */
const PRESS_ROLES: readonly BrowserRole[] = ['button', 'link', 'menuitem', 'tab', 'option'];
/**
 * A host-found control's structured locator (KTD4): its role and accessible name as Playwright reads them, its
 * ordinal among their matches, and its frame path, so `resolveLocator` finds it again on a later read.
 */
export async function captureElementLocator(element: ElementHandle): Promise<StructuredBrowserLocator> {
  const frame = await element.ownerFrame();
  if (!frame) throw new Error('Detached element');
  for (const role of PRESS_ROLES) {
    const all = frame.getByRole(role);
    const index = await all.evaluateAll((elements, target) => elements.indexOf(target), element);
    if (index < 0) continue;
    const [node] = ariaNodes(await all.nth(index).ariaSnapshotJSON({ timeout: 1_000 }));
    if (node?.role !== role) continue;
    const name = node.name;
    const matches = frame.getByRole(role, { name, exact: true });
    const ordinal = await matches.evaluateAll((elements, target) => elements.indexOf(target), element);
    if (ordinal >= 0) return { role, name, ordinal, count: await matches.count(), ...(await framePath(frame)) };
  }
  throw new Error('No structured accessible locator for this element');
}
/** The element a structured locator names, as a Playwright locator: its frames and its matches' count unchanged. */
export async function locateStructured(
  page: Page,
  target: StructuredBrowserLocator,
  checkMainUrl = true,
): Promise<Locator> {
  let frame = page.mainFrame();
  if (checkMainUrl && checkpointUrl(frame.url()) !== target.frameUrls[0]) throw new Error('Frame changed');
  for (let index = 0; index < target.framePath.length; index++) {
    const child = frame.childFrames()[target.framePath[index]];
    if (!child || checkpointUrl(child.url()) !== target.frameUrls[index + 1]) throw new Error('Frame changed');
    frame = child;
  }
  const matches = frame.getByRole(target.role, { name: target.name, exact: true });
  if ((await matches.count()) !== target.count) throw new Error('Accessible element count changed');
  return matches.nth(target.ordinal);
}
export async function resolveLocator(
  page: Page,
  target: StructuredBrowserLocator,
  checkMainUrl = true,
): Promise<ElementHandle> {
  const element = await (await locateStructured(page, target, checkMainUrl)).elementHandle({ timeout: 1_000 });
  if (!element) throw new Error('Element is absent');
  return element;
}
/**
 * A watch's marked region (KTD20): the element's structured locator, recorded as a recipe step's target is, when its
 * page is where `recipe` ends (the same address path and heading; inputs may change its query). `off_route` when it is
 * elsewhere, undefined when no accessible role and name find the element again. A watch replays the recipe, then finds
 * the region by `locateStructured`.
 */
export async function captureRecipeRegion(
  page: Page,
  target: PinnedBrowserRef,
  recipe: BrowserRecipe,
): Promise<StructuredBrowserLocator | 'off_route' | undefined> {
  const snapshot = await snapshotBrowserStructure(page);
  const end = recipe.steps.at(-1)?.after;
  const here = checkpoint(snapshot);
  const route = (point: RecipeCheckpoint): string => {
    const url = new URL(point.url);
    return JSON.stringify([url.origin, url.pathname, point.heading ?? null]);
  };
  if (!end || route(end) !== route(here)) return 'off_route';
  try {
    return await captureLocator(target, flatten(ariaNodes(snapshot.tree)));
  } catch (error) {
    if (error instanceof Error) return undefined;
    throw error;
  }
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
/** The original handles were all pinned before this JSON snapshot can replace their refs. */
export async function beginBrowserActionTrace(
  context: BrowserExecutionContext,
  page: Page,
  action: BrowserAction,
  refs: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<{ index: number; finish(reason?: string): Promise<void> }> {
  const snapshot = await snapshotBrowserStructure(page);
  const step: BrowserRecipeStep = {
    action: structuredClone(action),
    targets: [],
    before: checkpoint(snapshot),
    readOnly: false,
  };
  try {
    if (redactPageText(page, JSON.stringify(action)) !== JSON.stringify(action))
      throw new Error('Secret-bearing action');
    const nodes = flatten(ariaNodes(snapshot.tree));
    const actionTargets = browserActionRefs(action);
    const inputCount =
      action.kind === 'type' || action.kind === 'select' ? 1 : action.kind === 'form_input' ? action.fields.length : 0;
    step.inputs = [];
    for (const [index, ref] of actionTargets.entries()) {
      const target = refs.get(ref.ref);
      if (!target || (await isSecretBrowserField(target))) throw new Error('Secret or unavailable target');
      step.targets.push(await captureLocator(target, nodes));
      if (index < inputCount) {
        const name = (await target.element.getAttribute('name')) ?? '';
        const facts = await readControlFacts(page, target.element);
        step.inputs.push({ name, origin: new URL(facts.formAction ?? target.frame.url()).origin });
      }
    }
    const submits =
      action.kind === 'select' ||
      action.kind === 'click' ||
      (action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)) ||
      (action.kind === 'form_input' && action.submit);
    const submitRef = actionTargets[action.kind === 'form_input' ? actionTargets.length - 1 : 0];
    const submit = submitRef ? refs.get(submitRef.ref) : undefined;
    if (submits && submit) {
      const facts = await readControlFacts(page, submit.element);
      if (action.kind === 'click' && facts.href) {
        if (redactPageText(page, facts.href) !== facts.href) throw new Error('Secret-bearing target URL');
        step.clickHref = facts.href;
      }
      if (facts.formMethod?.toLowerCase() === 'get')
        step.getSubmissionFields = await submit.element.evaluate((node) => {
          const e = node as unknown as { form?: { elements: ArrayLike<{ name?: string }> } };
          return Array.from(e.form?.elements ?? [])
            .map((field) => field.name ?? '')
            .filter(Boolean);
        });
    }
    step.readOnly = await isReadOnlyBrowserAction(page, action, refs);
  } catch (_error) {
    // Refused secret input values never enter the trace, including in diagnostic rows.
    step.action = { kind: 'observe' };
    step.targets = [];
    step.saveError = 'The action has no safe structured locator or contains secret material.';
  }
  const index = await context.store.db.transaction(async () => {
    const last = await context.store.db.get<{ last: number | null }>(
      'SELECT MAX(action_index) AS last FROM gws_ea_browser_action_trace WHERE job_id = ?',
      context.job.id,
    );
    const next = (last?.last ?? -1) + 1;
    await context.store.db.run(
      'INSERT INTO gws_ea_browser_action_trace(job_id,action_index,request_id,step_json,created_at) VALUES(?,?,?,?,?)',
      context.job.id,
      next,
      context.request.id,
      JSON.stringify(step),
      new Date().toISOString(),
    );
    return next;
  });
  return {
    index,
    async finish(reason) {
      if (reason) step.stopReason = reason;
      if (!page.isClosed()) {
        try {
          step.after = checkpoint(await snapshotBrowserStructure(page));
        } catch (_error) {
          step.saveError ??= 'The page checkpoint was unavailable.';
        }
      } else step.saveError ??= 'The page closed before its checkpoint.';
      await context.store.db.run(
        'UPDATE gws_ea_browser_action_trace SET step_json = ? WHERE job_id = ? AND action_index = ?',
        JSON.stringify(step),
        context.job.id,
        index,
      );
    },
  };
}
function inputValue(action: BrowserAction): string | undefined {
  if (action.kind === 'type') return action.text;
  if (action.kind === 'select') return action.value;
  if (action.kind === 'form_input' && action.fields.length === 1) return action.fields[0].value;
  return undefined;
}
export async function saveBrowserRecipe(
  context: BrowserExecutionContext,
  payload: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const input = validateSaveRecipe(payload);
  const rows = await context.store.db.all<TraceRow>(
    'SELECT action_index,step_json FROM gws_ea_browser_action_trace WHERE job_id = ? AND action_index >= ? AND action_index <= ? ORDER BY action_index',
    context.job.id,
    input.first_action,
    input.last_action,
  );
  if (rows.length !== input.last_action - input.first_action + 1)
    throw invalidArgs('The entire recorded action range is required.');
  const steps = rows.map((row) => JSON.parse(row.step_json) as BrowserRecipeStep);
  if (steps.some((step) => step.saveError || !step.after))
    throw invalidArgs('This range contains an action without safe recorded locators and checkpoints.');
  const parameters = input.parameters.map((parameter) => {
    const step = parameter.action_index - input.first_action;
    const recordedValue = inputValue(steps[step].action);
    if (recordedValue !== undefined)
      return {
        name: parameter.name,
        step,
        kind: 'value' as const,
        recordedValue,
        inputName: steps[step].inputs?.[0]?.name,
        origin: steps[step].inputs?.[0]?.origin,
      };
    if (steps[step].action.kind === 'click' && steps[step].targets[0])
      return { name: parameter.name, step, kind: 'target_name' as const, recordedValue: steps[step].targets[0].name };
    throw invalidArgs(
      'A named input must bind one type, select, single-field form_input or click target’s exact accessible name.',
    );
  });
  let site: string;
  try {
    site = browserSite(steps[0].action.kind === 'navigate' ? steps[0].action.url : steps[0].before.url);
  } catch (_error) {
    throw invalidArgs('A recipe must belong to a public website.');
  }
  const readOnly = steps.every(
    (step) =>
      step.readOnly &&
      [...(step.action.kind === 'navigate' ? [] : [step.before]), step.after!].every((point) => {
        try {
          return browserSite(point.url) === site;
        } catch (_error) {
          return false;
        }
      }),
  );
  const saved = await context.store.db.transaction(async () => {
    const current = await context.store.db.get<{ last: number | null }>(
      'SELECT MAX(version) AS last FROM gws_ea_browser_recipes WHERE site = ? AND name = ?',
      site,
      input.name,
    );
    const version = (current?.last ?? 0) + 1;
    const id = `recipe_${randomUUID()}`;
    await context.store.db.run(
      'INSERT INTO gws_ea_browser_recipes(id,site,name,version,source_job_id,first_action,last_action,parameters_json,steps_json,read_only,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      id,
      site,
      input.name,
      version,
      context.job.id,
      input.first_action,
      input.last_action,
      JSON.stringify(parameters),
      JSON.stringify(steps),
      readOnly ? 1 : 0,
      new Date().toISOString(),
    );
    return { id, version };
  });
  if (await context.store.db.hasTable('gws_ea_browser_watches')) {
    const recipe = await loadRecipe(saved.id, context.store.db);
    if (recipe) {
      const { linkWatchBookingRecipe } = await import('./watches.js');
      await linkWatchBookingRecipe(context, recipe);
    }
  }
  return {
    status: 'saved',
    recipe_id: saved.id,
    version: saved.version,
    site,
    name: input.name,
    parameters: parameters.map((parameter) => parameter.name),
    read_only: readOnly,
    repeat_safe: false,
  };
}
export async function loadRecipe(id: string, db: DbDriver = getDb()): Promise<BrowserRecipe | undefined> {
  const row = await db.get<RecipeRow>('SELECT * FROM gws_ea_browser_recipes WHERE id = ?', id);
  if (!row) return undefined;
  return {
    id: row.id,
    site: row.site,
    name: row.name,
    version: row.version,
    sourceJobId: row.source_job_id,
    firstAction: row.first_action,
    lastAction: row.last_action,
    parameters: JSON.parse(row.parameters_json) as BrowserRecipe['parameters'],
    steps: JSON.parse(row.steps_json) as BrowserRecipeStep[],
    readOnly: row.read_only === 1,
  };
}
export function recipeCheckKey(
  recipe: Pick<BrowserRecipe, 'id' | 'version'>,
  parameters: Record<string, string>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        recipe.id,
        recipe.version,
        Object.keys(parameters)
          .sort()
          .map((name) => [name, parameters[name]]),
      ]),
    )
    .digest('hex');
}
function bindAction(step: BrowserRecipeStep, refs: BrowserRef[], value?: string): BrowserAction {
  const action = structuredClone(step.action);
  if ('ref' in action) {
    Object.assign(action, refs[0]);
    if (value !== undefined) {
      if (action.kind === 'type') action.text = value;
      else if (action.kind === 'select') action.value = value;
    }
  } else if (action.kind === 'form_input') {
    action.fields = action.fields.map((field, index) => ({ ...refs[index], value: value ?? field.value }));
    if (action.submit) action.submit = refs[action.fields.length];
  }
  return action;
}
async function observationRefs(page: Page, observation: BrowserObservation): Promise<Map<string, PinnedBrowserRef>> {
  return pinBrowserRefs(
    page,
    [...observation.snapshot.matchAll(/\[ref=((?:f\d+)?e\d+)\]/gu)].map((match) => ({
      ref: match[1],
      generation: observation.generation,
    })),
  );
}
async function nativeRef(
  page: Page,
  target: StructuredBrowserLocator,
  pinned: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<BrowserRef> {
  const element = await resolveLocator(page, target);
  try {
    return await nativeRefForElement(element, pinned);
  } finally {
    await element.dispose();
  }
}
async function nativeRefForElement(
  element: ElementHandle,
  pinned: ReadonlyMap<string, PinnedBrowserRef>,
): Promise<BrowserRef> {
  const frame = await element.ownerFrame();
  for (const candidate of pinned.values())
    if (candidate.frame === frame && (await candidate.element.evaluate((node, other) => node === other, element)))
      return { ref: candidate.ref, generation: candidate.generation };
  throw new Error('No current native ref for the recorded target');
}
interface ActiveUrlInput {
  parameter: BrowserRecipeParameter;
  value: string;
}
function parameterUrl(
  raw: string,
  active: ReadonlyMap<string, ActiveUrlInput>,
  hrefs?: ReadonlyMap<string, string>,
): string {
  const url = new URL(hrefs?.get(checkpointUrl(raw)) ?? raw);
  for (const { parameter, value } of active.values())
    if (parameter.inputName && parameter.origin === url.origin) {
      const values = url.searchParams.getAll(parameter.inputName);
      if (values.includes(parameter.recordedValue)) {
        url.searchParams.delete(parameter.inputName);
        for (const previous of values)
          url.searchParams.append(parameter.inputName, previous === parameter.recordedValue ? value : previous);
      }
    }
  return checkpointUrl(url.href);
}
function parameterLocator(
  locator: StructuredBrowserLocator,
  active: ReadonlyMap<string, ActiveUrlInput>,
  hrefs: ReadonlyMap<string, string>,
): StructuredBrowserLocator {
  return { ...locator, frameUrls: locator.frameUrls.map((url) => parameterUrl(url, active, hrefs)) };
}
function sameLinkShape(recorded: string, current: string): boolean {
  const before = new URL(recorded);
  const after = new URL(current);
  return (
    before.origin === after.origin &&
    before.pathname === after.pathname &&
    JSON.stringify([...before.searchParams.keys()].sort()) === JSON.stringify([...after.searchParams.keys()].sort())
  );
}
async function currentCheckpoint(page: Page): Promise<RecipeCheckpoint> {
  return checkpoint(await snapshotBrowserStructure(page));
}
function sameCheckpoint(expected: RecipeCheckpoint, found: RecipeCheckpoint): boolean {
  return expected.url === found.url && expected.heading === found.heading;
}
export async function executeRecipe(
  context: BrowserOperationContext,
  payload: Record<string, unknown>,
  options: BrowserBatchOptions = {},
): Promise<Record<string, unknown>> {
  const input = validateRunRecipe(payload);
  const recipe = await loadRecipe(input.recipe_id, context.store.db);
  if (!recipe) throw invalidArgs('This recipe does not exist for this assistant.');
  const expectedNames = recipe.parameters.map((parameter) => parameter.name).sort();
  if (JSON.stringify(Object.keys(input.parameters).sort()) !== JSON.stringify(expectedNames))
    throw invalidArgs('Supply exactly this recipe’s named inputs.');
  if (options.readOnly && !recipe.readOnly) throw invalidArgs('This recipe is not proven read-only.');
  const page = options.page ?? (await context.page());
  let repeatSafe = true;
  const activeInputs = new Map<string, ActiveUrlInput>();
  const activeHrefs = new Map<string, string>();
  const failed = async (step: number, expected: unknown, found: unknown): Promise<Record<string, unknown>> => ({
    status: 'checkpoint_failed',
    step,
    expected: JSON.parse(redactPageText(page, JSON.stringify(expected))) as unknown,
    found: JSON.parse(redactPageText(page, JSON.stringify(found))) as unknown,
    ...(!page.isClosed() ? { observation: await observePage(page, context.assertActive) } : {}),
    repeat_safe: repeatSafe,
  });
  for (let index = 0; index < recipe.steps.length; index++) {
    const step = recipe.steps[index];
    await context.assertActive();
    const before = await currentCheckpoint(page);
    const expectedBefore = { ...step.before, url: parameterUrl(step.before.url, activeInputs, activeHrefs) };
    if (step.action.kind !== 'navigate' && !sameCheckpoint(expectedBefore, before))
      return failed(index, expectedBefore, before);
    const parameter = recipe.parameters.find((candidate) => candidate.step === index);
    const targets = step.targets.map((target, targetIndex) => ({
      ...parameterLocator(target, activeInputs, activeHrefs),
      ...(targetIndex === 0 && parameter?.kind === 'target_name' ? { name: input.parameters[parameter.name] } : {}),
    }));
    let observation = await observePage(page, context.assertActive);
    let refs: BrowserRef[];
    try {
      refs = [];
      if (targets.length) {
        const pinned = await observationRefs(page, observation);
        try {
          for (const locator of targets) refs.push(await nativeRef(page, locator, pinned));
        } finally {
          await disposeBrowserRefs(pinned);
        }
      }
    } catch (_error) {
      return failed(index, { elements: step.targets }, { elements: 'missing or changed' });
    }
    if (parameter?.kind === 'target_name' && step.clickHref && targets[0]) {
      const element = await resolveLocator(page, targets[0]);
      try {
        const href = (await readControlFacts(page, element)).href;
        if (!href || !sameLinkShape(step.clickHref, href) || classifyNavigationUrl(href) !== 'ordinary')
          return failed(index, { target_url: step.clickHref }, { target_url: 'origin, path or query keys changed' });
        activeHrefs.set(checkpointUrl(step.clickHref), checkpointUrl(href));
      } finally {
        await element.dispose();
      }
    }
    const action = bindAction(step, refs, parameter?.kind === 'value' ? input.parameters[parameter.name] : undefined);
    const result = await executeBrowserBatch(context, { actions: [action] }, { ...options, page });
    // A step that bought something nobody approved has stopped the job: the replay ends with it (KTD10).
    if (result.reason === 'unapproved_commit') return { ...result, step: index, repeat_safe: false };
    if (result.repeat_safe === false) repeatSafe = false;
    observation = isRecord(result.observation)
      ? (result.observation as unknown as BrowserObservation)
      : await observePage(page, context.assertActive);
    if (result.reason === 'purchase_control') {
      const commit = targets[action.kind === 'form_input' ? targets.length - 1 : 0];
      if (!commit) return failed(index, { commit: 'recorded control' }, { commit: 'unavailable' });
      try {
        let target: BrowserRef;
        const pinned = await observationRefs(page, observation);
        try {
          if (action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)) {
            const element = await resolveLocator(page, commit);
            try {
              const handle = await browserKeyboardSubmitTarget(element);
              try {
                const submit = handle.asElement();
                if (!submit) throw new Error('No submit control');
                target = await nativeRefForElement(submit, pinned);
              } finally {
                await handle.dispose();
              }
            } finally {
              await element.dispose();
            }
          } else target = await nativeRef(page, commit, pinned);
        } finally {
          await disposeBrowserRefs(pinned);
        }
        return {
          status: 'reached_commit_point',
          step: index,
          target,
          observation,
          repeat_safe: repeatSafe,
        };
      } catch (_error) {
        return failed(index, { commit: 'recorded control' }, { commit: 'changed' });
      }
    }
    if (result.status === 'stopped' && result.reason !== 'navigated')
      return failed(index, { action: action.kind }, { reason: result.reason });
    if (step.getSubmissionFields) {
      for (const binding of recipe.parameters
        .filter((candidate) => candidate.kind === 'value' && candidate.step <= index)
        .sort((a, b) => a.step - b.step))
        if (binding.inputName && step.getSubmissionFields.includes(binding.inputName))
          activeInputs.set(`${binding.origin}\0${binding.inputName}`, {
            parameter: binding,
            value: input.parameters[binding.name],
          });
    }
    const after = await currentCheckpoint(page);
    const expectedAfter = step.after
      ? { ...step.after, url: parameterUrl(step.after.url, activeInputs, activeHrefs) }
      : undefined;
    if (expectedAfter && !sameCheckpoint(expectedAfter, after)) return failed(index, expectedAfter, after);
    const expectedInputs =
      action.kind === 'type'
        ? [action.text]
        : action.kind === 'select'
          ? [action.value]
          : action.kind === 'form_input'
            ? action.fields.map((field) => field.value)
            : [];
    if (expectedInputs.length) {
      const actual: string[] = [];
      try {
        for (const locator of targets.slice(0, expectedInputs.length)) {
          const element = await resolveLocator(page, locator, false);
          try {
            if (await isSecretBrowserField({ element })) throw new Error('The recorded input became a secret field');
            actual.push(await element.inputValue());
          } finally {
            await element.dispose();
          }
        }
      } catch (_error) {
        return failed(index, { input_values: expectedInputs }, { input_values: 'unavailable' });
      }
      if (JSON.stringify(actual) !== JSON.stringify(expectedInputs))
        return failed(index, { input_values: expectedInputs }, { input_values: actual });
    }
  }
  return { status: 'completed', observation: await observePage(page, context.assertActive), repeat_safe: repeatSafe };
}

export const saveRecipeAction: BrowserQueuedAction = { validate: validateSaveRecipe, execute: saveBrowserRecipe };
export const runRecipeAction: BrowserQueuedAction = { validate: validateRunRecipe, execute: executeRecipe };
registerBrowserSiteInfoProvider(async (_page, origin) => {
  const rows = await getDb().all<RecipeRow>(
    `SELECT r.* FROM gws_ea_browser_recipes r WHERE r.site = ? AND r.version = (SELECT MAX(latest.version) FROM gws_ea_browser_recipes latest WHERE latest.site = r.site AND latest.name = r.name) ORDER BY r.name`,
    browserSite(origin),
  );
  return {
    recipes: rows.map((row) => ({
      recipe_id: row.id,
      name: row.name,
      version: row.version,
      parameters: (JSON.parse(row.parameters_json) as BrowserRecipe['parameters']).map((parameter) => parameter.name),
      read_only: row.read_only === 1,
    })),
  };
});
