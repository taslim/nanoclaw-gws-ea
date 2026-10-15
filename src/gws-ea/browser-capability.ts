import { lstat } from 'node:fs/promises';
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
import { registerSecret } from './redact.js';
import type { NextAction } from './result.js';
import { readBrowserToken, removePrivateFile } from './secrets.js';
import { loadInstanceRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export const BROWSER_CAPABILITY = {
  name: 'browser',
  actions: ['show', 'check', 'enable', 'disable'],
  scope: 'assistant',
  summary: 'Run quiet host Chrome errands for one assistant.',
} as const;
export const BROWSER_REVOCATION_REMINDER =
  'Revoke any configured browser service account/token in 1Password. Deleting the local token does not revoke the provider credential.';

export interface BrowserCapabilityObservation {
  readonly name: 'browser';
  readonly scope: 'assistant';
  readonly actions: typeof BROWSER_CAPABILITY.actions;
  readonly summary: string;
  readonly instance_id: string;
  readonly observed_at: string;
  readonly activation: 'enabled' | 'disabled' | 'unavailable';
  readonly credential_mode: BrowserPolicyFile['credentialMode'];
  readonly policy_file: string;
  readonly chrome: {
    readonly path: string;
    readonly status: 'not_checked' | 'available' | 'unavailable';
    readonly version: string | null;
    readonly reason: string | null;
  };
  readonly vault: { readonly status: 'not_configured' | 'configured' | 'unavailable'; readonly reason: string | null };
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
  readonly credential_mode: BrowserPolicyFile['credentialMode'];
  readonly provider_revocation_required: boolean;
  readonly changed: boolean;
}
export interface BrowserCapabilityDependencies {
  readonly promptToken?: () => Promise<string>;
  readonly stdin?: AsyncIterable<string | Uint8Array>;
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
    // readBrowserPolicy validates the same owner-only file; retain the selected mode even while disabled.
    const raw: unknown = JSON.parse(await readPrivateFile(file, 16 * 1024));
    if (
      !isRecord(raw) ||
      raw.schemaVersion !== 1 ||
      typeof raw.enabled !== 'boolean' ||
      (raw.credentialMode !== 'email' && raw.credentialMode !== '1password')
    )
      throw new GwsEaError('invalid_browser_policy', 'Browser policy changed during inspection.');
    return {
      schemaVersion: 1,
      enabled: raw.enabled,
      credentialMode: raw.credentialMode,
      ...(typeof raw.chromePath === 'string' ? { chromePath: raw.chromePath } : {}),
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function withAssistantLock<T>(paths: ControlPlanePaths, instanceId: string, work: () => Promise<T>): Promise<T> {
  // Share removal/update's native lock so credentials cannot be republished after teardown.
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

async function deleteBrowserToken(file: string, dependencies: BrowserCapabilityDependencies): Promise<boolean> {
  try {
    await lstat(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
  await dependencies.recordEffect?.(null);
  await removePrivateFile(file);
  await dependencies.recordEffect?.(true);
  return true;
}

export async function enableBrowserCapability(
  paths: ControlPlanePaths,
  instanceId: string,
  options: { readonly credentialMode?: BrowserPolicyFile['credentialMode']; readonly tokenStdin?: boolean } = {},
  dependencies: BrowserCapabilityDependencies = {},
): Promise<BrowserOperationData> {
  return withAssistantLock(paths, instanceId, async () => {
    const { files } = await target(paths, instanceId);
    const previous = await storedPolicy(files.policyFile);
    const mode = options.credentialMode ?? previous?.credentialMode ?? 'email';
    if (options.tokenStdin && mode !== '1password')
      throw new GwsEaError('invalid_arguments', '--token-stdin requires --credential-mode 1password.');
    let changed = false;
    if (mode === '1password') {
      let token: string | undefined;
      if (options.tokenStdin) {
        if (!dependencies.stdin && process.stdin.isTTY)
          throw new GwsEaError(
            'invalid_arguments',
            'Pipe the token into --token-stdin; terminal keyboard input is not accepted.',
          );
        token = await readBrowserToken(dependencies.stdin ?? process.stdin);
      } else {
        try {
          token = (await readPrivateFile(files.tokenFile, 16 * 1024)).trim() || undefined;
        } catch (error) {
          if (!isErrno(error, 'ENOENT'))
            throw new GwsEaError(
              'browser_token_unavailable',
              'The configured browser token cannot be read safely. Repair its owner-only permissions or replace it using --token-stdin.',
              { cause: error },
            );
        }
        if (!token && dependencies.promptToken) token = (await dependencies.promptToken()).trim();
      }
      if (!token)
        throw new GwsEaError(
          'browser_token_required',
          'Supply the read-only service account token for one dedicated vault at the hidden prompt, or pipe it with --token-stdin. Never put it in arguments, the environment, or chat.',
        );
      registerSecret(token);
      if (/\s/u.test(token) || Buffer.byteLength(token) > 16 * 1024)
        throw new GwsEaError('invalid_browser_token', 'Supply exactly one service account token, at most 16 KiB.');
      let existing: string | undefined;
      // Explicit replacement may repair an unsafe mode. The atomic writer still refuses foreign owners or links.
      try {
        existing = await readPrivateFile(files.tokenFile, 16 * 1024);
        // eslint-disable-next-line no-catch-all/no-catch-all -- The private atomic writer independently refuses unsafe ownership and links before replacement.
      } catch (_error) {
        /* Replaced only after the writer checks the owned regular file. */
      }
      if (existing !== token) {
        await dependencies.recordEffect?.(null);
        await writePrivateFile(files.tokenFile, token);
        changed = true;
        await dependencies.recordEffect?.(true);
      }
    }
    const policy: BrowserPolicyFile = {
      schemaVersion: 1,
      enabled: true,
      credentialMode: mode,
      ...(previous?.chromePath ? { chromePath: previous.chromePath } : {}),
    };
    if (JSON.stringify(previous) !== JSON.stringify(policy)) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(files.policyFile, `${JSON.stringify(policy)}\n`);
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    // The email policy stops vault use before an old optional credential is removed.
    const tokenRemoved = mode === 'email' && (await deleteBrowserToken(files.tokenFile, dependencies));
    changed = changed || tokenRemoved;
    return {
      ...BROWSER_CAPABILITY,
      instance_id: instanceId,
      enabled: true,
      credential_mode: mode,
      provider_revocation_required: mode === 'email' && (previous?.credentialMode === '1password' || tokenRemoved),
      changed,
    };
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
    const mode = previous?.credentialMode ?? 'email';
    let changed = false;
    // Persist revocation intent first: even a stopped host must see disabled on its next start.
    if (!previous || previous.enabled) {
      await dependencies.recordEffect?.(null);
      await writePrivateFile(
        files.policyFile,
        `${JSON.stringify({ ...previous, schemaVersion: 1, enabled: false, credentialMode: mode })}\n`,
      );
      changed = true;
      await dependencies.recordEffect?.(true);
    }
    const tokenPresent = await deleteBrowserToken(files.tokenFile, dependencies);
    changed = changed || tokenPresent;
    return {
      ...BROWSER_CAPABILITY,
      instance_id: instanceId,
      enabled: false,
      credential_mode: mode,
      provider_revocation_required: mode === '1password' || tokenPresent,
      changed,
    };
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
  const mode = selected?.credentialMode ?? 'email';
  let chrome: BrowserCapabilityObservation['chrome'] = {
    path: selected?.chromePath ?? SYSTEM_CHROME,
    status: 'not_checked',
    version: null,
    reason: null,
  };
  let vault: BrowserCapabilityObservation['vault'] = { status: 'not_configured', reason: null };
  if (mode === '1password') {
    try {
      if (!(await readPrivateFile(files.tokenFile, 16 * 1024)).trim()) throw new Error('Empty token');
      vault = { status: 'configured', reason: null };
    } catch (_error) {
      vault = {
        status: 'unavailable',
        reason:
          'Configured 1Password token is missing, empty, or inaccessible. Restore its owner-only instance secret.',
      };
    }
  }
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
      if (health.proxy.state === 'listening') {
        if (
          !Number.isSafeInteger(health.proxy.port) ||
          Number(health.proxy.port) < 1 ||
          Number(health.proxy.port) > 65535
        )
          throw new Error('Invalid proxy port');
        port = Number(health.proxy.port);
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
    credential_mode: mode,
    policy_file: files.policyFile,
    chrome,
    vault,
    isolation,
    ready:
      policy.enabled &&
      chrome.status === 'available' &&
      vault.status !== 'unavailable' &&
      isolation.status === 'passed',
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
    `  Activation: ${capability.activation}; credential mode: ${capability.credential_mode}`,
    `  Chrome: ${capability.chrome.status}; path: ${capability.chrome.path}; version: ${capability.chrome.version ?? 'not checked'}`,
    `  Vault: ${capability.vault.status}`,
    `  Isolation: ${capability.isolation.status}`,
    ...[capability.chrome.reason, capability.vault.reason, capability.isolation.reason]
      .filter((reason): reason is string => reason !== null)
      .map((reason) => `  ${reason}`),
    `Observed: ${formatLocalTime(capability.observed_at, Intl.DateTimeFormat().resolvedOptions().timeZone)}`,
  ];
}
