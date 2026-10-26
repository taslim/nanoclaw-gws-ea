import { readFile } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { processLock } from '../community-portal/process-lock.js';
import { getInstallScopedNames } from '../install-slug.js';
import { formatLocalTime } from '../timezone.js';
import { browserPaths, readPrivateFile, writePrivateFile } from '../modules/gws-ea-browser/paths.js';
import {
  browserAccessOf,
  parseBrowserPolicyFile,
  readBrowserPolicy,
  SYSTEM_CHROME,
  type BrowserAccessPolicy,
  type BrowserPolicyFile,
} from '../modules/gws-ea-browser/policy.js';
import { runAliasStep, type AliasStepOptions } from './alias.js';
import type { RunEvent, StepReporter } from './events.js';
import { runInstanceNclJson } from './ncl.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, runSanitizedCommandOutcome, type SanitizedCommandOutcomeRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import type { NextAction, OperationData } from './result.js';
import { loadInstanceRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export const BROWSER_CAPABILITY = {
  name: 'browser',
  actions: ['show', 'check', 'enable', 'disable'],
  scope: 'assistant',
  summary: 'Run quiet host Chrome errands for one assistant.',
} as const;

interface BrowserIsolationCheck {
  readonly status: 'not_run' | 'passed' | 'failed' | 'unknown';
  readonly reason: string | null;
}

export interface BrowserCapabilityObservation {
  readonly name: 'browser';
  readonly scope: 'assistant';
  readonly actions: typeof BROWSER_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly observed_at: string;
  readonly activation: 'enabled' | 'disabled' | 'unavailable';
  readonly policy_file: string;
  readonly chrome: {
    readonly path: string;
    readonly status: 'not_checked' | 'available' | 'unavailable';
    readonly version: string | null;
    readonly reason: string | null;
  };
  readonly isolation: BrowserIsolationCheck & {
    readonly proxy: BrowserIsolationCheck;
    readonly debugger: BrowserIsolationCheck;
  };
  readonly ready: boolean;
  /** Null while the policy cannot be read. */
  readonly access: BrowserAccessView | null;
}
export interface BrowserOperationData {
  readonly actions: typeof BROWSER_CAPABILITY.actions;
  readonly summary: string;
  readonly name: 'browser';
  readonly scope: 'assistant';
  readonly instance_id: string;
  readonly enabled: boolean;
  readonly changed: boolean;
  readonly access: BrowserAccessView;
  /** Set when the enable's web alias step waits on the operator. */
  readonly pause?: OperationData['pause'];
}
/** Version 1 grants the browser to main alone; version 2 to exactly the listed agent groups. */
export type BrowserAccessView =
  | { readonly version: 1 }
  | { readonly version: 2; readonly agent_group_ids: readonly string[] };
export type BrowserAccessChange =
  | { readonly kind: 'main' }
  | { readonly kind: 'agent_groups'; readonly agentGroupIds: readonly string[] };
type NclRunner = (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
export interface BrowserCapabilityDependencies {
  readonly recordEffect?: (changed: true | null) => void | Promise<unknown>;
  readonly ncl?: NclRunner;
}
export interface BrowserEnableDependencies extends BrowserCapabilityDependencies {
  readonly alias?: Pick<AliasStepOptions, 'decision'>;
  /** Hears the alias step's progress. */
  readonly emit?: (event: RunEvent) => void;
}
export interface BrowserCapabilityInspection {
  readonly check?: boolean;
  readonly ncl?: NclRunner;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}
export function instanceBrowserPolicyFile(runtime: Pick<InstanceRuntimeConfig, 'instance_root'>): string {
  return path.join(runtime.instance_root, 'browser', 'policy.json');
}

async function target(paths: ControlPlanePaths, instanceId: string) {
  const reservation = await getInstanceReservation(paths, instanceId);
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  return { reservation, runtime, files: browserPaths(instanceBrowserPolicyFile(runtime)) };
}

async function storedPolicy(file: string): Promise<BrowserPolicyFile | undefined> {
  const policy = await readBrowserPolicy(file);
  if (policy.status === 'unavailable')
    throw new GwsEaError(
      'invalid_browser_policy',
      'Browser policy is invalid or inaccessible. Restore its owner-only policy file before continuing.',
    );
  try {
    // readBrowserPolicy validates the same owner-only file; retain its Chrome path and access list even while disabled.
    const stored = parseBrowserPolicyFile(JSON.parse(await readPrivateFile(file, 16 * 1024)));
    if (!stored) throw new GwsEaError('invalid_browser_policy', 'Browser policy changed during inspection.');
    return stored;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Refuses at once with `instance_busy` while another operation holds the
 * assistant's instance lock, rather than waiting for it.
 */
export async function withAssistantLock<T>(
  paths: ControlPlanePaths,
  instanceId: string,
  work: () => Promise<T>,
): Promise<T> {
  // Share removal/update's native lock so a policy cannot be republished after teardown.
  await getInstanceReservation(paths, instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    return await work();
  } finally {
    release();
  }
}

function accessView(access: BrowserAccessPolicy): BrowserAccessView {
  return access.version === 1 ? { version: 1 } : { version: 2, agent_group_ids: access.agentGroupIds };
}

/**
 * Only a running host can vouch that it reads a version-2 list and has each
 * listed group. A sealed agent can never use the browser, and a chat job only
 * while it is active.
 */
async function assertHostMayList(
  runtime: InstanceRuntimeConfig,
  agentGroupIds: readonly string[],
  ncl: NclRunner,
): Promise<void> {
  let health: unknown;
  try {
    health = await ncl(runtime, ['gws-ea-browser-health']);
  } catch (cause) {
    throw new GwsEaError(
      'browser_access_unverified',
      'The running assistant could not confirm that it reads a browser access list. Start the assistant and try again.',
      { cause },
    );
  }
  if (!isRecord(health) || !Array.isArray(health.policyVersions) || !health.policyVersions.includes(2))
    throw new GwsEaError(
      'browser_access_unsupported',
      "This assistant's release cannot read a browser access list. Update the assistant, then try again.",
    );
  const profile = await ncl(runtime, ['gws-ea-profile-get']);
  if (!isRecord(profile)) throw new GwsEaError('invalid_child_output', 'The assistant profile could not be read.');
  const sealed = new Map<unknown, string>([
    [profile.browser_agent_group_id, 'browser'],
    [profile.external_email_agent_group_id, 'external-email'],
    [profile.external_chat_agent_group_id, 'external-chat'],
  ]);
  const inactiveJobs = new Set<string>();
  if ('external_chat_agent_group_id' in profile) {
    const chatAgents = await ncl(runtime, ['gws-ea-chat-agents-health']);
    if (!isRecord(chatAgents) || !Array.isArray(chatAgents.jobs))
      throw new GwsEaError('invalid_child_output', 'The host-owned chat agent registry could not be read.');
    for (const job of chatAgents.jobs) {
      if (
        !isRecord(job) ||
        typeof job.agent_group_id !== 'string' ||
        !['creating', 'active', 'retiring', 'retired'].includes(String(job.state))
      )
        throw new GwsEaError('invalid_child_output', 'The host-owned chat agent registry is invalid.');
      if (job.state !== 'active') inactiveJobs.add(job.agent_group_id);
    }
  }
  for (const id of agentGroupIds) {
    const agent = sealed.get(id);
    if (agent !== undefined)
      throw new GwsEaError('invalid_arguments', `Agent group ${id} is ${agent}, which can never use the browser.`);
    if (inactiveJobs.has(id))
      throw new GwsEaError(
        'invalid_arguments',
        `Agent group ${id} is not an active chat job and cannot use the browser.`,
      );
    try {
      await ncl(runtime, ['groups', 'get', '--id', id]);
    } catch (cause) {
      if (!(cause instanceof GwsEaError) || cause.code !== 'ncl_failed') throw cause;
      throw new GwsEaError('invalid_arguments', `The assistant has no agent group ${id}.`, { cause });
    }
  }
}

/**
 * Each listed group shares the signed-in browser profile and the vault's
 * logins. Without `access`, the policy keeps whom it grants.
 */
export async function enableBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: BrowserCapabilityDependencies = {},
  access?: BrowserAccessChange,
): Promise<BrowserOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { files, runtime } = await target(paths, instanceId);
    const previous = await storedPolicy(files.policyFile);
    const chrome = previous?.chromePath ? { chromePath: previous.chromePath } : {};
    const listed =
      access === undefined
        ? previous?.schemaVersion === 2
          ? previous.agentGroupIds
          : undefined
        : access.kind === 'agent_groups'
          ? [...new Set(access.agentGroupIds)]
          : undefined;
    const policy = parseBrowserPolicyFile(
      listed === undefined
        ? { schemaVersion: 1, enabled: true, ...chrome }
        : { schemaVersion: 2, enabled: true, ...chrome, agentGroupIds: listed },
    );
    if (!policy)
      throw new GwsEaError(
        'invalid_arguments',
        'Agent group IDs have no spaces or control characters, and at most 64 groups may be listed.',
      );
    if (access?.kind === 'agent_groups')
      await assertHostMayList(runtime, listed ?? [], dependencies.ncl ?? runInstanceNclJson);
    let changed = false;
    if (JSON.stringify(previous) !== JSON.stringify(policy)) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(files.policyFile, `${JSON.stringify(policy)}\n`);
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    return {
      ...BROWSER_CAPABILITY,
      instance_id: instanceId,
      enabled: true,
      changed,
      access: accessView(browserAccessOf(policy)),
    };
  });
}

