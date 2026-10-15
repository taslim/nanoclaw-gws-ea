import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { stageBrowserUpload, handoffBrowserDownload } from './files.js';

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-files-'));
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

it('copies uploads before use and refuses traversal and symlinks', async () => {
  const session = path.join(root, 'session');
  const staging = path.join(root, 'staging');
  fs.mkdirSync(session);
  fs.writeFileSync(path.join(session, 'report.txt'), 'safe bytes');
  const copy = await stageBrowserUpload(session, staging, 'report.txt');
  fs.unlinkSync(path.join(session, 'report.txt'));
  fs.symlinkSync('/etc/passwd', path.join(session, 'report.txt'));
  expect(fs.readFileSync(copy.path, 'utf8')).toBe('safe bytes');
  await expect(stageBrowserUpload(session, staging, 'report.txt')).rejects.toThrow();
  await expect(stageBrowserUpload(session, staging, '../outside')).rejects.toThrow();
  await copy.remove();
  expect(fs.existsSync(copy.path)).toBe(false);
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
