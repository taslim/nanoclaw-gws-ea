import { linkWatchBookingRecipe } from './watch-recipes.js';
import { type BrowserRecipeParameter, type BrowserRecipe, loadRecipe } from './recipe-store.js';
import { checkpoint as recordedCheckpoint, type BrowserRecipeStep, type RecipeCheckpoint } from './recording.js';
import { browserKeyboardSubmitTarget } from './action-targets.js';
import { type BrowserAction, type BrowserBatchOptions } from './actions.js';
import {
  ariaNodes,
  flatten,
  checkpointUrl,
  captureLocator,
  captureElementRole,
  resolveLocator,
  type StructuredBrowserLocator,
} from './locators.js';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright-core';
import { invalidArgs } from '../../cli/delivery-action.js';
import { isRecord } from '../../gws-ea/validation.js';
import { classifyNavigationUrl } from './control-policy.js';
import { readPageControlFacts } from './control-facts.js';
import { executeBrowserBatch } from './executor.js';
import { browserSite } from './leases.js';
import {
  browserRefForElement,
  observePage,
  snapshotBrowserStructure,
  type BrowserRef,
  type PinnedBrowserRef,
} from './observe.js';
import { redactPageData } from './page-privacy.js';
import type { BrowserExecutionContext, BrowserOperationContext, BrowserQueuedAction } from './actions.js';

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
function checkpoint(snapshot: Awaited<ReturnType<typeof snapshotBrowserStructure>>): RecipeCheckpoint {
  if (!snapshot.replayUrl) throw invalidArgs('This page has no safe replay checkpoint.');
  return recordedCheckpoint(snapshot);
}
/**
 * A watch's marked region: the element's structured locator, recorded as a recipe step's target is, when its page is
 * where `recipe` ends (the same address path and heading; inputs may change its query). `off_route` when it is
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
  const requests = await context.store.db.all<{ answer_json: string | null }>(
    `SELECT answer_json FROM gws_ea_browser_requests WHERE job_id = ? AND started_at IS NOT NULL AND action IN ('browser','run_recipe')`,
    context.job.id,
  );
  for (const request of requests) {
    const frame: unknown = request.answer_json ? JSON.parse(request.answer_json) : undefined;
    const data = isRecord(frame) && frame.ok === true && isRecord(frame.data) ? frame.data : undefined;
    const coverage = data && isRecord(data.recording) ? data.recording : undefined;
    const unexecuted =
      data &&
      Array.isArray(data.actions) &&
      data.actions.every((action: unknown) => isRecord(action) && action.status === 'not_executed');
    if (!unexecuted && coverage?.status !== 'complete')
      throw invalidArgs(
        'This job has actions without provable recording coverage. Start a new job to record a recipe.',
      );
  }
  const rows = await context.store.db.all<TraceRow>(
    'SELECT action_index,step_json FROM gws_ea_browser_action_trace WHERE job_id = ? AND action_index >= ? AND action_index <= ? ORDER BY action_index',
    context.job.id,
    input.first_action,
    input.last_action,
  );
  if (rows.length !== input.last_action - input.first_action + 1)
    throw invalidArgs('The entire recorded action range is required.');
  const steps = rows.map((row) => JSON.parse(row.step_json) as BrowserRecipeStep);
  if (steps.some((step) => step.saveError || !step.before || !step.after))
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
function parameterizedAction(step: BrowserRecipeStep, value?: string): BrowserAction {
  const action = structuredClone(step.action);
  if (value !== undefined) {
    if (action.kind === 'type') action.text = value;
    else if (action.kind === 'select') action.value = value;
    else if (action.kind === 'form_input') action.fields = action.fields.map((field) => ({ ...field, value }));
  }
  return action;
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
  const recording = { status: 'complete' as 'complete' | 'unavailable', trace_indices: [] as number[] };
  const coverage = (): Record<string, unknown> =>
    options.record === false || context.kind === 'watch_check' ? {} : { recording: structuredClone(recording) };
  const activeInputs = new Map<string, ActiveUrlInput>();
  const activeHrefs = new Map<string, string>();
  const failed = async (step: number, expected: unknown, found: unknown): Promise<Record<string, unknown>> => ({
    status: 'checkpoint_failed',
    ...coverage(),
    step,
    expected: redactPageData(page, expected),
    found: redactPageData(page, found),
    ...(!page.isClosed()
      ? {
          observation: await observePage(page, context.assertActive, {
            remaining: context.remaining,
            signal: context.signal,
          }),
        }
      : {}),
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
    if (parameter?.kind === 'target_name' && step.clickHref && targets[0]) {
      const element = await resolveLocator(page, targets[0]);
      try {
        const href = (await readPageControlFacts(page, element)).href;
        if (!href || !sameLinkShape(step.clickHref, href) || classifyNavigationUrl(href) !== 'ordinary')
          return failed(index, { target_url: step.clickHref }, { target_url: 'origin, path or query keys changed' });
        activeHrefs.set(checkpointUrl(step.clickHref), checkpointUrl(href));
      } finally {
        await element.dispose();
      }
    }
    const action = parameterizedAction(
      step,
      parameter?.kind === 'value' ? input.parameters[parameter.name] : undefined,
    );
    const result = await executeBrowserBatch(context, { actions: [action] }, { ...options, page, targets });
    if (result.recording) {
      if (result.recording.status !== 'complete') recording.status = 'unavailable';
      recording.trace_indices.push(...result.recording.trace_indices);
    } else recording.status = 'unavailable';
    // A step that bought something nobody approved has stopped the job: the replay ends with it.
    if (result.reason === 'unapproved_commit') return { ...result, ...coverage(), step: index, repeat_safe: false };
    if (result.repeat_safe === false) repeatSafe = false;
    const observation =
      result.observation ??
      (await observePage(page, context.assertActive, {
        remaining: context.remaining,
        signal: context.signal,
      }));
    if (result.reason === 'purchase_control') {
      const commit = targets[action.kind === 'form_input' ? targets.length - 1 : 0];
      if (!commit) return failed(index, { commit: 'recorded control' }, { commit: 'unavailable' });
      try {
        let target: BrowserRef;
        const element = await resolveLocator(page, commit);
        try {
          if (action.kind === 'key' && /^(?:Shift\+)?Enter$/u.test(action.key)) {
            const handle = await browserKeyboardSubmitTarget(element);
            try {
              const submit = handle.asElement();
              if (!submit) throw new Error('No submit control');
              target = await browserRefForElement(page, submit, { role: await captureElementRole(submit) });
            } finally {
              await handle.dispose();
            }
          } else target = await browserRefForElement(page, element, commit);
        } finally {
          await element.dispose();
        }
        return {
          status: 'reached_commit_point',
          ...coverage(),
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
            if ((await readPageControlFacts(page, element)).secretEntry)
              throw new Error('The recorded input became a secret field');
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
  return {
    status: 'completed',
    ...coverage(),
    observation: await observePage(page, context.assertActive, {
      remaining: context.remaining,
      signal: context.signal,
    }),
    repeat_safe: repeatSafe,
  };
}

export const saveRecipeAction: BrowserQueuedAction = { validate: validateSaveRecipe, execute: saveBrowserRecipe };
export const runRecipeAction: BrowserQueuedAction = { validate: validateRunRecipe, execute: executeRecipe };
