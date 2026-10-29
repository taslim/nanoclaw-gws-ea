import { getDb } from '../../db/connection.js';
import { getPerson, mayNamePerson, type ForgottenPerson, type PersonToForget } from '../gws-ea-people/db.js';
import { getWhereabouts } from '../gws-ea-whereabouts/records.js';
import { getManualSections, withholdVersion } from './db.js';

export async function manualToRewrite(person: PersonToForget): Promise<string[]> {
  const [sections, whereabouts] = await Promise.all([getManualSections(), getWhereabouts()]);
  return [
    ...sections.filter((section) => mayNamePerson(person, section.text)).map((section) => `Manual ${section.key}`),
    ...whereabouts.places
      .filter((place) => mayNamePerson(person, `${place.label} ${place.locality}`))
      .map((place) => `whereabouts place ${place.id}`),
    ...whereabouts.stays
      .filter((stay) => stay.locality !== null && mayNamePerson(person, stay.locality))
      .map((stay) => `whereabouts stay ${stay.id}`),
  ];
}

export async function forgetFromManual(person: ForgottenPerson): Promise<void> {
  const current = await getPerson(person.id);
  if (current === undefined) return;
  const named = { ...person, name: current.name };
  await getDb().transaction(async () => {
    const sections = await getManualSections();
    for (const section of sections) {
      if (mayNamePerson(named, section.text)) await withholdVersion('section', section.key, section.text);
    }
    const previous = await getDb().all<{ readonly key: string; readonly previous_text: string }>(
      'SELECT key, previous_text FROM gws_ea_manual_sections WHERE previous_text IS NOT NULL',
    );
    for (const section of previous) {
      if (mayNamePerson(named, section.previous_text))
        await getDb().run(
          'UPDATE gws_ea_manual_sections SET previous_text=NULL, previous_updated_at=NULL WHERE key=?',
          section.key,
        );
    }
    const whereabouts = await getWhereabouts();
    for (const place of whereabouts.places) {
      if (mayNamePerson(named, `${place.label} ${place.locality}`)) await withholdVersion('place', place.id, place);
    }
    for (const stay of whereabouts.stays) {
      if (stay.locality !== null && mayNamePerson(named, stay.locality)) await withholdVersion('stay', stay.id, stay);
    }
  });
}
