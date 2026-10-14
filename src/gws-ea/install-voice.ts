/** The explicit operator recipe. Importing it never downloads or starts inference. */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { errorCode, isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import {
  buildToolEnvironment,
  resolveExecutable,
  runSanitizedCommand,
  type SanitizedCommandRunner,
} from './process.js';
import { GwsEaError } from './types.js';
import { activeStep } from './run-log.js';
import {
  VOICE_MODEL_CATALOG,
  VOICE_RECIPE_ID,
  VOICE_SOURCE_ARTIFACTS,
  verifyVoiceInstallation,
  voiceModelUrl,
  type VoiceArtifactReceipt,
  type VoiceAssetReceipt,
  type VoiceModelId,
  type VerifiedVoiceInstallation,
} from './voice-assets.js';

/** Default for explicit installation; real principal-note qualification remains a launch gate. */
export const DEFAULT_VOICE_MODEL: VoiceModelId = 'base';
const LICENSE_INPUTS = [
  {
    file: 'Whisper-model-MIT.txt',
    url: 'https://raw.githubusercontent.com/openai/whisper/v20250625/LICENSE',
    sha256: 'b5d65a59060e68c4ff940e1eddfa6f94b2d68fdf58ed7f4dd57721c997e35e9d',
  },
  {
    file: 'Silero-MIT.txt',
    url: 'https://raw.githubusercontent.com/snakers4/silero-vad/1e261b036686cd0017d500ee96acd1c4ba572a9d/LICENSE',
    sha256: '2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b',
  },
  {
    file: 'converted-VAD-model-card.md',
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/README.md',
    sha256: '6c1077880c654e84e103c34d2f7560e058ee62fecd2bc868db0249641c5d247e',
  },
] as const;
export interface VoiceInstallRequest {
  readonly model?: VoiceModelId;
  readonly cmake?: string;
}
export interface VoiceInstallDependencies {
  readonly fetch?: typeof globalThis.fetch;
  readonly runCommand?: SanitizedCommandRunner;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  readonly progress?: (line: string) => void;
}

export function voiceInstallationDirectory(
  paths: Pick<ControlPlanePaths, 'stateRoot'>,
  model: VoiceModelId,
  platform: string = process.platform,
  architecture: string = process.arch,
): string {
  return path.join(paths.stateRoot, 'voice', `${VOICE_RECIPE_ID}-${platform}-${architecture}-${model}`);
}

async function prerequisiteRepair(
  tool: string,
  explicitCmake: boolean,
  platform: NodeJS.Platform,
  searchPath: string | undefined,
): Promise<string> {
  if (explicitCmake)
    return `Correct --cmake: ${tool} must be an executable CMake binary, or omit --cmake to use CMake on PATH.`;
  if (platform === 'darwin') {
    if (tool !== 'cmake')
      return 'Install or repair Apple Command Line Tools: xcode-select --install. If already installed, inspect xcode-select -p and the developer-path error below.';
    try {
      await resolveExecutable('brew', searchPath);
      return 'Install CMake: brew install cmake. Alternatively supply --cmake /absolute/path/to/cmake.';
    } catch (error) {
      if (!(error instanceof GwsEaError) || error.code !== 'executable_not_found') throw error;
      return 'Install CMake from https://cmake.org/download/ and put it on PATH, or supply --cmake /absolute/path/to/cmake.';
    }
  }
  const packages = tool === 'cmake' ? 'cmake' : tool === 'tar' ? 'tar xz-utils' : 'build-essential';
  return `Install or repair ${tool} with your distribution's package manager. On Debian/Ubuntu: sudo apt-get install ${packages}. Check PATH before retrying.`;
}

async function digest(file: string): Promise<VoiceArtifactReceipt> {
  const handle = await open(file, 'r');
  try {
    const info = await handle.stat();
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return { file: '', size: info.size, sha256: hash.digest('hex') };
  } finally {
    await handle.close();
  }
}

async function retainBuildDiagnostic(file: string): Promise<void> {
  const step = activeStep();
  if (!step) return;
  try {
    const handle = await open(file, 'r');
    try {
      const size = (await handle.stat()).size;
      const tail = Buffer.alloc(Math.min(size, 16 * 1024));
      const offset = Math.max(0, size - tail.length);
      const { bytesRead } = await handle.read(tail, 0, tail.length, offset);
      const text = tail.subarray(0, bytesRead).toString('utf8');
      // A cut credential is no longer recognizable by the redactor. Keep complete lines only.
      const firstNewline = text.indexOf('\n');
      const excerpt = offset === 0 ? text : firstNewline < 0 ? '' : text.slice(firstNewline + 1);
      step.write(`\n${file} (bounded diagnostic excerpt):\n${excerpt}\n`);
    } finally {
      await handle.close();
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- Optional diagnostic collection must preserve the original build failure.
  } catch (error) {
    // Diagnostic collection must not replace the failed build.
    try {
      step.write(`Build diagnostic unavailable (${errorCode(error)}): ${file}\n`);
      // eslint-disable-next-line no-catch-all/no-catch-all -- A broken diagnostic sink must not replace the original build failure.
    } catch {
      /* Preserve the build failure and continue scratch cleanup. */
    }
  }
}

async function download(
  fetch: typeof globalThis.fetch,
  url: string,
  destination: string,
  sha256: string,
  expectedSize?: number,
): Promise<void> {
  const artifact = path.basename(destination);
  try {
    activeStep()?.write(`Downloading ${artifact}: ${url}\n`);
    const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
    if (!response.ok || !response.body) {
      await response.body
        ?.cancel()
        .catch((error: unknown) => activeStep()?.write(`Response cleanup failed: ${String(error)}\n`));
      throw new GwsEaError('voice_download_failed', `HTTP ${response.status} or missing response body`, {
        details: { httpStatus: response.status },
      });
    }
    const reader = response.body.getReader();
    let handle: Awaited<ReturnType<typeof open>> | undefined;
    let failed = false;
    let failure: unknown;
    try {
      handle = await open(destination, 'wx', 0o600);
      const hash = createHash('sha256');
      let size = 0;
      for (;;) {
        const item = await reader.read();
        if (item.done) break;
        size += item.value.byteLength;
        if (size > (expectedSize ?? 256 * 1024 * 1024))
          throw new GwsEaError('voice_download_failed', 'Download exceeds its pinned size bound');
        hash.update(item.value);
        await handle.writeFile(item.value);
      }
      await handle.sync();
      if ((expectedSize !== undefined && size !== expectedSize) || hash.digest('hex') !== sha256)
        throw new GwsEaError('voice_checksum_failed', 'Download does not match its pinned size/checksum');
      // eslint-disable-next-line no-catch-all/no-catch-all -- Save the primary error until independent resource cleanup completes.
    } catch (error) {
      failed = true;
      failure = error;
    }
    // An errored stream may reject cancel; it must not hide the download error or leak the file handle.
    const cleanup = await Promise.allSettled([reader.cancel(), ...(handle ? [handle.close()] : [])]);
    reader.releaseLock();
    for (const result of cleanup)
      if (result.status === 'rejected') {
        if (!failed) {
          failed = true;
          failure = result.reason;
        } else activeStep()?.write(`Download cleanup failed: ${String(result.reason)}\n`);
      }
    if (failed) throw failure;
  } catch (error) {
    activeStep()?.write(`Download failed: ${String(error)}\n`);
    throw new GwsEaError(
      error instanceof GwsEaError ? error.code : 'voice_download_failed',
      `Download of ${artifact} failed${error instanceof GwsEaError ? `: ${error.message}` : ''}. Check network/proxy access and available disk space, then retry; checksum verification stays required.`,
      { cause: error, details: { ...(error instanceof GwsEaError ? error.details : {}), artifact, url } },
    );
  }
}

/** Called under the dedicated host voice lock. Publishes only a fully verified immutable directory. */
export async function installVoiceAssets(
  paths: ControlPlanePaths,
  request: VoiceInstallRequest = {},
  dependencies: VoiceInstallDependencies = {},
): Promise<VerifiedVoiceInstallation> {
  const platform = dependencies.platform ?? process.platform;
  const architecture = dependencies.architecture ?? process.arch;
  if ((platform !== 'darwin' && platform !== 'linux') || (architecture !== 'arm64' && architecture !== 'x64')) {
    throw new GwsEaError(
      'voice_unsupported_host',
      'Local voice installation supports macOS/Linux on arm64/x64; text service remains available.',
    );
  }
  const model = request.model ?? DEFAULT_VOICE_MODEL;
  const destination = voiceInstallationDirectory(paths, model, platform, architecture);
  try {
    await lstat(destination);
    try {
      return await verifyVoiceInstallation(destination);
    } catch (error) {
      throw new GwsEaError(
        'voice_assets_invalid',
        'Existing voice assets are invalid. Disable voice, run gws-ea capabilities uninstall voice, then gws-ea capabilities install voice.',
        { cause: error, details: { model } },
      );
    }
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await preparePrivateDirectory(path.dirname(destination));
  const work = await mkdtemp(path.join(path.dirname(destination), '.build-'));
  const publish = path.join(work, 'installation');
  const run = dependencies.runCommand ?? runSanitizedCommand;
  const environment = buildToolEnvironment(dependencies.environment ?? process.env);
  const invoke = (command: string, args: readonly string[], cwd = work) =>
    run({
      command,
      args,
      cwd,
      env: environment,
      timeoutMs: 30 * 60_000,
      outputLimitBytes: 2 * 1024 * 1024,
      ...(args[0] === '--version' ? {} : { stream: true }),
    });
  let stage = 'Checking voice prerequisites';
  let published = false;
  let failure: GwsEaError | undefined;
  let installation: VerifiedVoiceInstallation | undefined;
  try {
    const cmake = request.cmake ?? 'cmake';
    if (request.cmake && !path.isAbsolute(request.cmake))
      throw new GwsEaError('invalid_arguments', '--cmake must be an absolute executable path');
    dependencies.progress?.('Checking CMake, C/C++ compilers, make, and tar…');
    for (const [tool, label] of [
      [cmake, 'CMake'],
      ['cc', 'C compiler'],
      ['c++', 'C++ compiler'],
      ['make', 'make'],
      ['tar', 'tar'],
    ] as const) {
      try {
        await invoke(tool, ['--version']);
      } catch (error) {
        const missing = error instanceof GwsEaError && error.code === 'executable_not_found';
        const instruction = await prerequisiteRepair(tool, tool === request.cmake, platform, environment.PATH);
        throw new GwsEaError(
          'voice_build_prerequisite',
          `${missing ? 'Missing' : 'Preflight failed for'} ${label} (${tool})${missing ? ': executable unavailable' : ': --version failed'}. ${instruction}`,
          {
            cause: error,
            details: {
              ...(error instanceof GwsEaError ? error.details : {}),
              program: tool,
              failure: missing ? 'missing' : 'failed',
              instruction,
            },
          },
        );
      }
    }
    await mkdir(path.join(publish, 'bin'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(publish, 'models'), { mode: 0o700 });
    await mkdir(path.join(publish, 'licenses'), { mode: 0o700 });
    const fetch = dependencies.fetch ?? globalThis.fetch;
    stage = 'Downloading pinned voice inputs';
    dependencies.progress?.('Downloading and verifying pinned voice sources, model, and VAD…');
    const modelPin = VOICE_MODEL_CATALOG[model];
    // Sequential downloads keep bounded memory and leave one owned scratch tree on failure.
    await download(
      fetch,
      VOICE_SOURCE_ARTIFACTS.whisper.url,
      path.join(work, 'whisper.tar.gz'),
      VOICE_SOURCE_ARTIFACTS.whisper.sha256,
    );
    await download(
      fetch,
      VOICE_SOURCE_ARTIFACTS.ffmpeg.url,
      path.join(work, 'ffmpeg.tar.xz'),
      VOICE_SOURCE_ARTIFACTS.ffmpeg.sha256,
    );
    await download(
      fetch,
      voiceModelUrl(model),
      path.join(publish, 'models', modelPin.filename),
      modelPin.sha256,
      modelPin.size,
    );
    await download(
      fetch,
      VOICE_SOURCE_ARTIFACTS.vad.url,
      path.join(publish, 'models', VOICE_SOURCE_ARTIFACTS.vad.filename),
      VOICE_SOURCE_ARTIFACTS.vad.sha256,
      VOICE_SOURCE_ARTIFACTS.vad.size,
    );
    const whisper = path.join(work, 'whisper');
    const ffmpeg = path.join(work, 'ffmpeg');
    await mkdir(whisper, { mode: 0o700 });
    await mkdir(ffmpeg, { mode: 0o700 });
    stage = 'Extracting whisper.cpp';
    await invoke('tar', ['-xzf', path.join(work, 'whisper.tar.gz'), '--strip-components=1', '-C', whisper]);
    stage = 'Extracting FFmpeg';
    await invoke('tar', ['-xJf', path.join(work, 'ffmpeg.tar.xz'), '--strip-components=1', '-C', ffmpeg]);
    dependencies.progress?.('Building the service-usable local recognizer and file decoder…');
    const whisperBuild = path.join(work, 'whisper-build');
    const cmakeArgs = [
      '-S',
      whisper,
      '-B',
      whisperBuild,
      '-DCMAKE_BUILD_TYPE=Release',
      '-DBUILD_SHARED_LIBS=OFF',
      '-DWHISPER_BUILD_TESTS=OFF',
      '-DGGML_BLAS=OFF',
      `-DGGML_METAL=${platform === 'darwin' ? 'ON' : 'OFF'}`,
      ...(platform === 'darwin' ? ['-DGGML_METAL_EMBED_LIBRARY=ON'] : []),
    ];
    stage = 'Configuring whisper.cpp';
    await invoke(cmake, cmakeArgs);
    stage = 'Building whisper.cpp';
    await invoke(cmake, ['--build', whisperBuild, '--config', 'Release', '--target', 'whisper-cli', '-j', '4']);
    const ffmpegArgs = [
      '--disable-shared',
      '--enable-static',
      '--disable-everything',
      '--disable-autodetect',
      '--disable-doc',
      '--disable-debug',
      '--disable-ffplay',
      '--disable-ffprobe',
      '--disable-network',
      '--enable-ffmpeg',
      '--enable-protocol=file',
      '--enable-demuxer=ogg,mp3,mov,wav,flac,aac,matroska',
      '--enable-decoder=opus,vorbis,mp3,aac,flac,pcm_s16le,pcm_s24le,pcm_s32le,pcm_f32le',
      '--enable-encoder=pcm_s16le',
      '--enable-muxer=wav',
      '--enable-filter=aresample,aformat,anull',
      '--disable-asm',
    ];
    stage = 'Configuring FFmpeg';
    await invoke(path.join(ffmpeg, 'configure'), ffmpegArgs, ffmpeg);
    stage = 'Building FFmpeg';
    await invoke('make', ['-j4'], ffmpeg);
    stage = 'Staging voice programs and licenses';
    await copyFile(path.join(whisperBuild, 'bin', 'whisper-cli'), path.join(publish, 'bin', 'whisper-cli'));
    await copyFile(path.join(ffmpeg, 'ffmpeg'), path.join(publish, 'bin', 'ffmpeg'));
    for (const file of ['bin/ffmpeg', 'bin/whisper-cli']) await chmod(path.join(publish, file), 0o500);
    await copyFile(path.join(whisper, 'LICENSE'), path.join(publish, 'licenses', 'whisper-MIT.txt'));
    await copyFile(path.join(ffmpeg, 'COPYING.LGPLv2.1'), path.join(publish, 'licenses', 'FFmpeg-LGPLv2.1.txt'));
    await copyFile(path.join(ffmpeg, 'LICENSE.md'), path.join(publish, 'licenses', 'FFmpeg-LICENSE.md'));
    for (const license of LICENSE_INPUTS)
      await download(fetch, license.url, path.join(publish, 'licenses', license.file), license.sha256);
    const artifacts = {
      ffmpeg: { ...(await digest(path.join(publish, 'bin/ffmpeg'))), file: 'bin/ffmpeg' },
      whisperCli: { ...(await digest(path.join(publish, 'bin/whisper-cli'))), file: 'bin/whisper-cli' },
      model: { file: `models/${modelPin.filename}`, size: modelPin.size, sha256: modelPin.sha256 },
      vad: {
        file: `models/${VOICE_SOURCE_ARTIFACTS.vad.filename}`,
        size: VOICE_SOURCE_ARTIFACTS.vad.size,
        sha256: VOICE_SOURCE_ARTIFACTS.vad.sha256,
      },
    };
    const receipt: VoiceAssetReceipt = {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      platform,
      architecture,
      model,
      builtAt: new Date().toISOString(),
      artifacts,
    };
    stage = 'Recording voice build provenance';
    await writePrivate(path.join(publish, 'receipt.json'), receipt);
    await writePrivate(path.join(publish, 'build.json'), {
      schemaVersion: 1,
      recipe: VOICE_RECIPE_ID,
      sources: VOICE_SOURCE_ARTIFACTS,
      model: { ...modelPin, url: voiceModelUrl(model) },
      licenses: LICENSE_INPUTS,
      cmake: cmakeArgs,
      ffmpeg: ffmpegArgs,
      compiler: (await invoke('cc', ['--version'])).stdout.trim(),
    });
    stage = 'Verifying staged voice assets';
    await verifyVoiceInstallation(publish);
    stage = 'Publishing voice assets';
    await rename(publish, destination);
    published = true;
    stage = 'Verifying published voice assets';
    installation = await verifyVoiceInstallation(destination);
    // eslint-disable-next-line no-catch-all/no-catch-all -- The installer attributes every build-stage error, then cleans only its owned scratch tree.
  } catch (error) {
    if (stage === 'Configuring FFmpeg') await retainBuildDiagnostic(path.join(work, 'ffmpeg', 'ffbuild', 'config.log'));
    if (stage === 'Configuring whisper.cpp')
      await retainBuildDiagnostic(path.join(work, 'whisper-build', 'CMakeFiles', 'CMakeConfigureLog.yaml'));
    const code = error instanceof GwsEaError ? error.code : 'voice_install_failed';
    failure = new GwsEaError(
      code === 'command_failed' || code === 'command_timeout' ? 'voice_build_failed' : code,
      `${stage} failed${error instanceof GwsEaError ? `: ${error.message}` : ` (${errorCode(error)})`}`,
      {
        cause: error,
        details: {
          ...(error instanceof GwsEaError ? error.details : { reasonCode: errorCode(error) }),
          stage,
          published,
          installationDir: destination,
          model,
        },
      },
    );
    try {
      activeStep()?.write(`${stage} failed: ${String(error)}\n`);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Cleanup remains mandatory when logging itself fails.
    } catch {
      /* The managed failure already retains the stage and cause. */
    }
  }
  try {
    await rm(work, { recursive: true, force: true });
    // eslint-disable-next-line no-catch-all/no-catch-all -- A cleanup failure augments the primary failure or reports retained published assets.
  } catch (error) {
    failure = new GwsEaError(
      failure?.code ?? 'voice_cleanup_failed',
      `${failure?.message ?? 'Voice assets were published.'} Scratch cleanup failed; inspect ${work} before retrying.`,
      {
        cause: failure ?? error,
        details: {
          ...failure?.details,
          scratchDirectory: work,
          published,
          installationDir: destination,
        },
      },
    );
  }
  if (failure) throw failure;
  if (!installation) throw new GwsEaError('voice_install_failed', 'Voice installation produced no verified result.');
  return installation;
}
