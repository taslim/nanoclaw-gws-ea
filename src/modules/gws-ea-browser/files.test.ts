import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const uploadRace = vi.hoisted(() => ({
  beforeOpen: undefined as ((file: import('node:fs').PathLike) => void) | undefined,
  afterLstat: undefined as ((file: import('node:fs').PathLike) => void) | undefined,
}));

// Keep real filesystem operations; move the attacker's directory at the exact syscall boundary.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async open(...args: Parameters<typeof actual.open>) {
      uploadRace.beforeOpen?.(args[0]);
      return actual.open(...args);
    },
    async lstat(...args: Parameters<typeof actual.lstat>) {
      const stat = await actual.lstat(...args);
      uploadRace.afterLstat?.(args[0]);
      return stat;
    },
  };
});

import { stageBrowserUpload, handoffBrowserDownload } from './files.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-files-'));
});
afterEach(() => {
  uploadRace.beforeOpen = undefined;
  uploadRace.afterLstat = undefined;
  fs.rmSync(root, { recursive: true, force: true });
});

it('copies uploads before use and refuses traversal and symlinks', async () => {
  const session = path.join(root, 'session');
  const staging = path.join(root, 'staging');
  const documents = path.join(session, 'documents');
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(path.join(documents, 'report.txt'), 'safe bytes');
  const copy = await stageBrowserUpload(session, staging, 'documents/report.txt');
  fs.unlinkSync(path.join(documents, 'report.txt'));
  fs.symlinkSync('/etc/passwd', path.join(documents, 'report.txt'));
  expect(fs.readFileSync(copy.path, 'utf8')).toBe('safe bytes');
  await expect(stageBrowserUpload(session, staging, 'documents/report.txt')).rejects.toThrow();
  fs.rmSync(documents, { recursive: true });
  fs.symlinkSync(root, documents);
  await expect(stageBrowserUpload(session, staging, 'documents/report.txt')).rejects.toThrow();
  await expect(stageBrowserUpload(session, staging, '../outside')).rejects.toThrow();
  await copy.remove();
  expect(fs.existsSync(copy.path)).toBe(false);
});

it.each(['file', 'directory'] as const)(
  'never stages outside bytes when a %s is swapped and then restored',
  async (kind) => {
    const session = path.join(root, 'session');
    const nested = path.join(session, 'documents');
    const saved = path.join(session, 'original');
    const outside = path.join(root, 'outside');
    fs.mkdirSync(nested, { recursive: true });
    fs.mkdirSync(outside);
    fs.writeFileSync(path.join(nested, 'report.txt'), 'session-owned bytes');
    fs.writeFileSync(path.join(outside, 'report.txt'), 'outside private bytes');
    const source = fs.realpathSync(path.join(nested, 'report.txt'));
    const swappedPath = kind === 'file' ? path.join(nested, 'report.txt') : nested;
    const symlinkTarget = kind === 'file' ? path.join(outside, 'report.txt') : outside;
    let swapped = false;
    let attacked = false;
    function restore() {
      if (!swapped) return;
      fs.unlinkSync(swappedPath);
      fs.renameSync(saved, swappedPath);
      swapped = false;
    }
    uploadRace.beforeOpen = (file) => {
      if (attacked || (file !== source && !/^\/proc\/self\/fd\/\d+\/report\.txt$/u.test(String(file)))) return;
      fs.renameSync(swappedPath, saved);
      fs.symlinkSync(symlinkTarget, swappedPath);
      swapped = true;
      attacked = true;
    };
    // The vulnerable implementation validates the outside inode, then sees the safe path again.
    uploadRace.afterLstat = (file) => {
      if (attacked && file === source) restore();
    };
    const result = await stageBrowserUpload(session, path.join(root, 'staging'), 'documents/report.txt').then(
      (upload) => ({ upload }),
      (error: unknown) => ({ error }),
    );
    try {
      expect(attacked).toBe(true);
      if ('upload' in result) expect(fs.readFileSync(result.upload.path, 'utf8')).toBe('session-owned bytes');
      else expect(result.error).toBeInstanceOf(Error);
    } finally {
      restore();
      if ('upload' in result) await result.upload.remove();
    }
  },
);

it('retains the only host download on failed handoff, then hands off once durably', async () => {
  const host = path.join(root, 'download');
  fs.writeFileSync(host, 'invoice');
  const inbox = path.join(root, 'session', 'inbox');
  fs.mkdirSync(path.dirname(inbox));
  fs.symlinkSync(root, inbox);
  await expect(handoffBrowserDownload(host, inbox, 'browser-safe', 'invoice.txt')).rejects.toThrow();
  expect(fs.readFileSync(host, 'utf8')).toBe('invoice');
  fs.unlinkSync(inbox);
  const result = await handoffBrowserDownload(host, inbox, 'browser-safe', 'invoice.txt');
  expect(fs.readFileSync(result, 'utf8')).toBe('invoice');
  expect(fs.existsSync(host)).toBe(false);
  expect(await handoffBrowserDownload(host, inbox, 'browser-safe', 'invoice.txt')).toBe(result);
  expect(fs.statSync(result).mode & 0o777).toBe(0o600);
});

it('compares every download byte on replay and retains a changed host original', async () => {
  const host = path.join(root, 'download');
  const inbox = path.join(root, 'session', 'inbox');
  fs.mkdirSync(path.dirname(inbox));
  const bytes = Buffer.alloc(200_003, 7);
  fs.writeFileSync(host, bytes);
  const result = await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin');
  fs.writeFileSync(host, bytes);
  expect(await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin')).toBe(result);
  expect(fs.existsSync(host)).toBe(false);
  bytes[bytes.length - 1] = 8;
  fs.writeFileSync(host, bytes);
  await expect(handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin')).rejects.toThrow(
    'incomplete or changed',
  );
  expect(fs.readFileSync(host)).toEqual(bytes);
  expect(fs.readFileSync(result).at(-1)).toBe(7);
});
