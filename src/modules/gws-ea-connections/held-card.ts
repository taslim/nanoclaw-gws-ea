import { isRecord } from '../../gws-ea/validation.js';

const SOFT_HYPHEN = 0x00ad;
const COMBINING_GRAPHEME_JOINER = 0x034f;
const ARABIC_LETTER_MARK = 0x061c;
const MONGOLIAN_VOWEL_SEPARATOR = 0x180e;
const BYTE_ORDER_MARK = 0xfeff;

const PLAIN_ARG_KEY = /^[A-Za-z0-9_.-]+$/u;
const JWT_TOKEN = /^[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]{8,})?$/u;
const HEX_DIGEST = /^(?:0x)?[0-9a-fA-F]{24,}$/u;
const OPAQUE_BLOB = /^[A-Za-z0-9_+=/:-]{36,}$/u;
const ISO_TIMESTAMP_PREFIX = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/u;
const SNAKE_OR_KEBAB_WORDS = /^[a-z0-9]+(?:[_-][a-z0-9]+){3,}$/u;

const ENVELOPE_KEYS = new Set([
  'data',
  'result',
  'quote',
  'payload',
  'response',
  'checkout',
  'order',
  'preview',
  'booking',
  'reservation',
  'transaction',
  'draft',
]);

const TRIVIAL_STATUS_KEYS = new Set(['ok', 'success', 'status', 'code', 'statusCode', 'status_code']);
const TRIVIAL_STATUS_STRINGS = /^(?:ok|success|succeeded)$/iu;

const KEEP_ZERO_KEY =
  /(?:^|[_-])(?:total|subtotal|amount|price|cost|payable|due|balance|charge|quantity|qty|count|guests|seats|adults|children|rooms|nights|days|hours|minutes|score|rating|status|code)(?:$|[_-])/iu;

const OPTIONAL_ZERO_SLOT = /(?:tip|voucher|promo|discount|fee|tax|bag|container|safety|small[_-]?order|surcharge)/iu;

function shouldKeepZeroKey(key: string): boolean {
  const normalized = key.replace(/([a-z0-9])([A-Z])/gu, '$1_$2');
  return KEEP_ZERO_KEY.test(normalized) && !OPTIONAL_ZERO_SLOT.test(normalized);
}

const USER_FACING_ID_KEY =
  /^(?:order|booking|confirmation|reference|ref|invoice|receipt|transaction|ticket|tracking|flight|reservation|case|issue|pr|pull_request)(?:_id|_number|_no|_code|Id|Number|Code)?$/iu;

const INTERNAL_ID_KEY = /^(?:id|[a-z0-9]+(?:_[a-z0-9]+)*_id|[a-z][a-zA-Z0-9]*Id)$/u;

const HUMAN_LABEL_KEY =
  /^(?:name|label|title|address|summary|description|headline|subject|email|text|vendor_name|merchant_name|store_name|restaurant_name|display_name|full_name|formatted_address)$/iu;

const ITEM_HEADLINE_KEYS = ['name', 'title', 'label', 'item', 'description', 'summary'] as const;
const ITEM_QUANTITY_KEYS = ['quantity', 'qty', 'count'] as const;

const PRIORITY_PATTERNS: readonly RegExp[] = [
  /^(?:error|errors|warning|warnings|summary|headline|description|title|action|operation|subject|message)$/iu,
  /^(?:merchant|vendor|store|restaurant|seller|provider|shop|business|payee|recipient|to|cc|bcc|from|sender|customer|passenger|guest|quote|checkout|cart|booking|reservation|preview|items?|line_items?|products?|entries|orders?|destination|delivery_address|shipping_address|address|location|origin|pickup|venue|place)(?:_name|Name)?$/iu,
  /^(?:currency|total|grand_total|net_total|subtotal|amount|amounts|price|unit_price|cost|fee|fees|tax|taxes|discount|balance|payable|due|payment|payment_method|card|wallet|billing)$/iu,
  /^(?:eta|estimated_.*|delivery_.*|pickup_.*|date|time|start|end|start_time|end_time|when|schedule|window|expires_at|valid_until|deadline)$/iu,
  /^(?:note|notes|instructions|delivery_instructions|comment|memo|status|state|mode|type|kind|confirmed|refundable|cancellable)$/iu,
];

