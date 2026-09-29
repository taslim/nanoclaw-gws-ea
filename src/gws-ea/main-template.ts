/**
 * Main's template (R11, KTD12). Create stamps main from the release's
 * `templates/gws-ea/main` through NanoClaw's own `ncl groups create
 * --template`, which keeps the plugin it stamped in main's folder, at
 * `plugins/gws-ea-main/`, as the baseline: exactly what was stamped, and
 * read-only to the agent. What a plugin stamps into the folder is NanoClaw's
 * (`src/templates/extension.ts`, `create-agent.ts`, `restamp.ts`): its
 * persona as `instructions.prepend.md`, and each other context Markdown file
 * at its own path. Customization is decided file by file against what the
 * baseline stamps: a file that differs, a stamped file deleted, and a file
 * added where the baseline has none (at a path either template stamps, or
 * under a directory one stamps into) each count.
 *
 * An update refreshes main from the release's template only when the
 * template changed and nothing is customized, deciding again right before it
 * restamps; otherwise it keeps the files and names them. The restamp is
 * NanoClaw's, through the assistant's own `ncl`, and it also rewrites main's
 * scheduled task series and plugin-owned MCP servers, whose customization
 * NanoClaw's own plan flags. What the restamp changed is recorded with the
 * release the update kept, before it runs and once it finished, so one cut
 * short is finished rather than decided again, and a code-only rollback to
 * that release can reverse it with the restored release's own restamp,
 * provided nothing it touched changed since.
 */
import { createHash } from 'node:crypto';
import type { Stats } from 'node:fs';
import { lstat, readdir, readFile, readlink } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { MAIN_PLUGIN_NAME, MAIN_TEMPLATE } from './identity.js';
import type { InstanceNclOptions } from './ncl.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord, unwrapData } from './validation.js';
import { readMainGroup, readPluginMcpServers, readTaskSeries } from './verify.js';

/** Where the NanoClaw extension keeps a plugin's persona, context, and tasks (`src/templates/extension.ts`). */
const EXTENSION = 'ai.nanoco.nanoclaw';
const PERSONA_SOURCE = 'instructions.md';
/** The persona as NanoClaw stamps it (`src/group-persona.ts`). */
export const PERSONA_FILE = 'instructions.prepend.md';
/** Where a group keeps the plugins stamped into it, and main's own. */
const PLUGINS = 'plugins';
const BASELINE = `${PLUGINS}/${MAIN_PLUGIN_NAME}`;
const MANIFEST = 'plugin.json';

/** NanoClaw's surfaces whose customization is decided here, file by file; its plan decides the rest. */
const FILE_SURFACES: ReadonlySet<string> = new Set(['plugin', 'persona', 'context']);

/** What is at each path in main's folder: a digest of what is there, or null when nothing is. */
export type TemplateFiles = Readonly<Record<string, string | null>>;

/** How a customized file or surface differs from what was stamped. */
export type TemplateChange = 'changed' | 'deleted' | 'added';

export interface CustomizedTemplateFile {
  /** NanoClaw's name for it: `persona` or `context` for a file, or its restamp surface (`skill`, `mcp-server`, `task`). */
  readonly surface: string;
  /** A file's path in main's folder, or the surface's name. */
  readonly name: string;
  readonly change: TemplateChange;
}

/** What an update does with main's template (R8, R11). */
export type MainTemplateDecision =
  /** The release's template differs from main's, and nothing is customized. */
  | { readonly kind: 'refresh' }
  /** The release stamps what main's template already stamped. */
  | { readonly kind: 'unchanged' }
  /** The release's template differs, and these are kept as they are. */
  | { readonly kind: 'customized'; readonly customized: readonly CustomizedTemplateFile[] }
  /** There is nothing to refresh: no main, no template stamp in it, or no template in the release. */
  | { readonly kind: 'not_stamped'; readonly reason: string };

/** Main's template as `status` shows it (R2). */
export type MainTemplateInspection =
  | { readonly kind: 'stamped'; readonly customized: readonly CustomizedTemplateFile[] }
  | { readonly kind: 'not_stamped'; readonly reason: string };

