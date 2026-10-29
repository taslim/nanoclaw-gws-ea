import { randomUUID } from 'node:crypto';
import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

import { getDb } from '../../db/connection.js';
import { listPeople } from '../gws-ea-people/db.js';
import { htmlReadings } from '../gws-ea-privacy/html.js';
import { checkOutbound } from '../gws-ea-privacy/outbound.js';
import { compilePrivateValue, givesAway, streamOf } from '../gws-ea-privacy/match.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { getWhereabouts } from '../gws-ea-whereabouts/records.js';

export const LESSON_STATUSES = ['queued', 'accepted', 'folded', 'declined'] as const;
export type LessonStatus = (typeof LESSON_STATUSES)[number];
export interface Lesson {
  readonly id: string;
  readonly text: string;
  readonly status: LessonStatus;
  readonly created_at: string;
}

export class LessonRefusal extends Error {}
const refuse = (kind: string): never => {
  throw new LessonRefusal(`The lesson contains ${kind}. Rewrite it as a general principle without that detail.`);
};

async function checkLesson(text: string): Promise<void> {
  const outbound = await checkOutbound(text, 'others');
  if (!outbound.allowed) throw new LessonRefusal(`The lesson cannot be queued: ${outbound.reason}`);
  const [profile, people, whereabouts] = await Promise.all([getGwsEaProfile(), listPeople(), getWhereabouts()]);
  const rendered = micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  const readings = [streamOf([text]), ...htmlReadings(rendered)];
  const names = (name: string): string[] => [name, ...name.split(/\s+/u)].filter(Boolean);
  const contains = (values: readonly (string | null)[]): boolean =>
    values.some(
      (value) =>
        value !== null &&
        value.trim() !== '' &&
        readings.some((reading) => givesAway(compilePrivateValue('other', value), reading)),
    );
  if (contains([profile.principal_first_name, profile.principal_last_name, profile.principal_display_name]))
    refuse('the principal’s name');
  if (
    contains(
      whereabouts.places
        .flatMap((place) => [place.label, place.locality])
        .concat(whereabouts.stays.flatMap((stay) => stay.locality ?? [])),
    )
  )
    refuse('a whereabouts place');
  if (contains(people.flatMap((person) => names(person.name)))) refuse('a person’s name');
  if (contains(people.flatMap((person) => person.identities))) refuse('a person’s contact detail');
  const address = /[\p{L}\p{N}._%+-]+\s*@\s*[\p{L}\p{N}.-]+/u;
  for (const source of [text, rendered]) {
    let visible = source.normalize('NFKC').replace(/\p{Default_Ignorable_Code_Point}/gu, '');
    for (let round = 0; round < 4; round += 1) {
      if (address.test(visible)) refuse('an email address');
      visible = visible.replace(/(?:%[0-9a-f]{2})+/giu, (run) => {
        try {
          return decodeURIComponent(run);
        } catch (error) {
          if (error instanceof URIError) return run;
          throw error;
        }
      });
    }
  }
  if (readings.some((reading) => reading.phoneRuns.some((run) => run.length >= 7))) refuse('a phone number');
}

export async function listLessons(status?: LessonStatus): Promise<Lesson[]> {
  return getDb().all<Lesson>(
    `SELECT id,text,status,created_at FROM gws_ea_lessons${status ? ' WHERE status=?' : ''} ORDER BY created_at,id`,
    ...(status ? [status] : []),
  );
}

export async function addLesson(value: string): Promise<Lesson & { readonly added: boolean }> {
  const text = value.trim();
  if (!text) throw new LessonRefusal('A lesson needs a principle.');
  await checkLesson(text);
  return getDb().transaction(async () => {
    const result = await getDb().run(
      "INSERT INTO gws_ea_lessons (id,text,status,created_at) VALUES (?,?,'queued',?) ON CONFLICT(text) DO NOTHING",
      `lesson-${randomUUID()}`,
      text,
      new Date().toISOString(),
    );
    const stored = await getDb().get<Lesson>('SELECT id,text,status,created_at FROM gws_ea_lessons WHERE text=?', text);
    if (!stored) throw new Error('Lesson receipt unavailable');
    return { ...stored, added: result.changes > 0 };
  });
}
