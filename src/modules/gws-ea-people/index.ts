/**
 * GWS-EA's people store (KTD8): one typed record per person, which the
 * principal controls. `main` reads and writes it through main-only
 * `ncl people` verbs and reads it live through a pointer section; the only
 * people fact the host passes on is a level for an identity
 * (`getPersonLevel`). Other modules purge their own data for a forgotten
 * person through `registerPersonForgetHook`.
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { optionalString } from '../../gws-ea/validation.js';
import { registerRequiredProjectDocSection, type RequiredProjectDocSection } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import { assertMainCaller, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { assertPrincipalProvenance } from '../gws-ea-profile/provenance.js';
import {
  addPerson,
  addPersonInstruction,
  assertPeopleStoreRunning,
  CHANGE_SOURCES,
  findPeople,
  forgetPerson,
  getPerson,
  IDENTITY_SOURCES,
  listPeople,
  PERSON_LEVELS,
  removePersonInstruction,
  setPersonLevel,
  updatePerson,
} from './db.js';
import { gwsEaPeopleMigration } from './migration.js';

registerMigration(gwsEaPeopleMigration);

// ---------------------------------------------------------------------------
// Project-document pointer: main only, and never a record.
// ---------------------------------------------------------------------------

/**
 * main changes the store mid-conversation, so a copy composed when its
 * container started would go stale; it reads the store live instead. Other
 * groups get nothing: no person's record leaves main.
 */
export const MAIN_PEOPLE_POINTER =
  "The people the principal deals with live in their typed people store: each person's identities (channel-qualified, such as `email:name@example.com`), names, organization, level, where that level came from, the principal's standing instructions for them, and notes. Read it with `ncl people find`, `ncl people get`, or `ncl people list` before you schedule with someone or say what you know about them: the store is the only current copy, and a record from earlier in the conversation may have changed since. Anyone without a record is unknown.";

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

