import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { FailureReport } from '../src/gws-ea/cli.js';
import type { SanitizedCommand } from '../src/gws-ea/process.js';
import { registerSecret } from '../src/gws-ea/redact.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { CLAUDE_DIAGNOSIS_ARGS, offerDiagnosis, type DiagnosisUi } from './gws-ea-assist.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function failure(): Promise<{ readonly report: FailureReport; readonly secret: string }> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-assist-'));
  roots.push(root);
  const runDirectory = path.join(root, 'logs', 'run-1');
  await mkdir(path.join(runDirectory, 'steps'), { recursive: true, mode: 0o700 });
  const secret = `late-registered-secret-${Date.now()}`;
  const progressLog = path.join(runDirectory, 'progress.log');
  const rawLog = path.join(runDirectory, 'steps', '03-provision-gcp.log');
  await writeFile(progressLog, '=== provision_gcp → failed ===\n  error: command_failed\n');
  await writeFile(rawLog, `$ gcloud projects describe p\n  stderr: denied ${secret}\n`);
  registerSecret(secret);
  return {
    secret,
    report: {
      command: 'resume',
      step: 'provision_gcp',
      stepLabel: 'Configuring Google Cloud…',
      code: 'command_failed',
      cause: 'Command failed (exit code 1): gcloud projects describe p',
      nextAction: 'Resume with: gws-ea resume --id 00000000-0000-4000-8000-000000000000',
      progressLog,
      rawLog,
      runDirectory,
      instanceId: '00000000-0000-4000-8000-000000000000',
    },
  };
}

function ui(answer = true): DiagnosisUi & { readonly notes: Array<[string, string]> } {
  const notes: Array<[string, string]> = [];
  return {
    notes,
    note: (message, title) => void notes.push([message, title]),
    confirm: vi.fn(async () => answer),
    warn: vi.fn(),
    wait: async (_label, work) => work(),
  };
}

