/** Account state is instance-owned and deliberately outside release snapshot roots. */
import fs from 'node:fs';
import path from 'node:path';

import { isErrno } from '../../community-portal/errors.js';
import { readEnvFile } from '../../env.js';
import { readOwnerOnlyJson, writePrivateTextFile } from '../../gws-ea/secrets.js';
import { isRecord } from '../../gws-ea/validation.js';

export const WHATSAPP_DIRECTORY_ENV = 'GWS_EA_WHATSAPP_DIR';

/** LID is the bare WhatsApp person id; the phone JID is an alias, never a second identity. */
export interface WhatsAppPerson {
  readonly lid: string;
  readonly phoneJid?: string;
}

export interface WhatsAppLink {
  readonly schema_version: 1;
  readonly state: 'linking' | 'connected' | 'needs-relink';
  readonly account?: WhatsAppPerson;
  readonly principal?: WhatsAppPerson;
  readonly error?: { readonly message: string; readonly at: string };
}

export function whatsappDirectory(): string | undefined {
  const configured =
    process.env[WHATSAPP_DIRECTORY_ENV] || readEnvFile([WHATSAPP_DIRECTORY_ENV])[WHATSAPP_DIRECTORY_ENV];
  return configured ? assertWhatsAppDirectory(configured) : undefined;
}

export function assertWhatsAppDirectory(directory: string): string {
  if (
    !path.isAbsolute(directory) ||
    path.basename(directory) !== 'whatsapp' ||
    path.basename(path.dirname(directory)) !== 'secrets'
  ) {
    throw new Error('WhatsApp account state must be an absolute instance secrets/whatsapp directory');
  }
  return directory;
}

/** No symlink or shared directory may contain the account's private SQLite files. */
export function ensureWhatsAppDirectory(directory: string): void {
  assertWhatsAppDirectory(directory);
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  for (const entry of [path.dirname(directory), directory]) {
    const info = fs.lstatSync(entry);
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid()) ||
      (info.mode & 0o077) !== 0
    ) {
      throw new Error(`WhatsApp secrets directory must be owner-only and not a symlink: ${entry}`);
    }
  }
}

export function privateDatabaseFile(
  directory: string,
  name: 'auth.sqlite' | 'messages.sqlite' | 'contacts.sqlite',
): string {
  ensureWhatsAppDirectory(directory);
  const file = path.join(directory, name);
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_CREAT | fs.constants.O_NOFOLLOW, 0o600);
  try {
    const info = fs.fstatSync(fd);
    if (
      !info.isFile() ||
      (info.mode & 0o077) !== 0 ||
      (typeof process.getuid === 'function' && info.uid !== process.getuid())
    ) {
      throw new Error(`WhatsApp database must be an owner-only regular file: ${file}`);
    }
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

function person(value: unknown): value is WhatsAppPerson {
  return (
    isRecord(value) &&
    typeof value.lid === 'string' &&
    /^\d+$/u.test(value.lid) &&
    (value.phoneJid === undefined ||
      (typeof value.phoneJid === 'string' && /^\d+@s\.whatsapp\.net$/u.test(value.phoneJid)))
  );
}

export async function readWhatsAppLink(directory: string): Promise<WhatsAppLink | undefined> {
  assertWhatsAppDirectory(directory);
  let value: unknown;
  try {
    value = await readOwnerOnlyJson(path.join(directory, 'link.json'), 'WhatsApp link', 'invalid_whatsapp_link');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    !['linking', 'connected', 'needs-relink'].includes(String(value.state)) ||
    (value.account !== undefined && !person(value.account)) ||
    (value.principal !== undefined && !person(value.principal)) ||
    (value.error !== undefined &&
      (!isRecord(value.error) || typeof value.error.message !== 'string' || typeof value.error.at !== 'string'))
  ) {
    throw new Error('Invalid WhatsApp link record');
  }
  return value as unknown as WhatsAppLink;
}

export async function writeWhatsAppLink(directory: string, link: WhatsAppLink): Promise<void> {
  ensureWhatsAppDirectory(directory);
  await writePrivateTextFile(path.join(directory, 'link.json'), JSON.stringify(link));
}