const LOW_PRIORITY_KEY = /(?:^id$|_id$|Id$|_hash$|Hash$|fingerprint|token|signature|nonce|cursor)/u;

const MAX_DISTILL_DEPTH = 6;
const MAX_ARRAY_ITEMS = 8;
const MAX_JSON_FIELD_STRING = 280;
const LEADING_OR_TRAILING_PUNCTUATION = /^[[("'`{<]+|[.,;:!?)\]"'}>]+$/gu;

function isNonWhitespaceControl(cp: number): boolean {
  return cp <= 0x08 || cp === 0x0b || cp === 0x0c || (cp >= 0x0e && cp <= 0x1f) || cp === 0x7f;
}

function isInvisibleFormatChar(cp: number): boolean {
  return (
    cp === SOFT_HYPHEN ||
    cp === COMBINING_GRAPHEME_JOINER ||
    cp === ARABIC_LETTER_MARK ||
    cp === MONGOLIAN_VOWEL_SEPARATOR ||
    cp === BYTE_ORDER_MARK
  );
}

function isZeroWidthOrBidi(cp: number): boolean {
  return (cp >= 0x200b && cp <= 0x200f) || (cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2060 && cp <= 0x2069);
}

function isInvisibleCodePoint(cp: number): boolean {
  return isNonWhitespaceControl(cp) || isInvisibleFormatChar(cp) || isZeroWidthOrBidi(cp);
}

/** Truncates to at most `maxUnits` UTF-16 code units without splitting surrogate pairs; counts ellipsis in the budget. */
export function capUtf16(text: string, maxUnits: number): string {
  if (text.length <= maxUnits) return text;
  if (maxUnits <= 1) return maxUnits === 1 ? '…' : '';
  const limit = maxUnits - 1;
  let end = 0;
  for (const ch of text) {
    if (end + ch.length > limit) break;
    end += ch.length;
  }
  return `${text.slice(0, end)}…`;
}

export function escapeInvisibleChars(text: string): { readonly rendered: string; readonly hasInvisible: boolean } {
  let hasInvisible = false;
  let rendered = '';
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0;
    if (isInvisibleCodePoint(cp)) {
      hasInvisible = true;
      rendered += `[U+${cp.toString(16).toUpperCase().padStart(4, '0')}]`;
    } else {
      rendered += ch;
    }
  }
  return { rendered, hasInvisible };
}

export function renderCompactArgs(args: Record<string, unknown>): {
  readonly text: string;
  readonly hasInvisible: boolean;
} {
  const entries = Object.entries(args);
  if (entries.length === 0) return { text: '(none)', hasInvisible: false };
  let hasInvisible = false;
  const lines: string[] = [];
  for (const [key, value] of entries) {
    const keyOut = escapeInvisibleChars(key);
    const renderedKey = PLAIN_ARG_KEY.test(keyOut.rendered) ? keyOut.rendered : JSON.stringify(keyOut.rendered);
    let renderedValue: string;
    let valueHasInvisible: boolean;
    if (typeof value === 'string') {
      const valOut = escapeInvisibleChars(value);
      valueHasInvisible = valOut.hasInvisible;
      renderedValue = JSON.stringify(valOut.rendered);
    } else {
      const valOut = escapeInvisibleChars(JSON.stringify(value));
      valueHasInvisible = valOut.hasInvisible;
      renderedValue = valOut.rendered;
    }
    if (keyOut.hasInvisible || valueHasInvisible) hasInvisible = true;
    lines.push(`${renderedKey}: ${renderedValue}`);
  }
  return { text: lines.join('\n'), hasInvisible };
}

/** True for printable-ASCII opaque tokens (JWTs, hex digests, high-entropy blobs) that humans cannot read inline. */
export function isOpaqueToken(value: string): boolean {
  if (value.length < 24 || /\s/u.test(value)) return false;
  if (
    value.startsWith('http://') ||
    value.startsWith('https://') ||
    value.startsWith('mailto:') ||
    value.includes('@') ||
    (value.startsWith('/') && !value.endsWith('='))
  ) {
    return false;
  }
  if (ISO_TIMESTAMP_PREFIX.test(value)) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    if (code < 0x21 || code > 0x7e) return false;
  }
  if (new Set(value).size < 8) return false;
  if (value.length >= 40 && JWT_TOKEN.test(value)) return true;
  if (HEX_DIGEST.test(value)) {
    return value.length >= 32 || (/[0-9]/u.test(value) && /[a-fA-F]/u.test(value));
  }
  if (OPAQUE_BLOB.test(value)) {
    const classes = (/[A-Z]/u.test(value) ? 1 : 0) + (/[a-z]/u.test(value) ? 1 : 0) + (/[0-9]/u.test(value) ? 1 : 0);
    if (classes >= 3) return true;
    if (classes >= 2 && value.length >= 48 && !SNAKE_OR_KEBAB_WORDS.test(value)) return true;
  }
  return false;
}

export function collapseOpaqueToken(value: string): string {
  return `${value.slice(0, 6)}…${value.slice(-4)}`;
}

function collapseOpaqueInValue(
  value: unknown,
  opaqueTokens: Set<string>,
  depth = 0,
): { readonly value: unknown; readonly compacted: boolean } {
  if (depth > 8) return { value, compacted: false };
  if (typeof value === 'string') {
    if (isOpaqueToken(value)) {
      opaqueTokens.add(value);
      return { value: collapseOpaqueToken(value), compacted: true };
    }
    return { value, compacted: false };
  }
  if (Array.isArray(value)) {
    let compacted = false;
    const mapped = value.map((item) => {
      const next = collapseOpaqueInValue(item, opaqueTokens, depth + 1);
      if (next.compacted) compacted = true;
      return next.value;
    });
    return { value: mapped, compacted };
  }
  if (isRecord(value)) {
    let compacted = false;
    const mapped: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      const next = collapseOpaqueInValue(v, opaqueTokens, depth + 1);
      if (next.compacted) compacted = true;
      mapped[k] = next.value;
    }
    return { value: mapped, compacted };
  }
  return { value, compacted: false };
}