describe('GWS-EA failure diagnosis', () => {
  it('is omitted without a TTY', async () => {
    const { report } = await failure();
    const prompts = ui();
    const runClaude = vi.fn();

    expect(await offerDiagnosis(report, { interactive: false, ui: prompts, runClaude })).toBe('skipped');
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('is omitted when claude is not installed', async () => {
    const { report } = await failure();
    const prompts = ui();
    const runClaude = vi.fn();

    expect(
      await offerDiagnosis(report, {
        interactive: true,
        ui: prompts,
        runClaude,
        locateClaude: async () => {
          throw new GwsEaError('executable_not_found', 'claude was not found on PATH');
        },
      }),
    ).toBe('skipped');
    expect(prompts.confirm).not.toHaveBeenCalled();
    expect(prompts.notes).toEqual([]);
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('sends nothing when the operator declines', async () => {
    const { report } = await failure();
    const runClaude = vi.fn();

    expect(
      await offerDiagnosis(report, {
        interactive: true,
        ui: ui(false),
        runClaude,
        locateClaude: async () => '/usr/local/bin/claude',
      }),
    ).toBe('declined');
    expect(runClaude).not.toHaveBeenCalled();
  });

  it('sends only the staged, redacted bundle to a tool-less claude with no secret environment', async () => {
    const { report, secret } = await failure();
    const prompts = ui();
    const commands: SanitizedCommand[] = [];
    const order: string[] = [];
    prompts.confirm = vi.fn(async (message: string) => {
      order.push('consent');
      expect(message).toMatch(/send/iu);
      return true;
    });

    const outcome = await offerDiagnosis(report, {
      interactive: true,
      ui: prompts,
      locateClaude: async () => '/usr/local/bin/claude',
      ambient: {
        PATH: '/usr/local/bin:/usr/bin',
        HOME: '/Users/operator',
        HTTPS_PROXY: 'http://proxy.example.test:3128',
        ANTHROPIC_API_KEY: 'sk-ant-api03-ambient',
        GWS_EA_PROVIDER_CREDENTIAL: 'sk-ant-api03-supplied',
        CLOUDSDK_AUTH_ACCESS_TOKEN_FILE: '/tmp/token',
        SSH_AUTH_SOCK: '/tmp/agent.sock',
        GITHUB_TOKEN: 'ghp_ambient',
      },
      runClaude: async (command) => {
        order.push('claude');
        commands.push(command);
        return {
          exitCode: 0,
          stderr: '',
          stdout: 'The project is missing.\u001B[31m\nCOMMAND: gcloud projects list --filter=gws-ea\n',
        };
      },
    });

    expect(outcome).toBe('answered');
    expect(order).toEqual(['consent', 'claude']);
    const consent = prompts.notes.find(([, title]) => /leaves this machine/iu.test(title))?.[0] ?? '';
    for (const category of [
      'Google account email',
      'project, organization, and Cloudflare zone IDs',
      'hostnames',
      'local paths',
      'Google Chat user IDs and display names',
    ]) {
      expect(consent).toContain(category);
    }
    const bundle = path.join(report.runDirectory, 'diagnosis');
    expect(consent).toContain(bundle);
    expect((await stat(bundle)).mode & 0o777).toBe(0o700);
    expect((await readdir(bundle)).sort()).toEqual(['progress.log', 'sources', 'step.log']);

    expect(commands).toHaveLength(1);
    const command = commands[0]!;
    expect(command.command).toBe('/usr/local/bin/claude');
    expect(command.args).toEqual(CLAUDE_DIAGNOSIS_ARGS);
    expect(command.args).toEqual(
      expect.arrayContaining(['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence']),
    );
    expect(command.args[command.args.indexOf('--mcp-config') + 1]).toBe('{"mcpServers":{}}');
    expect(command.args).not.toEqual(expect.arrayContaining(['--resume']));
    expect(command.args).not.toEqual(expect.arrayContaining(['--continue']));
    expect(command.cwd).toBe(bundle);
    expect(command.env).toEqual({
      PATH: '/usr/local/bin:/usr/bin',
      HOME: '/Users/operator',
      HTTPS_PROXY: 'http://proxy.example.test:3128',
    });
    expect(command.input).toContain('command_failed');
    expect(command.input).toContain('gcloud projects describe p');
    expect(command.input).toContain('src/gws-ea/gcloud.ts');
    expect(command.input).not.toContain(secret);

    const shown = prompts.notes.find(([, title]) => /untrusted/iu.test(title))?.[0] ?? '';
    expect(shown).toContain('The project is missing.');
    expect(shown).not.toContain('\u001B');
    expect(shown).toContain('gcloud projects list --filter=gws-ea');
  });

  it('strips bidi and zero-width format characters, so a suggested command reads as its bytes', async () => {
    const { report } = await failure();
    const prompts = ui();

    expect(
      await offerDiagnosis(report, {
        interactive: true,
        ui: prompts,
        locateClaude: async () => '/usr/local/bin/claude',
        runClaude: async () => ({
          exitCode: 0,
          stderr: '',
          stdout: 'The ‮project is missing.\nCOMMAND: gcloud projects list ⁦--filter=gws-ea⁩​\n',
        }),
      }),
    ).toBe('answered');
    const shown = prompts.notes.find(([, title]) => /untrusted/iu.test(title))?.[0] ?? '';
    expect(shown).not.toMatch(/[‮⁦]/u);
    expect(shown).not.toMatch(/\p{Cf}/u);
    expect(shown).toContain('The project is missing.');
    expect(shown).toMatch(/\n {2}gcloud projects list --filter=gws-ea$/u);
  });

  it('reports a failed diagnosis without running anything else', async () => {
    const { report } = await failure();
    const prompts = ui();

    expect(
      await offerDiagnosis(report, {
        interactive: true,
        ui: prompts,
        locateClaude: async () => '/usr/local/bin/claude',
        runClaude: async () => ({ exitCode: 1, stdout: '', stderr: 'Not logged in' }),
      }),
    ).toBe('unavailable');
    expect(prompts.warn).toHaveBeenCalledWith(expect.stringContaining('Claude could not'));
  });
});