/** Main's plugin-owned MCP servers and template task series, as digests. */
export interface SettledTemplateState {
  readonly mcp_servers: string;
  readonly tasks: string;
}

/**
 * Main's template restamp an update ran on the release it deployed, recorded
 * with the release it replaced (KTD12): main's template files, its stamped
 * plugin among them, before the restamp and as the restamp leaves them.
 */
export interface TemplateRestamp {
  readonly agent_group_id: string;
  readonly files_before: TemplateFiles;
  readonly files_after: TemplateFiles;
  /** Both templates' task slugs: the task series the restamp can touch (`<slug>-<4 hex>`). */
  readonly task_slugs: readonly string[];
  /** Main's plugin-owned MCP servers and those task series once the restamp finished; absent while it may be under way. */
  readonly settled?: SettledTemplateState;
  /** A rollback began reversing it: from then on the restored release's restamp may have changed any of them. */
  readonly reversing?: true;
}

/** `ncl <args> --json` through the assistant's own host. */
export type InstanceNcl = (
  runtime: InstanceRuntimeConfig,
  args: readonly string[],
  options?: InstanceNclOptions,
) => Promise<unknown>;

/** What a template follow-up works with (KTD2). */
export interface TemplateFollowUp {
  /** The assistant's runtime: its live checkout runs the release whose template is stamped. */
  readonly runtime: InstanceRuntimeConfig;
  readonly ncl: InstanceNcl;
  /** The restamp recorded with the kept release, if any. */
  readonly recorded: () => Promise<TemplateRestamp | undefined>;
  /** Record `restamp` there, in place of what was. */
  readonly record: (restamp: TemplateRestamp) => Promise<void>;
}

/** Main's folder in a checkout, and the plugin stamped into it. */
interface MainFolder {
  readonly agentGroupId: string;
  readonly directory: string;
}

/** A plugin's stamp: what it puts at each path in main's folder, by digest. */
type Stamp = ReadonlyMap<string, string>;

/** The release's main template in a checkout. */
export function mainTemplateRoot(checkoutRoot: string): string {
  return path.join(checkoutRoot, 'templates', ...MAIN_TEMPLATE.split('/'));
}

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** A file's digest: its content, and whether it is executable, since NanoClaw's copier keeps that bit. */
function fileDigest(content: Buffer, executable: boolean): string {
  return `sha256:${sha256(content)}${executable ? '+x' : ''}`;
}

async function lstatIfPresent(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    throw error;
  }
}

/** Every file and link under `root`, by '/'-separated path; links are never followed. None when `root` is no directory. */
async function entriesUnder(root: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (directory: string, prefix: string): Promise<void> => {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(path.join(directory, entry.name), relative);
      else found.push(relative);
    }
  };
  if ((await lstatIfPresent(root))?.isDirectory()) await walk(root, '');
  return found.sort();
}

/**
 * What is at `relative` under `root`, never following a link: a file's
 * digest, a link's target's, or null when nothing is. The folder is the
 * agent's to write, so a link or file where a directory belongs is reported
 * as that, and nothing beyond it is read.
 */
async function digestAt(root: string, relative: string): Promise<string | null> {
  const parts = relative.split('/');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = path.join(current, part);
    const info = await lstatIfPresent(current);
    if (!info) return null;
    if (index < parts.length - 1) {
      if (info.isDirectory()) continue;
      return 'blocked';
    }
    if (info.isFile()) return fileDigest(await readFile(current), (info.mode & 0o111) !== 0);
    if (info.isSymbolicLink()) return `link:${sha256(await readlink(current))}`;
    return info.isDirectory() ? 'directory' : 'other';
  }
  return null;
}

async function digestsAt(root: string, paths: readonly string[]): Promise<Record<string, string | null>> {
  const digests: Record<string, string | null> = {};
  for (const relative of paths) digests[relative] = await digestAt(root, relative);
  return digests;
}

/** Whether `directory` holds a plugin: a regular `plugin.json`. */
async function holdsPlugin(directory: string): Promise<boolean> {
  return (await lstatIfPresent(path.join(directory, MANIFEST)))?.isFile() === true;
}

