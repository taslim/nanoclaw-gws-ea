import { createHash } from 'node:crypto';
import { isRecord } from '../../gws-ea/validation.js';

export const ASSISTANT_SUMMARY_FIELD = 'assistant_summary';

export interface ToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint?: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
  readonly openWorldHint?: boolean;
}

export interface ToolDefinition {
  readonly name: string;
  readonly title?: string;
  readonly description?: string;
  readonly inputSchema: Record<string, unknown>;
  readonly outputSchema?: Record<string, unknown>;
  readonly annotations?: ToolAnnotations;
}

/** UTF-16 code unit ordering per RFC 8785 Section 3.2.3. */
function compareCodeUnits(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}

/** RFC 8785 JSON Canonicalization Scheme (JCS) serialization. */
export function canonicalJson(value: unknown): string {
  if (value === null) return 'null';
  switch (typeof value) {
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number':
      if (!Number.isFinite(value)) throw new TypeError('Non-finite numbers cannot be canonicalized as JSON');
      return Object.is(value, -0) ? '0' : JSON.stringify(value);
    case 'string':
      return JSON.stringify(value);
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value.map((item) => (item === undefined ? 'null' : canonicalJson(item))).join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record)
        .filter((key) => record[key] !== undefined)
        .sort(compareCodeUnits);
      return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`).join(',')}}`;
    }
    default:
      throw new TypeError(`Unsupported JSON value type: ${typeof value}`);
  }
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

function pickAnnotations(raw: unknown): ToolAnnotations | undefined {
  if (!isRecord(raw)) return undefined;
  const annotations: {
    title?: string;
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    openWorldHint?: boolean;
  } = {};
  if (typeof raw.title === 'string') annotations.title = raw.title;
  if (typeof raw.readOnlyHint === 'boolean') annotations.readOnlyHint = raw.readOnlyHint;
  if (typeof raw.destructiveHint === 'boolean') annotations.destructiveHint = raw.destructiveHint;
  if (typeof raw.idempotentHint === 'boolean') annotations.idempotentHint = raw.idempotentHint;
  if (typeof raw.openWorldHint === 'boolean') annotations.openWorldHint = raw.openWorldHint;
  return Object.keys(annotations).length > 0 ? annotations : undefined;
}

export function normalizeToolDefinition(raw: unknown): ToolDefinition {
  if (!isRecord(raw) || typeof raw.name !== 'string' || !raw.name) {
    throw new TypeError('MCP tool definition is missing a valid name');
  }
  const inputSchema = isRecord(raw.inputSchema) ? raw.inputSchema : { type: 'object' };
  const outputSchema = isRecord(raw.outputSchema) ? raw.outputSchema : undefined;
  const annotations = pickAnnotations(raw.annotations);
  return {
    name: raw.name,
    ...(typeof raw.title === 'string' ? { title: raw.title } : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description } : {}),
    inputSchema,
    ...(outputSchema ? { outputSchema } : {}),
    ...(annotations ? { annotations } : {}),
  };
}

export function toolDefinitionHash(definition: ToolDefinition): string {
  const projected = normalizeToolDefinition(definition);
  return sha256Hex(canonicalJson(projected));
}

export function toolListHash(tools: readonly { readonly name: string; readonly definitionHash: string }[]): string {
  const ordered = [...tools]
    .map(({ name, definitionHash }) => ({ definitionHash, name }))
    .sort((a, b) => compareCodeUnits(a.name, b.name));
  return sha256Hex(canonicalJson(ordered));
}

export function canonicalArgsHash(args: Record<string, unknown>): {
  readonly canonical: string;
  readonly hash: string;
} {
  const canonical = canonicalJson(args);
  return { canonical, hash: sha256Hex(canonical) };
}
