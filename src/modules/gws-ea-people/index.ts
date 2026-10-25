/**
 * GWS-EA's people store: one thin typed record per person, holding only what
 * the host enforces: who they are by identity, and their one level. `main`
 * reads and writes it through the main-only `ncl people` verbs; what it knows
 * of a person lives in its own memory. A reader other than main learns at
 * most a level for an identity (`getPersonLevel`), never a name. Other modules
 * purge their own data for a forgotten person through
 * `registerPersonForgetHook`, and put to main what only it can rewrite through
 * `registerPersonForgetReview`.
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { DATA_DIR } from '../../config.js';
import { registerMigration } from '../../db/migrations/index.js';
import { optionalString } from '../../gws-ea/validation.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerMessageInterceptor } from '../../router.js';
import { assertMainCaller } from '../gws-ea-profile/db.js';
import {
  addPerson,
  assertPeopleStoreRunning,
  CHANGE_SOURCES,
  findPeople,
  forgetPerson,
  getPerson,
  IDENTITY_SOURCES,
  listPeople,
  PeopleStoreStoppedError,
  PERSON_LEVELS,
  setPersonLevel,
  updatePerson,
} from './db.js';
import { peopleForgetHandoffFile } from './forget-handoff.js';
import { sweepForgetHandoff } from './forget-sweep.js';
import { gwsEaPeopleMigration, gwsEaPeopleThinRecordMigration } from './migration.js';

registerMigration(gwsEaPeopleMigration);
registerMigration(gwsEaPeopleThinRecordMigration);

// ---------------------------------------------------------------------------
// `ncl people …` — main's read and write path.
// ---------------------------------------------------------------------------

/**
 * Restoring the key is the operator's job, so main hears only what it can do;
 * the key's path and remedy go to the host log.
 */
const PEOPLE_STORE_UNAVAILABLE =
  "The people store can't be used right now, and restoring it is the operator's job. Tell the principal in a line that you can't look people up or change them for now, and carry on with the rest.";

function forCaller(ctx: CallerContext, error: unknown): unknown {
  if (ctx.caller !== 'agent') return error;
  log.error('The people store refused main until the operator restores it', { err: error });
  return new Error(PEOPLE_STORE_UNAVAILABLE);
}

/**
 * The guard admits the host and any agent whose CLI scope reaches this
 * resource; the people belong to the canonical main alone. A stopped store
 * refuses every verb, so main learns of it at once, in its own terms; the
 * operator's host caller gets the remedy.
 */
async function asMain<T>(ctx: CallerContext, work: () => Promise<T>): Promise<T> {
  await assertMainCaller(ctx, 'people');
  try {
    await assertPeopleStoreRunning();
  } catch (error) {
    throw forCaller(ctx, error);
  }
  try {
    return await work();
  } catch (error) {
    throw error instanceof PeopleStoreStoppedError ? forCaller(ctx, error) : error;
  }
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
    'inner-circle and close are usually the principal’s word. A level you judged yourself is learned: --source learned, or on add, --level-source learned.',
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
        "Use --source principal for someone the principal tells you about, and --source learned for someone you came to know from the calendar or the directory: a learned identity names where you found it with --identity-source. When the principal gives you someone but not where they stand, add --level-source learned: the level is then your judgment, and learning may revise it. An identity the principal had forgotten is refused to learning; only the principal can add it back. The principal's own addresses and yours are never a person's.",
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
        'Answers with their name and identities: clear them from your memory, their file and every other mention. `rewrite` lists, by kind and id, what else you wrote that may name them: rewrite each so none does.',
      args: [ID_ARG],
      examples: ['ncl people forget p-1a2b3c4d5e6f'],
      handler: async (args, ctx) => asMain(ctx, async () => forgetPerson({ id: requiredString(args, 'id') })),
    },
  },
});

// ---------------------------------------------------------------------------
// Forgetting again after a snapshot restore
// ---------------------------------------------------------------------------

let handoffSweep: Promise<void> | undefined;

/**
 * The host's one sweep of a forget handoff a snapshot restore left, started
 * by host start or by the first inbound event, whichever comes first: the
 * host opens routing before it starts its modules.
 */
function forgetHandoffSwept(): Promise<void> {
  handoffSweep ??= sweepForgetHandoff(peopleForgetHandoffFile(DATA_DIR));
  return handoffSweep;
}

onHostStart(() => forgetHandoffSwept());

// Holds every inbound event until the sweep has finished, so none reaches a
// person the restore brought back, then declines it: routing goes on as usual.
registerMessageInterceptor(async () => {
  await forgetHandoffSwept();
  return false;
});

export {
  getPersonLevel,
  PERSON_LEVELS,
  registerPersonForgetHook,
  registerPersonForgetReview,
  type ForgottenPerson,
  type PersonForgetHook,
  type PersonForgetReview,
  type PersonLevel,
  type PersonToForget,
} from './db.js';
