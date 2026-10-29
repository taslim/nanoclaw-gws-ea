import { getDb } from '../../db/connection.js';
import { getPerson, mayNamePerson, type ForgottenPerson, type PersonToForget } from '../gws-ea-people/db.js';
import { clearTripSourceHistory } from '../gws-ea-whereabouts/db.js';
import { getWhereabouts } from '../gws-ea-whereabouts/records.js';
import { getManualSections } from './db.js';

export async function manualToRewrite(person: PersonToForget): Promise<string[]> {
  const [sections, whereabouts] = await Promise.all([getManualSections(), getWhereabouts()]);
  const tripSource = whereabouts.base.trip_source;
  return [
    ...sections.filter((section) => mayNamePerson(person, section.text)).map((section) => `Manual ${section.key}`),
    ...(tripSource !== null && mayNamePerson(person, tripSource) ? ['whereabouts trip source'] : []),
    ...whereabouts.places
      .filter((place) => mayNamePerson(person, `${place.label} ${place.locality}`))
      .map((place) => `whereabouts place ${place.id}`),
    ...whereabouts.stays
      .filter((stay) => stay.locality !== null && mayNamePerson(person, stay.locality))
      .map((stay) => `whereabouts stay ${stay.id}`),
  ];
}

/** Current text is main's to rewrite; only the kept previous values that name the person are cleared here. */
export async function forgetFromManual(person: ForgottenPerson): Promise<void> {
  const current = await getPerson(person.id);
  if (current === undefined) return;
  const named = { ...person, name: current.name };
  const names = (text: string): boolean => mayNamePerson(named, text);
  await getDb().transaction(async () => {
    const previous = await getDb().all<{ readonly key: string; readonly previous_text: string }>(
      'SELECT key, previous_text FROM gws_ea_manual_sections WHERE previous_text IS NOT NULL',
    );
    for (const section of previous) {
      if (names(section.previous_text))
        await getDb().run(
          'UPDATE gws_ea_manual_sections SET previous_text=NULL, previous_updated_at=NULL WHERE key=?',
          section.key,
        );
    }
    await clearTripSourceHistory(names);
  });
}
