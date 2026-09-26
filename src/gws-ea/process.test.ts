import { randomBytes } from 'node:crypto';
import { chmod, copyFile, mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  buildHostEnvironment,
  buildToolEnvironment,
  resolvePersistedExecutable,
  runSanitizedCommand,
  runSanitizedCommandOutcome,
} from './process.js';
import { resolveControlPlanePaths } from './paths.js';
import { REDACTED } from './redact.js';
import { startRunLog, type RunLog } from './run-log.js';
import { GwsEaError } from './types.js';

const NODE = process.execPath;
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(label: string, parent = os.tmpdir()): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(parent, `.gws-ea-${label}-`)));
  roots.push(root);
  return root;
}

async function runLog(
  options: { secretDirectories?: readonly string[]; captureFixturesTo?: string } = {},
): Promise<RunLog> {
  const root = await temporaryRoot('process-run');
  return startRunLog({
    paths: resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') }),
    command: 'create',
    ...options,
  });
}

async function rawLog(run: RunLog, stepFile: string): Promise<string> {
  return readFile(path.join(run.directory, 'steps', stepFile), 'utf8');
}

async function failure(promise: Promise<unknown>): Promise<GwsEaError> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof GwsEaError) return error;
    throw error;
  }
  throw new Error('Expected the command to fail');
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') return false;
    throw error;
  }
}