/** A write, which counts as the principal's only in a turn answering the principal. */
async function asMainWriting<T>(ctx: CallerContext, args: Record<string, unknown>, work: () => Promise<T>): Promise<T> {
  return asMain(ctx, async () => {
    await assertPrincipalProvenance(ctx, args.source);
    return work();
  });
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
  description:
    'Who is making the change: principal for what the principal tells you in the message you are answering, learned for what you derived.',
};
const LEVEL_ARG: ColumnDef = {
  name: 'level',
  type: 'string',
  enum: [...PERSON_LEVELS],
  description: 'inner-circle and close come only from the principal; a learned level is active or known.',
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
const ORGANIZATION_ARG: ColumnDef = {
  name: 'organization',
  type: 'string',
  description: 'Where the person works; empty clears it.',
};
const NOTES_ARG: ColumnDef = {
  name: 'notes',
  type: 'string',
  description: 'Notes about the person; empty clears them.',
};

registerResource({
  name: 'person',
  plural: 'people',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_people',
  idColumn: 'id',
  description:
    "The people the principal deals with: one record each, with identities (channel-qualified handles such as email:name@example.com), names, organization, exactly one level (inner-circle, close, active, known; anyone without a record is unknown), the principal's standing instructions, and notes. Only main may use them.",
  columns: [
    { name: 'id', type: 'string', description: 'The person.', generated: true },
    { name: 'name', type: 'string', description: "The person's name." },
    { name: 'organization', type: 'string', description: 'Where the person works.' },
    { name: 'level', type: 'string', description: 'Their one level.', enum: [...PERSON_LEVELS] },
    { name: 'level_source', type: 'string', description: 'Who set the level.', enum: [...CHANGE_SOURCES] },
    { name: 'level_basis', type: 'string', description: 'Why the person has this level.' },
    { name: 'notes', type: 'string', description: 'Notes about the person.' },
    { name: 'updated_at', type: 'string', description: 'When the record last changed.', generated: true },
  ],
  operations: {},
  customOperations: {
    find: {
      access: 'open',
      description:
        'Find people by an identity (an address or a handle) or by a name.\n\n' +
        'A name matches an exact remembered name first, then an exact name, then names whose words start with every word you give. The result says which rule matched; an empty result means nobody with a record matches.',
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
        "Read one person's whole record: identities with their source, names, organization, level with its source, basis, and time, standing instructions, and notes.",
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
        ORGANIZATION_ARG,
        NOTES_ARG,
        {
          name: 'identity',
          type: 'string',
          description: 'One identity, such as email:name@example.com (a bare address is an email identity).',
        },
        IDENTITY_SOURCE_ARG,
        {
          name: 'remembered_name',
          type: 'string',
          description: 'A name the principal uses for this person, remembered so it resolves to them. Principal only.',
        },
      ],
      examples: [
        'ncl people add --name "Pat Doe" --level close --source principal --basis "Said Pat is a close friend" --identity pat@example.com --remembered-name Pat',
        'ncl people add --name "Sam Lee" --level active --source learned --basis "6 months to 2 Oct: 9 meetings, 4 one-on-ones" --identity email:sam@example.com --identity-source calendar',
        'ncl people add --name "Ann Ito" --level known --source principal --level-source learned --basis "Principal gave her address; no meetings yet" --identity ann@example.com --remembered-name Ann',
      ],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          addPerson({
            name: requiredString(args, 'name'),
            level: requiredString(args, 'level'),
            source: requiredString(args, 'source'),
            levelSource: optionalString(args.level_source),
            basis: requiredString(args, 'basis'),
            organization: optionalString(args.organization),
            notes: optionalString(args.notes),
            identity: optionalString(args.identity),
            identitySource: optionalString(args.identity_source),
            rememberedName: optionalString(args.remembered_name),
          }),
        ),
    },
    update: {
      access: 'open',
      description:
        "Change a person's name, organization, notes, identities, or remembered names in one step.\n\n" +
        'Learning can add an identity it found (--identity-source directory or calendar) and remove one it added, but never removes one the principal gave. Remembered names come only from the principal.',
      args: [
        ID_ARG,
        SOURCE_ARG,
        NAME_ARG,
        ORGANIZATION_ARG,
        NOTES_ARG,
        { name: 'add_identity', type: 'string', description: 'An identity to add, such as email:name@example.com.' },
        IDENTITY_SOURCE_ARG,
        { name: 'remove_identity', type: 'string', description: 'An identity that is not this person’s.' },
        { name: 'add_remembered_name', type: 'string', description: 'A name the principal uses for this person.' },
        { name: 'remove_remembered_name', type: 'string', description: 'A remembered name to take back.' },
      ],
      examples: [
        'ncl people update p-1a2b3c4d5e6f --source learned --add-identity email:pat@work.example.com --identity-source directory',
        'ncl people update p-1a2b3c4d5e6f --source principal --add-remembered-name "Patty"',
      ],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          updatePerson({
            id: requiredString(args, 'id'),
            source: requiredString(args, 'source'),
            name: optionalString(args.name),
            organization: optionalString(args.organization),
            notes: optionalString(args.notes),
            addIdentity: optionalString(args.add_identity),
            identitySource: optionalString(args.identity_source),
            removeIdentity: optionalString(args.remove_identity),
            addRememberedName: optionalString(args.add_remembered_name),
            removeRememberedName: optionalString(args.remove_remembered_name),
          }),
        ),
    },
    'set-level': {
      access: 'open',
      description:
        "Set a person's one level.\n\n" +
        'A level the principal set changes only on the principal’s word. A learned level is active or known, and never replaces one the principal set.',
      args: [ID_ARG, { ...LEVEL_ARG, required: true }, SOURCE_ARG, BASIS_ARG],
      examples: ['ncl people set-level p-1a2b3c4d5e6f --level close --source principal --basis "Said Pat is close"'],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          setPersonLevel({
            id: requiredString(args, 'id'),
            level: requiredString(args, 'level'),
            source: requiredString(args, 'source'),
            basis: requiredString(args, 'basis'),
          }),
        ),
    },
    instruct: {
      access: 'open',
      description:
        'Keep one of the principal’s standing instructions for a person. Only the principal gives them: --source learned is refused.',
      args: [
        ID_ARG,
        { name: 'text', type: 'string', required: true, description: 'The instruction, in one line.' },
        SOURCE_ARG,
      ],
      examples: ['ncl people instruct p-1a2b3c4d5e6f --text "Always make room for Pat" --source principal'],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          addPersonInstruction({
            id: requiredString(args, 'id'),
            text: requiredString(args, 'text'),
            source: requiredString(args, 'source'),
          }),
        ),
    },
    unsay: {
      access: 'open',
      description: 'Take back one standing instruction, by its ID from `get`. Only the principal takes one back.',
      args: [{ ...ID_ARG, description: 'The instruction, by its ID from `get`.' }, SOURCE_ARG],
      examples: ['ncl people unsay i-1a2b3c4d5e6f --source principal'],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          removePersonInstruction({ id: requiredString(args, 'id'), source: requiredString(args, 'source') }),
        ),
    },
    forget: {
      access: 'open',
      description:
        'Forget a person, when the principal tells you to: their record, identities, names, instructions, and everything kept about them are deleted. Only a one-way fingerprint of each identity remains, so they are unknown from then on and only the principal can add them back.',
      args: [ID_ARG, SOURCE_ARG],
      examples: ['ncl people forget p-1a2b3c4d5e6f --source principal'],
      handler: async (args, ctx) =>
        asMainWriting(ctx, args, async () =>
          forgetPerson({ id: requiredString(args, 'id'), source: requiredString(args, 'source') }),
        ),
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
