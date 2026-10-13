/** Immutable optional voice inputs; importing this module performs no installation. */
import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, realpath } from 'node:fs/promises';
import path from 'node:path';
import { isRecord } from './validation.js';

export const VOICE_POLICY_SCHEMA_VERSION = 1;
export const VOICE_RECIPE_ID = 'whisper.cpp-1.9.5-ffmpeg-8.1-vad-6.2.0';
const MODEL_REVISION = '5359861c739e955e79d9a303bcbc70fb988958b1';
export type VoiceModelId = 'base' | 'small' | 'large-v3-turbo-q5_0';

export const VOICE_MODEL_CATALOG = {
  base: {
    filename: 'ggml-base.bin',
    size: 147951465,
    sha256: '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe',
  },
  small: {
    filename: 'ggml-small.bin',
    size: 487601967,
    sha256: '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b',
  },
  'large-v3-turbo-q5_0': {
    filename: 'ggml-large-v3-turbo-q5_0.bin',
    size: 574041195,
    sha256: '394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2',
  },
} as const satisfies Record<VoiceModelId, { filename: string; size: number; sha256: string }>;

export function voiceModelUrl(model: VoiceModelId): string {
  return `https://huggingface.co/ggerganov/whisper.cpp/resolve/${MODEL_REVISION}/${VOICE_MODEL_CATALOG[model].filename}`;
}

export const VOICE_SOURCE_ARTIFACTS = {
  whisper: {
    url: 'https://codeload.github.com/ggml-org/whisper.cpp/tar.gz/refs/tags/v1.9.5',
    sha256: 'ff1a9053feb509ff9d7729703355541ae9690073a6b1c40eb692c962e0dc1720',
  },
  ffmpeg: {
    url: 'https://ffmpeg.org/releases/ffmpeg-8.1.tar.xz',
    sha256: 'b072aed6871998cce9b36e7774033105ca29e33632be5b6347f3206898e0756a',
  },
  vad: {
    url: 'https://huggingface.co/ggml-org/whisper-vad/resolve/9ffd54a1e1ee413ddf265af9913beaf518d1639b/ggml-silero-v6.2.0.bin',
    filename: 'ggml-silero-v6.2.0.bin',
    size: 885098,
    sha256: '2aa269b785eeb53a82983a20501ddf7c1d9c48e33ab63a41391ac6c9f7fb6987',
  },
} as const;

export interface VoiceHostPolicy {
  schemaVersion: 1;
  enabled: boolean;
  installationDir: string | null;
}

export interface VoiceArtifactReceipt {
  file: string;
  size: number;
  sha256: string;
}

export interface VoiceAssetReceipt {
  schemaVersion: 1;
  recipe: typeof VOICE_RECIPE_ID;
  platform: 'darwin' | 'linux';
  architecture: 'arm64' | 'x64';
  model: VoiceModelId;
  builtAt: string;
  artifacts: Record<'ffmpeg' | 'whisperCli' | 'model' | 'vad', VoiceArtifactReceipt>;
}

export interface VerifiedVoiceInstallation {
  installationDir: string;
  receipt: VoiceAssetReceipt;
  ffmpeg: string;
  whisperCli: string;
  model: string;
  vad: string;
}

export class VoiceAssetsError extends Error {
  constructor(
    readonly code: 'not-installed' | 'unsupported' | 'invalid-assets',
    message: string,
    cause?: unknown,
  ) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'VoiceAssetsError';
  }
}

function object(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new VoiceAssetsError('invalid-assets', 'Voice configuration must be an object');
  }
  return value;
}

export function parseVoiceHostPolicy(value: unknown): VoiceHostPolicy {
  const record = object(value);
  if (record.schemaVersion !== VOICE_POLICY_SCHEMA_VERSION) {
    throw new VoiceAssetsError('unsupported', 'This release does not support the selected voice policy');
  }
  if (
    typeof record.enabled !== 'boolean' ||
    !(
      record.installationDir === null ||
      (typeof record.installationDir === 'string' && path.isAbsolute(record.installationDir))
    ) ||
    (record.enabled && record.installationDir === null)
  ) {
    throw new VoiceAssetsError(
      'invalid-assets',
      'Voice policy needs enabled state and an absolute installation directory',
    );
  }
  return { schemaVersion: 1, enabled: record.enabled, installationDir: record.installationDir };
}

async function readJson(file: string): Promise<unknown> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size > 65536 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      throw new VoiceAssetsError('invalid-assets', 'Voice configuration is not a bounded owned regular file');
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function readVoiceHostPolicy(file: string): Promise<VoiceHostPolicy> {
  if (!path.isAbsolute(file)) throw new VoiceAssetsError('invalid-assets', 'Voice policy location must be absolute');
  return parseVoiceHostPolicy(await readJson(file));
}

function artifact(value: unknown, expectedFile: string): VoiceArtifactReceipt {
  const item = object(value);
  if (
    item.file !== expectedFile ||
    typeof item.size !== 'number' ||
    !Number.isSafeInteger(item.size) ||
    item.size < 1 ||
    item.size > 1024 * 1024 * 1024 ||
    typeof item.sha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(item.sha256)
  ) {
    throw new VoiceAssetsError('invalid-assets', `Invalid voice artifact receipt for ${expectedFile}`);
  }
  return { file: expectedFile, size: item.size, sha256: item.sha256 };
}

