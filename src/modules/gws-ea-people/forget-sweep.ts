/**
 * Forgetting again after a snapshot restore (R5, KTD8). A rollback that
 * restores state from before a forget brings the forgotten person back: in
 * the people store, and in main's memory. Before any inbound event routes,
 * the host sweeps the handoff gws-ea left:
 *
 *   1. it records the handed-over fingerprints, in one transaction;
 *   2. it keeps in the handoff the name of everyone holding a fingerprinted
 *      identity, before forgetting anyone, since afterwards nothing else
 *      holds their names;
 *   3. it forgets each through `forgetPerson`, hooks included; one it cannot
 *      forget (an identity with access in NanoClaw) is logged and skipped,
 *      and their fingerprints still refuse learning;
 *   4. it tells main, in one note, whom to clear from its memory again;
 *   5. it deletes the handoff.
 *
 * A host stopped at any step repeats the rest at its next start: recording
 * is idempotent, the names wait in the handoff, and the note's id is derived
 * from what it reports, so writing it again adds nothing.
 */
import { createHash } from 'node:crypto';

import { removePrivateFile } from '../../gws-ea/secrets.js';
import { log } from '../../log.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import { forgetPerson, listForgottenPeople, recordForgottenFingerprints } from './db.js';
import {
  readPeopleForgetHandoff,
  writePeopleForgetHandoff,
  type ForgottenFingerprint,
  type PeopleForgetHandoff,
} from './forget-handoff.js';

const LIST = new Intl.ListFormat('en', { style: 'long', type: 'conjunction' });

function noteText(names: readonly string[]): string {
  const files = names.length === 1 ? 'their file' : 'their files';
  return (
    `This assistant was rolled back to an earlier copy of its state, from before the principal asked you to forget ${LIST.format(names)}, so they came back. ` +
    `They are forgotten again. Clear them from your memory again: ${files} under \`memory/people/\` and every other mention.`
  );
}

/** The same handoff and names give the same id, so a note written before a stop is not written again. */
function noteId(fingerprints: readonly ForgottenFingerprint[], names: readonly string[]): string {
  const rows = fingerprints.map((row) => `${row.fingerprint} ${row.forgotten_at}`).sort();
  const digest = createHash('sha256')
    .update(JSON.stringify([rows, [...names].sort()]))
    .digest('hex')
    .slice(0, 32);
  return `gws-ea-people-forgotten-again-${digest}`;
}

async function tellMain(handoff: PeopleForgetHandoff, names: readonly string[]): Promise<void> {
  const result = await writeNoteForMain({
    id: noteId(handoff.fingerprints, names),
    timestamp: new Date().toISOString(),
    text: noteText(names),
    wake: true,
  });
  if (result === 'no-main' || result === 'no-principal') {
    log.warn('Nobody to tell of the people forgotten again after a snapshot restore', { result });
  }
}

async function forgetAgain(file: string): Promise<void> {
  const handoff = await readPeopleForgetHandoff(file);
  const pending = handoff?.pending_note ?? [];
  if (handoff === undefined || (handoff.fingerprints.length === 0 && pending.length === 0)) return;

  await recordForgottenFingerprints(handoff.fingerprints);
  const people = await listForgottenPeople();
  const names = [...new Set([...pending, ...people.map((person) => person.name)])];
  if (names.some((name) => !pending.includes(name))) {
    await writePeopleForgetHandoff(file, { ...handoff, pending_note: names });
  }

  const kept: Array<(typeof people)[number]> = [];
  for (const person of people) {
    /* eslint-disable no-catch-all/no-catch-all -- one person who cannot be forgotten must not keep the others */
    try {
      await forgetPerson({ id: person.id });
    } catch (err) {
      log.warn(
        'A person a snapshot restore brought back could not be forgotten again; their fingerprints still refuse learning',
        { personId: person.id, err },
      );
      kept.push(person);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }

  // Decided by person, not name: two people may share a name, and one kept must not hide the other forgotten.
  const forgottenNow = new Set(people.filter((person) => !kept.includes(person)).map((person) => person.name));
  const keptNames = new Set(kept.map((person) => person.name));
  const forgotten = names.filter((name) => forgottenNow.has(name) || !keptNames.has(name));
  if (forgotten.length > 0) await tellMain(handoff, forgotten);
  await removePrivateFile(file);
  log.info('Forgot again the people a snapshot restore brought back', {
    forgotten: people.length - kept.length,
    kept: kept.length,
  });
}

/**
 * Sweep the forget handoff at `file`, if there is one. Never throws: a sweep
 * that fails is logged, keeps the handoff for the next start, and lets the
 * host serve, since the fingerprints it recorded already refuse learning.
 */
export async function sweepForgetHandoff(file: string): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- the host serves on; the handoff stays for its next start */
  try {
    await forgetAgain(file);
  } catch (err) {
    log.error('Forgetting again after a snapshot restore failed; the handoff is kept for the next start', {
      file,
      err,
    });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
