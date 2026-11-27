/**
 * The host-only command an operator uninstall sends to each running assistant: disconnect every app made from one
 * catalog entry the operator has just disabled, and say how many are still connected. The operator removes the
 * entry's host files only once every running assistant answers with none remaining.
 */
import { isRecord } from '../../gws-ea/validation.js';

export const CATALOG_RETIRE_COMMAND = 'gws-ea-connections-catalog-retire';

/** The entries an operator enables, so the only ones an operator can retire. */
export const RETIRABLE_CATALOG_ENTRIES = ['link', 'shop'] as const;
export type RetirableCatalogEntry = (typeof RETIRABLE_CATALOG_ENTRIES)[number];

export interface CatalogRetireRequest {
  readonly entry: RetirableCatalogEntry;
}

export interface CatalogRetireReply {
  readonly schemaVersion: 1;
  readonly entry: RetirableCatalogEntry;
  /** Apps this call disconnected. */
  readonly retired: number;
  /** Apps for the entry still connected after this call; the operator waits for zero. */
  readonly remaining: number;
}

export function catalogRetireArgs(entry: RetirableCatalogEntry): readonly string[] {
  return [CATALOG_RETIRE_COMMAND, '--entry', entry];
}

function retirableEntry(value: unknown): value is RetirableCatalogEntry {
  return typeof value === 'string' && (RETIRABLE_CATALOG_ENTRIES as readonly string[]).includes(value);
}

export function parseCatalogRetireRequest(raw: Record<string, unknown>): CatalogRetireRequest {
  const extra = Object.keys(raw).find((key) => key !== 'entry');
  if (extra !== undefined) throw new Error(`Unknown catalog retire field: --${extra}`);
  if (!retirableEntry(raw.entry)) throw new Error(`--entry must be one of ${RETIRABLE_CATALOG_ENTRIES.join(', ')}.`);
  return { entry: raw.entry };
}

function countOf(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Undefined when the reply is not this contract's answer for `entry`, which never counts as confirmation. */
export function parseCatalogRetireReply(value: unknown, entry: RetirableCatalogEntry): CatalogRetireReply | undefined {
  const item = isRecord(value) && 'data' in value ? value.data : value;
  if (
    !isRecord(item) ||
    item.schemaVersion !== 1 ||
    item.entry !== entry ||
    !countOf(item.retired) ||
    !countOf(item.remaining)
  )
    return undefined;
  return { schemaVersion: 1, entry, retired: item.retired, remaining: item.remaining };
}