export interface DistilledArgsResult {
  readonly text: string;
  readonly hasInvisible: boolean;
  readonly compacted: boolean;
  readonly opaqueTokens: ReadonlySet<string>;
}

/** Renders tool arguments with opaque tokens collapsed on the card while keeping every argument key visible. */
export function renderDistilledArgs(args: Record<string, unknown>): DistilledArgsResult {
  const opaqueTokens = new Set<string>();
  const collapsed = collapseOpaqueInValue(args, opaqueTokens);
  const rendered = renderCompactArgs(isRecord(collapsed.value) ? collapsed.value : args);
  return {
    text: rendered.text,
    hasInvisible: rendered.hasInvisible,
    compacted: collapsed.compacted,
    opaqueTokens,
  };
}

/** Iteratively scans an entire decoded value at any depth for invisible characters in keys or string values. */
export function hasAnyInvisible(root: unknown): boolean {
  const stack: unknown[] = [root];
  while (stack.length > 0) {
    const value = stack.pop();
    if (typeof value === 'string') {
      if (escapeInvisibleChars(value).hasInvisible) return true;
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
      continue;
    }
    if (isRecord(value)) {
      for (const [k, v] of Object.entries(value)) {
        if (escapeInvisibleChars(k).hasInvisible) return true;
        stack.push(v);
      }
    }
  }
  return false;
}

