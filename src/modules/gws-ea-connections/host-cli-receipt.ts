/**
 * What an operator install of a host-run app records, and the check each host makes before it spawns that app. The
 * receipt pins the exact file the host will run; anything that changed it since install refuses the spawn.
 */
import { createHash, randomBytes } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, open, readFile, realpath, rename, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';

import { isRecord } from '../../gws-ea/validation.js';
import type { CatalogTransport } from './catalog.js';

export type HostCliTransport = Extract<CatalogTransport, { readonly kind: 'host_cli' }>;

export const HOST_CLI_RECEIPT_FILE = 'receipt.json';
const RECEIPT_SCHEMA_VERSION = 1;
const RECEIPT_MAX_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;

export interface HostCliReceipt {
  readonly schemaVersion: typeof RECEIPT_SCHEMA_VERSION;
  readonly package: string;
  readonly version: string;
  /** The canonical path of the package's bin entry inside the installation. */
  readonly entryFile: string;
  readonly sha256: string;
  /** Where `undici` resolves from the entry file: `LINK_HTTP_PROXY` loads it and the CLI does not declare it. */
  readonly undici: string;
}

export class HostCliInstallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HostCliInstallError';
  }
}

function invalid(message: string): never {
  throw new HostCliInstallError(message);
}

function ownedByUs(uid: number): boolean {
  return typeof process.getuid !== 'function' || uid === process.getuid();
}

function inside(root: string, file: string): boolean {
  return file.startsWith(`${root}${path.sep}`);
}

async function physicalInstallation(installationDir: string): Promise<void> {
  if (!path.isAbsolute(installationDir)) invalid('The installation location must be absolute');
  const info = await lstat(installationDir);
  if (
    !info.isDirectory() ||
    !ownedByUs(info.uid) ||
    (info.mode & 0o022) !== 0 ||
    (await realpath(installationDir)) !== installationDir
  ) {
    invalid('The installation must be a physical canonical directory only its owner can change');
  }
}

/** Hashes through a no-follow descriptor, so the bytes checked are the file named, never a link's target. */
async function ownedFileDigest(file: string): Promise<string> {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const info = await handle.stat();
    if (!info.isFile() || !ownedByUs(info.uid) || (info.mode & 0o022) !== 0) {
      invalid('An installed file is not a regular file only its owner can change');
    }
    const hash = createHash('sha256');
    for await (const chunk of handle.createReadStream({ autoClose: false })) hash.update(chunk as Buffer);
    return hash.digest('hex');
  } finally {
    await handle.close();
  }
}

async function resolveUndici(installationDir: string, entryFile: string): Promise<string> {
  let resolved: string;
  try {
    resolved = await realpath(createRequire(entryFile).resolve('undici'));
    /* eslint-disable-next-line no-catch-all/no-catch-all -- any failure to resolve is the missing dependency being checked */
  } catch {
    return invalid('undici does not resolve from the installed entry file');
  }
  if (!inside(installationDir, resolved)) invalid('undici resolves outside the installation');
  return resolved;
}

async function binEntry(installationDir: string, transport: HostCliTransport): Promise<string> {
  const packageDir = await realpath(path.join(installationDir, 'node_modules', transport.package));
  if (!inside(installationDir, packageDir)) invalid('The installed package lies outside the installation');
  const manifest: unknown = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  if (!isRecord(manifest) || manifest.name !== transport.package || manifest.version !== transport.version) {
    invalid('The installed package is not the pinned version');
  }
  const bin =
    typeof manifest.bin === 'string' ? manifest.bin : isRecord(manifest.bin) ? manifest.bin[transport.bin] : null;
  if (typeof bin !== 'string' || path.isAbsolute(bin)) invalid('The installed package names no such command');
  const entryFile = await realpath(path.resolve(packageDir, bin));
  if (!inside(installationDir, entryFile)) invalid('The command lies outside the installation');
  return entryFile;
}

/** Run after a frozen-lockfile install: records the file each host will spawn for this pinned version. */
export async function recordHostCliReceipt(
  installationDir: string,
  transport: HostCliTransport,
): Promise<HostCliReceipt> {
  await physicalInstallation(installationDir);
  const entryFile = await binEntry(installationDir, transport);
  const receipt: HostCliReceipt = {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    package: transport.package,
    version: transport.version,
    entryFile,
    sha256: await ownedFileDigest(entryFile),
    undici: await resolveUndici(installationDir, entryFile),
  };
  const target = path.join(installationDir, HOST_CLI_RECEIPT_FILE);
  const staged = `${target}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    await writeFile(staged, `${JSON.stringify(receipt, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
    await rename(staged, target);
  } finally {
    await rm(staged, { force: true });
  }
  return receipt;
}

function parseReceipt(value: unknown, installationDir: string): HostCliReceipt {
  if (
    !isRecord(value) ||
    value.schemaVersion !== RECEIPT_SCHEMA_VERSION ||
    typeof value.package !== 'string' ||
    typeof value.version !== 'string' ||
    typeof value.entryFile !== 'string' ||
    typeof value.sha256 !== 'string' ||
    typeof value.undici !== 'string' ||
    !SHA256.test(value.sha256) ||
    !inside(installationDir, value.entryFile) ||
    !inside(installationDir, value.undici)
  ) {
    invalid('The install receipt is malformed');
  }
  return {
    schemaVersion: RECEIPT_SCHEMA_VERSION,
    package: value.package,
    version: value.version,
    entryFile: value.entryFile,
    sha256: value.sha256,
    undici: value.undici,
  };
}

async function readReceipt(installationDir: string): Promise<HostCliReceipt> {
  const handle = await open(
    path.join(installationDir, HOST_CLI_RECEIPT_FILE),
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
  );
  try {
    const info = await handle.stat();
    if (!info.isFile() || info.size > RECEIPT_MAX_BYTES || !ownedByUs(info.uid) || (info.mode & 0o022) !== 0) {
      invalid('The install receipt is not a bounded file only its owner can change');
    }
    return parseReceipt(JSON.parse(await handle.readFile('utf8')), installationDir);
  } finally {
    await handle.close();
  }
}

/** Before every spawn: the pinned version's receipt, its entry file's bytes and its undici all still hold. */
export async function verifyHostCliReceipt(
  installationDir: string,
  transport: HostCliTransport,
): Promise<{ readonly entryFile: string }> {
  try {
    await physicalInstallation(installationDir);
    const receipt = await readReceipt(installationDir);
    if (receipt.package !== transport.package || receipt.version !== transport.version) {
      invalid('The install receipt is for another version');
    }
    if ((await realpath(receipt.entryFile)) !== receipt.entryFile) invalid('The entry file path is not canonical');
    if ((await ownedFileDigest(receipt.entryFile)) !== receipt.sha256) invalid('The entry file changed since install');
    if ((await resolveUndici(installationDir, receipt.entryFile)) !== receipt.undici) {
      invalid('undici resolves elsewhere than at install');
    }
    return { entryFile: receipt.entryFile };
  } catch (error) {
    if (error instanceof HostCliInstallError) throw error;
    throw new HostCliInstallError(error instanceof Error ? error.message : 'The installation is unreadable');
  }
}
