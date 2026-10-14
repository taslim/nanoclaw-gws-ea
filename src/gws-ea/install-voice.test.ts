/** Recipe boundaries use tiny checksum-pinned downloads and a compiler boundary; real engine proof is separate. */
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installVoiceAssets, voiceInstallationDirectory } from './install-voice.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { SanitizedCommand, SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
import { startRunLog } from './run-log.js';
import { registerSecret } from './redact.js';
import {
  VOICE_SOURCE_ARTIFACTS,
  voiceModelUrl,
  verifyVoiceInstallation,
  type VoiceAssetReceipt,
} from './voice-assets.js';

vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rm: vi.fn(actual.rm) };
});

vi.mock('./voice-assets.js', async (original) => {
  const actual = await original<typeof import('./voice-assets.js')>();
  const { createHash } = await import('node:crypto');
  const sha = (text: string) => createHash('sha256').update(text).digest('hex');
  return {
    ...actual,
    VOICE_MODEL_CATALOG: Object.fromEntries(
      Object.entries(actual.VOICE_MODEL_CATALOG).map(([name, pin]) => [
        name,
        { ...pin, size: 5, sha256: sha('model') },
      ]),
    ),
    VOICE_SOURCE_ARTIFACTS: {
      whisper: { ...actual.VOICE_SOURCE_ARTIFACTS.whisper, sha256: sha('whisper source') },
      ffmpeg: { ...actual.VOICE_SOURCE_ARTIFACTS.ffmpeg, sha256: sha('ffmpeg source') },
      vad: { ...actual.VOICE_SOURCE_ARTIFACTS.vad, size: 3, sha256: sha('vad') },
    },
    verifyVoiceInstallation: vi.fn(async (installationDir: string) => {
      // This is the asset-verification boundary, whose full pinned identities have their own tests.
      const { readFile } = await import('node:fs/promises');
      const { join } = await import('node:path');
      const receipt = JSON.parse(await readFile(join(installationDir, 'receipt.json'), 'utf8')) as VoiceAssetReceipt;
      return {
        installationDir,
        receipt,
        ffmpeg: join(installationDir, receipt.artifacts.ffmpeg.file),
        whisperCli: join(installationDir, receipt.artifacts.whisperCli.file),
        model: join(installationDir, receipt.artifacts.model.file),
        vad: join(installationDir, receipt.artifacts.vad.file),
      };
    }),
  };
});

