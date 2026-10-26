import { getInstallScopedNames } from '../install-slug.js';
import { SYSTEM_CHROME } from '../modules/gws-ea-browser/availability.js';
import type { ControlPlanePaths } from './paths.js';
import { runInstanceNclJson } from './ncl.js';
import { buildToolEnvironment, runSanitizedCommandOutcome, type SanitizedCommandOutcomeRunner } from './process.js';
import { getInstanceReservation } from './registry.js';
import { loadInstanceRuntimeConfig, type InstanceRuntimeConfig } from './service.js';
import { isRecord } from './validation.js';

export interface BrowserIsolationCheck {
  readonly status: 'not_run' | 'passed' | 'failed' | 'unknown';
  readonly reason: string | null;
}
export interface BrowserIsolationObservation {
  readonly instance_id: string;
  readonly observed_at: string;
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
}
export interface BrowserIsolationInspection {
  readonly check?: boolean;
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

function validListenerPort(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 65_535;
}

function observedListeners(health: unknown) {
  if (
    !isRecord(health) ||
    health.schemaVersion !== 1 ||
    typeof health.available !== 'boolean' ||
    !isRecord(health.proxy) ||
    (health.proxy.state !== 'listening' && health.proxy.state !== 'stopped')
  )
    throw new Error('Invalid browser health');
  const chrome = isRecord(health.chrome) ? health.chrome : undefined;
  return {
    available: health.available,
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
): BrowserIsolationObservation['isolation'] {
  const unresolved =
    [checks.proxy, checks.debugger].find((check) => check.status === 'failed') ??
    [checks.proxy, checks.debugger].find((check) => check.status === 'unknown');
  const overall: BrowserIsolationCheck =
    unresolved ?? (checks.proxy.status === 'passed' ? { status: 'passed', reason: null } : checks.proxy);
  return { ...overall, ...checks };
}

/** Bounded read-only observation: no locks, policy writes, host reconciliation, downloads or repairs. */
/* eslint-disable no-catch-all/no-catch-all -- Optional observations preserve unavailable/unknown results; raw failures must never reveal credentials. */
export async function inspectBrowserIsolation(
  paths: ControlPlanePaths,
  instanceId: string,
  options: BrowserIsolationInspection = {},
): Promise<BrowserIsolationObservation> {
  const reservation = await getInstanceReservation(paths, instanceId);
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  let chrome: BrowserIsolationObservation['chrome'] = {
    path: SYSTEM_CHROME,
    status: 'not_checked',
    version: null,
    reason: null,
  };
  const notRun: BrowserIsolationCheck = {
    status: 'not_run',
    reason: 'Run gws-ea status --details to observe active host listeners.',
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
        reason: 'Google Chrome is missing or cannot report its version at the standard installation path.',
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
      if (!snapshot.available) {
        checks.proxy = checks.debugger = {
          status: 'not_run',
          reason:
            'The running host browser or its Chrome prerequisite is unavailable. Ask your operator to inspect its status.',
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
    instance_id: instanceId,
    observed_at: new Date().toISOString(),
    chrome,
    isolation,
    ready: chrome.status === 'available' && isolation.status === 'passed',
  };
}
/* eslint-enable no-catch-all/no-catch-all */