/**
 * The alias step takes the assistant's lock again and runs only while the
 * policy still enables the browser. An alias that waits on the operator
 * returns as the operation's pause, with the browser already enabled.
 */
export async function enableBrowserWithAlias(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: BrowserEnableDependencies = {},
  access?: BrowserAccessChange,
): Promise<BrowserOperationData> {
  const enabled = await enableBrowserCapability(paths, instanceId, dependencies, access);
  const reporter: StepReporter = {
    emit: (event) => {
      if (event.type === 'domain-effect') void dependencies.recordEffect?.(event.changed);
      dependencies.emit?.(event);
    },
  };
  const alias = await withAssistantLock(paths, instanceId, async () => {
    const { runtime, files } = await target(paths, instanceId);
    if (!(await readBrowserPolicy(files.policyFile)).enabled) return undefined;
    return runAliasStep(paths, instanceId, runtime, reporter, { ...dependencies.alias, ncl: dependencies.ncl });
  });
  if (alias?.status !== 'paused') return enabled;
  const { settled: _settled, kind: _kind, ...pause } = alias.pause;
  return { ...enabled, pause };
}

/** A resume flag with a `<placeholder>` asks the operator for input rather than naming a command to run. */
export function browserAliasNextActions(instanceId: string, pause: NonNullable<OperationData['pause']>): NextAction[] {
  const command = ['gws-ea', 'connectors', 'enable', 'browser', '--id', instanceId];
  const flag = pause.resumeFlag;
  return [
    ...(pause.actionUrl ? [{ kind: 'external' as const, instruction: pause.message, url: pause.actionUrl }] : []),
    ...(flag?.includes('<')
      ? [{ kind: 'external' as const, instruction: `Supply the input requested by ${flag}.` }]
      : []),
    { kind: 'command', argv: flag && !flag.includes('<') ? [...command, ...flag.split(' ')] : command },
  ];
}