/**
 * What a plugin stamps into main's folder (`src/templates/create-agent.ts`,
 * `restamp.ts`): itself, whole, under `plugins/gws-ea-main/`; its persona,
 * trimmed, when it has one; and every other context Markdown file as it is.
 */
async function stampOf(pluginDir: string): Promise<Stamp> {
  const stamp = new Map<string, string>();
  for (const relative of await entriesUnder(pluginDir)) {
    stamp.set(`${BASELINE}/${relative}`, (await digestAt(pluginDir, relative)) ?? 'other');
  }
  const context = path.join(pluginDir, EXTENSION, 'context');
  for (const relative of await entriesUnder(context)) {
    if (!relative.endsWith('.md') || !(await lstat(path.join(context, relative))).isFile()) continue;
    const text = await readFile(path.join(context, relative), 'utf8');
    if (relative !== PERSONA_SOURCE) stamp.set(relative, fileDigest(Buffer.from(text), false));
    else if (text.trim()) stamp.set(PERSONA_FILE, fileDigest(Buffer.from(`${text.trimEnd()}\n`), false));
  }
  return stamp;
}

function sameStamp(left: Stamp, right: Stamp): boolean {
  return left.size === right.size && [...left].every(([relative, digest]) => right.get(relative) === digest);
}

/** Each path an earlier stamp named, as a stamp, so its area can be walked again. */
function stampOfFiles(files: TemplateFiles): Stamp {
  return new Map(Object.entries(files).flatMap(([relative, digest]) => (digest === null ? [] : [[relative, digest]])));
}

/**
 * The paths a restamp between these stamps can touch in main's folder: each
 * path either names, every file in the stamped plugin, and every file under a
 * directory one stamps context into, where one added counts as customized.
 */
async function areaOf(directory: string, ...stamps: readonly Stamp[]): Promise<string[]> {
  const paths = new Set<string>();
  const directories = new Set<string>([BASELINE]);
  for (const stamp of stamps) {
    for (const relative of stamp.keys()) {
      paths.add(relative);
      const [top, ...rest] = relative.split('/');
      if (top !== PLUGINS && rest.length > 0) directories.add(top!);
    }
  }
  for (const under of directories) {
    for (const relative of await entriesUnder(path.join(directory, ...under.split('/')))) {
      paths.add(`${under}/${relative}`);
    }
  }
  return [...paths].sort();
}

function changeOf(expected: string | null, found: string | null): TemplateChange {
  if (expected === null) return 'added';
  return found === null ? 'deleted' : 'changed';
}

function fileSurface(relative: string): string {
  return relative === PERSONA_FILE ? 'persona' : 'context';
}

/** Main's template files that differ from what `baseline` stamps, over the area it and `target` share. */
async function customizedFiles(directory: string, baseline: Stamp, target: Stamp): Promise<CustomizedTemplateFile[]> {
  const customized: CustomizedTemplateFile[] = [];
  for (const relative of await areaOf(directory, baseline, target)) {
    if (relative.startsWith(`${PLUGINS}/`)) continue;
    const expected = baseline.get(relative) ?? null;
    const found = await digestAt(directory, relative);
    if (found !== expected) {
      customized.push({ surface: fileSurface(relative), name: relative, change: changeOf(expected, found) });
    }
  }
  return customized;
}

/** Main's folder in `checkoutRoot`, as its central database names it; undefined until main is published. */
function locateMain(checkoutRoot: string): MainFolder | undefined {
  const main = readMainGroup(checkoutRoot);
  return main && { agentGroupId: main.id, directory: path.join(checkoutRoot, 'groups', main.folder) };
}

/**
 * Main's stamp, the release template's (undefined when the release has
 * none), and main's files customized against its own stamp; or why main has
 * no stamp to compare.
 */
type Compared =
  | {
      readonly kind: 'stamped';
      readonly baseline: Stamp;
      readonly target: Stamp | undefined;
      readonly customized: readonly CustomizedTemplateFile[];
    }
  | { readonly kind: 'not_stamped'; readonly reason: string };

