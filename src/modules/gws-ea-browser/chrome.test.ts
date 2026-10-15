import { execFile } from 'node:child_process';
import { chmod, lstat, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { buildChromeLaunch, prepareChromeProfile } from './chrome.js';
import { browserPaths, ensureBrowserPaths, writePrivateFile } from './paths.js';
import { readBrowserPolicy } from './policy.js';

const execute = promisify(execFile);
let root: string;
beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'browser-runtime-'));
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe('dedicated Chrome profile and launch', () => {
  it('uses a private pipe, dedicated profile, public proxy and background flags only', () => {
    const paths = browserPaths(path.join(root, 'browser', 'policy.json'));
    const launch = buildChromeLaunch({
      chromePath: '/Applications/Chrome with spaces.app/Chrome',
      paths,
      proxyUrl: 'http://127.0.0.1:45678',
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
        '--remote-debugging-pipe',
        '--disable-blink-features=AutomationControlled',
        `--user-data-dir=${paths.profileDir}`,
        '--proxy-server=http://127.0.0.1:45678',
        '--proxy-bypass-list=<-loopback>',
        '--no-startup-window',
        '--disable-quic',
        '--deny-permission-prompts',
      ]),
    );
    expect(
      launch.args.some((arg) =>
        /--(?:remote-debugging-port|enable-automation|remote-allow-origins|headless)/.test(arg),
      ),
    ).toBe(false);
  });

  it('sets a child-only umask and preserves argv verbatim', async () => {
    const paths = browserPaths(path.join(root, 'browser', 'policy.json'));
    const launch = buildChromeLaunch({ chromePath: process.execPath, paths, proxyUrl: 'http://127.0.0.1:45678' });
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
    const paths = browserPaths(path.join(root, 'browser', 'policy.json'));
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
    });
    for (const dir of [paths.root, paths.profileDir, paths.stagingDir])
      expect((await lstat(dir)).mode & 0o777).toBe(0o700);
    expect((await lstat(pref)).mode & 0o777).toBe(0o600);
    await symlink(path.join(root, 'elsewhere'), path.join(paths.stagingDir, 'escape'));
    await expect(ensureBrowserPaths(paths)).rejects.toThrow(/symbolic|symlink/i);
  });

  it('reads required optional-capability policy on each use and never adopts configurable profiles', async () => {
    const paths = browserPaths(path.join(root, 'browser', 'policy.json'));
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({ enabled: false, status: 'disabled' });
    await ensureBrowserPaths(paths);
    await writePrivateFile(
      paths.policyFile,
      JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }),
    );
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({
      enabled: true,
      status: 'enabled',
      credentialMode: 'email',
      paths,
    });
    await writePrivateFile(
      paths.policyFile,
      JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: ['email'] }),
    );
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({ enabled: false, status: 'unavailable' });
    await writePrivateFile(
      paths.policyFile,
      JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }),
    );
    await chmod(paths.policyFile, 0o644);
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({ enabled: false, status: 'unavailable' });
    expect((await lstat(paths.policyFile)).mode & 0o777).toBe(0o644);
    await writePrivateFile(
      paths.policyFile,
      JSON.stringify({ schemaVersion: 1, enabled: false, credentialMode: 'email' }),
    );
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({ enabled: false, status: 'disabled' });
    await writePrivateFile(
      paths.policyFile,
      JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email', profileDir: '/personal' }),
    );
    expect(await readBrowserPolicy(paths.policyFile)).toMatchObject({
      enabled: false,
      status: 'unavailable',
      reason: 'invalid-browser-policy',
    });
  });
});