/** Collects a bounded sample of invisible-bearing escaped snippets from a deep subtree so markers stay visible on cards. */
function collectDeepInvisibleSnippets(root: unknown, limit = 3): string[] {
  const found: string[] = [];
  const stack: unknown[] = [root];
  while (stack.length > 0 && found.length < limit) {
    const value = stack.pop();
    if (typeof value === 'string') {
      const escaped = escapeInvisibleChars(value);
      if (escaped.hasInvisible) {
        found.push(capUtf16(escaped.rendered.replace(/\r\n|\r|\n/gu, '\\n'), MAX_JSON_FIELD_STRING));
      }
      continue;
    }
    if (Array.isArray(value)) {
      for (let i = value.length - 1; i >= 0; i -= 1) stack.push(value[i]);
      continue;
    }
    if (isRecord(value)) {
      const entries = Object.entries(value);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const [k, v] = entries[i]!;
        const keyEscaped = escapeInvisibleChars(k);
        if (keyEscaped.hasInvisible && found.length < limit) {
          found.push(capUtf16(keyEscaped.rendered.replace(/\r\n|\r|\n/gu, '\\n'), MAX_JSON_FIELD_STRING));
        }
        stack.push(v);
      }
    }
  }
  return found;
}

function isTrivialWrapperEntry(key: string, value: unknown): boolean {
  if (value === null || value === undefined || value === '') return true;
  if (TRIVIAL_STATUS_KEYS.has(key)) {
    if (value === true || value === 200) return true;
    if (typeof value === 'string' && TRIVIAL_STATUS_STRINGS.test(value.trim())) return true;
  }
  if (key === 'message' && typeof value === 'string' && TRIVIAL_STATUS_STRINGS.test(value.trim())) return true;
  return false;
}

function hasSummaryOrMessage(obj: Record<string, unknown>): boolean {
  if (
    (typeof obj.summary === 'string' && obj.summary.trim().length > 0) ||
    (typeof obj.message === 'string' && obj.message.trim().length > 0)
  ) {
    return true;
  }
  for (const [k, v] of Object.entries(obj)) {
    if (ENVELOPE_KEYS.has(k.toLowerCase()) && isRecord(v)) {
      if (
        (typeof v.summary === 'string' && v.summary.trim().length > 0) ||
        (typeof v.message === 'string' && v.message.trim().length > 0)
      ) {
        return true;
      }
    }
  }
  return false;
}

function unwrapEnvelope(root: Record<string, unknown>): {
  readonly value: Record<string, unknown>;
  readonly unwrapped: boolean;
} {
  let current = root;
  let unwrapped = false;
  for (let step = 0; step < 2; step += 1) {
    const entries = Object.entries(current);
    const envelopeEntry = entries.find(([key, val]) => ENVELOPE_KEYS.has(key.toLowerCase()) && isRecord(val));
    if (!envelopeEntry) break;
    const [envKey, envVal] = envelopeEntry;
    if (!isRecord(envVal)) break;
    const siblings = entries.filter(([key]) => key !== envKey);
    let hoistedMessage: string | undefined;
    let canUnwrap = true;
    for (const [key, val] of siblings) {
      if (escapeInvisibleChars(key).hasInvisible || hasAnyInvisible(val)) {
        canUnwrap = false;
        break;
      }
      if (isTrivialWrapperEntry(key, val)) continue;
      if (key === 'message' && typeof val === 'string' && hoistedMessage === undefined) {
        hoistedMessage = val.trim();
        continue;
      }
      canUnwrap = false;
      break;
    }
    if (!canUnwrap) break;
    current = hoistedMessage && !hasSummaryOrMessage(envVal) ? { message: hoistedMessage, ...envVal } : envVal;
    unwrapped = true;
  }
  return { value: current, unwrapped };
}

function isEmptyValue(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed === '' || trimmed === '[]' || trimmed === '{}';
  }
  if (Array.isArray(value)) return value.length === 0;
  if (isRecord(value)) return Object.keys(value).length === 0;
  return false;
}