async function waitFor<T>(observe: () => Promise<T | undefined> | T | undefined, timeoutMs = 5_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await observe();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('Timed out waiting for condition');
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function readPid(file: string): Promise<number | undefined> {
  try {
    const text = await readFile(file, 'utf8');
    return text ? Number(text) : undefined;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

describe('GWS-EA tool and host environments', () => {
  const ambient = {
    PATH: '/safe/bin',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    LC_CTYPE: 'UTF-8',
    TERM: 'xterm',
    TMPDIR: '/var/folders/operator/T/',
    SSL_CERT_FILE: '/etc/ssl/cert.pem',
    SSL_CERT_DIR: '/etc/ssl/certs',
    HOME: '/attacker',
    NODE_OPTIONS: '--import=/tmp/attacker.js',
    DOCKER_CONFIG: '/Users/operator/.docker',
    XDG_RUNTIME_DIR: '/run/user/501',
    DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
    USER: 'operator',
    LOGNAME: 'operator',
    HTTPS_PROXY: 'http://proxy:3128',
    https_proxy: 'http://proxy:3128',
    NO_PROXY: 'localhost',
    CLOUDSDK_CONFIG: '/Users/operator/.config/gcloud',
    CLOUDSDK_PYTHON: '/usr/bin/python3',
    CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '/tmp/stolen-token',
    CLOUDSDK_CORE_ACCOUNT: 'someone@example.com',
    SSH_AUTH_SOCK: '/tmp/agent.sock',
    GOOGLE_APPLICATION_CREDENTIALS: '/tmp/key.json',
    CLOUDFLARE_API_TOKEN: 'ambient-cloudflare',
    ONECLI_API_KEY: 'ambient-onecli',
    ANTHROPIC_API_KEY: 'ambient-anthropic',
    GCHAT_CREDENTIALS: 'ambient-chat-secret',
    NANOCLAW_INSTALL_ID: 'victim',
  };

  it('passes exactly the tool allowlist plus explicit overrides to tools', () => {
    expect(buildToolEnvironment(ambient, { HOME: '/expected/home', NANOCLAW_INSTALL_ID: 'expected' })).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm',
      TMPDIR: '/var/folders/operator/T/',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      DOCKER_CONFIG: '/Users/operator/.docker',
      XDG_RUNTIME_DIR: '/run/user/501',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/501/bus',
      USER: 'operator',
      LOGNAME: 'operator',
      HTTPS_PROXY: 'http://proxy:3128',
      https_proxy: 'http://proxy:3128',
      NO_PROXY: 'localhost',
      CLOUDSDK_CONFIG: '/Users/operator/.config/gcloud',
      CLOUDSDK_PYTHON: '/usr/bin/python3',
      HOME: '/expected/home',
      NANOCLAW_INSTALL_ID: 'expected',
    });
  });

  it('passes exactly the host allowlist plus explicit overrides to the instance host', () => {
    expect(buildHostEnvironment(ambient, { HOME: '/expected/home' })).toEqual({
      PATH: '/safe/bin',
      LANG: 'en_US.UTF-8',
      LC_ALL: 'en_US.UTF-8',
      LC_CTYPE: 'UTF-8',
      TERM: 'xterm',
      TMPDIR: '/var/folders/operator/T/',
      SSL_CERT_FILE: '/etc/ssl/cert.pem',
      SSL_CERT_DIR: '/etc/ssl/certs',
      HOME: '/expected/home',
    });
  });

  it('rejects malformed override entries', () => {
    expect(() => buildToolEnvironment({}, { 'BAD-KEY': 'x' })).toThrow(
      expect.objectContaining({ code: 'invalid_environment' }),
    );
    expect(() => buildHostEnvironment({}, { GOOD: 'nul\0byte' })).toThrow(
      expect.objectContaining({ code: 'invalid_environment' }),
    );
  });
});

describe('GWS-EA command runner', () => {
  it('executes an argument array without a shell or unlisted ambient variables', async () => {
    const canaryKey = 'GWS_EA_AMBIENT_SECRET_CANARY';
    process.env[canaryKey] = 'must-not-cross';
    try {
      const result = await runSanitizedCommand({
        command: NODE,
        args: [
          '--eval',
          `process.stdout.write(JSON.stringify({ argv: process.argv.slice(1), canary: process.env.${canaryKey} ?? null }))`,
          '$(touch /tmp/gws-ea-must-not-exist)',
        ],
        cwd: process.cwd(),
      });
      expect(JSON.parse(result.stdout)).toEqual({ argv: ['$(touch /tmp/gws-ea-must-not-exist)'], canary: null });
    } finally {
      delete process.env[canaryKey];
    }
  });

  it('returns non-zero outcomes to callers that classify them', async () => {
    const outcome = await runSanitizedCommandOutcome({
      command: NODE,
      args: ['--eval', 'process.stderr.write("NOT_FOUND: project"); process.exit(1)'],
      cwd: process.cwd(),
    });
    expect(outcome).toEqual({ stdout: '', stderr: 'NOT_FOUND: project', exitCode: 1 });
  });

  it('names the program, non-secret arguments, exit code, and stderr tail of a failed command', async () => {
    const error = await failure(
      runSanitizedCommand({
        command: NODE,
        args: [
          '--eval',
          'process.stderr.write("line one\\nERROR: permission denied\\n"); process.exit(2)',
          'extra arg',
        ],
        cwd: process.cwd(),
      }),
    );

    expect(error.code).toBe('command_failed');
    expect(error.message).toContain(NODE);
    expect(error.message).toContain('"extra arg"');
    expect(error.message).toContain('exit code 2');
    expect(error.details).toMatchObject({
      program: NODE,
      args: ['--eval', expect.any(String), 'extra arg'],
      cwd: process.cwd(),
      exitCode: 2,
      signal: null,
      stderrTail: 'line one\nERROR: permission denied',
    });
  });

  it('reports a missing working directory with ENOENT and its path', async () => {
    const missing = path.join(await temporaryRoot('missing-cwd'), 'never-created');
    const error = await failure(runSanitizedCommand({ command: NODE, args: ['--version'], cwd: missing }));

    expect(error.code).toBe('command_failed');
    expect(error.message).toContain(missing);
    expect(error.details).toMatchObject({ errno: 'ENOENT', cwd: missing });
    expect(error.cause).toMatchObject({ code: 'ENOENT' });
  });

  it('names a missing executable and the directories searched', async () => {
    const root = await temporaryRoot('missing-exe');
    const error = await failure(
      runSanitizedCommand({
        command: 'gws-ea-no-such-tool',
        args: [],
        cwd: root,
        env: { PATH: `:relative/bin:${root}:/usr/bin` },
      }),
    );

    expect(error.code).toBe('executable_not_found');
    expect(error.message).toContain('gws-ea-no-such-tool');
    expect(error.details).toMatchObject({ program: 'gws-ea-no-such-tool', searched: [root, '/usr/bin'] });
  });

  it('ignores empty and relative PATH entries and passes only absolute entries on', async () => {
    const root = await temporaryRoot('path');
    const marker = path.join(root, 'hostile-ran');
    const trustedBin = path.join(root, 'trusted-bin');
    await mkdir(path.join(root, 'relative-bin'));
    await mkdir(trustedBin);
    const hostile = `#!/bin/sh\nprintf hostile > ${JSON.stringify(marker)}\n`;
    await writeFile(path.join(root, 'gws-ea-tool'), hostile, { mode: 0o755 });
    await writeFile(path.join(root, 'relative-bin', 'gws-ea-tool'), hostile, { mode: 0o755 });
    await writeFile(path.join(trustedBin, 'gws-ea-tool'), '#!/bin/sh\nprintf "%s" "$PATH"\n', { mode: 0o755 });

    const result = await runSanitizedCommand({
      command: 'gws-ea-tool',
      args: [],
      cwd: root,
      env: { PATH: `:relative-bin::${trustedBin}:` },
    });

    expect(result.stdout).toBe(trustedBin);
    await expect(readFile(marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('kills the whole process group on timeout and reports the timeout', async () => {
    const root = await temporaryRoot('timeout');
    const pidFile = path.join(root, 'grandchild.pid');
    const script = [
      "const { spawn } = require('node:child_process');",
      "const grandchild = spawn(process.execPath, ['--eval', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });",
      `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(grandchild.pid));`,
      'setInterval(() => {}, 1000);',
    ].join('\n');

    const error = await failure(
      runSanitizedCommand({ command: NODE, args: ['--eval', script], cwd: root, timeoutMs: 1_000 }),
    );

    expect(error.code).toBe('command_timeout');
    expect(error.message).toContain('timed out after 1.0s');
    expect(error.details).toMatchObject({ timeoutMs: 1_000 });
    const grandchild = await waitFor(() => readPid(pidFile));
    await waitFor(() => (isAlive(grandchild) ? undefined : true));
  });

  it('reports an external SIGKILL as a signal, not a timeout', async () => {
    const root = await temporaryRoot('signal');
    const pidFile = path.join(root, 'child.pid');
    const running = runSanitizedCommand({
      command: NODE,
      args: [
        '--eval',
        `require('node:fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);`,
      ],
      cwd: root,
      timeoutMs: 30_000,
    });
    const pid = await waitFor(() => readPid(pidFile));
    process.kill(pid, 'SIGKILL');

    const error = await failure(running);
    expect(error.code).toBe('command_failed');
    expect(error.message).toContain('SIGKILL');
    expect(error.message).not.toContain('timed out');
    expect(error.details).toMatchObject({ signal: 'SIGKILL', exitCode: null });
  });

  it('never logs parsed stdout, only its byte count', async () => {
    const run = await runLog();
    const apiKey = `oc_${randomBytes(18).toString('hex')}`;
    const accessToken = `ya29.${randomBytes(18).toString('hex')}`;
    const inspect = JSON.stringify([{ Id: 'c0ffee', Config: { Env: ['POSTGRES_PASSWORD=plain-password-value'] } }]);
    const stdout = `${JSON.stringify({ apiKey })}\n${accessToken}\n${inspect}`;

    const result = await run.step('start_onecli', () =>
      runSanitizedCommand({
        command: NODE,
        args: ['--eval', 'process.stdout.write(process.env.GWS_EA_TEST_OUTPUT)'],
        cwd: process.cwd(),
        env: buildToolEnvironment(process.env, { GWS_EA_TEST_OUTPUT: stdout }),
      }),
    );

    expect(result.stdout).toBe(stdout);
    const raw = await rawLog(run, '01-start-onecli.log');
    expect(raw).toContain(`stdout: ${Buffer.byteLength(stdout)} bytes (parsed, not logged)`);
    for (const leaked of [apiKey, accessToken, 'plain-password-value', 'c0ffee']) expect(raw).not.toContain(leaked);
  });

  it('writes input to stdin without logging it, and survives a child that never reads it', async () => {
    const run = await runLog();
    const input = `diagnosis bundle ${randomBytes(12).toString('hex')}`;

    const echoed = await run.step('diagnose', () =>
      runSanitizedCommand({
        command: NODE,
        args: ['--eval', 'process.stdin.pipe(process.stdout)'],
        cwd: process.cwd(),
        input,
      }),
    );
    const ignored = await runSanitizedCommandOutcome({
      command: NODE,
      args: ['--eval', 'process.exit(3)'],
      cwd: process.cwd(),
      input: 'x'.repeat(4 * 1024 * 1024),
    });

    expect(echoed.stdout).toBe(input);
    expect(await rawLog(run, '01-diagnose.log')).not.toContain(input);
    expect(ignored.exitCode).toBe(3);
  });

  it('redacts secrets from stderr in the raw log and the error tail', async () => {
    const secretDirectory = await temporaryRoot('secret-dir');
    const fileSecret = `file-secret-${randomBytes(12).toString('hex')}`;
    await writeFile(path.join(secretDirectory, 'onecli-admin-api-key'), `${fileSecret}\n`, { mode: 0o600 });
    const run = await runLog({ secretDirectories: [secretDirectory] });
    const pemBody = 'MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7';
    const escapedPem = JSON.stringify({
      private_key: `-----BEGIN PRIVATE KEY-----\n${pemBody}\n-----END PRIVATE KEY-----\n`,
    });
    const urlPassword = 'url-password-value';
    const jwt = `eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIx${randomBytes(6).toString('hex')}.c2ln`;
    const stderr = [
      `rejected ${fileSecret}`,
      escapedPem,
      `fetch https://operator:${urlPassword}@example.com/x.git failed`,
      `token ${jwt}`,
    ].join('\n');

    const error = await run.step('provision_gcp', () =>
      failure(
        runSanitizedCommand({
          command: NODE,
          args: ['--eval', `process.stderr.write(${JSON.stringify(stderr)}); process.exit(3)`],
          cwd: process.cwd(),
        }),
      ),
    );

    const raw = await rawLog(run, '01-provision-gcp.log');
    const tail = String(error.details?.stderrTail);
    for (const leaked of [fileSecret, pemBody, urlPassword, jwt]) {
      expect(raw).not.toContain(leaked);
      expect(tail).not.toContain(leaked);
      expect(error.message).not.toContain(leaked);
    }
    expect(tail).toContain(`rejected ${REDACTED}`);
    expect(raw).toContain(`rejected ${REDACTED}`);
  });

  it('registers secret-bearing environment values before a command runs', async () => {
    const apiKey = `env-secret-${randomBytes(12).toString('hex')}`;
    const error = await failure(
      runSanitizedCommand({
        command: NODE,
        args: ['--eval', 'process.stderr.write(`bad key ${process.env.ONECLI_API_KEY}`); process.exit(1)'],
        cwd: process.cwd(),
        env: buildToolEnvironment(process.env, { ONECLI_API_KEY: apiKey }),
      }),
    );
    expect(error.details?.stderrTail).toBe(`bad key ${REDACTED}`);
  });

  it('trims retained stderr to whole lines, so no fragment of a secret survives the cut', async () => {
    const run = await runLog();
    const apiKey = `env-secret-${randomBytes(12).toString('hex')}`;
    const kept = 20;
    // Blank lines after the key fill the 64 KiB retained window, except for the key's last `kept` characters.
    const script = `process.stderr.write('x'.repeat(4096) + process.env.ONECLI_API_KEY + '\\n'.repeat(${64 * 1024 - kept})); process.exitCode = 1;`;

    const error = await run.step('provision_gcp', () =>
      failure(
        runSanitizedCommand({
          command: NODE,
          args: ['--eval', script],
          cwd: process.cwd(),
          env: buildToolEnvironment(process.env, { ONECLI_API_KEY: apiKey }),
        }),
      ),
    );

    const raw = await rawLog(run, '01-provision-gcp.log');
    const tail = String(error.details?.stderrTail);
    const cut = apiKey.length - kept;
    for (const fragment of [apiKey.slice(0, cut), apiKey.slice(cut)]) {
      expect(tail).not.toContain(fragment);
      expect(raw).not.toContain(fragment);
    }
  });

  it('streams an opt-in build log over 1 MiB to the raw log, redacted', async () => {
    const secret = `build-secret-${randomBytes(12).toString('hex')}`;
    const secretDirectory = await temporaryRoot('build-secret');
    await writeFile(path.join(secretDirectory, 'token'), secret, { mode: 0o600 });
    const run = await runLog({ secretDirectories: [secretDirectory] });
    const script = [
      "const line = 'layer '.padEnd(1023, 'x') + '\\n';",
      'for (let index = 0; index < 1536; index++) process.stdout.write(line);',
      `process.stderr.write('pushing with ${secret}\\n');`,
      "process.stdout.write('build complete\\n');",
    ].join('\n');

    const result = await run.step('start_nanoclaw', () =>
      runSanitizedCommand({ command: NODE, args: ['--eval', script], cwd: process.cwd(), stream: true }),
    );

    expect(result.stdout).toBe('');
    const raw = await rawLog(run, '01-start-nanoclaw.log');
    expect(Buffer.byteLength(raw)).toBeGreaterThan(1024 * 1024);
    expect(raw).toContain('build complete');
    expect(raw).toContain(`pushing with ${REDACTED}`);
    expect(raw).not.toContain(secret);
  });

  it('caps only parsed output', async () => {
    const command = {
      command: NODE,
      args: ['--eval', "process.stdout.write('x'.repeat(4096))"],
      cwd: process.cwd(),
      outputLimitBytes: 1024,
    };

    expect((await failure(runSanitizedCommand(command))).code).toBe('command_output_limit');
    await expect(runSanitizedCommand({ ...command, stream: true })).resolves.toMatchObject({ stdout: '' });
  });

  it('captures an allowlisted read with the stdout the runner parsed when the run enables capture', async () => {
    const root = await temporaryRoot('capture');
    const bin = path.join(root, 'bin');
    const staging = path.join(root, 'staging');
    await mkdir(bin);
    await writeFile(path.join(bin, 'gcloud'), '#!/bin/sh\nprintf \'[{"projectId":"gws-ea-fixture"}]\'\n', {
      mode: 0o755,
    });
    const run = await runLog({ captureFixturesTo: staging });

    await run.step('provision_gcp', () =>
      runSanitizedCommand({
        command: 'gcloud',
        args: ['projects', 'list', '--format=json'],
        cwd: root,
        env: { PATH: bin },
      }),
    );

    const staged = await Promise.all(
      (await readdir(staging)).map(
        async (file) => JSON.parse(await readFile(path.join(staging, file), 'utf8')) as unknown,
      ),
    );
    expect(staged).toEqual([
      expect.objectContaining({ kind: 'command', program: 'gcloud', stdout: '[{"projectId":"gws-ea-fixture"}]' }),
    ]);
  });
});

describe('GWS-EA persisted executables', () => {
  it('resolves a persisted executable to its real path', async () => {
    await expect(resolvePersistedExecutable('/bin/sh')).resolves.toBe(await realpath('/bin/sh'));
    await expect(resolvePersistedExecutable('sh', { searchPath: `relative:${path.dirname('/bin/sh')}` })).resolves.toBe(
      await realpath('/bin/sh'),
    );
  });

  it('refuses a persisted node inside the control-plane checkout or an instance checkout', async () => {
    const inRepository = await temporaryRoot('checkout-node', process.cwd());
    await copyFile(NODE, path.join(inRepository, 'node'));
    await chmod(path.join(inRepository, 'node'), 0o755);
    await expect(resolvePersistedExecutable(path.join(inRepository, 'node'))).rejects.toMatchObject({
      code: 'untrusted_executable',
      message: expect.stringContaining('checkout'),
    });

    const instances = path.join(await temporaryRoot('instances'), 'instances');
    const instanceBin = path.join(instances, 'one', 'nanoclaw', 'node_modules', '.bin');
    await mkdir(instanceBin, { recursive: true });
    await writeFile(path.join(instanceBin, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(
      resolvePersistedExecutable(path.join(instanceBin, 'node'), { checkoutRoots: [instances] }),
    ).rejects.toMatchObject({ code: 'untrusted_executable', message: expect.stringContaining('checkout') });
  });

  it('refuses a persisted executable in a world-writable or temporary directory', async () => {
    const root = await temporaryRoot('writable');
    const shared = path.join(root, 'shared');
    await mkdir(shared);
    await chmod(shared, 0o777);
    await writeFile(path.join(shared, 'node'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(resolvePersistedExecutable(path.join(shared, 'node'))).rejects.toMatchObject({
      code: 'untrusted_executable',
      message: expect.stringContaining('writable'),
    });

    await writeFile(path.join(root, 'onecli'), '#!/bin/sh\n', { mode: 0o755 });
    await expect(resolvePersistedExecutable('onecli', { searchPath: root })).rejects.toMatchObject({
      code: 'untrusted_executable',
      message: expect.stringContaining('temporary'),
    });
  });
});