const MIT = `Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;
const MODEL_LICENSE = `MIT License\n\nCopyright (c) 2022 OpenAI\n\n${MIT}\n`;
const VAD_LICENSE = `MIT License\n\nCopyright (c) 2020-present Silero Team\n\n${MIT}`;
const VAD_CARD =
  '---\nlicense: mit\n---\n\n### Voice Activity Detection (VAD) models for whisper.cpp\nThis repository contains VAD models that have been converted to ggml format for usage with whiper.cpp.';

let root: string;
let paths: ControlPlanePaths;
beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'voice-recipe-')));
  paths = resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function fetchRecipe(): typeof globalThis.fetch {
  return vi.fn(async (input) => {
    const url = String(input);
    let body: string;
    if (url === VOICE_SOURCE_ARTIFACTS.whisper.url) body = 'whisper source';
    else if (url === VOICE_SOURCE_ARTIFACTS.ffmpeg.url) body = 'ffmpeg source';
    else if (url === VOICE_SOURCE_ARTIFACTS.vad.url) body = 'vad';
    else if (url === voiceModelUrl('base')) body = 'model';
    else if (url.includes('openai/whisper/')) body = MODEL_LICENSE;
    else if (url.includes('snakers4/silero-vad/')) body = VAD_LICENSE;
    else if (url.endsWith('/README.md')) body = VAD_CARD;
    else throw new Error(`Unexpected download ${url}`);
    return new Response(body);
  });
}
function compiler(commands: SanitizedCommand[]): SanitizedCommandRunner {
  return async (command) => {
    commands.push(command);
    if (command.command === 'tar' && command.args[0] !== '--version') {
      const destination = command.args[command.args.indexOf('-C') + 1];
      for (const file of ['LICENSE', 'COPYING.LGPLv2.1', 'LICENSE.md'])
        await writeFile(path.join(destination, file), 'source license');
    } else if (command.args[0] === '--build') {
      const bin = path.join(command.args[1], 'bin');
      await mkdir(bin, { recursive: true });
      await writeFile(path.join(bin, 'whisper-cli'), 'compiled recognizer');
    } else if (command.command === 'make' && command.args[0] === '-j4') {
      await writeFile(path.join(command.cwd, 'ffmpeg'), 'compiled decoder');
    }
    return { stdout: 'compiler identity', stderr: '' };
  };
}

describe('explicit pinned voice recipe', () => {
  it.each(['cmake', 'cc', 'c++', 'make', 'tar'])(
    'identifies missing %s before any download instead of blaming every prerequisite',
    async (tool) => {
      const fetch = fetchRecipe();
      await expect(
        installVoiceAssets(
          paths,
          {},
          {
            fetch,
            runCommand: async (command) => {
              if (command.command === tool)
                throw new GwsEaError('executable_not_found', 'missing', {
                  details: { program: tool, searched: ['/fixture/bin'] },
                });
              return { stdout: 'version', stderr: '' };
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 'voice_build_prerequisite',
        message: expect.stringContaining(tool),
        details: { program: tool, searched: ['/fixture/bin'], failure: 'missing' },
      });
      expect(fetch).not.toHaveBeenCalled();
      expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
    },
  );
  it('preserves an installed compiler failure instead of telling the operator it is missing', async () => {
    const fetch = fetchRecipe();
    await expect(
      installVoiceAssets(
        paths,
        {},
        {
          fetch,
          runCommand: async (command) => {
            if (command.command === 'cc')
              throw new GwsEaError('command_failed', 'compiler failed', {
                details: { program: 'cc', exitCode: 1, stderrTail: 'invalid active developer path' },
              });
            return { stdout: 'version', stderr: '' };
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'voice_build_prerequisite',
      message: expect.stringContaining('failed'),
      details: { failure: 'failed', exitCode: 1, stderrTail: 'invalid active developer path' },
    });
    expect(fetch).not.toHaveBeenCalled();
  });
  it('checks prerequisites before downloading and cleans its unpublished build on failure', async () => {
    const fetch = fetchRecipe();
    await expect(
      installVoiceAssets(
        paths,
        { model: 'base' },
        {
          fetch,
          runCommand: async () => {
            throw new Error('cmake unavailable');
          },
        },
      ),
    ).rejects.toMatchObject({ code: 'voice_build_prerequisite' });
    expect(fetch).not.toHaveBeenCalled();
    expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
  });
  it('refuses a checksum mismatch without publishing a partial artifact', async () => {
    const commands: SanitizedCommand[] = [];
    await expect(
      installVoiceAssets(
        paths,
        { model: 'base' },
        { fetch: async () => new Response('corrupt'), runCommand: compiler(commands) },
      ),
    ).rejects.toMatchObject({ code: 'voice_checksum_failed' });
    expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
    expect(commands.some((command) => command.command === 'tar' && command.args[0] !== '--version')).toBe(false);
  });
  it('installs base by default, records exact build/source provenance, and reuses it without downloads', async () => {
    const commands: SanitizedCommand[] = [];
    const fetch = fetchRecipe();
    const result = await installVoiceAssets(
      paths,
      { cmake: '/operator/tools/cmake' },
      { fetch, runCommand: compiler(commands) },
    );
    expect(result.installationDir).toBe(voiceInstallationDirectory(paths, 'base'));
    expect(result.ffmpeg).toBe(path.join(result.installationDir, 'bin/ffmpeg'));
    expect(result.receipt.artifacts.whisperCli.sha256).toBe(
      createHash('sha256').update('compiled recognizer').digest('hex'),
    );
    expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([path.basename(result.installationDir)]);
    expect(await readFile(path.join(result.installationDir, 'licenses/Whisper-model-MIT.txt'), 'utf8')).toBe(
      MODEL_LICENSE,
    );
    const build = JSON.parse(await readFile(path.join(result.installationDir, 'build.json'), 'utf8')) as {
      cmake: string[];
      ffmpeg: string[];
      sources: unknown;
    };
    expect(build.cmake).toContain('-DBUILD_SHARED_LIBS=OFF');
    expect(build.cmake).toContain(`-DGGML_METAL=${process.platform === 'darwin' ? 'ON' : 'OFF'}`);
    expect(build.ffmpeg).toContain('--disable-network');
    expect(build.ffmpeg).toContain('--enable-protocol=file');
    expect(build.sources).toEqual(VOICE_SOURCE_ARTIFACTS);
    const calls = vi.mocked(fetch).mock.calls.length;
    expect(
      await installVoiceAssets(
        paths,
        {},
        {
          fetch,
          runCommand: async () => {
            throw new Error('must not build');
          },
        },
      ),
    ).toEqual(result);
    expect(vi.mocked(fetch).mock.calls).toHaveLength(calls);
  });
  it('cleans a failed compile without leaving a selected or published installation', async () => {
    const commands: SanitizedCommand[] = [];
    const base = compiler(commands);
    await expect(
      installVoiceAssets(
        paths,
        { model: 'base' },
        {
          fetch: fetchRecipe(),
          runCommand: async (command) => {
            if (command.args[0] === '--build')
              throw new GwsEaError('command_failed', 'compiler failed', {
                details: { exitCode: 2, stderrTail: 'fatal compiler diagnostic' },
              });
            return base(command);
          },
        },
      ),
    ).rejects.toMatchObject({
      code: 'voice_build_failed',
      details: {
        stage: 'Building whisper.cpp',
        exitCode: 2,
        stderrTail: 'fatal compiler diagnostic',
        published: false,
      },
    });
    expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
    await expect(readFile(path.join(paths.configRoot, 'voice.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each(['network', 'http', 'stream'])(
    'names the source artifact on a %s download failure and cleans scratch',
    async (failure) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.error(new Error('socket closed'));
        },
      });
      await expect(
        installVoiceAssets(
          paths,
          {},
          {
            runCommand: compiler([]),
            fetch: async () => {
              if (failure === 'network') throw new TypeError('fetch failed');
              return failure === 'http' ? new Response(null, { status: 503 }) : new Response(body);
            },
          },
        ),
      ).rejects.toMatchObject({
        code: 'voice_download_failed',
        message: expect.stringContaining('whisper.tar.gz'),
        details: { artifact: 'whisper.tar.gz', published: false },
      });
      expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
    },
  );
  it.each([false, true])(
    'reports verification failure before/after publication (published=%s) without deleting published assets',
    async (published) => {
      const commands: SanitizedCommand[] = [];
      const verify = vi.mocked(verifyVoiceInstallation);
      if (published) {
        const original = verify.getMockImplementation()!;
        verify.mockImplementationOnce(original);
      }
      verify.mockRejectedValueOnce(new Error('receipt verification failed'));
      await expect(
        installVoiceAssets(paths, {}, { fetch: fetchRecipe(), runCommand: compiler(commands) }),
      ).rejects.toMatchObject({
        code: 'voice_install_failed',
        details: { published, stage: published ? 'Verifying published voice assets' : 'Verifying staged voice assets' },
      });
      expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual(
        published ? [path.basename(voiceInstallationDirectory(paths, 'base'))] : [],
      );
    },
  );
  it('rejects unsupported hosts before creating optional state', async () => {
    const fetch = fetchRecipe();
    await expect(installVoiceAssets(paths, {}, { platform: 'win32', fetch })).rejects.toMatchObject({
      code: 'voice_unsupported_host',
    });
    expect(fetch).not.toHaveBeenCalled();
    await expect(readdir(paths.stateRoot)).rejects.toMatchObject({ code: 'ENOENT' });
  });
  it.each([false, true])(
    'retains the primary outcome and owned scratch location if cleanup fails (published=%s)',
    async (published) => {
      vi.mocked(rm).mockRejectedValueOnce(Object.assign(new Error('cleanup denied'), { code: 'EACCES' }));
      await expect(
        installVoiceAssets(
          paths,
          {},
          {
            fetch: fetchRecipe(),
            runCommand: published
              ? compiler([])
              : async () => {
                  throw new GwsEaError('command_failed', 'primary failure');
                },
          },
        ),
      ).rejects.toMatchObject({
        code: published ? 'voice_cleanup_failed' : 'voice_build_prerequisite',
        details: { published, scratchDirectory: expect.stringContaining('/.build-') },
      });
      const directories = await readdir(path.join(paths.stateRoot, 'voice'));
      expect(directories.filter((name) => name.startsWith('.build-'))).toHaveLength(1);
      expect(directories.includes(path.basename(voiceInstallationDirectory(paths, 'base')))).toBe(published);
    },
  );
  it.each([
    ['FFmpeg', true],
    ['whisper.cpp', true],
    ['whisper.cpp', false],
  ] as const)(
    'retains safe %s configure diagnostics when present=%s before removing scratch',
    async (engine, available) => {
      const secret = 'fixture-configure-secret-92734';
      registerSecret(secret);
      const run = await startRunLog({ paths, command: 'capabilities install' });
      let log = '';
      const base = compiler([]);
      await expect(
        run.step('install voice', async (step) => {
          log = step.rawLog;
          return installVoiceAssets(
            paths,
            {},
            {
              fetch: fetchRecipe(),
              runCommand: async (command) => {
                if (engine === 'FFmpeg' ? command.command.endsWith('/configure') : command.args[0] === '-S') {
                  const diagnostic =
                    engine === 'FFmpeg'
                      ? path.join(command.cwd, 'ffbuild/config.log')
                      : path.join(command.args[3], 'CMakeFiles/CMakeConfigureLog.yaml');
                  if (available) {
                    await mkdir(path.dirname(diagnostic), { recursive: true });
                    await writeFile(diagnostic, `compiler probe failed; ${secret}`);
                  }
                  throw new GwsEaError('command_failed', 'C compiler test failed', {
                    details: { stderrTail: 'compiler probe failed' },
                  });
                }
                return base(command);
              },
            },
          );
        }),
      ).rejects.toMatchObject({
        code: 'voice_build_failed',
        message: expect.stringContaining('C compiler test failed'),
        details: { stage: `Configuring ${engine}` },
      });
      const retained = await readFile(log, 'utf8');
      expect(retained).toContain(available ? 'compiler probe failed' : 'Build diagnostic unavailable (ENOENT)');
      expect(retained).not.toContain(secret);
      expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
    },
  );

  it('drops the partial first diagnostic line before redaction at the byte limit', async () => {
    const secret = 'boundary-secret-92734';
    registerSecret(secret);
    const run = await startRunLog({ paths, command: 'capabilities install' });
    let log = '';
    const base = compiler([]);
    await expect(
      run.step('build', async (step) => {
        log = step.rawLog;
        return installVoiceAssets(
          paths,
          {},
          {
            fetch: fetchRecipe(),
            runCommand: async (command) => {
              if (command.command.endsWith('/configure')) {
                await mkdir(path.join(command.cwd, 'ffbuild'));
                await writeFile(
                  path.join(command.cwd, 'ffbuild/config.log'),
                  `${secret}${'x'.repeat(16350)}\nuseful complete line\n`,
                );
                throw new GwsEaError('command_failed', 'configure failed');
              }
              return base(command);
            },
          },
        );
      }),
    ).rejects.toMatchObject({ code: 'voice_build_failed' });
    const retained = await readFile(log, 'utf8');
    expect(retained).not.toContain('92734');
    expect(retained).toContain('useful complete line');
  });

  it('cleans scratch and preserves the build failure when the diagnostic sink fails', async () => {
    const run = await startRunLog({ paths, command: 'capabilities install' });
    const base = compiler([]);
    await expect(
      run.step('build', async (step) =>
        installVoiceAssets(
          paths,
          {},
          {
            fetch: fetchRecipe(),
            runCommand: async (command) => {
              if (command.command.endsWith('/configure')) {
                vi.spyOn(step, 'write').mockImplementation(() => {
                  throw Object.assign(new Error('disk full'), { code: 'ENOSPC' });
                });
                throw new GwsEaError('command_failed', 'original configure failure');
              }
              return base(command);
            },
          },
        ),
      ),
    ).rejects.toMatchObject({
      code: 'voice_build_failed',
      message: expect.stringContaining('original configure failure'),
    });
    expect(await readdir(path.join(paths.stateRoot, 'voice'))).toEqual([]);
  });
});