export async function disableBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: BrowserCapabilityDependencies = {},
): Promise<BrowserOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { files } = await target(paths, instanceId);
    const previous = await storedPolicy(files.policyFile);
    // The access list stays: enabling again grants the same groups.
    const policy: BrowserPolicyFile = previous ? { ...previous, enabled: false } : { schemaVersion: 1, enabled: false };
    let changed = false;
    // Persist disabled intent: even a stopped host must see it on its next start.
    if (!previous || previous.enabled) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(files.policyFile, `${JSON.stringify(policy)}\n`);
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    return {
      ...BROWSER_CAPABILITY,
      instance_id: instanceId,
      enabled: false,
      changed,
      access: accessView(browserAccessOf(policy)),
    };
  });
}

function validListenerPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function observedListeners(health: unknown) {
  if (
    !isRecord(health) ||
    health.schemaVersion !== 1 ||
    typeof health.enabled !== 'boolean' ||
    !isRecord(health.proxy) ||
    (health.proxy.state !== 'listening' && health.proxy.state !== 'stopped')
  )
    throw new Error('Invalid browser health');
  const chrome = isRecord(health.chrome) ? health.chrome : undefined;
  return {
    enabled: health.enabled,
    proxyState: health.proxy.state,
    proxyPort: validListenerPort(health.proxy.port) ? health.proxy.port : undefined,
    chromeState: typeof chrome?.state === 'string' ? chrome.state : 'unknown',
    chromePid:
      typeof chrome?.pid === 'number' && Number.isSafeInteger(chrome.pid) && chrome.pid > 0 ? chrome.pid : undefined,
    debuggerPort: validListenerPort(chrome?.debuggerPort) ? chrome.debuggerPort : undefined,
  };
}

