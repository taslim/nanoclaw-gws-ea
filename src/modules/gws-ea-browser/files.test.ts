import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const stagingRace = vi.hoisted(() => ({
  beforeLstat: undefined as ((file: import('node:fs').PathLike) => void) | undefined,
}));

// Keep real filesystem operations; rename Chrome's partial file at the exact syscall boundary.
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    async lstat(...args: Parameters<typeof actual.lstat>) {
      stagingRace.beforeLstat?.(args[0]);
      return actual.lstat(...args);
    },
  };
});

import { browserStagingBytes, stageBrowserUpload, handoffBrowserDownload } from './files.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-files-'));
});
afterEach(() => {
  stagingRace.beforeLstat = undefined;
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

it('refuses an upload that is a second name for a file elsewhere, or a FIFO, without blocking', async () => {
  const session = path.join(root, 'session');
  const staging = path.join(root, 'staging');
  const documents = path.join(session, 'documents');
  const outside = path.join(root, 'outside.txt');
  const upload = path.join(documents, 'report.txt');
  fs.mkdirSync(documents, { recursive: true });
  fs.writeFileSync(outside, 'outside private bytes');

  fs.linkSync(outside, upload);
  await expect(stageBrowserUpload(session, staging, 'documents/report.txt')).rejects.toThrow(
    'not a regular session file',
  );
  fs.unlinkSync(upload);

  execFileSync('mkfifo', [upload]);
  await expect(stageBrowserUpload(session, staging, 'documents/report.txt')).rejects.toThrow(
    'not a regular session file',
  );
});

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

it('compares every download byte on replay and replaces a target that is not the host original', async () => {
  const host = path.join(root, 'download');
  const inbox = path.join(root, 'session', 'inbox');
  fs.mkdirSync(path.dirname(inbox));
  const bytes = Buffer.alloc(200_003, 7);
  fs.writeFileSync(host, bytes);
  const result = await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin');
  fs.writeFileSync(host, bytes);
  expect(await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin')).toBe(result);
  expect(fs.existsSync(host)).toBe(false);
  // A target that is not the host original (a copy cut short, a change, a link) is replaced by it.
  bytes[bytes.length - 1] = 8;
  fs.writeFileSync(host, bytes);
  expect(await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin')).toBe(result);
  expect(fs.readFileSync(result)).toEqual(bytes);
  expect(fs.existsSync(host)).toBe(false);
  fs.writeFileSync(host, bytes);
  fs.unlinkSync(result);
  fs.symlinkSync('/etc/passwd', result);
  expect(await handoffBrowserDownload(host, inbox, 'browser-replay', 'invoice.bin')).toBe(result);
  expect(fs.lstatSync(result).isSymbolicLink()).toBe(false);
  expect(fs.readFileSync(result)).toEqual(bytes);
});

it("counts a download's staged bytes across Chrome's rename of its partial file, and refuses anything but files", async () => {
  const staging = path.join(root, 'download');
  fs.mkdirSync(staging);
  const guid = '76347a02-c21a-4763-839a-327c7e0cbb9e';
  fs.writeFileSync(path.join(staging, `${guid}.crdownload`), Buffer.alloc(120));
  // Chrome completes the download between the listing and the size read: the partial name is gone.
  stagingRace.beforeLstat = (file) => {
    if (String(file).endsWith('.crdownload')) {
      stagingRace.beforeLstat = undefined;
      fs.renameSync(path.join(staging, `${guid}.crdownload`), path.join(staging, guid));
    }
  };
  expect(await browserStagingBytes(staging)).toBe(0);
  expect(await browserStagingBytes(staging)).toBe(120);
  fs.symlinkSync('/etc/passwd', path.join(staging, 'link'));
  await expect(browserStagingBytes(staging)).rejects.toThrow('Unsafe download staging');
});
