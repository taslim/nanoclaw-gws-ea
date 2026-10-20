import fs from 'node:fs';
import { lstat, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { AnchoredDir } from '../../anchored-dir.js';

const readAt = promisify(fs.read);
const fstat = promisify(fs.fstat);
const close = promisify(fs.close);

export const MAX_VOICE_INPUT_BYTES = 64 * 1024 * 1024;

export class VoiceMediaError extends Error {
  constructor(
    readonly code: 'missing-audio' | 'unsafe-audio' | 'input-limit',
    cause?: unknown,
  ) {
    super(`Voice media ${code}`, cause === undefined ? undefined : { cause });
    this.name = 'VoiceMediaError';
  }
}

/** Only inline bytes or native adapter-owned files beneath this instance's root. */
export async function readOriginalAudio(
  attachment: Readonly<Record<string, unknown>>,
  attachmentRoot: string,
): Promise<Buffer> {
  if (typeof attachment.data === 'string') {
    if (attachment.data.length > Math.ceil(MAX_VOICE_INPUT_BYTES / 3) * 4) throw new VoiceMediaError('input-limit');
    const bytes = Buffer.from(attachment.data, 'base64');
    if (!bytes.length || bytes.toString('base64') !== attachment.data) throw new VoiceMediaError('missing-audio');
    if (bytes.length > MAX_VOICE_INPUT_BYTES) throw new VoiceMediaError('input-limit');
    return bytes;
  }
  if (
    typeof attachment.path !== 'string' ||
    !attachment.path ||
    /[\0\r\n]/.test(attachment.path) ||
    /^[a-z][a-z0-9+.-]*:/i.test(attachment.path)
  )
    throw new VoiceMediaError('missing-audio');
  const lexicalRoot = path.resolve(attachmentRoot);
  const rootInfo = await lstat(lexicalRoot);
  if (!rootInfo.isDirectory() || rootInfo.isSymbolicLink()) throw new VoiceMediaError('unsafe-audio');
  const relative = path.relative(lexicalRoot, path.resolve(attachment.path));
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) throw new VoiceMediaError('unsafe-audio');
  // Releases deliberately link data/ to their own physical state, so the
  // root's operator-owned ancestors are trusted; below it, each component is
  // opened through its parent and no link may redirect the host.
  const segments = relative.split(path.sep);
  const leaf = segments.pop()!;
  let fd: number;
  try {
    const directory = AnchoredDir.open(lexicalRoot, segments);
    if (!directory) throw new VoiceMediaError('missing-audio');
    try {
      fd = directory.openReadFd(leaf);
    } finally {
      directory.close();
    }
  } catch (error) {
    if (error instanceof VoiceMediaError) throw error;
    const code = error instanceof Error && 'code' in error ? error.code : undefined;
    if (code === 'ENOENT') throw new VoiceMediaError('missing-audio', error);
    throw new VoiceMediaError('unsafe-audio', error);
  }
  try {
    const info = await fstat(fd);
    if (typeof process.getuid === 'function' && info.uid !== process.getuid())
      throw new VoiceMediaError('unsafe-audio');
    if (info.size === 0) throw new VoiceMediaError('missing-audio');
    if (info.size > MAX_VOICE_INPUT_BYTES) throw new VoiceMediaError('input-limit');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await readAt(fd, bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new VoiceMediaError('missing-audio');
      offset += bytesRead;
    }
    if ((await fstat(fd)).size !== info.size) throw new VoiceMediaError('unsafe-audio');
    return bytes;
  } finally {
    await close(fd);
  }
}

/** Host-owned temporary files stay outside all container-writable session mounts. */
export async function withVoiceTemp<T>(root: string, use: (directory: string) => Promise<T>): Promise<T> {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const info = await lstat(root);
  if (
    !info.isDirectory() ||
    info.isSymbolicLink() ||
    (info.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
    (await realpath(root)) !== root
  ) {
    throw new VoiceMediaError('unsafe-audio');
  }
  const directory = await mkdtemp(path.join(root, 'note-'));
  try {
    return await use(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
