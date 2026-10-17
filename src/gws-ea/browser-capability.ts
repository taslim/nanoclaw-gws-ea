import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { processLock } from '../community-portal/process-lock.js';
import { getInstallScopedNames } from '../install-slug.js';
import { formatLocalTime } from '../timezone.js';
import { browserPaths, readPrivateFile, writePrivateFile } from '../modules/gws-ea-browser/paths.js';
import { readBrowserPolicy, SYSTEM_CHROME, type BrowserPolicyFile } from '../modules/gws-ea-browser/policy.js';
import { runInstanceNclJson } from './ncl.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, runSanitizedCommandOutcome, type SanitizedCommandOutcomeRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import type { NextAction } from './result.js';
import { loadInstanceRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export const BROWSER_CAPABILITY = {
  name: 'browser',
  actions: ['show', 'check', 'enable', 'disable'],
  scope: 'assistant',
  summary: 'Run quiet host Chrome errands for one assistant.',
} as const;

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
  readonly isolation: { readonly status: 'not_run' | 'passed' | 'failed' | 'unknown'; readonly reason: string | null };
  readonly ready: boolean;
}
export interface BrowserOperationData {
  readonly actions: typeof BROWSER_CAPABILITY.actions;
  readonly summary: string;
  readonly name: 'browser';
  readonly scope: 'assistant';
  readonly instance_id: string;
  readonly enabled: boolean;
  readonly changed: boolean;
}
export interface BrowserCapabilityDependencies {
  readonly recordEffect?: (changed: true | null) => void | Promise<unknown>;
}
export interface BrowserCapabilityInspection {
  readonly check?: boolean;
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
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
    // readBrowserPolicy validates the same owner-only file; retain its Chrome path even while disabled.
    const raw: unknown = JSON.parse(await readPrivateFile(file, 16 * 1024));
    if (!isRecord(raw) || raw.schemaVersion !== 1 || typeof raw.enabled !== 'boolean')
      throw new GwsEaError('invalid_browser_policy', 'Browser policy changed during inspection.');
    return {
      schemaVersion: 1,
      enabled: raw.enabled,
      ...(typeof raw.chromePath === 'string' ? { chromePath: raw.chromePath } : {}),
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

/**
 * Run `work` under the assistant's native instance lock, or refuse at once
 * with `instance_busy`. The assistant's capabilities (browser, 1Password) share it.
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

export async function enableBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: BrowserCapabilityDependencies = {},
): Promise<BrowserOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { files } = await target(paths, instanceId);
    const previous = await storedPolicy(files.policyFile);
    const policy: BrowserPolicyFile = {
      schemaVersion: 1,
      enabled: true,
      ...(previous?.chromePath ? { chromePath: previous.chromePath } : {}),
    };
    let changed = false;
    if (JSON.stringify(previous) !== JSON.stringify(policy)) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(files.policyFile, `${JSON.stringify(policy)}\n`);
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    return { ...BROWSER_CAPABILITY, instance_id: instanceId, enabled: true, changed };
  });
}

export async function disableBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: BrowserCapabilityDependencies = {},
): Promise<BrowserOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { files } = await target(paths, instanceId);
    const previous = await storedPolicy(files.policyFile);
    let changed = false;
    // Persist disabled intent: even a stopped host must see it on its next start.
    if (!previous || previous.enabled) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(
        files.policyFile,
        `${JSON.stringify({ ...previous, schemaVersion: 1, enabled: false })}\n`,
      );
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    return { ...BROWSER_CAPABILITY, instance_id: instanceId, enabled: false, changed };
  });
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
  let isolation: BrowserCapabilityObservation['isolation'] = {
    status: 'not_run',
    reason: options.check
      ? 'The browser proxy is not running.'
      : 'Run capabilities check browser to observe the live proxy.',
  };
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
    let port: number | undefined;
    try {
      const health = await (options.ncl ?? runInstanceNclJson)(runtime, ['gws-ea-browser-health']);
      if (
        !isRecord(health) ||
        health.schemaVersion !== 1 ||
        typeof health.enabled !== 'boolean' ||
        !isRecord(health.proxy) ||
        !['listening', 'stopped'].includes(String(health.proxy.state))
      )
        throw new Error('Invalid browser health');
      if (!health.enabled) {
        isolation = {
          status: 'not_run',
          reason:
            'The running host has not enabled this browser capability. Wait for policy reconciliation and check again.',
        };
      } else if (health.proxy.state === 'listening') {
        if (
          !Number.isSafeInteger(health.proxy.port) ||
          Number(health.proxy.port) < 1 ||
          Number(health.proxy.port) > 65535
        )
          throw new Error('Invalid proxy port');
        port = Number(health.proxy.port);
      }
      if (isRecord(health.chrome) && health.chrome.state === 'unavailable') {
        chrome = {
          ...chrome,
          status: 'unavailable',
          reason:
            'The running host could not launch its owned Chrome. Check its browser diagnostics before trying another errand.',
        };
      }
    } catch (_error) {
      isolation = {
        status: 'not_run',
        reason: 'The running host browser health could not be observed. Start the assistant and check again.',
      };
    }
    if (port !== undefined) {
      try {
        const script = `const net=require('node:net');const socket=net.connect({host:'gws-ea-browser-host',port:${port}});let done=false;function finish(reachable){if(done)return;done=true;socket.destroy();console.log(JSON.stringify({reachable}));}socket.setTimeout(4000);socket.on('connect',()=>finish(true));socket.on('timeout',()=>finish(false));socket.on('error',e=>{if(['ECONNREFUSED','EHOSTUNREACH','ENETUNREACH','ETIMEDOUT'].includes(e.code))finish(false);else{console.error('Probe connection could not be evaluated');process.exitCode=1;socket.destroy();}});`;
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
        if (!isRecord(probe) || typeof probe.reachable !== 'boolean') throw new Error('Isolation probe failed');
        isolation = probe.reachable
          ? { status: 'failed', reason: 'An agent-network container can reach the host browser proxy.' }
          : { status: 'passed', reason: null };
      } catch (_error) {
        isolation = {
          status: 'unknown',
          reason:
            'The agent-network isolation probe could not run. Check Docker, the existing release image, and the assistant network.',
        };
      }
    }
  }
  return {
    ...BROWSER_CAPABILITY,
    instance_id: instanceId,
    observed_at: new Date().toISOString(),
    activation: policy.status,
    policy_file: files.policyFile,
    chrome,
    isolation,
    ready: policy.enabled && chrome.status === 'available' && isolation.status === 'passed',
  };
}
/* eslint-enable no-catch-all/no-catch-all */

export function browserCapabilityNextActions(capability: BrowserCapabilityObservation): readonly NextAction[] {
  return [
    {
      kind: 'command',
      argv: [
        'gws-ea',
        'capabilities',
        capability.activation === 'disabled' ? 'enable' : 'check',
        'browser',
        '--id',
        capability.instance_id,
      ],
    },
  ];
}
export function browserCapabilityLines(capability: BrowserCapabilityObservation): readonly string[] {
  return [
    `browser (assistant ${capability.instance_id}): ${capability.summary}`,
    `  Activation: ${capability.activation}`,
    `  Chrome: ${capability.chrome.status}; path: ${capability.chrome.path}; version: ${capability.chrome.version ?? 'not checked'}`,
    `  Isolation: ${capability.isolation.status}`,
    ...[capability.chrome.reason, capability.isolation.reason]
      .filter((reason): reason is string => reason !== null)
      .map((reason) => `  ${reason}`),
    `Observed: ${formatLocalTime(capability.observed_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  ];
}
