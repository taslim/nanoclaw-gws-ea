/**
 * The forget handoff (KTD8): how a forget survives a snapshot rollback. A
 * rollback that restores state from before a forget brings the forgotten
 * person back. gws-ea, as it restores, writes the fingerprints the restored
 * database lacks, read from the state it replaced, into this owner-only file
 * in the restored data directory; the people module's host start records
 * them, forgets again whoever holds one, tells main, and deletes the file.
 *
 * Side-effect free: gws-ea imports it without loading the people module.
 */
import path from 'node:path';

import { isErrno } from '../../community-portal/errors.js';
import { readOwnerOnlyFile, writePrivateTextFile } from '../../gws-ea/secrets.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { canonicalTimestamp, isRecord, parseJson, requireString } from '../../gws-ea/validation.js';

const INVALID = 'invalid_people_forget_handoff';
const LABEL = 'The people forget handoff';

/** A fingerprint as `gws_ea_people_fingerprints` holds it: an HMAC-SHA256 in lowercase hex. */
const FINGERPRINT_PATTERN = /^[0-9a-f]{64}$/u;

/** The handoff's file under a NanoClaw data directory (`data/`, `state/data` in an instance). */
export function peopleForgetHandoffFile(dataDir: string): string {
  return path.join(dataDir, 'gws-ea', 'people-forget-handoff.json');
}

/** One row of `gws_ea_people_fingerprints`. */
export interface ForgottenFingerprint {
  readonly fingerprint: string;
  /** When the identity was forgotten, as `Date#toISOString` writes it. */
  readonly forgotten_at: string;
}

export interface PeopleForgetHandoff {
  /** The rows the restored database lacks; gws-ea writes these. */
  readonly fingerprints: readonly ForgottenFingerprint[];
  /** The host's own: the names it is forgetting again, kept until main has been told. */
  readonly pending_note?: readonly string[];
}

function invalid(what: string): GwsEaError {
  return new GwsEaError(INVALID, `${LABEL} is invalid: ${what}`);
}

function parseFingerprint(value: unknown, index: number): ForgottenFingerprint {
  if (!isRecord(value)) throw invalid(`fingerprints[${index}] must be an object`);
  const { fingerprint } = value;
  if (typeof fingerprint !== 'string' || !FINGERPRINT_PATTERN.test(fingerprint)) {
    throw invalid(`fingerprints[${index}].fingerprint must be 64 lowercase hex characters`);
  }
  const forgottenAt = canonicalTimestamp(value.forgotten_at);
  if (forgottenAt === undefined) throw invalid(`fingerprints[${index}].forgotten_at must be an ISO-8601 UTC timestamp`);
  return { fingerprint, forgotten_at: forgottenAt };
}

/** The handoff in `value`, every row checked: a file with one bad row is refused whole. */
function parseHandoff(value: unknown): PeopleForgetHandoff {
  if (!isRecord(value)) throw invalid('it must be an object');
  if (!Array.isArray(value.fingerprints)) throw invalid('fingerprints must be an array');
  const fingerprints = value.fingerprints.map(parseFingerprint);
  if (value.pending_note === undefined) return { fingerprints };
  if (!Array.isArray(value.pending_note)) throw invalid('pending_note must be an array of names');
  const pendingNote = value.pending_note.map((name, index) =>
    requireString(name, `${LABEL} pending_note[${index}]`, INVALID),
  );
  return { fingerprints, pending_note: pendingNote };
}

/** The handoff, or undefined when there is none. An unsafe or malformed file is refused. */
export async function readPeopleForgetHandoff(file: string): Promise<PeopleForgetHandoff | undefined> {
  let source: string;
  try {
    source = await readOwnerOnlyFile(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  return parseHandoff(parseJson(source, LABEL, INVALID));
}

/** Replace the handoff atomically, owner-only, in its existing directory; a handoff the host would refuse is never written. */
export async function writePeopleForgetHandoff(file: string, handoff: PeopleForgetHandoff): Promise<void> {
  await writePrivateTextFile(file, `${JSON.stringify(parseHandoff(handoff), null, 2)}\n`);
}
