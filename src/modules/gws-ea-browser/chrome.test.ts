import { execFile, spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import net from 'node:net';
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildChromeLaunch, prepareChromeProfile, spawnChrome } from './chrome.js';
import { browserPaths, ensureBrowserPaths } from './paths.js';

vi.mock('node:child_process', async (load) => {
  const original = await load<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-runtime-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('dedicated Chrome profile and launch', () => {
  it('uses an explicit loopback debugger port, dedicated profile, public proxy and background flags only', () => {
    const paths = browserPaths(path.join(root, 'browser'));
    const launch = buildChromeLaunch({
      chromePath: '/Applications/Chrome with spaces.app/Chrome',
      paths,
      proxyUrl: 'http://127.0.0.1:45678',
      debuggerPort: 45679,
    });
    expect(launch.command).toBe('/bin/sh');
    expect(launch.args.slice(0, 4)).toEqual([
      '-c',
      'umask 077; exec "$@"',
      'gws-ea-chrome',
      '/Applications/Chrome with spaces.app/Chrome',
    ]);
    expect(launch.args).toEqual(
      expect.arrayContaining([
        '--remote-debugging-address=127.0.0.1',
        '--remote-debugging-port=45679',
        `--user-data-dir=${paths.profileDir}`,
        '--proxy-server=http://127.0.0.1:45678',
        '--proxy-bypass-list=<-loopback>',
        '--no-startup-window',
        '--disable-quic',
        '--deny-permission-prompts',
        // A page restored from the back/forward cache would skip the document gate.
        '--disable-back-forward-cache',
      ]),
    );
    expect(
      launch.args.some((arg) =>
        /--(?:remote-debugging-pipe|disable-notifications|enable-automation|remote-allow-origins|headless)|AutomationControlled|CDPScreenshotNewSurface/.test(
          arg,
        ),
      ),
    ).toBe(false);
  });

  it.each([0, -1, 65_536, 1.5, Number.NaN])('refuses invalid Chrome debugger port %s', (debuggerPort) => {
    expect(() =>
      buildChromeLaunch({
        chromePath: '/fixture/chrome',
        paths: browserPaths(path.join(root, 'browser')),
        proxyUrl: 'http://127.0.0.1:45678',
        debuggerPort,
      }),
    ).toThrow('Chrome needs an explicit debugger port');
  });

  it('never spawns a late Chrome after cancellation during port selection', async () => {
    let listening!: () => void;
    const selector = Object.assign(new EventEmitter(), {
      listen: vi.fn((_port: number, _host: string, callback: () => void) => {
        listening = callback;
      }),
      address: () => ({ address: '127.0.0.1', family: 'IPv4', port: 45679 }),
      close: vi.fn((callback?: (error?: Error) => void) => {
        callback?.();
      }),
    });
    const reserve = vi.spyOn(net, 'createServer').mockReturnValue(selector as unknown as net.Server);
    const spawnProcess = vi.mocked(spawn);
    spawnProcess.mockClear();
    const controller = new AbortController();
    try {
      const pending = spawnChrome(
        {
          chromePath: '/fixture/chrome',
          paths: browserPaths(path.join(root, 'browser')),
          proxyUrl: 'http://127.0.0.1:45678',
        },
        controller.signal,
      );
      controller.abort();
      await expect(pending).rejects.toThrow('Chrome startup cancelled');
      listening();
      await Promise.resolve();
      expect(spawnProcess).not.toHaveBeenCalled();
      expect(selector.close).toHaveBeenCalled();
    } finally {
      reserve.mockRestore();
      spawnProcess.mockClear();
    }
  });

  it('sets a child-only umask and preserves argv verbatim', async () => {
    const paths = browserPaths(path.join(root, 'browser'));
    const launch = buildChromeLaunch({
      chromePath: process.execPath,
      paths,
      proxyUrl: 'http://127.0.0.1:45678',
      debuggerPort: 45679,
    });
    const output = path.join(root, 'private data with spaces');
    const argv = ['literal $(no-command)', 'quoted "value"'];
    await execute(launch.command, [
      ...launch.args.slice(0, 4),
      '-e',
      "require('node:fs').writeFileSync(process.argv[1], JSON.stringify(process.argv.slice(2)))",
      output,
      ...argv,
    ]);
    expect(JSON.parse(await readFile(output, 'utf8'))).toEqual(argv);
    expect((await lstat(output)).mode & 0o777).toBe(0o600);
  });

  it('keeps profile/staging private and rewrites WebRTC preference on reopening without losing site state', async () => {
    const paths = browserPaths(path.join(root, 'browser'));
    await ensureBrowserPaths(paths);
    await prepareChromeProfile(paths);
    const pref = path.join(paths.profileDir, 'Default', 'Preferences');
    const value = JSON.parse(await readFile(pref, 'utf8')) as {
      profile: object;
      webrtc: { ip_handling_policy: string };
      testSiteState?: string;
    };
    value.testSiteState = 'preserved';
    value.webrtc.ip_handling_policy = 'default';
    await writeFile(pref, JSON.stringify(value));
    await chmod(pref, 0o644);
    await chmod(paths.profileDir, 0o755);
    await prepareChromeProfile(paths);
    const actual = JSON.parse(await readFile(pref, 'utf8')) as typeof value;
    expect(actual.webrtc.ip_handling_policy).toBe('disable_non_proxied_udp');
    expect(actual.testSiteState).toBe('preserved');
    expect(actual).toMatchObject({
      policy: { url_blocklist: ['*'], url_allowlist: ['http://*', 'https://*', 'about:*', 'data:*'] },
      signin: { allowed: false },
      // Speculative prefetch and prerender would fetch a page without any request the gate sees.
      net: { network_prediction_options: 2 },
    });
    for (const dir of [paths.root, paths.profileDir, paths.stagingDir])
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(pref)).mode & 0o777).toBe(0o600);
    await symlink(path.join(root, 'elsewhere'), path.join(paths.stagingDir, 'escape'));
    await expect(ensureBrowserPaths(paths)).rejects.toThrow(/symbolic|symlink/i);
  });

  it('retains Chrome’s version sentinel without following it, only at the profile root', async () => {
    const paths = browserPaths(path.join(root, 'browser'));
    await ensureBrowserPaths(paths);
    const sentinel = path.join(paths.profileDir, 'RunningChromeVersion');
    await symlink('155.0.8059.85:1', sentinel);
    await prepareChromeProfile(paths);
    expect(await readlink(sentinel)).toBe('155.0.8059.85:1');
    const staged = path.join(paths.stagingDir, 'RunningChromeVersion');
    await symlink('155.0.8059.85:1', staged);
    await expect(ensureBrowserPaths(paths)).rejects.toThrow(/symlink/iu);
    await rm(staged);
    await symlink(path.join(root, 'elsewhere'), path.join(paths.profileDir, 'unknown-link'));
    await expect(ensureBrowserPaths(paths)).rejects.toThrow(/symlink/iu);
  });

  it('drops every service worker registration while Chrome is stopped', async () => {
    const paths = browserPaths(path.join(root, 'browser'));
    await prepareChromeProfile(paths);
    // A worker registered before would answer navigations without a request the gate sees.
    const workers = path.join(paths.profileDir, 'Default', 'Service Worker');
    await mkdir(path.join(workers, 'Database'), { recursive: true });
    await writeFile(path.join(workers, 'Database', 'CURRENT'), 'MANIFEST-000001');
    await prepareChromeProfile(paths);
    await expect(lstat(workers)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('removes orphaned upload copies while retaining unhanded downloads before a fresh Chrome launch', async () => {
    const paths = browserPaths(path.join(root, 'browser'));
    await ensureBrowserPaths(paths);
    const upload = path.join(paths.stagingDir, 'uploads', 'orphan');
    await mkdir(upload, { recursive: true, mode: 0o700 });
    await writeFile(path.join(upload, 'supporting.txt'), 'stale upload', { mode: 0o600 });
    const download = path.join(paths.stagingDir, 'downloads', 'pending');
    await mkdir(download, { recursive: true, mode: 0o700 });
    await writeFile(path.join(download, 'invoice.pdf'), 'only valid download', { mode: 0o600 });
    await prepareChromeProfile(paths);
    expect(await readdir(path.join(paths.stagingDir, 'uploads'))).toEqual([]);
    expect(await readFile(path.join(download, 'invoice.pdf'), 'utf8')).toBe('only valid download');
  });
});
