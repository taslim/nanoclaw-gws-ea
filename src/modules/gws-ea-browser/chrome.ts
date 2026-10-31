import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { rm } from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';

import {
  captureChromeGroup,
  claimChromeProfile,
  retireChromeGroup,
  type ChromeProcessGroup,
} from './chrome-processes.js';
export { retireChromeProfile } from './chrome-processes.js';

import {
  ensureBrowserPaths,
  clearBrowserUploadStaging,
  ensurePrivateDirectory,
  readPrivateFile,
  writePrivateFile,
  type BrowserPaths,
} from './paths.js';

interface ChromeLaunchInput {
  chromePath: string;
  paths: BrowserPaths;
  proxyUrl: string;
}

export interface OwnedChrome {
  readonly child: ChildProcess;
  readonly debuggerPort: number;
}

/** Positional argv only: the shell establishes the child's umask then execs Chrome. */
export function buildChromeLaunch(input: ChromeLaunchInput & { debuggerPort: number }): {
  command: string;
  args: string[];
} {
  const proxy = new URL(input.proxyUrl);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port)
    throw new Error('Chrome needs the host public-only proxy');
  if (!Number.isInteger(input.debuggerPort) || input.debuggerPort < 1 || input.debuggerPort > 65_535)
    throw new Error('Chrome needs an explicit debugger port');
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'umask 077; exec "$@"',
      'gws-ea-chrome',
      input.chromePath,
      `--user-data-dir=${input.paths.profileDir}`,
      '--remote-debugging-address=127.0.0.1',
      `--remote-debugging-port=${input.debuggerPort}`,
      '--no-startup-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      // Native background targets still need rendering and timer progress for errands and watches.
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      `--proxy-server=${input.proxyUrl}`,
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--deny-permission-prompts',
      '--block-new-web-contents',
      '--noerrdialogs',
      '--disable-session-crashed-bubble',
      '--disable-sync',
      '--disable-features=MediaRouter,Translate,GlobalMediaControls,PrivacySandboxSettings4',
      '--mute-audio',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
      // A page restored from the back/forward cache skips the document gate; a fresh load is decided.
      '--disable-back-forward-cache',
    ],
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Only called while Chrome is stopped; retain cookies/site state and rewrite safety preferences. */
export async function prepareChromeProfile(paths: BrowserPaths): Promise<void> {
  await claimChromeProfile(paths);
  await ensureBrowserPaths(paths);
  await clearBrowserUploadStaging(paths);
  const defaultDir = path.join(paths.profileDir, 'Default');
  await ensurePrivateDirectory(defaultDir);
  // A registered service worker answers navigations without a request the document gate sees. The
  // gate refuses every new worker script; registrations from before are dropped here, while stopped.
  await rm(path.join(defaultDir, 'Service Worker'), { recursive: true, force: true });
  const file = path.join(defaultDir, 'Preferences');
  let prefs: Record<string, unknown> = {};
  try {
    prefs = object(JSON.parse(await readPrivateFile(file, 16 * 1024 * 1024)));
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT')) throw error;
  }
  prefs.profile = {
    ...object(prefs.profile),
    exit_type: 'Normal',
    exited_cleanly: true,
    password_manager_enabled: false,
    default_content_setting_values: {
      ...object(object(prefs.profile).default_content_setting_values),
      clipboard: 2,
      notifications: 2,
      automatic_downloads: 2,
      geolocation: 2,
      media_stream_mic: 2,
      media_stream_camera: 2,
      popups: 2,
      // File System Access pickers open a native panel that chooser interception never sees.
      // Verified on Chrome 155: blocked, both pickers reject with NotAllowedError before any panel.
      file_system_read_guard: 2,
      file_system_write_guard: 2,
    },
  };
  prefs.credentials_enable_service = false;
  prefs.signin = { ...object(prefs.signin), allowed: false };
  // URLBlocklistManager reads these registered profile lists even when they
  // are user prefs. NavigationThrottle rejects before external OS dispatch.
  // Verified on Chrome 155 for both direct and script-initiated navigation.
  prefs.policy = {
    ...object(prefs.policy),
    url_blocklist: ['*'],
    url_allowlist: ['http://*', 'https://*', 'about:*', 'data:*'],
  };
  prefs.browser = { ...object(prefs.browser), check_default_browser: false };
  prefs.session = { ...object(prefs.session), restore_on_startup: 5 };
  prefs.webrtc = { ...object(prefs.webrtc), ip_handling_policy: 'disable_non_proxied_udp' };
  // Speculative prefetch and prerender fetch a page with no request the document gate sees, and serve
  // it on navigation. Verified on Chrome 155: with this off, both are plain, gated navigations.
  prefs.net = { ...object(prefs.net), network_prediction_options: 2 };
  await writePrivateFile(file, JSON.stringify(prefs));
}

export async function spawnChrome(input: ChromeLaunchInput, signal?: AbortSignal): Promise<OwnedChrome> {
  signal?.throwIfAborted();
  const selector = net.createServer();
  const debuggerPort = await new Promise<number>((resolve, reject) => {
    const onAbort = (): void => {
      selector.close();
      reject(new Error('Chrome startup cancelled'));
    };
    const finish = (): void => signal?.removeEventListener('abort', onAbort);
    signal?.addEventListener('abort', onAbort, { once: true });
    selector.once('error', (error) => {
      finish();
      reject(error);
    });
    selector.listen(0, '127.0.0.1', () => {
      const address = selector.address();
      selector.close((error) => {
        finish();
        if (error) reject(error);
        else if (!address || typeof address === 'string') reject(new Error('Chrome debugger port unavailable'));
        else resolve(address.port);
      });
    });
  });
  signal?.throwIfAborted();
  const launch = buildChromeLaunch({ ...input, debuggerPort });
  await claimChromeProfile(input.paths);
  signal?.throwIfAborted();
  const child = spawn(launch.command, launch.args, { stdio: 'ignore', detached: true });
  // The shell can fail before the connection owner installs its listeners.
  child.on('error', () => undefined);
  try {
    if (child.pid !== undefined) ownedGroups.set(child, await captureChromeGroup(child.pid));
  } catch (error) {
    await stopChrome(child);
    throw error;
  }
  return { child, debuggerPort };
}

const retirements = new WeakMap<ChildProcess, Promise<void>>();
const ownedGroups = new WeakMap<ChildProcess, ChromeProcessGroup>();

/** Capture helpers before the graceful close can orphan them. */
export async function prepareChromeRetirement(child: ChildProcess): Promise<void> {
  const group = ownedGroups.get(child);
  if (group) ownedGroups.set(child, await captureChromeGroup(group.id, group));
}

export function stopChrome(child: ChildProcess): Promise<void> {
  let retirement = retirements.get(child);
  if (!retirement) {
    retirement = retireChrome(child);
    retirements.set(child, retirement);
  }
  return retirement;
}

async function retireChrome(child: ChildProcess): Promise<void> {
  const group = ownedGroups.get(child);
  if (group) {
    await retireChromeGroup(group);
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) return;
  // A failed spawn has no pid and never emits exit.
  if (child.pid === undefined) return;
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      exited,
      new Promise<void>((resolve) => {
        timer = setTimeout(resolve, 3_000);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    let forced: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        exited,
        new Promise<never>((_resolve, reject) => {
          forced = setTimeout(() => reject(new Error('Chrome process did not stop')), 2_000);
        }),
      ]);
    } finally {
      if (forced) clearTimeout(forced);
    }
  }
}
