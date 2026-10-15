import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import path from 'node:path';

import {
  ensureBrowserPaths,
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

/** Positional argv only: the shell establishes the child's umask then execs Chrome. */
export function buildChromeLaunch(input: ChromeLaunchInput): { command: string; args: string[] } {
  const proxy = new URL(input.proxyUrl);
  if (proxy.protocol !== 'http:' || proxy.hostname !== '127.0.0.1' || !proxy.port)
    throw new Error('Chrome needs the host public-only proxy');
  return {
    command: '/bin/sh',
    args: [
      '-c',
      'umask 077; exec "$@"',
      'gws-ea-chrome',
      input.chromePath,
      `--user-data-dir=${input.paths.profileDir}`,
      '--remote-debugging-pipe',
      '--no-startup-window',
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-search-engine-choice-screen',
      '--disable-backgrounding-occluded-windows',
      '--disable-renderer-backgrounding',
      '--disable-background-timer-throttling',
      '--enable-features=CDPScreenshotNewSurface',
      '--disable-blink-features=AutomationControlled',
      `--proxy-server=${input.proxyUrl}`,
      '--proxy-bypass-list=<-loopback>',
      '--disable-quic',
      '--force-webrtc-ip-handling-policy=disable_non_proxied_udp',
      '--deny-permission-prompts',
      '--disable-notifications',
      '--block-new-web-contents',
      '--noerrdialogs',
      '--disable-session-crashed-bubble',
      '--disable-sync',
      '--disable-features=MediaRouter,Translate,GlobalMediaControls,PrivacySandboxSettings4',
      '--mute-audio',
      '--disable-extensions',
      '--disable-component-extensions-with-background-pages',
    ],
  };
}

function object(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Only called while Chrome is stopped; retain cookies/site state and rewrite safety preferences. */
export async function prepareChromeProfile(paths: BrowserPaths): Promise<void> {
  await ensureBrowserPaths(paths);
  const defaultDir = path.join(paths.profileDir, 'Default');
  await ensurePrivateDirectory(defaultDir);
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
  await writePrivateFile(file, JSON.stringify(prefs));
}

export function spawnChrome(input: ChromeLaunchInput): ChildProcess {
  const launch = buildChromeLaunch(input);
  return spawn(launch.command, launch.args, { stdio: ['ignore', 'ignore', 'ignore', 'pipe', 'pipe'] });
}

export async function stopChrome(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  // A failed spawn has no pid and never emits exit.
  if (child.pid === undefined) return;
  const exited = once(child, 'exit').then(() => undefined);
  child.kill('SIGTERM');
  await Promise.race([exited, delay(3_000)]);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill('SIGKILL');
    await exited;
  }
}
