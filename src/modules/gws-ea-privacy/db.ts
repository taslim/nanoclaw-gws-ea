import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { hasControlCharacters, parseLine } from '../../gws-ea/validation.js';
import { canonicalText, PRIVATE_VALUE_KINDS, uncheckableReason, type PrivateValueKind } from './match.js';

export interface PrivateValue {
  readonly id: string;
  /** What the principal calls it, such as "Home". Never shown to anyone else. */
  readonly label: string;
  readonly kind: PrivateValueKind;
  /** As the principal wrote it. */
  readonly value: string;
  readonly created_at: string;
}

/** Unvalidated caller input: the store checks each field. */
interface AddPrivateValueInput {
  readonly label: string;
  readonly kind: string;
  readonly value: string;
}

const LABEL_MAX_LENGTH = 80;

function parseKind(value: string): PrivateValueKind {
  const kind = PRIVATE_VALUE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`Kind ${JSON.stringify(value)} is invalid: use ${PRIVATE_VALUE_KINDS.join(', ')}`);
  return kind;
}

function parseValue(kind: PrivateValueKind, value: string): string {
  const text = value.trim();
  if (!text || hasControlCharacters(text)) throw new Error('A private value must be one line of text');
  const problem = uncheckableReason(kind, text);
  if (problem !== undefined) throw new Error(problem);
  return text;
}

/** Two spellings of one value share this key, so the store holds each value once. */
function valueKey(kind: PrivateValueKind, value: string): string {
  const canonical = canonicalText(value);
  return `${kind}:${kind === 'phone' ? canonical.replace(/[^0-9]/gu, '') : canonical}`;
}

function newValueId(): string {
  return `pv-${randomBytes(6).toString('hex')}`;
}

export async function listPrivateValues(): Promise<PrivateValue[]> {
  return getDb().all<PrivateValue>(
    'SELECT id, label, kind, value, created_at FROM gws_ea_private_values ORDER BY created_at, id',
  );
}

export async function getPrivateValue(id: string): Promise<PrivateValue | undefined> {
  return getDb().get<PrivateValue>(
    'SELECT id, label, kind, value, created_at FROM gws_ea_private_values WHERE id = ?',
    id,
  );
}

/**
 * Hold a private value. Refuses one the check could not match reliably.
 * Adding a value already held, in any spelling, changes nothing and returns
 * the held one.
 */
export async function addPrivateValue(
  input: AddPrivateValueInput,
): Promise<PrivateValue & { readonly added: boolean }> {
  const kind = parseKind(input.kind);
  const label = parseLine(input.label, 'Label', LABEL_MAX_LENGTH);
  const value = parseValue(kind, input.value);
  const key = valueKey(kind, value);
  const db = getDb();
  return db.transaction(async () => {
    const held = (await listPrivateValues()).find((existing) => valueKey(existing.kind, existing.value) === key);
    if (held) return { ...held, added: false };
    const record: PrivateValue = { id: newValueId(), label, kind, value, created_at: new Date().toISOString() };
    await db.run(
      'INSERT INTO gws_ea_private_values (id, label, kind, value, created_at) VALUES (?, ?, ?, ?, ?)',
      record.id,
      record.label,
      record.kind,
      record.value,
      record.created_at,
    );
    return { ...record, added: true };
  });
}

/** Forget a private value, switching its check off. Callers decide who may; see `index.ts`. */
export async function removePrivateValue(id: string): Promise<PrivateValue> {
  const db = getDb();
  return db.transaction(async () => {
    const existing = await getPrivateValue(id);
    if (!existing) throw new Error(`No private value ${JSON.stringify(id)} exists`);
    await db.run('DELETE FROM gws_ea_private_values WHERE id = ?', id);
    return existing;
  });
}
