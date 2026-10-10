/**
 * No page in an agent's browser may reach a host where the gateway injects the
 * assistant's Google token (KTD10). Chromium's URL blocklist stops navigations,
 * not a page's own requests, so the image starts Chromium through a launch
 * wrapper that sends it through the gateway and bypasses the gateway for
 * exactly those hosts. On the internal agent-egress network a bypassed host has
 * no route, while gog keeps the gateway.
 */
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { afterEach, describe, expect, it } from 'vitest';

import { AGENT_GOOGLE_HOSTS } from './grant.js';

const containerFile = (name: string): string =>
  readFileSync(fileURLToPath(new URL(`../../../container/${name}`, import.meta.url)), 'utf8');

/** The image's Chromium, which the wrapper must start and nothing else. */
const IMAGE_CHROMIUM = '/usr/bin/chromium';
/** OneCLI's proxy variable: the agent's gateway token rides in the userinfo. */
const GATEWAY = 'http://x:aoc_agent-token@host.docker.internal:10255';
const GATEWAY_SERVER = '--proxy-server=http://host.docker.internal:10255';

const scratch: string[] = [];
afterEach(() => {
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true });
});

interface Launch {
  readonly status: number | null;
  /** The arguments Chromium was started with; empty when it was not started. */
  readonly argv: readonly string[];
  readonly stderr: string;
}

/**
 * Runs the checked-in wrapper with the image's Chromium replaced by a stub that
 * prints the arguments it was started with, under exactly `env`.
 */
function launch(env: Readonly<Record<string, string>>, args: readonly string[] = []): Launch {
  const source = containerFile('chromium-launch.sh');
  expect(source.split(IMAGE_CHROMIUM)).toHaveLength(2);
  const dir = mkdtempSync(path.join(os.tmpdir(), 'chromium-launch-'));
  scratch.push(dir);
  const stub = path.join(dir, 'chromium');
  writeFileSync(stub, '#!/bin/sh\nprintf \'%s\\0\' "$@"\n');
  chmodSync(stub, 0o755);
  const wrapper = path.join(dir, 'chromium-launch.sh');
  writeFileSync(wrapper, source.replace(IMAGE_CHROMIUM, `'${stub}'`));
  const result = spawnSync('/bin/sh', [wrapper, ...args], {
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
  });
  const printed = result.stdout;
  return { status: result.status, argv: printed ? printed.split('\0').slice(0, -1) : [], stderr: result.stderr };
}

function bypassList(argv: readonly string[]): string[] {
  const flag = argv.find((arg) => arg.startsWith('--proxy-bypass-list='));
  return flag ? flag.slice('--proxy-bypass-list='.length).split(',') : [];
}

describe("an agent's browser and Google's API hosts", () => {
  it('sends Chromium through the gateway, bypassing it for exactly the hosts that carry agent Google tokens', () => {
    const { status, argv } = launch({ HTTPS_PROXY: GATEWAY });

    expect(status).toBe(0);
    expect(argv[0]).toBe(GATEWAY_SERVER);
    expect(bypassList(argv).sort()).toEqual([...AGENT_GOOGLE_HOSTS].sort());
  });

  it('leaves every other host on the gateway: each bypass entry is one exact host', () => {
    const bypassed = bypassList(launch({ HTTPS_PROXY: GATEWAY }).argv);

    for (const host of bypassed) expect(host).toMatch(/^[a-z0-9-]+(\.[a-z0-9-]+)+$/);
    for (const host of ['fonts.googleapis.com', 'maps.googleapis.com', 'docs.google.com', 'example.com']) {
      expect(bypassed).not.toContain(host);
    }
  });

  it('replaces the proxy settings agent-browser passes, and passes every other argument through', () => {
    const { argv } = launch({ HTTPS_PROXY: GATEWAY }, [
      '--proxy-server=http://host.docker.internal:10255',
      '--proxy-bypass-list=localhost',
      '-proxy-pac-url=data:application/x-ns-proxy-autoconfig,function FindProxyForURL(){return "DIRECT"}',
      '--proxy-auto-detect',
      '--no-proxy-server',
      '--headless=new',
      '--user-data-dir=/tmp/agent browser',
      'about:blank',
    ]);

    expect(argv).toEqual([
      GATEWAY_SERVER,
      `--proxy-bypass-list=${bypassList(argv).join(',')}`,
      '--headless=new',
      '--user-data-dir=/tmp/agent browser',
      'about:blank',
    ]);
  });

  it.each([
    ['HTTPS_PROXY, without its credentials', { HTTPS_PROXY: GATEWAY, HTTP_PROXY: 'http://elsewhere:1' }],
    ['https_proxy when HTTPS_PROXY is unset', { https_proxy: GATEWAY }],
    ['a gateway written with a trailing slash', { HTTPS_PROXY: 'http://host.docker.internal:10255/' }],
  ])('takes the gateway from %s', (_label, env) => {
    expect(launch(env).argv[0]).toBe(GATEWAY_SERVER);
  });

  it('does not start Chromium when the container names no gateway', () => {
    const { status, argv, stderr } = launch({ HTTP_PROXY: GATEWAY });

    expect(status).not.toBe(0);
    expect(argv).toEqual([]);
    expect(stderr).toMatch(/HTTPS_PROXY/);
  });

  it('is what the image starts for agent-browser and Playwright', () => {
    const instructions = containerFile('Dockerfile')
      .replace(/\\\n\s*/g, ' ')
      .split('\n');
    const install = instructions.find((line) => /^COPY\b.*\bchromium-launch\.sh\b/.test(line));
    const installed = install?.split(/\s+/).at(-1);
    const env = (name: string) => instructions.find((line) => line.startsWith(`ENV ${name}=`))?.split('=')[1];

    expect(install).toMatch(/^COPY --chmod=0755 chromium-launch\.sh \//);
    expect(env('AGENT_BROWSER_EXECUTABLE_PATH')).toBe(installed);
    expect(env('PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH')).toBe(installed);
  });
});
