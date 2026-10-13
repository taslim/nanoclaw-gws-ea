import { constants } from 'node:fs';
import { lstat, mkdir, mkdtemp, open, realpath, rm } from 'node:fs/promises';
import path from 'node:path';
import { isPathInside } from '../../inbox-safety.js';

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
  // Releases deliberately link data/ to their own physical state. Trust that
  // operator-owned ancestor while refusing links at/below the adapter root.
  const root = await realpath(lexicalRoot);
  const supplied = path.resolve(attachment.path);
  const file = isPathInside(lexicalRoot, supplied) ? path.join(root, path.relative(lexicalRoot, supplied)) : supplied;
  if (!isPathInside(root, file) || file === root) throw new VoiceMediaError('unsafe-audio');
  // Lexical and physical containment; no component may redirect the host.
  let current = root;
  const components = path.relative(root, file).split(path.sep);
  const chain = ['', ...components];
  for (let index = 0; index < chain.length; index++) {
    const component = chain[index];
    current = component ? path.join(current, component) : current;
    const info = await lstat(current);
    if (info.isSymbolicLink() || (index === chain.length - 1 ? !info.isFile() : !info.isDirectory())) {
      throw new VoiceMediaError('unsafe-audio');
    }
  }
  if ((await realpath(file)) !== file || (await realpath(root)) !== root) throw new VoiceMediaError('unsafe-audio');
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || (typeof process.getuid === 'function' && info.uid !== process.getuid()))
      throw new VoiceMediaError('unsafe-audio');
    if (info.size === 0) throw new VoiceMediaError('missing-audio');
    if (info.size > MAX_VOICE_INPUT_BYTES) throw new VoiceMediaError('input-limit');
    const bytes = Buffer.alloc(info.size);
    let offset = 0;
    while (offset < bytes.length) {
      const read = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (read.bytesRead === 0) throw new VoiceMediaError('missing-audio');
      offset += read.bytesRead;
    }
    if ((await handle.stat()).size !== info.size) throw new VoiceMediaError('unsafe-audio');
    return bytes;
  } finally {
    await handle.close();
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