function hasHumanSibling(obj: Record<string, unknown>): boolean {
  for (const [key, value] of Object.entries(obj)) {
    if (
      typeof value === 'string' &&
      value.trim().length > 0 &&
      !isOpaqueToken(value.trim()) &&
      (HUMAN_LABEL_KEY.test(key) || key.endsWith('_name') || key.endsWith('Name'))
    ) {
      return true;
    }
  }
  return false;
}

function isInternalIdField(key: string, value: unknown): boolean {
  if (!INTERNAL_ID_KEY.test(key) || USER_FACING_ID_KEY.test(key)) return false;
  return typeof value === 'number' || (typeof value === 'string' && isOpaqueToken(value));
}

function keyPriority(key: string): number {
  for (let i = 0; i < PRIORITY_PATTERNS.length; i += 1) {
    if (PRIORITY_PATTERNS[i]!.test(key)) return i;
  }
  if (LOW_PRIORITY_KEY.test(key)) return PRIORITY_PATTERNS.length + 1;
  return PRIORITY_PATTERNS.length;
}

function sortKeysByRelevance<T>(entries: readonly (readonly [string, T])[]): Array<readonly [string, T]> {
  return [...entries].sort(([left], [right]) => keyPriority(left) - keyPriority(right));
}

function humanizeKey(key: string, capitalizeFirst = true): string {
  const escaped = escapeInvisibleChars(key);
  if (escaped.hasInvisible) return escaped.rendered.replace(/\r\n|\r|\n/gu, '\\n');
  const spaced = escaped.rendered
    .replace(/([a-z0-9])([A-Z])/gu, '$1 $2')
    .replace(/[_-]+/gu, ' ')
    .trim();
  if (!spaced) return escaped.rendered.replace(/\r\n|\r|\n/gu, '\\n');
  const words = spaced.split(/\s+/u).map((word, index) => {
    if (/^[A-Z]{2,5}$/u.test(word)) return word;
    const lower = word.toLowerCase();
    return capitalizeFirst && index === 0 ? `${lower.slice(0, 1).toUpperCase()}${lower.slice(1)}` : lower;
  });
  return words.join(' ');
}

interface DistillState {
  compacted: boolean;
  hasInvisible: boolean;
}

function cleanRecord(
  obj: Record<string, unknown>,
  argOpaqueTokens: ReadonlySet<string>,
  state: DistillState,
  depth: number,
): Record<string, unknown> {
  if (depth >= MAX_DISTILL_DEPTH) {
    state.compacted = true;
    if (hasAnyInvisible(obj)) {
      state.hasInvisible = true;
      const snippets = collectDeepInvisibleSnippets(obj);
      if (snippets.length > 0) return { hidden: snippets.join(', ') };
    }
    return {};
  }
  const humanSibling = hasHumanSibling(obj);
  const rawEntries = Object.entries(obj);
  const hasNonZeroNumber = rawEntries.some(([, v]) => typeof v === 'number' && v !== 0);
  const cleaned: Record<string, unknown> = {};

  for (const [key, value] of rawEntries) {
    const keyInvisible = escapeInvisibleChars(key).hasInvisible;
    if (keyInvisible) state.hasInvisible = true;

    if (isRecord(value)) {
      const nested = cleanRecord(value, argOpaqueTokens, state, depth + 1);
      if (Object.keys(nested).length === 0 && !keyInvisible) {
        state.compacted = true;
        continue;
      }
      cleaned[key] = Object.keys(nested).length > 0 ? nested : value;
      continue;
    }

    if (Array.isArray(value)) {
      const nestedArray = cleanArray(value, argOpaqueTokens, state, depth + 1);
      if (nestedArray.length === 0 && !keyInvisible) {
        state.compacted = true;
        continue;
      }
      cleaned[key] = nestedArray.length > 0 ? nestedArray : value;
      continue;
    }

    const valInvisible = hasAnyInvisible(value);
    if (keyInvisible || valInvisible) {
      state.hasInvisible = true;
      cleaned[key] = value;
      continue;
    }

    if (typeof value === 'string' && argOpaqueTokens.has(value)) {
      state.compacted = true;
      continue;
    }

    if (isEmptyValue(value)) {
      state.compacted = true;
      continue;
    }

    if (typeof value === 'number' && value === 0 && hasNonZeroNumber && !shouldKeepZeroKey(key)) {
      state.compacted = true;
      continue;
    }

    if (humanSibling && isInternalIdField(key, value)) {
      state.compacted = true;
      continue;
    }

    cleaned[key] = value;
  }

  return cleaned;
}

