import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { GwsEaError } from './types.js';

/**
 * Process-wide secret redaction for everything the control plane writes to a
 * log, an error, a fixture, or a diagnostic bundle. A secret learned anywhere
 * in the process is redacted everywhere in the process, so registration is
 * global rather than scoped to one run.
 */
export const REDACTED = '[REDACTED]';

const MINIMUM_SECRET_LENGTH = 8;
const MAX_SECRET_FILE_BYTES = 1024 * 1024;
const MAX_PENDING_LINE_CHARACTERS = 64 * 1024;
const OMITTED_LINE = `[output line over ${MAX_PENDING_LINE_CHARACTERS / 1024} KiB omitted]`;
// Enough of a dropped line's unscanned end to finish a PEM marker split across chunks.
const PEM_MARKER_CARRY_CHARACTERS = 256;

const PEM_BLOCK = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?-----END [A-Z0-9 ]+-----/gu;
const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----/u;
const PEM_END = /-----END [A-Z0-9 ]+-----/u;
const PEM_MARKER = /-----(BEGIN|END) [A-Z0-9 ]+-----/gu;
const PEM_UNTIL_END = /^[\s\S]*?-----END [A-Z0-9 ]+-----/u;
const PEM_FROM_BEGIN = /-----BEGIN [A-Z0-9 ]+-----[\s\S]*$/u;

const PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  // JSON (or JSON-in-JSON) `private_key` values, even when PEM markers are absent.
  [/(private_key\\*"\s*:\s*\\*")(?:[^"\\]|\\(?!"))*/gu, `$1${REDACTED}`],
  [/\b(bearer)\s+[A-Za-z0-9\-._~+/]+=*/giu, `$1 ${REDACTED}`],
  [/\b([a-z][a-z0-9+.-]*:\/\/[^\s/:@]*:)[^\s/@]+@/giu, `$1${REDACTED}@`],
  [/\bya29\.[A-Za-z0-9._-]+/gu, REDACTED],
  [/\bsk-ant-[A-Za-z0-9_-]+/gu, REDACTED],
  [/\boc_[A-Za-z0-9_-]{16,}/gu, REDACTED],
  [/\beyJ[A-Za-z0-9_\-+/=]{8,}(?:\.[A-Za-z0-9_\-+/=]*)*/gu, REDACTED],
];

const secrets = new Set<string>();
let secretsByLength: readonly string[] = [];

/** Register one secret value, with its trimmed, per-line, and JSON-escaped forms. */
export function registerSecret(value: string): void {
  const candidates = [
    value,
    value.trim(),
    JSON.stringify(value).slice(1, -1),
    ...value.split(/\r?\n/u).map((line) => line.trim()),
  ];
  const before = secrets.size;
  for (const candidate of candidates) {
    if (candidate.length >= MINIMUM_SECRET_LENGTH) secrets.add(candidate);
  }
  if (secrets.size !== before) secretsByLength = [...secrets].sort((left, right) => right.length - left.length);
}

/** Register the contents of every regular file beneath a secret directory. A missing directory registers nothing. */
export async function registerSecretDirectory(directory: string): Promise<void> {
  let entries;
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  await Promise.all(
    entries.map(async (entry) => {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) return registerSecretDirectory(file);
      if (!entry.isFile()) return;
      if ((await lstat(file)).size > MAX_SECRET_FILE_BYTES) {
        throw new GwsEaError('unsafe_secret', `Secret file is too large to register for redaction: ${file}`);
      }
      registerSecret(await readFile(file, 'utf8'));
    }),
  );
}

function redactPemBlocks(text: string): string {
  let result = text.replace(PEM_BLOCK, REDACTED);
  // A tail window or chunk can cut a block: redact from the start to an orphan
  // END marker, and from an orphan BEGIN marker to the end.
  if (PEM_END.test(result)) result = result.replace(PEM_UNTIL_END, REDACTED);
  if (PEM_BEGIN.test(result)) result = result.replace(PEM_FROM_BEGIN, REDACTED);
  return result;
}

