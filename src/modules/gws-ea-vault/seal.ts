import { createCipheriv, createDecipheriv, randomBytes, timingSafeEqual } from 'node:crypto';
import type { KeychainKey } from './key.js';

const IV_BYTES = 12;
const TAG_BYTES = 16;
const SEALED_MIN_BYTES = IV_BYTES + TAG_BYTES;

/** AES-256-GCM as iv | tag | ciphertext. The label binds a value to one store of one assistant. */
export function seal(value: Buffer, key: Buffer, label: string): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG_BYTES });
  cipher.setAAD(Buffer.from(label, 'utf8'));
  const ciphertext = Buffer.concat([cipher.update(value), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]);
}

export function unseal(blob: Buffer, key: Buffer, label: string): Buffer {
  if (!Buffer.isBuffer(blob) || blob.length < SEALED_MIN_BYTES) throw new Error('Sealed value is malformed');
  const decipher = createDecipheriv('aes-256-gcm', key, blob.subarray(0, IV_BYTES), { authTagLength: TAG_BYTES });
  decipher.setAAD(Buffer.from(label, 'utf8'));
  decipher.setAuthTag(blob.subarray(IV_BYTES, SEALED_MIN_BYTES));
  // Keep unauthenticated bytes out of returned values even when final() rejects.
  const decoded = decipher.update(blob.subarray(SEALED_MIN_BYTES));
  try {
    return Buffer.concat([decoded, decipher.final()]);
  } finally {
    decoded.fill(0);
  }
}

export type SealAvailability =
  | { readonly available: true }
  | { readonly available: false; readonly reason: 'key_missing' | 'key_mismatch' | 'keychain_unavailable' };

/** A store's own view of its file, read inside the store's serialized operation. */
export interface SealedFile {
  hasSecrets(): boolean;
  readCheck(): Buffer | undefined;
  writeCheck(sealed: Buffer): void;
}

export class SealUnavailableError extends Error {
  constructor() {
    super('seal_unavailable');
  }
}

export interface StoreSealOptions {
  readonly key: KeychainKey;
  readonly label: string;
  /** Known plaintext kept sealed in the file, proving which key its secrets belong to. */
  readonly check: string;
}

/** One store's sealing. A key is created only while that store's own file holds no secrets. */
export class StoreSeal {
  private readonly check: Buffer;
  constructor(private readonly options: StoreSealOptions) {
    this.check = Buffer.from(options.check, 'utf8');
  }

  seal(value: Buffer, key: Buffer): Buffer {
    return seal(value, key, this.options.label);
  }
  unseal(blob: Buffer, key: Buffer): Buffer {
    return unseal(blob, key, this.options.label);
  }

  private matches(file: SealedFile, key: Buffer): boolean {
    const check = file.readCheck();
    if (!check) return false;
    let value: Buffer | undefined;
    try {
      value = this.unseal(check, key);
      return value.length === this.check.length && timingSafeEqual(value, this.check);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Authentication failure is the constant key_mismatch state.
    } catch {
      return false;
    } finally {
      value?.fill(0);
    }
  }

  async availability(file: SealedFile): Promise<SealAvailability> {
    const populated = file.hasSecrets();
    const read = await this.options.key.read();
    if (read.status === 'unavailable') return { available: false, reason: 'keychain_unavailable' };
    if (read.status === 'missing') return populated ? { available: false, reason: 'key_missing' } : { available: true };
    try {
      return !populated || this.matches(file, read.key)
        ? { available: true }
        : { available: false, reason: 'key_mismatch' };
    } finally {
      read.key.fill(0);
    }
  }

  /** The key is read fresh for every operation and zeroed after it. */
  async withKey<T>(file: SealedFile, operation: (key: Buffer) => T): Promise<T> {
    const populated = file.hasSecrets();
    let read = await this.options.key.read();
    if (read.status === 'missing' && !populated) read = await this.options.key.create();
    if (read.status !== 'ready') throw new SealUnavailableError();
    try {
      if (populated) {
        if (!this.matches(file, read.key)) throw new SealUnavailableError();
      } else file.writeCheck(this.seal(this.check, read.key));
      return operation(read.key);
    } finally {
      read.key.fill(0);
    }
  }
}
