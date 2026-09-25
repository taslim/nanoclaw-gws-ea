/**
 * The shared readers for gws-ea's state files and child-process output.
 * Readers validate the fields they need and ignore every other field, so a
 * newer or older writer's extra fields never wedge a run (R14). Ownership is
 * still decided by the exact values a caller compares, never by which keys
 * happen to be present.
 */
import path from 'node:path';

import { GwsEaError } from './types.js';

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hasControlCharacters(value: string): boolean {
  return [...value].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
}

/** Parse JSON text; malformed text raises `code`. */
export function parseJson(source: string, label: string, code: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError(code, `${label} is not valid JSON`);
  }
}

/** `ncl` and the OneCLI CLI wrap their result in `{ data }`. */
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

/** A recorded Docker endpoint: a local `unix://` socket (KTD3). */
export function requireDockerEndpoint(value: unknown, label: string, code: string): string {
  const endpoint = requireString(value, label, code);
  if (!unixSocketPath(endpoint)) throw new GwsEaError(code, `${label} must be a local unix:// socket`);
  return endpoint;
}
