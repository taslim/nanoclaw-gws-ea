/** The explicit operator recipe. Importing it never downloads or starts inference. */
import { createHash } from 'node:crypto';
import { chmod, copyFile, lstat, mkdir, mkdtemp, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
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

/** Initial quality candidate; real principal-note qualification remains the launch gate. */
export const DEFAULT_VOICE_MODEL: VoiceModelId = 'large-v3-turbo-q5_0';
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

async function download(
  fetch: typeof globalThis.fetch,
  url: string,
  destination: string,
  sha256: string,
  expectedSize?: number,
): Promise<void> {
  const response = await fetch(url, { signal: AbortSignal.timeout(30 * 60_000) });
  if (!response.ok || !response.body)
    throw new GwsEaError('voice_download_failed', `Voice download failed (${response.status}): ${url}`);
  const handle = await open(destination, 'wx', 0o600);
  const reader = response.body.getReader();
  const hash = createHash('sha256');
  let size = 0;
  try {
    for (;;) {
      const item = await reader.read();
      if (item.done) break;
      size += item.value.byteLength;
      if (size > (expectedSize ?? 256 * 1024 * 1024))
        throw new GwsEaError('voice_download_failed', 'Voice download exceeds its pinned size bound');
      hash.update(item.value);
      await handle.writeFile(item.value);
    }
    await handle.sync();
    if ((expectedSize !== undefined && size !== expectedSize) || hash.digest('hex') !== sha256) {
      throw new GwsEaError('voice_checksum_failed', `Voice download does not match its pinned checksum: ${url}`);
    }
  } finally {
    await reader.cancel();
    reader.releaseLock();
    await handle.close();
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
        { cause: error },
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
    run({ command, args, cwd, env: environment, timeoutMs: 30 * 60_000, outputLimitBytes: 2 * 1024 * 1024 });
  try {
    const cmake = request.cmake ?? 'cmake';
    if (request.cmake && !path.isAbsolute(request.cmake))
      throw new GwsEaError('invalid_arguments', '--cmake must be an absolute executable path');
    dependencies.progress?.('Checking CMake, C compiler, and make…');
    try {
      await invoke(cmake, ['--version']);
      await invoke('cc', ['--version']);
      await invoke('make', ['--version']);
    } catch (error) {
      throw new GwsEaError(
        'voice_build_prerequisite',
        'Voice installation needs CMake, a C compiler, and make. Install those tools, then retry gws-ea capabilities install voice (or pass --cmake /absolute/path).',
        { cause: error },
      );
    }
    await mkdir(path.join(publish, 'bin'), { recursive: true, mode: 0o700 });
    await mkdir(path.join(publish, 'models'), { mode: 0o700 });
    await mkdir(path.join(publish, 'licenses'), { mode: 0o700 });
    const fetch = dependencies.fetch ?? globalThis.fetch;
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
    await invoke('tar', ['-xzf', path.join(work, 'whisper.tar.gz'), '--strip-components=1', '-C', whisper]);
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
    await invoke(cmake, cmakeArgs);
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
    await invoke(path.join(ffmpeg, 'configure'), ffmpegArgs, ffmpeg);
    await invoke('make', ['-j4'], ffmpeg);
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
    await verifyVoiceInstallation(publish);
    await rename(publish, destination);
    return await verifyVoiceInstallation(destination);
  } finally {
    await rm(work, { recursive: true, force: true });
  }
}