/** Redact registered secrets and known secret shapes from text bound for a log, error, or fixture. */
export function redact(text: string): string {
  let result = text;
  for (const secret of secretsByLength) {
    if (result.includes(secret)) result = result.split(secret).join(REDACTED);
  }
  result = redactPemBlocks(result);
  for (const [pattern, replacement] of PATTERNS) result = result.replace(pattern, replacement);
  return result;
}

/** A failure's code as gws-ea reports it: a GWS-EA error's own code, `unexpected` for anything else. */
export function safeErrorCode(error: unknown): string {
  return error instanceof GwsEaError ? error.code : 'unexpected';
}

/** A failure's message as gws-ea reports it: only a GWS-EA error's own message, redacted, is ever shown. */
export function safeErrorMessage(error: unknown): string {
  return error instanceof GwsEaError ? redact(error.message) : 'Unexpected control-plane failure.';
}

export interface StreamRedactor {
  /** Accept a chunk and return the redacted text of every line it completes. */
  push(chunk: string): string;
  /** Return the redacted remainder once the stream ends. */
  end(): string;
}

/**
 * Line-buffered redaction for teed streams; a line is the unit of redaction. A
 * PEM block split across lines or chunks is swallowed from its BEGIN marker
 * through its END marker, so body lines between them never pass. A line longer
 * than the bound cannot be redacted in bounded memory, so none of its text is
 * written: one marker stands in for it, and its PEM markers still open or close
 * a block.
 */
export function createStreamRedactor(): StreamRedactor {
  // While `dropping`, `pending` holds only the unscanned end of the dropped line.
  let pending = '';
  let insidePem = false;
  let dropping = false;

  // Dropped text moves the PEM state to its last marker; returns the end a split marker may still complete.
  const skip = (text: string): string => {
    let scanned = 0;
    for (const marker of text.matchAll(PEM_MARKER)) {
      insidePem = marker[1] === 'BEGIN';
      scanned = marker.index + marker[0].length;
    }
    return text.slice(Math.max(scanned, text.length - PEM_MARKER_CARRY_CHARACTERS));
  };

  const emit = (line: string, terminated: boolean): string => {
    const newline = terminated ? '\n' : '';
    if (insidePem) {
      const end = PEM_END.exec(line);
      if (!end) return '';
      insidePem = false;
      return `${redact(line.slice(end.index + end[0].length))}${newline}`;
    }
    const begin = PEM_BEGIN.exec(line);
    if (begin && !PEM_END.test(line.slice(begin.index))) {
      insidePem = true;
      return `${redact(line.slice(0, begin.index))}${REDACTED}`;
    }
    return `${redact(line)}${newline}`;
  };

  return {
    push(chunk) {
      let text = `${pending}${chunk}`;
      let output = '';
      if (dropping) {
        const newline = text.indexOf('\n');
        if (newline === -1) {
          pending = skip(text);
          return '';
        }
        skip(text.slice(0, newline));
        dropping = false;
        // As emit() does, a line that leaves a PEM block open leaves its newline to the END line.
        output = insidePem ? '' : '\n';
        text = text.slice(newline + 1);
      }
      const lines = text.split('\n');
      pending = lines.pop() ?? '';
      output += lines.map((line) => emit(line, true)).join('');
      if (pending.length >= MAX_PENDING_LINE_CHARACTERS) {
        output += OMITTED_LINE;
        pending = skip(pending);
        dropping = true;
      }
      return output;
    },
    end() {
      const output = !dropping && pending ? emit(pending, false) : '';
      pending = '';
      insidePem = false;
      dropping = false;
      return output;
    },
  };
}

/** The key names of a dotenv file; values never leave this function. */
export function envKeyNames(contents: string): string[] {
  const keys: string[] = [];
  for (const line of contents.split(/\r?\n/u)) {
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/u.exec(line);
    if (match?.[1]) keys.push(match[1]);
  }
  return keys;
}