function aggregateIsolation(
  checks: Record<'proxy' | 'debugger', BrowserIsolationCheck>,
): BrowserCapabilityObservation['isolation'] {
  const unresolved =
    [checks.proxy, checks.debugger].find((check) => check.status === 'failed') ??
    [checks.proxy, checks.debugger].find((check) => check.status === 'unknown');
  const overall: BrowserIsolationCheck =
    unresolved ?? (checks.proxy.status === 'passed' ? { status: 'passed', reason: null } : checks.proxy);
  return { ...overall, ...checks };
}

/** Bounded read-only observation: no locks, policy writes, host reconciliation, downloads or repairs. */
/* eslint-disable no-catch-all/no-catch-all -- Optional observations preserve unavailable/unknown results; raw failures must never reveal credentials. */
export async function inspectBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  options: BrowserCapabilityInspection = {},
): Promise<BrowserCapabilityObservation> {
  const { runtime, reservation, files } = await target(paths, instanceId);
  const policy = await readBrowserPolicy(files.policyFile);
  let selected: BrowserPolicyFile | undefined;
  try {
    selected = await storedPolicy(files.policyFile);
  } catch (_error) {
    /* Invalid optional policy stays unavailable below. */
  }
  let chrome: BrowserCapabilityObservation['chrome'] = {
    path: selected?.chromePath ?? SYSTEM_CHROME,
    status: 'not_checked',
    version: null,
    reason: null,
  };
  const notRun: BrowserIsolationCheck = {
    status: 'not_run',
    reason: 'Run connectors check browser to observe active host listeners.',
  };
  const checks: Record<'proxy' | 'debugger', BrowserIsolationCheck> = { proxy: notRun, debugger: notRun };
  const run = options.runCommand ?? runSanitizedCommandOutcome;
  if (options.check) {
    try {
      const result = await run({
        command: chrome.path,
        args: ['--version'],
        cwd: runtime.instance_root,
        env: buildToolEnvironment({}, { HOME: runtime.home_directory }),
        timeoutMs: 10_000,
        outputLimitBytes: 4096,
      });
      if (result.exitCode !== 0 || !/^Google Chrome\S*\s+\d[\d.]*\b/u.test(result.stdout.trim()))
        throw new Error('Chrome did not report a version');
      chrome = { ...chrome, status: 'available', version: result.stdout.trim() };
    } catch (_error) {
      chrome = {
        ...chrome,
        status: 'unavailable',
        reason: 'Google Chrome is missing or cannot report its version at the configured absolute path.',
      };
    }
    const ncl = options.ncl ?? runInstanceNclJson;
    try {
      const snapshot = observedListeners(await ncl(runtime, ['gws-ea-browser-health']));
      if (snapshot.chromeState === 'unavailable')
        chrome = {
          ...chrome,
          status: 'unavailable',
          reason:
            'The running host could not launch its owned Chrome. Check its browser diagnostics before trying another errand.',
        };
      if (!snapshot.enabled) {
        checks.proxy = checks.debugger = {
          status: 'not_run',
          reason:
            'The running host has not enabled this browser capability. Wait for policy reconciliation and check again.',
        };
      } else {
        const ports: Partial<Record<'proxy' | 'debugger', number>> = {};
        checks.proxy = { status: 'not_run', reason: 'The browser proxy is not running.' };
        if (snapshot.proxyState === 'listening') {
          checks.proxy = { status: 'unknown', reason: 'The active browser proxy has not been verified.' };
          if (snapshot.proxyPort !== undefined) ports.proxy = snapshot.proxyPort;
        }
        checks.debugger =
          snapshot.chromeState === 'stopped'
            ? { status: 'not_run', reason: 'Chrome is stopped; debugger isolation has not been tested.' }
            : { status: 'unknown', reason: 'The host could not identify an admitted running Chrome debugger.' };
        if (
          snapshot.chromeState === 'running' &&
          snapshot.chromePid !== undefined &&
          snapshot.debuggerPort !== undefined
        )
          ports.debugger = snapshot.debuggerPort;
        if (Object.keys(ports).length) {
          try {
            const script = `const net=require('node:net');const ports=${JSON.stringify(ports)};
Promise.all(Object.entries(ports).map(([name,port])=>new Promise((resolve,reject)=>{
  const socket=net.connect({host:'gws-ea-browser-host',port});let done=false;
  function finish(reachable){if(done)return;done=true;socket.destroy();resolve([name,reachable]);}
  socket.setTimeout(4000);socket.once('connect',()=>finish(true));socket.once('timeout',()=>finish(false));
  socket.once('error',error=>{if(['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT'].includes(error.code))finish(false);else{socket.destroy();reject(new Error('Probe could not be evaluated'));}});
}))).then(results=>console.log(JSON.stringify(Object.fromEntries(results)))).catch(()=>{console.error('Isolation probe failed');process.exitCode=1;});`;
            const result = await run({
              command: 'docker',
              args: [
                'run',
                '--rm',
                '--pull=never',
                '--network',
                runtime.agent_egress_network,
                '--add-host=gws-ea-browser-host:host-gateway',
                '--entrypoint',
                'node',
                `${getInstallScopedNames(runtime.install_id).containerImageBase}:r-${reservation.deployed_commit.slice(0, 8)}`,
                '--eval',
                script,
              ],
              cwd: runtime.instance_root,
              env: buildToolEnvironment(process.env, {
                DOCKER_HOST: runtime.docker_endpoint,
                HOME: runtime.home_directory,
              }),
              timeoutMs: 20_000,
              outputLimitBytes: 4096,
            });
            const probe: unknown = result.exitCode === 0 ? JSON.parse(result.stdout) : undefined;
            if (!isRecord(probe)) throw new Error('Isolation probe failed');
            for (const name of ['proxy', 'debugger'] as const) {
              if (ports[name] === undefined) continue;
              const reachable = probe[name];
              if (typeof reachable !== 'boolean') throw new Error('Isolation probe incomplete');
              checks[name] = reachable
                ? {
                    status: 'failed',
                    reason: `An assistant-network container can reach the host ${name === 'proxy' ? 'browser proxy' : 'Chrome debugger'} through the host gateway.`,
                  }
                : { status: 'passed', reason: null };
            }
          } catch {
            for (const name of ['proxy', 'debugger'] as const)
              if (ports[name] !== undefined)
                checks[name] = {
                  status: 'unknown',
                  reason:
                    'The assistant-network host-gateway TCP probe could not run. Check Docker, the existing release image, and the assistant network.',
                };
          }
          const after = observedListeners(await ncl(runtime, ['gws-ea-browser-health']));
          if (JSON.stringify(after) !== JSON.stringify(snapshot))
            checks.proxy = checks.debugger = {
              status: 'unknown',
              reason: 'The host browser listeners changed during the check. Run the check again.',
            };
        }
      }
    } catch {
      checks.proxy = checks.debugger = {
        status: 'unknown',
        reason: 'The running host browser health could not be observed. Start the assistant and check again.',
      };
    }
  }
  const isolation = aggregateIsolation(checks);
  return {
    ...BROWSER_CAPABILITY,
    instance_id: instanceId,
    observed_at: new Date().toISOString(),
    activation: policy.status,
    policy_file: files.policyFile,
    chrome,
    isolation,
    ready: policy.enabled && chrome.status === 'available' && isolation.status === 'passed',
    access: policy.status === 'unavailable' ? null : accessView(policy.access),
  };
}
/* eslint-enable no-catch-all/no-catch-all */