export function parseVoiceAssetReceipt(value: unknown): VoiceAssetReceipt {
  const item = object(value);
  if (item.schemaVersion !== 1 || item.recipe !== VOICE_RECIPE_ID) {
    throw new VoiceAssetsError('unsupported', 'This release does not support the installed voice artifacts');
  }
  if (
    (item.platform !== 'darwin' && item.platform !== 'linux') ||
    (item.architecture !== 'arm64' && item.architecture !== 'x64') ||
    (item.model !== 'base' && item.model !== 'small' && item.model !== 'large-v3-turbo-q5_0') ||
    typeof item.builtAt !== 'string' ||
    !/^\d{4}-\d\d-\d\dT.*Z$/.test(item.builtAt) ||
    !Number.isFinite(Date.parse(item.builtAt))
  ) {
    throw new VoiceAssetsError('invalid-assets', 'Invalid voice installation identity');
  }
  const files = object(item.artifacts);
  const model = VOICE_MODEL_CATALOG[item.model];
  const modelReceipt = artifact(files.model, `models/${model.filename}`);
  const vadReceipt = artifact(files.vad, `models/${VOICE_SOURCE_ARTIFACTS.vad.filename}`);
  if (
    modelReceipt.size !== model.size ||
    modelReceipt.sha256 !== model.sha256 ||
    vadReceipt.size !== VOICE_SOURCE_ARTIFACTS.vad.size ||
    vadReceipt.sha256 !== VOICE_SOURCE_ARTIFACTS.vad.sha256
  ) {
    throw new VoiceAssetsError('invalid-assets', 'Voice model receipt differs from the pinned catalog');
  }
  return {
    schemaVersion: 1,
    recipe: VOICE_RECIPE_ID,
    platform: item.platform,
    architecture: item.architecture,
    model: item.model,
    builtAt: item.builtAt,
    artifacts: {
      ffmpeg: artifact(files.ffmpeg, 'bin/ffmpeg'),
      whisperCli: artifact(files.whisperCli, 'bin/whisper-cli'),
      model: modelReceipt,
      vad: vadReceipt,
    },
  };
}

// Cache only verified immutable file identities; metadata changes require a fresh hash.
const verified = new Map<string, string>();

async function verifyArtifact(root: string, receipt: VoiceArtifactReceipt, executable: boolean): Promise<string> {
  const file = path.join(root, receipt.file);
  for (const component of [path.dirname(file), file]) {
    const info = await lstat(component);
    if (info.isSymbolicLink())
      throw new VoiceAssetsError('invalid-assets', 'Voice artifacts must not be symbolic links');
  }
  if ((await realpath(file)) !== file)
    throw new VoiceAssetsError('invalid-assets', 'Voice artifact location is not canonical');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (
      !info.isFile() ||
      info.size !== receipt.size ||
      (info.mode & 0o022) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (executable && (info.mode & 0o111) === 0)
    ) {
      throw new VoiceAssetsError('invalid-assets', 'Voice artifact size, ownership, or permissions are invalid');
    }
    const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}:${receipt.sha256}`;
    if (verified.get(file) !== fingerprint) {
      const hash = createHash('sha256');
      for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
      if (hash.digest('hex') !== receipt.sha256)
        throw new VoiceAssetsError('invalid-assets', 'Voice artifact checksum differs');
      verified.set(file, fingerprint);
    }
    return file;
  } finally {
    await handle.close();
  }
}

/** Resolve verified, explicitly installed assets. Never downloads or repairs anything. */
export async function verifyVoiceInstallation(installationDir: string): Promise<VerifiedVoiceInstallation> {
  if (!path.isAbsolute(installationDir))
    throw new VoiceAssetsError('invalid-assets', 'Voice installation must be absolute');
  const info = await lstat(installationDir);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(installationDir)) !== installationDir
  ) {
    throw new VoiceAssetsError('invalid-assets', 'Voice installation must be a physical canonical owned directory');
  }
  const receipt = parseVoiceAssetReceipt(await readJson(path.join(installationDir, 'receipt.json')));
  if (receipt.platform !== process.platform || receipt.architecture !== process.arch) {
    throw new VoiceAssetsError('unsupported', 'Installed voice artifacts target a different host');
  }
  const checks = await Promise.allSettled([
    verifyArtifact(installationDir, receipt.artifacts.ffmpeg, true),
    verifyArtifact(installationDir, receipt.artifacts.whisperCli, true),
    verifyArtifact(installationDir, receipt.artifacts.model, false),
    verifyArtifact(installationDir, receipt.artifacts.vad, false),
  ]);
  const paths: string[] = [];
  for (const check of checks) {
    if (check.status === 'rejected') throw check.reason;
    paths.push(check.value);
  }
  const [ffmpeg, whisperCli, model, vad] = paths;
  return { installationDir, receipt, ffmpeg, whisperCli, model, vad };
}
