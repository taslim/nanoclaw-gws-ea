/**
 * GWS-EA's people store (KTD8, KTD10): one thin typed record per person,
 * holding only what the host enforces: who they are by identity, and their
 * one level. `main` reads and writes it through main-only `ncl people` verbs
 * and reads it live through a pointer section; what it knows of a person
 * lives in its own memory. The only people fact the host passes on is a
 * level for an identity (`getPersonLevel`). Other modules purge their own
 * data for a forgotten person through `registerPersonForgetHook`.
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { optionalString } from '../../gws-ea/validation.js';
import { registerRequiredProjectDocSection, type RequiredProjectDocSection } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import { assertMainCaller, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  addPerson,
  assertPeopleStoreRunning,
  CHANGE_SOURCES,
  findPeople,
  forgetPerson,
  getPerson,
  IDENTITY_SOURCES,
  listPeople,
  PERSON_LEVELS,
  setPersonLevel,
  updatePerson,
} from './db.js';
import { gwsEaPeopleMigration, gwsEaPeopleThinRecordMigration } from './migration.js';

registerMigration(gwsEaPeopleMigration);
registerMigration(gwsEaPeopleThinRecordMigration);

// ---------------------------------------------------------------------------
// Project-document pointer: main only, and never a record.
// ---------------------------------------------------------------------------

/**
 * main changes the store mid-conversation, so a copy composed when its
 * container started would go stale; it reads the store live instead. Other
 * groups get nothing: no person's record leaves main.
 */
export const MAIN_PEOPLE_POINTER =
  'Everyone the principal deals with has a record in their people store: their name, their identities (channel-qualified, such as `email:name@example.com`), and the one level that says where they stand, with where it came from. Read it with `ncl people find`, `ncl people get`, or `ncl people list` before you schedule with someone or say where they stand: the store is the only current copy, and a record from earlier in the conversation may have changed since. Anyone without a record is unknown. What you know about a person is in your memory, in their file under `memory/people/`.';

async function peopleSection(group: AgentGroup): Promise<RequiredProjectDocSection | undefined> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_people')) || !(await db.hasTable('gws_ea_profile'))) return undefined;
  if (group.id !== (await getMainAgentGroupId())) return undefined;
  return { name: 'People', body: MAIN_PEOPLE_POINTER };
}

registerRequiredProjectDocSection('gws-ea-people:pointer', peopleSection);

// ---------------------------------------------------------------------------
// `ncl people …` — main's read and write path.
// ---------------------------------------------------------------------------

/**
 * The guard admits the host and any agent whose CLI scope reaches this
 * resource; the people belong to the canonical main alone. A stopped store
 * refuses every verb, so main learns of it at once.
 */
async function asMain<T>(ctx: CallerContext, work: () => Promise<T>): Promise<T> {
  await assertMainCaller(ctx, 'people');
  await assertPeopleStoreRunning();
  return work();
}

function flag(name: string): string {
  return `--${name.replace(/_/g, '-')}`;
}

