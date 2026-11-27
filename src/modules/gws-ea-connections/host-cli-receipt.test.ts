import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { catalogEntry } from './catalog.js';
import {
  HOST_CLI_RECEIPT_FILE,
  HostCliInstallError,
  recordHostCliReceipt,
  verifyHostCliReceipt,
} from './host-cli-receipt.js';
import { isHostCliEntry, type HostCliEntry } from './host-process.js';

function linkEntry(): HostCliEntry {
  const entry = catalogEntry('link');
  if (!entry || !isHostCliEntry(entry)) throw new Error('Link must be a host-run catalog entry');
  return entry;
}

// Receipts accept only canonical paths, and the temporary directory may sit behind a link.
let base: string;
let installDir: string;
let entryFile: string;
let receiptFile: string;

/** A package laid out the way a frozen-lockfile install lays out the pinned CLI, with its receipt recorded. */
async function install(): Promise<void> {
  const packageDir = path.join(installDir, 'node_modules', '@stripe', 'link-cli');
  fs.mkdirSync(path.join(packageDir, 'dist'), { recursive: true, mode: 0o755 });
  fs.chmodSync(installDir, 0o755);
  fs.writeFileSync(
    path.join(packageDir, 'package.json'),
    JSON.stringify({ name: '@stripe/link-cli', version: '1.6.0', type: 'module', bin: { 'link-cli': 'dist/cli.js' } }),
  );
  entryFile = path.join(packageDir, 'dist', 'cli.js');
  fs.writeFileSync(entryFile, 'export {};\n', { mode: 0o644 });
  const undiciDir = path.join(installDir, 'node_modules', 'undici');
  fs.mkdirSync(undiciDir, { recursive: true });
  fs.writeFileSync(path.join(undiciDir, 'package.json'), JSON.stringify({ name: 'undici', version: '7.30.2' }));
  fs.writeFileSync(path.join(undiciDir, 'index.js'), 'module.exports = {};\n');
  await recordHostCliReceipt(installDir, linkEntry().transport);
  receiptFile = path.join(installDir, HOST_CLI_RECEIPT_FILE);
}

function rewriteReceipt(change: (receipt: Record<string, unknown>) => void): void {
  const receipt = JSON.parse(fs.readFileSync(receiptFile, 'utf8')) as Record<string, unknown>;
  change(receipt);
  fs.writeFileSync(receiptFile, JSON.stringify(receipt), { mode: 0o600 });
}

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'host-cli-receipt-')));
  installDir = path.join(base, 'install');
  await install();
});

afterEach(() => {
  fs.rmSync(base, { recursive: true, force: true });
});

describe('verifying a host-run app install that changed since its receipt', () => {
  it.each([
    ['a group-writable install directory', () => fs.chmodSync(installDir, 0o775)],
    ['a world-writable install directory', () => fs.chmodSync(installDir, 0o757)],
    ['a group-writable entry file', () => fs.chmodSync(entryFile, 0o664)],
    ['a world-writable entry file', () => fs.chmodSync(entryFile, 0o646)],
    ['a group-writable receipt', () => fs.chmodSync(receiptFile, 0o620)],
    ['a world-writable receipt', () => fs.chmodSync(receiptFile, 0o602)],
    [
      'a receipt that is a link to one elsewhere',
      () => {
        const moved = path.join(base, 'receipt-elsewhere.json');
        fs.renameSync(receiptFile, moved);
        fs.symlinkSync(moved, receiptFile);
      },
    ],
    [
      'a receipt recorded for another version',
      () =>
        rewriteReceipt((receipt) => {
          receipt.version = '1.5.0';
        }),
    ],
    [
      'a receipt whose undici lies outside the install',
      () => {
        const outside = path.join(base, 'elsewhere', 'node_modules', 'undici');
        fs.mkdirSync(outside, { recursive: true });
        fs.writeFileSync(path.join(outside, 'index.js'), 'module.exports = {};\n');
        rewriteReceipt((receipt) => {
          receipt.undici = path.join(outside, 'index.js');
        });
      },
    ],
  ])('refuses %s', async (_case, tamper) => {
    await expect(verifyHostCliReceipt(installDir, linkEntry().transport)).resolves.toEqual({ entryFile });

    tamper();

    await expect(verifyHostCliReceipt(installDir, linkEntry().transport)).rejects.toBeInstanceOf(HostCliInstallError);
  });
});
