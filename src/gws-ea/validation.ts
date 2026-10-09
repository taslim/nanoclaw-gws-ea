/**
 * The shared readers for gws-ea's state files and child-process output.
 * Readers validate the fields they need and ignore every other field, so a
 * newer or older writer's extra fields never wedge a run. Ownership is
 * still decided by the exact values a caller compares, never by which keys
 * happen to be present.
 */
import path from 'node:path';

import { GwsEaError } from './types.js';

/** An email address: a local part, `@`, and a dotted domain, with no whitespace. */
export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

/**
 * A Cloudflare tunnel ID, lowercase: an RFC 9562 UUID of any version from 1
 * to 8, so a time-ordered v7 ID passes as a v4 one does. It guards both the
 * request paths that carry the account token and the ID the registry records.
 */
export const CLOUDFLARE_TUNNEL_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    // C0 controls, DEL, and C1 controls (U+009B alone starts a terminal escape).
    return code !== undefined && (code <= 0x1f || (code >= 0x7f && code <= 0x9f));
  });
}

/**
 * A principal address as every layer stores it: trimmed and lowercased.
 * Undefined when `value` cannot be one. Agents see each address quoted in a
 * code span, so an address may not hold a backtick.
 */
export function normalizePrincipalEmail(value: string): string | undefined {
  const email = value.trim().toLowerCase();
  const valid =
    email.length <= 254 && EMAIL_PATTERN.test(email) && !email.includes('`') && !hasControlCharacters(email);
  return valid ? email : undefined;
}

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * One identity in every spelling that reaches the same mailbox: an email
 * handle lowercased, without its `+tag`, and, at Gmail, without the dots
 * Gmail ignores. Other handles are already canonical. Used only to widen a
 * protection (a fingerprint, a refusal, a release to the principal), never
 * to grant a level to a different handle.
 */
export function identityMatchKey(handle: string): string {
  if (!handle.toLowerCase().startsWith('email:')) return handle;
  const address = handle.slice('email:'.length).toLowerCase();
  const at = address.lastIndexOf('@');
  if (at <= 0) return `email:${address}`;
  let local = address.slice(0, at);
  let domain = address.slice(at + 1);
  const plus = local.indexOf('+');
  if (plus > 0) local = local.slice(0, plus);
  if (GMAIL_DOMAINS.has(domain)) {
    const undotted = local.replaceAll('.', '');
    if (undotted) local = undotted;
    domain = 'gmail.com';
  }
  return `email:${local}@${domain}`;
}

/** `value` trimmed, refused unless it is one line of 1 to `maxLength` characters; `label` names it in the refusal. */
export function parseLine(value: string, label: string, maxLength: number): string {
  const text = value.trim();
  if (!text || text.length > maxLength || hasControlCharacters(text)) {
    throw new Error(`${label} must be one line of 1 to ${maxLength} characters`);
  }
  return text;
}

/** As `parseLine`, but a blank value is null: it clears the field. */
export function parseOptionalLine(value: string, label: string, maxLength: number): string | null {
  return value.trim() === '' ? null : parseLine(value, label, maxLength);
}

/** Parse JSON text; malformed text raises `code`. */
export function parseJson(source: string, label: string, code: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError(code, `${label} is not valid JSON`);
  }
}

/** `ncl` wraps its result in `{ data }`. */
export function unwrapData(value: unknown): unknown {
  return isRecord(value) && 'data' in value ? value.data : value;
}

export function requireRecord(value: unknown, label: string, code: string): Record<string, unknown> {
  if (!isRecord(value)) throw new GwsEaError(code, `${label} must be an object`);
  return value;
}

/** A non-empty, bounded string without control characters. */
export function requireString(value: unknown, label: string, code: string, maxLength = 2_048): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || hasControlCharacters(value)) {
    throw new GwsEaError(code, `${label} is invalid`);
  }
  return value;
}

/** `record[key]` as a required string, named `<label> <key>` when invalid. */
export function stringField(record: Record<string, unknown>, key: string, label: string, code: string): string {
  return requireString(record[key], `${label} ${key}`, code);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** `value` when it is a timestamp exactly as `Date#toISOString` writes it (ISO-8601 UTC), else undefined. */
export function canonicalTimestamp(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value ? value : undefined;
}

/** A canonical timestamp (see `canonicalTimestamp`); anything else raises `code` with `message`. */
export function requireCanonicalTimestamp(value: unknown, code: string, message: string): string {
  const timestamp = canonicalTimestamp(value);
  if (timestamp === undefined) throw new GwsEaError(code, message);
  return timestamp;
}

/** An absolute, normalized path. */
export function requirePath(value: unknown, label: string, code: string): string {
  const result = requireString(value, label, code);
  if (!path.isAbsolute(result) || path.resolve(result) !== result) {
    throw new GwsEaError(code, `${label} must be an absolute normalized path`);
  }
  return result;
}

/** The socket path of a local `unix://` Docker endpoint, or undefined for any other endpoint. */
export function unixSocketPath(endpoint: string): string | undefined {
  const socket = endpoint.startsWith('unix://') ? endpoint.slice('unix://'.length) : undefined;
  return socket && path.isAbsolute(socket) && !hasControlCharacters(socket) ? socket : undefined;
}

/** A recorded Docker endpoint: a local `unix://` socket. */
export function requireDockerEndpoint(value: unknown, label: string, code: string): string {
  const endpoint = requireString(value, label, code);
  if (!unixSocketPath(endpoint)) throw new GwsEaError(code, `${label} must be a local unix:// socket`);
  return endpoint;
}