function requiredString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${flag(key)} is required`);
  return value;
}

const ID_ARG: ColumnDef = {
  name: 'id',
  type: 'string',
  required: true,
  description: 'The person, by the ID `find`, `list`, or `add` returned.',
};
const SOURCE_ARG: ColumnDef = {
  name: 'source',
  type: 'string',
  required: true,
  enum: [...CHANGE_SOURCES],
  description: 'Who is making the change: principal for what the principal says, learned for what you derived.',
};
const LEVEL_ARG: ColumnDef = {
  name: 'level',
  type: 'string',
  enum: [...PERSON_LEVELS],
  description:
    'inner-circle and close are usually the principal’s word; a level you judged yourself is --source learned.',
};
const BASIS_ARG: ColumnDef = {
  name: 'basis',
  type: 'string',
  required: true,
  description: 'Why the person has this level, in one short line.',
};
const IDENTITY_SOURCE_ARG: ColumnDef = {
  name: 'identity_source',
  type: 'string',
  enum: [...IDENTITY_SOURCES],
  description:
    'Where the identity came from. principal by default when --source principal; directory or calendar is required when --source learned.',
};
const NAME_ARG: ColumnDef = { name: 'name', type: 'string', description: "The person's name." };

registerResource({
  name: 'person',
  plural: 'people',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_people',
  idColumn: 'id',
  description:
    'The people the principal deals with: one record each, with a name, identities (channel-qualified handles such as email:name@example.com), and exactly one level (inner-circle, close, active, known; anyone without a record is unknown). What you know about a person belongs in your memory, not here. Only main may use them.',
  columns: [
    { name: 'id', type: 'string', description: 'The person.', generated: true },
    { name: 'name', type: 'string', description: "The person's name." },
    { name: 'level', type: 'string', description: 'Their one level.', enum: [...PERSON_LEVELS] },
    { name: 'level_source', type: 'string', description: 'Who set the level.', enum: [...CHANGE_SOURCES] },
    { name: 'level_basis', type: 'string', description: 'Why the person has this level.' },
    { name: 'updated_at', type: 'string', description: 'When the record last changed.', generated: true },
  ],
  operations: {},
  customOperations: {
    find: {
      access: 'open',
      description:
        'Find people by an identity (an address or a handle) or by a name.\n\n' +
        'A name matches an exact name first, then names whose words start with every word you give. The result says which rule matched; an empty result means nobody with a record matches. Other names someone goes by are aliases in their memory file.',
      args: [
        {
          name: 'query',
          type: 'string',
          description: 'A name, an email address, or a handle such as email:name@example.com.',
        },
      ],
      examples: ['ncl people find --query "Sam"', 'ncl people find --query sam@example.com'],
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const query = optionalString(args.query) ?? optionalString(args.id);
          if (query === undefined) throw new Error('--query is required');
          return findPeople(query);
        }),
    },
    get: {
      access: 'open',
      description:
        "Read one person's whole record: their name, identities with their source, and level with its source, basis, and time.",
      args: [ID_ARG],
      examples: ['ncl people get p-1a2b3c4d5e6f'],
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const id = requiredString(args, 'id');
          const person = await getPerson(id);
          if (!person) throw new Error(`No person ${JSON.stringify(id.trim())} exists`);
          return person;
        }),
    },
    list: {
      access: 'open',
      description: 'List everyone with a record, closest level first, or only those at one --level.',
      args: [LEVEL_ARG],
      examples: ['ncl people list', 'ncl people list --level close'],
      handler: async (args, ctx) => asMain(ctx, async () => listPeople(optionalString(args.level))),
    },
    add: {
      access: 'open',
      description:
        'Keep a new person with exactly one level.\n\n' +
        "Use --source principal for someone the principal tells you about, and --source learned for someone you came to know from the calendar, mail, or the directory: a learned level is active or known, and a learned identity names where you found it with --identity-source. When the principal gives you someone but not where they stand, add --level-source learned: the level is then your judgment, and learning may revise it. An identity the principal had forgotten is refused to learning; only the principal can add it back. The principal's own addresses and yours are never a person's.",
      args: [
        { ...NAME_ARG, required: true },
        { ...LEVEL_ARG, required: true },
        SOURCE_ARG,
        {
          name: 'level_source',
          type: 'string',
          enum: [...CHANGE_SOURCES],
          description:
            'Who chose the level, when not --source: learned when the principal gave you the person but not where they stand.',
        },
        BASIS_ARG,
        {
          name: 'identity',
          type: 'string',
          description: 'One identity, such as email:name@example.com (a bare address is an email identity).',
        },
        IDENTITY_SOURCE_ARG,
      ],
      examples: [
        'ncl people add --name "Pat Doe" --level close --source principal --basis "Said Pat is a close friend" --identity pat@example.com',
        'ncl people add --name "Sam Lee" --level active --source learned --basis "6 months to 2 Oct: 9 meetings, 4 one-on-ones" --identity email:sam@example.com --identity-source calendar',
        'ncl people add --name "Ann Ito" --level known --source principal --level-source learned --basis "Principal gave her address; no meetings yet" --identity ann@example.com',
      ],
      handler: async (args, ctx) =>
        asMain(ctx, async () =>
          addPerson({
            name: requiredString(args, 'name'),
            level: requiredString(args, 'level'),
            source: requiredString(args, 'source'),
            levelSource: optionalString(args.level_source),
            basis: requiredString(args, 'basis'),
            identity: optionalString(args.identity),
            identitySource: optionalString(args.identity_source),
          }),
        ),
    },
    update: {
      access: 'open',
      description:
        "Change a person's name or identities in one step.\n\n" +
        'Learning can add an identity it found (--identity-source directory or calendar) and remove one it added, but never removes one the principal gave.',
      args: [
        ID_ARG,
        SOURCE_ARG,
        NAME_ARG,
        { name: 'add_identity', type: 'string', description: 'An identity to add, such as email:name@example.com.' },
        IDENTITY_SOURCE_ARG,
        { name: 'remove_identity', type: 'string', description: 'An identity that is not this person’s.' },
      ],
      examples: [
        'ncl people update p-1a2b3c4d5e6f --source learned --add-identity email:pat@work.example.com --identity-source directory',
        'ncl people update p-1a2b3c4d5e6f --source principal --name "Patricia Doe"',
      ],
      handler: async (args, ctx) =>
        asMain(ctx, async () =>
          updatePerson({
            id: requiredString(args, 'id'),
            source: requiredString(args, 'source'),
            name: optionalString(args.name),
            addIdentity: optionalString(args.add_identity),
            identitySource: optionalString(args.identity_source),
            removeIdentity: optionalString(args.remove_identity),
          }),
        ),
    },
    'set-level': {
      access: 'open',
      description:
        "Set a person's one level, with who set it and why.\n\n" +
        'Before a level you judged replaces one the principal set, tell them.',
      args: [ID_ARG, { ...LEVEL_ARG, required: true }, SOURCE_ARG, BASIS_ARG],
      examples: ['ncl people set-level p-1a2b3c4d5e6f --level close --source principal --basis "Said Pat is close"'],
      handler: async (args, ctx) =>
        asMain(ctx, async () =>
          setPersonLevel({
            id: requiredString(args, 'id'),
            level: requiredString(args, 'level'),
            source: requiredString(args, 'source'),
            basis: requiredString(args, 'basis'),
          }),
        ),
    },
    forget: {
      access: 'open',
      description:
        'Forget a person, when the principal tells you to: their record, their identities, and the work on their email threads are deleted. Only a one-way fingerprint of each identity remains, so they are unknown from then on and only the principal can add them back.\n\n' +
        'Answers with their name and identities: clear them from your memory, their file and every other mention.',
      args: [ID_ARG],
      examples: ['ncl people forget p-1a2b3c4d5e6f'],
      handler: async (args, ctx) => asMain(ctx, async () => forgetPerson({ id: requiredString(args, 'id') })),
    },
  },
});

export {
  getPersonLevel,
  PERSON_LEVELS,
  registerPersonForgetHook,
  type ForgottenPerson,
  type PersonForgetHook,
  type PersonLevel,
} from './db.js';