/** Mirrors the release host's `BROWSER_POLICY_VERSIONS`. */
const POLICY_VERSIONS_FILE = 'src/gws-ea/browser-compatibility.json';

/** A release without a readable marker reads version 1 alone. */
export async function releaseBrowserPolicyVersions(checkout: string): Promise<readonly number[]> {
  let item: unknown;
  try {
    item = JSON.parse(await readFile(path.join(checkout, POLICY_VERSIONS_FILE), 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR') || error instanceof SyntaxError) return [1];
    throw error;
  }
  return isRecord(item) &&
    item.schemaVersion === 1 &&
    Array.isArray(item.policyVersions) &&
    item.policyVersions.every((version) => Number.isSafeInteger(version))
    ? (item.policyVersions as number[])
    : [1];
}

/**
 * An older host reads a version-2 access list as invalid, so a rollback to it
 * would lose the browser.
 */
export async function assertBrowserPolicyReadable(
  runtime: InstanceRuntimeConfig,
  checkout: string,
  release: string,
): Promise<void> {
  const policy = await readBrowserPolicy(instanceBrowserPolicyFile(runtime));
  if (policy.status === 'unavailable' || policy.access.version === 1) return;
  if ((await releaseBrowserPolicyVersions(checkout)).includes(policy.access.version)) return;
  const id = runtime.instance_id;
  throw new GwsEaError(
    'rollback_unavailable',
    `Assistant ${id}'s browser access lists agent groups, which ${release} cannot read: rolled back, it would lose the browser. Return the browser to main alone with gws-ea connectors enable browser --id ${id} --main-only (and disable it again if it should stay off), then roll back.`,
  );
}

export function browserCapabilityNextActions(capability: BrowserCapabilityObservation): readonly NextAction[] {
  return [
    {
      kind: 'command',
      argv: [
        'gws-ea',
        'connectors',
        capability.activation === 'disabled' ? 'enable' : 'check',
        'browser',
        '--id',
        capability.instance_id,
      ],
    },
  ];
}
export function browserAccessLine(access: BrowserAccessView): string {
  if (access.version === 1) return 'main alone';
  if (access.agent_group_ids.length === 0) return 'no agent group';
  return `agent groups ${access.agent_group_ids.join(', ')}; each shares the signed-in browser profile and the vault's logins`;
}

export function browserCapabilityLines(capability: BrowserCapabilityObservation): readonly string[] {
  return [
    `browser (assistant ${capability.instance_id}): ${capability.summary}`,
    `  Activation: ${capability.activation}`,
    ...(capability.access === null ? [] : [`  Access: ${browserAccessLine(capability.access)}`]),
    `  Chrome: ${capability.chrome.status}; path: ${capability.chrome.path}; version: ${capability.chrome.version ?? 'not checked'}`,
    `  Isolation: ${capability.isolation.status}`,
    `  Proxy isolation: ${capability.isolation.proxy.status}`,
    `  Debugger isolation: ${capability.isolation.debugger.status}`,
    ...[
      ...new Set([
        capability.chrome.reason,
        capability.isolation.reason,
        capability.isolation.proxy.reason,
        capability.isolation.debugger.reason,
      ]),
    ]
      .filter((reason): reason is string => reason !== null)
      .map((reason) => `  ${reason}`),
    `Observed: ${formatLocalTime(capability.observed_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  ];
}