function cleanArray(
  arr: readonly unknown[],
  argOpaqueTokens: ReadonlySet<string>,
  state: DistillState,
  depth: number,
): unknown[] {
  if (depth >= MAX_DISTILL_DEPTH) {
    state.compacted = true;
    if (hasAnyInvisible(arr)) {
      state.hasInvisible = true;
      return collectDeepInvisibleSnippets(arr);
    }
    return [];
  }
  const cleaned: unknown[] = [];
  for (const item of arr) {
    if (isRecord(item)) {
      const nested = cleanRecord(item, argOpaqueTokens, state, depth + 1);
      if (Object.keys(nested).length > 0) cleaned.push(nested);
      else if (hasAnyInvisible(item)) {
        state.hasInvisible = true;
        cleaned.push(item);
      } else {
        state.compacted = true;
      }
      continue;
    }
    if (Array.isArray(item)) {
      const nested = cleanArray(item, argOpaqueTokens, state, depth + 1);
      if (nested.length > 0) cleaned.push(nested);
      else if (hasAnyInvisible(item)) {
        state.hasInvisible = true;
        cleaned.push(item);
      } else {
        state.compacted = true;
      }
      continue;
    }
    if (hasAnyInvisible(item)) {
      state.hasInvisible = true;
      cleaned.push(item);
      continue;
    }
    if (typeof item === 'string' && argOpaqueTokens.has(item)) {
      state.compacted = true;
      continue;
    }
    if (isEmptyValue(item)) {
      state.compacted = true;
      continue;
    }
    cleaned.push(item);
  }
  return cleaned;
}

function formatScalar(value: unknown, state: DistillState): string {
  if (typeof value === 'string') {
    const escaped = escapeInvisibleChars(value);
    if (escaped.hasInvisible) state.hasInvisible = true;
    const singleLine = (escaped.hasInvisible ? escaped.rendered : escaped.rendered.trim()).replace(
      /\r\n|\r|\n/gu,
      '\\n',
    );
    if (!escaped.hasInvisible && isOpaqueToken(singleLine)) {
      state.compacted = true;
      return collapseOpaqueToken(singleLine);
    }
    if (singleLine.length > MAX_JSON_FIELD_STRING) {
      state.compacted = true;
      return capUtf16(singleLine, MAX_JSON_FIELD_STRING);
    }
    return singleLine;
  }
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null) return 'null';
  const raw = escapeInvisibleChars(JSON.stringify(value));
  if (raw.hasInvisible) state.hasInvisible = true;
  if (raw.rendered.length > MAX_JSON_FIELD_STRING) {
    state.compacted = true;
    return capUtf16(raw.rendered, MAX_JSON_FIELD_STRING);
  }
  return raw.rendered;
}

function isFlatValue(value: unknown): boolean {
  if (value === null || typeof value !== 'object') return true;
  if (Array.isArray(value)) return value.every((item) => item === null || typeof item !== 'object');
  return false;
}

function isFlatRecord(obj: Record<string, unknown>): boolean {
  return Object.values(obj).every(isFlatValue);
}

