import fs from 'node:fs';
import path from 'node:path';
import { addStay } from '../../../src/modules/gws-ea-whereabouts/db.js';
import { addPerson } from '../../../src/modules/gws-ea-people/db.js';
import { ensureMemoryScaffold } from '../../../container/agent-runner/src/memory/scaffold.js';
import type { ScenarioCase } from '../types.js';

/** Imported only after preparation has changed into the new synthetic host. */
export async function seedScenarioStores(scenario: ScenarioCase, agent: string): Promise<void> {
  if (scenario.audience !== 'main') return;
  ensureMemoryScaffold(agent);
  if (scenario.id === 'trip-zone')
    await addStay({
      locality: 'London',
      zone: 'Europe/London',
      start: '2026-11-02',
      end: '2026-11-06',
      source: 'said',
      certainty: 'certain',
    });
  const people =
    scenario.id === 'unknown-pronouns'
      ? [
          {
            name: 'Juno Hale',
            level: 'active',
            identity: 'juno.hale@example.test',
            basis: 'New project coordinator.',
            note: 'Juno Hale is the new project coordinator. No pronouns have been supplied or observed.',
          },
        ]
      : scenario.id === 'principal-does-it' || scenario.id === 'missing-remy'
        ? [
            {
              name: 'Remy Vance',
              level: 'close',
              identity: 'remy.vance@example.test',
              basis: 'Morgan said Remy is a close friend.',
              note: 'Remy Vance is a close friend of Morgan Ellery.',
            },
          ]
        : [];
  for (const seed of people) {
    const person = await addPerson({
      name: seed.name,
      level: seed.level,
      identity: seed.identity,
      source: 'principal',
      basis: seed.basis,
    });
    const relative = `people/${person.id}.md`;
    fs.mkdirSync(path.join(agent, 'memory', 'people'), { recursive: true });
    fs.writeFileSync(
      path.join(agent, 'memory', relative),
      `---\ntype: note\n---\n\n# ${person.name}\n\nNative person record: ${person.id}.\n\n${seed.note}\n`,
    );
    fs.appendFileSync(
      path.join(agent, 'memory', 'index.md'),
      `\n- [${person.name}](${relative}) - conversation facts for ${person.id}\n`,
    );
  }
}