async function compare(directory: string | undefined, templateRoot: string): Promise<Compared> {
  if (directory === undefined) return { kind: 'not_stamped', reason: 'no main agent group is published yet' };
  const baselineDir = path.join(directory, ...BASELINE.split('/'));
  if (!(await holdsPlugin(baselineDir))) {
    return { kind: 'not_stamped', reason: `main's folder holds no ${MAIN_PLUGIN_NAME} plugin it was stamped from` };
  }
  const [baseline, target] = await Promise.all([
    stampOf(baselineDir),
    holdsPlugin(templateRoot).then((held) => (held ? stampOf(templateRoot) : undefined)),
  ]);
  const customized = await customizedFiles(directory, baseline, target ?? baseline);
  return { kind: 'stamped', baseline, target, customized };
}

function inspectionOf(compared: Compared): MainTemplateInspection {
  return compared.kind === 'stamped' ? { kind: 'stamped', customized: compared.customized } : compared;
}

function decisionOf(compared: Compared): MainTemplateDecision {
  if (compared.kind === 'not_stamped') return compared;
  if (!compared.target) return { kind: 'not_stamped', reason: `the release has no ${MAIN_TEMPLATE} template` };
  if (sameStamp(compared.baseline, compared.target)) return { kind: 'unchanged' };
  return compared.customized.length > 0 ? { kind: 'customized', customized: compared.customized } : { kind: 'refresh' };
}

/** What an update would do with the main folder at `directory`, refreshed from the template at `templateRoot`. Only reads. */
export async function decideMainFolder(directory: string, templateRoot: string): Promise<MainTemplateDecision> {
  return decisionOf(await compare(directory, templateRoot));
}

/** The main folder at `directory`'s files customized against the plugin stamped into it. Only reads. */
export async function inspectMainFolder(directory: string, templateRoot: string): Promise<MainTemplateInspection> {
  return inspectionOf(await compare(directory, templateRoot));
}

/**
 * What an update would do with main's template: main as `checkoutRoot`'s
 * database and folder hold it, refreshed from the template at `templateRoot`.
 * Only reads.
 */
export async function decideMainTemplate(checkoutRoot: string, templateRoot: string): Promise<MainTemplateDecision> {
  return decisionOf(await compare(locateMain(checkoutRoot)?.directory, templateRoot));
}

/** Main's template files customized against the plugin it was stamped from (R2). Only reads. */
export async function inspectMainTemplate(checkoutRoot: string): Promise<MainTemplateInspection> {
  return inspectionOf(await compare(locateMain(checkoutRoot)?.directory, mainTemplateRoot(checkoutRoot)));
}

/** How a list of customized files and surfaces reads in a sentence. */
export function describeCustomized(customized: readonly CustomizedTemplateFile[]): string {
  return customized
    .map(({ surface, name, change }) => `${FILE_SURFACES.has(surface) ? name : `${surface} ${name}`} (${change})`)
    .join(', ');
}

/** NanoClaw's name for a task's series (`taskNameSlug`, `src/modules/scheduling/create.ts`). */
export function taskNameSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 24)
    .replace(/-+$/gu, '');
}