function formatPrimitiveArray(arr: readonly unknown[], state: DistillState): string {
  const shown = arr.slice(0, MAX_ARRAY_ITEMS).map((item) => formatScalar(item, state));
  if (arr.length > MAX_ARRAY_ITEMS) {
    state.compacted = true;
    shown.push(`… (+${arr.length - MAX_ARRAY_ITEMS} more)`);
  }
  return shown.join(', ');
}

function formatInlineRecord(obj: Record<string, unknown>, state: DistillState, depth = 0): string {
  if (depth >= MAX_DISTILL_DEPTH) {
    state.compacted = true;
    return formatScalar(obj, state);
  }
  const sorted = sortKeysByRelevance(Object.entries(obj));
  return sorted
    .map(([k, v]) => {
      const label = humanizeKey(k, false);
      const rendered = Array.isArray(v)
        ? formatPrimitiveArray(v, state)
        : isRecord(v)
          ? `{ ${formatInlineRecord(v, state, depth + 1)} }`
          : formatScalar(v, state);
      return `${label}: ${rendered}`;
    })
    .join(', ');
}

function formatArrayItem(item: unknown, state: DistillState): string {
  if (!isRecord(item)) {
    return Array.isArray(item) ? formatPrimitiveArray(item, state) : formatScalar(item, state);
  }
  const headlineKey = ITEM_HEADLINE_KEYS.find(
    (candidate) => typeof item[candidate] === 'string' && item[candidate].trim().length > 0,
  );
  const qtyKey = ITEM_QUANTITY_KEYS.find((candidate) => typeof item[candidate] === 'number');
  if (!headlineKey) return formatInlineRecord(item, state);

  const headline = formatScalar(item[headlineKey], state);
  const prefix = qtyKey !== undefined ? `${String(item[qtyKey])}x ${headline}` : headline;
  const rest: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(item)) {
    if (k === headlineKey || k === qtyKey) continue;
    rest[k] = v;
  }
  const restKeys = Object.keys(rest);
  if (restKeys.length === 0) return prefix;
  return `${prefix} (${formatInlineRecord(rest, state)})`;
}

function renderRecordLines(
  obj: Record<string, unknown>,
  state: DistillState,
  indent = '',
  depth = 0,
): readonly string[] {
  const lines: string[] = [];
  const sorted = sortKeysByRelevance(Object.entries(obj));
  for (const [key, value] of sorted) {
    const label = humanizeKey(key);
    if (Array.isArray(value)) {
      if (value.every((entry) => entry === null || typeof entry !== 'object')) {
        lines.push(`${indent}${label}: ${formatPrimitiveArray(value, state)}`);
      } else if (value.length === 1) {
        lines.push(`${indent}${label}: ${formatArrayItem(value[0], state)}`);
      } else {
        lines.push(`${indent}${label}:`);
        for (const entry of value.slice(0, MAX_ARRAY_ITEMS)) {
          lines.push(`${indent}  • ${formatArrayItem(entry, state)}`);
        }
        if (value.length > MAX_ARRAY_ITEMS) {
          state.compacted = true;
          lines.push(`${indent}  • … (+${value.length - MAX_ARRAY_ITEMS} more)`);
        }
      }
      continue;
    }
    if (isRecord(value)) {
      if (isFlatRecord(value) || depth >= 2) {
        lines.push(`${indent}${label}: ${formatInlineRecord(value, state)}`);
      } else {
        lines.push(`${indent}${label}:`);
        lines.push(...renderRecordLines(value, state, `${indent}  `, depth + 1));
      }
      continue;
    }
    lines.push(`${indent}${label}: ${formatScalar(value, state)}`);
  }
  return lines;
}