/** The slugs of a plugin's tasks: each Markdown file in its tasks directory names one (`src/templates/tasks.ts`). */
async function taskSlugsOf(pluginDir: string): Promise<string[]> {
  const tasks = path.join(pluginDir, EXTENSION, 'tasks');
  if (!(await lstatIfPresent(tasks))?.isDirectory()) return [];
  return (await readdir(tasks, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.md'))
    .map((entry) => taskNameSlug(path.basename(entry.name, '.md')))
    .filter(Boolean);
}

/** JSON with every object's keys in order, so equal values digest equally. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

function settledState(checkoutRoot: string, main: MainFolder, slugs: readonly string[]): SettledTemplateState {
  return {
    mcp_servers: `sha256:${sha256(canonical(readPluginMcpServers(checkoutRoot, main.agentGroupId, MAIN_PLUGIN_NAME)))}`,
    tasks: `sha256:${sha256(canonical(readTaskSeries(checkoutRoot, main.agentGroupId, slugs)))}`,
  };
}

interface RestampChange {
  readonly surface: string;
  readonly name: string;
  readonly action: string;
  readonly customized: boolean;
}

function invalidRestamp(): GwsEaError {
  return new GwsEaError('invalid_child_output', "ncl returned an invalid restamp of main's template");
}

/**
 * NanoClaw's restamp of main from the live release's template, through the
 * assistant's own `ncl` (`src/templates/restamp.ts`): only its plan, or with
 * `apply` the restamp itself. Main is named, so NanoClaw restamps main alone
 * and never stamps a new group. Returns what it changes, or changed.
 */
async function restampMain(
  followUp: Pick<TemplateFollowUp, 'runtime' | 'ncl'>,
  agentGroupId: string,
  apply: boolean,
): Promise<RestampChange[]> {
  const args = ['groups', 'create', '--template', MAIN_TEMPLATE, '--id', agentGroupId, ...(apply ? ['--yes'] : [])];
  const result = unwrapData(await followUp.ncl(followUp.runtime, args));
  if (
    !isRecord(result) ||
    result.plugin !== MAIN_PLUGIN_NAME ||
    result.applied !== apply ||
    !isRecord(result.group) ||
    result.group.id !== agentGroupId ||
    !Array.isArray(result.changes)
  ) {
    throw invalidRestamp();
  }
  return result.changes.map((change: unknown) => {
    if (
      !isRecord(change) ||
      typeof change.surface !== 'string' ||
      typeof change.name !== 'string' ||
      typeof change.action !== 'string'
    ) {
      throw invalidRestamp();
    }
    return {
      surface: change.surface,
      name: change.name,
      action: change.action,
      customized: change.customized === true,
    };
  });
}

/** What NanoClaw's plan flags as customized beyond the files: skills, MCP servers, and tasks. */
function flaggedBeyondFiles(changes: readonly RestampChange[]): CustomizedTemplateFile[] {
  return changes
    .filter((change) => change.customized && !FILE_SURFACES.has(change.surface))
    .map(({ surface, name, action }) => ({ surface, name, change: action === 'create' ? 'deleted' : 'changed' }));
}

/** Main's skills, MCP servers, and tasks NanoClaw's restamp plan flags as customized; nothing is restamped. */
export async function planMainRestamp(
  runtime: InstanceRuntimeConfig,
  agentGroupId: string,
  ncl: InstanceNcl,
): Promise<CustomizedTemplateFile[]> {
  return flaggedBeyondFiles(await restampMain({ runtime, ncl }, agentGroupId, false));
}

function recreatedTasks(changes: readonly RestampChange[]): string {
  const created = changes.filter((change) => change.surface === 'task' && change.action === 'create');
  return created.length > 0
    ? ` It created these scheduled tasks, paused: ${created.map((change) => change.name).join(', ')}.`
    : '';
}

function keptNote(customized: readonly CustomizedTemplateFile[]): string {
  return `Main's template was kept as it is, because these are customized: ${describeCustomized(customized)}.`;
}

function undecidedNote(decision: MainTemplateDecision): string | undefined {
  switch (decision.kind) {
    case 'refresh':
    case 'unchanged':
      return undefined;
    case 'customized':
      return keptNote(decision.customized);
    case 'not_stamped':
      return `Main's template was not refreshed: ${decision.reason}.`;
  }
}

/** The paths an earlier run's record covers, and every file now under the directories they stamp into. */
async function recordedArea(
  directory: string,
  restamp: TemplateRestamp,
  ...stamps: readonly Stamp[]
): Promise<string[]> {
  const recorded = [...Object.keys(restamp.files_before), ...Object.keys(restamp.files_after)];
  const walked = await areaOf(
    directory,
    stampOfFiles(restamp.files_before),
    stampOfFiles(restamp.files_after),
    ...stamps,
  );
  return [...new Set([...recorded, ...walked])].sort();
}

/**
 * Restamp main as `pending` recorded, then record what the restamp settled.
 * A run cut short leaves every file as it was or as the restamp leaves it,
 * and NanoClaw's restamp converges on a second run, so it simply runs again;
 * a file that is neither was changed since it began, and is kept.
 */
async function finishRefresh(followUp: TemplateFollowUp, main: MainFolder, pending: TemplateRestamp): Promise<string> {
  const area = await recordedArea(main.directory, pending);
  const found = await digestsAt(main.directory, area);
  const changed = area.filter(
    (relative) =>
      found[relative] !== (pending.files_before[relative] ?? null) &&
      found[relative] !== (pending.files_after[relative] ?? null),
  );
  if (changed.length > 0) {
    return `Main's template refresh was cut short, and ${changed.join(', ')} changed since it began, so main's files were kept as they are.`;
  }
  const applied = await restampMain(followUp, main.agentGroupId, true);
  await followUp.record({
    ...pending,
    settled: settledState(followUp.runtime.checkout_realpath, main, pending.task_slugs),
  });
  return `Main's template was refreshed from this release.${recreatedTasks(applied)}`;
}

/**
 * The `refresh_template` follow-up (KTD12): once an update is recorded,
 * restamp main from the release's template when it changed and nothing is
 * customized, deciding again right before the restamp; otherwise keep main's
 * files and say which. What the restamp changes is recorded with the kept
 * release before it runs. Returns what the operator is told.
 */
export async function refreshMainTemplate(followUp: TemplateFollowUp): Promise<string | undefined> {
  const checkout = followUp.runtime.checkout_realpath;
  const recorded = await followUp.recorded();
  if (recorded?.settled) return "Main's template was refreshed from this release.";
  const main = locateMain(checkout);
  if (recorded) {
    if (main?.agentGroupId !== recorded.agent_group_id) {
      return "Main's template refresh was cut short, and main is no longer the group it began on, so it was not finished.";
    }
    return finishRefresh(followUp, main, recorded);
  }
  const template = mainTemplateRoot(checkout);
  const first = decisionOf(await compare(main?.directory, template));
  if (first.kind !== 'refresh' || !main) return undecidedNote(first);
  const flagged = await planMainRestamp(followUp.runtime, main.agentGroupId, followUp.ncl);
  if (flagged.length > 0) return keptNote(flagged);
  // Decide again right before the restamp: the files may have changed while NanoClaw planned it.
  const compared = await compare(main.directory, template);
  const decided = decisionOf(compared);
  if (decided.kind !== 'refresh' || compared.kind !== 'stamped' || !compared.target) return undecidedNote(decided);
  const { target } = compared;
  const area = await areaOf(main.directory, compared.baseline, target);
  const baselineDir = path.join(main.directory, ...BASELINE.split('/'));
  const pending: TemplateRestamp = {
    agent_group_id: main.agentGroupId,
    files_before: await digestsAt(main.directory, area),
    files_after: Object.fromEntries(area.map((relative) => [relative, target.get(relative) ?? null])),
    task_slugs: [...new Set([...(await taskSlugsOf(baselineDir)), ...(await taskSlugsOf(template))])].sort(),
  };
  await followUp.record(pending);
  return finishRefresh(followUp, main, pending);
}

/**
 * The `reverse_template_restamp` follow-up (KTD12): once a code-only rollback
 * to the release an update kept is recorded, undo that update's restamp of
 * main with the restored release's own. It runs only when main's template
 * files, its stamped plugin, its plugin-owned MCP servers, and its template
 * task series are as the update's restamp left them, and NanoClaw flags
 * nothing else customized; otherwise main is left as it is and the change is
 * named. A reversal cut short is finished the same way a refresh is. Returns
 * what the operator is told, naming any task the restamp recreates.
 */
export async function reverseMainTemplate(followUp: TemplateFollowUp): Promise<string | undefined> {
  const recorded = await followUp.recorded();
  if (!recorded) return undefined;
  const checkout = followUp.runtime.checkout_realpath;
  const left = (why: string): string => `Main's template was left as the update refreshed it, because ${why}.`;
  const main = locateMain(checkout);
  if (main?.agentGroupId !== recorded.agent_group_id) return left('main is no longer the group it restamped');
  const template = mainTemplateRoot(checkout);
  if (!(await holdsPlugin(template))) return left(`this release has no ${MAIN_TEMPLATE} template`);
  const restored = await stampOf(template);
  const area = await recordedArea(main.directory, recorded, restored);
  const found = await digestsAt(main.directory, area);
  const refreshed = (relative: string): boolean =>
    found[relative] === (recorded.files_after[relative] ?? null) ||
    // A refresh that never settled may have stopped before reaching this file.
    (!recorded.settled && found[relative] === (recorded.files_before[relative] ?? null));
  if (recorded.reversing) {
    const changed = area.filter(
      (relative) => !refreshed(relative) && found[relative] !== (restored.get(relative) ?? null),
    );
    if (changed.length > 0) return left(`its reversal was cut short, and ${changed.join(', ')} changed since`);
  } else {
    const changed: string[] = [];
    const files = area.filter((relative) => !refreshed(relative));
    if (files.length > 0) changed.push(files.join(', '));
    if (recorded.settled) {
      const now = settledState(checkout, main, recorded.task_slugs);
      if (now.mcp_servers !== recorded.settled.mcp_servers) changed.push('its plugin MCP servers');
      if (now.tasks !== recorded.settled.tasks) changed.push('its template tasks');
    }
    const flagged = await planMainRestamp(followUp.runtime, main.agentGroupId, followUp.ncl);
    if (flagged.length > 0) changed.push(describeCustomized(flagged));
    if (changed.length > 0) return left(`${changed.join('; ')} changed since the update`);
    await followUp.record({ ...recorded, reversing: true });
  }
  const applied = await restampMain(followUp, main.agentGroupId, true);
  return `Main's template was restored to this release's.${recreatedTasks(applied)}`;
}

const DIGEST = /^(?:sha256:[0-9a-f]{64}(?:\+x)?|link:[0-9a-f]{64}|blocked|directory|other)$/u;
const SETTLED_DIGEST = /^sha256:[0-9a-f]{64}$/u;
const AGENT_GROUP_ID = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/u;
const TASK_SLUG = /^[a-z0-9](?:[a-z0-9-]{0,22}[a-z0-9])?$/u;

function isFolderPath(relative: string): boolean {
  return (
    relative.length > 0 &&
    relative.length <= 1024 &&
    relative.split('/').every((part) => part !== '' && part !== '.' && part !== '..' && !part.includes('\0'))
  );
}

/**
 * A recorded restamp, validated; `invalid` names what is wrong with it.
 * Unknown fields are dropped.
 */
export function parseTemplateRestamp(value: unknown, invalid: (detail: string) => GwsEaError): TemplateRestamp {
  if (!isRecord(value)) throw invalid("records main's template restamp invalidly");
  const files = (entry: unknown, label: string): TemplateFiles => {
    if (!isRecord(entry)) throw invalid(`records main's template files ${label} invalidly`);
    // fromEntries defines each path as an own field, so a path named `__proto__` stays data.
    return Object.fromEntries(
      Object.entries(entry).map(([relative, digest]) => {
        if (!isFolderPath(relative) || (digest !== null && (typeof digest !== 'string' || !DIGEST.test(digest)))) {
          throw invalid(`records main's template files ${label} invalidly`);
        }
        return [relative, digest];
      }),
    );
  };
  if (typeof value.agent_group_id !== 'string' || !AGENT_GROUP_ID.test(value.agent_group_id)) {
    throw invalid("records main's template restamp for no valid agent group");
  }
  if (
    !Array.isArray(value.task_slugs) ||
    !value.task_slugs.every((slug): slug is string => typeof slug === 'string' && TASK_SLUG.test(slug))
  ) {
    throw invalid("records main's template task slugs invalidly");
  }
  let settled: SettledTemplateState | undefined;
  if (value.settled !== undefined) {
    const { mcp_servers: servers, tasks } = isRecord(value.settled) ? value.settled : {};
    if (
      typeof servers !== 'string' ||
      !SETTLED_DIGEST.test(servers) ||
      typeof tasks !== 'string' ||
      !SETTLED_DIGEST.test(tasks)
    ) {
      throw invalid("records what main's template restamp settled invalidly");
    }
    settled = { mcp_servers: servers, tasks };
  }
  if (value.reversing !== undefined && value.reversing !== true) {
    throw invalid("records the reversal of main's template restamp invalidly");
  }
  return {
    agent_group_id: value.agent_group_id,
    files_before: files(value.files_before, 'before'),
    files_after: files(value.files_after, 'after'),
    task_slugs: value.task_slugs,
    ...(settled ? { settled } : {}),
    ...(value.reversing === true ? { reversing: true as const } : {}),
  };
}