function distillStructuredJson(
  parsed: Record<string, unknown> | readonly unknown[],
  argOpaqueTokens: ReadonlySet<string>,
): { readonly text: string; readonly hasInvisible: boolean; readonly compacted: boolean } {
  const state: DistillState = { compacted: true, hasInvisible: hasAnyInvisible(parsed) };
  if (Array.isArray(parsed)) {
    const cleaned = cleanArray(parsed, argOpaqueTokens, state, 0);
    if (cleaned.length === 0) {
      return { text: '(empty)', hasInvisible: state.hasInvisible, compacted: true };
    }
    const lines = cleaned.slice(0, MAX_ARRAY_ITEMS).map((item) => `• ${formatArrayItem(item, state)}`);
    if (cleaned.length > MAX_ARRAY_ITEMS) {
      lines.push(`• … (+${cleaned.length - MAX_ARRAY_ITEMS} more)`);
    }
    return { text: lines.join('\n'), hasInvisible: state.hasInvisible, compacted: true };
  }

  const { value: unwrapped } = unwrapEnvelope(parsed as Record<string, unknown>);
  const cleaned = cleanRecord(unwrapped, argOpaqueTokens, state, 0);
  const source = Object.keys(cleaned).length > 0 ? cleaned : unwrapped;
  const lines = renderRecordLines(source, state);
  return {
    text: lines.length > 0 ? lines.join('\n') : '(empty)',
    hasInvisible: state.hasInvisible,
    compacted: state.compacted,
  };
}

function collapseInlineProseTokens(text: string): { readonly text: string; readonly compacted: boolean } {
  let compacted = false;
  const replaced = text.replace(/\S+/gu, (word) => {
    const trimmed = word.replace(LEADING_OR_TRAILING_PUNCTUATION, '');
    if (trimmed.length < 40 || !isOpaqueToken(trimmed)) return word;
    compacted = true;
    return word.replace(trimmed, collapseOpaqueToken(trimmed));
  });
  return { text: replaced, compacted };
}

function tryParseJsonStructure(text: string): Record<string, unknown> | unknown[] | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    if (isRecord(parsed) || Array.isArray(parsed)) return parsed;
    return undefined;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    return undefined;
  }
}

export interface DistilledContextResult {
  readonly text: string;
  readonly hasInvisible: boolean;
  readonly compacted: boolean;
}

/**
 * Distills an app's prior tool result into scannable chat-card lines:
 * structured JSON is unwrapped, pruned of null/empty/zero-clutter/duplicate-token noise, and ordered by
 * decision relevance; plain prose passes through untouched unless it embeds long opaque tokens.
 */
export function renderDistilledContext(rawText: string, argOpaqueTokens: ReadonlySet<string>): DistilledContextResult {
  const rawEscaped = escapeInvisibleChars(rawText);
  const wholeJson = tryParseJsonStructure(rawText);
  if (wholeJson !== undefined) {
    const distilled = distillStructuredJson(wholeJson, argOpaqueTokens);
    return {
      text: distilled.text,
      hasInvisible: rawEscaped.hasInvisible || distilled.hasInvisible,
      compacted: distilled.compacted,
    };
  }

  const rawLines = rawText.split('\n');
  if (rawLines.length > 1) {
    let anyJsonLine = false;
    let compacted = false;
    let hasInvisible = rawEscaped.hasInvisible;
    const outLines: string[] = [];
    for (const line of rawLines) {
      const parsedLine = tryParseJsonStructure(line);
      if (parsedLine !== undefined) {
        anyJsonLine = true;
        const distilled = distillStructuredJson(parsedLine, argOpaqueTokens);
        if (distilled.compacted) compacted = true;
        if (distilled.hasInvisible) hasInvisible = true;
        outLines.push(distilled.text);
      } else {
        const lineEscaped = escapeInvisibleChars(line);
        if (lineEscaped.hasInvisible) hasInvisible = true;
        const collapsed = collapseInlineProseTokens(lineEscaped.rendered);
        if (collapsed.compacted) compacted = true;
        outLines.push(collapsed.text);
      }
    }
    if (anyJsonLine) {
      return { text: outLines.join('\n'), hasInvisible, compacted };
    }
  }

  const prose = collapseInlineProseTokens(rawEscaped.rendered);
  return {
    text: prose.text,
    hasInvisible: rawEscaped.hasInvisible,
    compacted: prose.compacted,
  };
}
