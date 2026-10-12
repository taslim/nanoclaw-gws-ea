/**
 * GWS-EA's matters (KTD3): what the assistant must come back to after the
 * current turn, however small (R1). Each matter holds the principal's words
 * for it, its open loop, links to where the facts live, its next look, and
 * whether it is open (R2); big projects split into strands one level deep
 * (R29, KTD13). Only `main` keeps matters, through main-only `ncl matters`
 * verbs whose answers are bare data for it, never words for the principal
 * (R6). `get` reads each link live from its source (KTD5, `render.ts`).
 *
 * A matter's next look is one scheduled task in main's conversation
 * (KTD4, `looks.ts`), the daily sync brings main back to whatever waited for
 * it (KTD6, `sync.ts`), and the host keeps both on time without the model
 * (KTD7, `loop.ts`). Forgetting a person takes them off every matter
 * (R26, `forget.ts`).
 */
import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { registerMigration } from '../../db/migrations/index.js';
import { optionalString } from '../../gws-ea/validation.js';
import { onHostStart } from '../../host-lifecycle.js';
import { registerPersonForgetHook, registerPersonForgetReview } from '../gws-ea-people/index.js';
import { assertMainCaller } from '../gws-ea-profile/db.js';
import {
  getMatter,
  LINK_KINDS,
  listClosedMatters,
  listOpenMatters,
  placeInMatter,
  placeNowhere,
  type LinkRef,
} from './db.js';
import { forgetFromMatters, mattersToRewrite } from './forget.js';
import { closeMatterAndLook, lookVerdict, openMatterWithLook, updateMatterAndLook } from './looks.js';
import { runMattersLoop } from './loop.js';
import { gwsEaMattersMigration } from './migration.js';
import { parseNextLook, type NextLook } from './next-look.js';
import { principalTimezone, renderMatter } from './render.js';
import { syncVerdict, todayVerdict } from './sync.js';

registerMigration(gwsEaMattersMigration);

onHostStart(({ signal }) => {
  // Started, not awaited: host startup never waits on a pass.
  void runMattersLoop(signal);
});

// A forgotten person leaves every matter, and main is asked to rewrite each one whose words may still tell of them.
registerPersonForgetReview('gws-ea-matters:forget', mattersToRewrite);
registerPersonForgetHook('gws-ea-matters:forget', forgetFromMatters);

// ---------------------------------------------------------------------------
// `ncl matters …` — main's read and write path.
// ---------------------------------------------------------------------------

/** The guard admits the host and any agent whose CLI scope reaches this resource; matters are the canonical main's alone. */
async function asMain<T>(ctx: CallerContext, work: () => Promise<T>): Promise<T> {
  await assertMainCaller(ctx, 'matters');
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

/** The links the per-kind flags name, each flag holding one or more comma-separated references. */
function linksFrom(args: Record<string, unknown>): LinkRef[] {
  const links: LinkRef[] = [];
  for (const kind of LINK_KINDS) {
    const value = optionalString(args[kind]);
    if (value === undefined) continue;
    for (const reference of value.split(',')) {
      if (reference.trim() !== '') links.push({ kind, reference });
    }
  }
  return links;
}

/** `--unlink`: comma-separated `kind:reference` pairs, as `get` shows each link. */
function unlinksFrom(args: Record<string, unknown>): LinkRef[] {
  const value = optionalString(args.unlink);
  if (value === undefined) return [];
  return value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '')
    .map((entry) => {
      const colon = entry.indexOf(':');
      const kind = colon > 0 ? LINK_KINDS.find((candidate) => candidate === entry.slice(0, colon)) : undefined;
      if (kind === undefined) {
        throw new Error(
          `--unlink takes kind:reference, the kind one of ${LINK_KINDS.join(', ')}, such as person:p-1a2b3c4d5e6f; got ${JSON.stringify(entry)}`,
        );
      }
      return { kind, reference: entry.slice(colon + 1) };
    });
}

/** `--parent`: a project's id, or "" for none. */
function parentFrom(args: Record<string, unknown>): string | null | undefined {
  const value = optionalString(args.parent);
  if (value === undefined) return undefined;
  return value.trim() === '' ? null : value;
}

/** The next look `--look` or `--look-cron` asks for (KTD4), checked before anything is written. */
async function nextLookFrom(args: Record<string, unknown>): Promise<NextLook | undefined> {
  return parseNextLook(
    { at: optionalString(args.look), cron: optionalString(args.look_cron) },
    await principalTimezone(),
  );
}

const ID_ARG: ColumnDef = {
  name: 'id',
  type: 'string',
  required: true,
  description: 'The matter, by the id `open` or `list` gave.',
};
const TITLE_ARG: ColumnDef = {
  name: 'title',
  type: 'string',
  description: 'What the principal calls it, in their own words: one line.',
};
const OPEN_LOOP_ARG: ColumnDef = {
  name: 'open_loop',
  type: 'string',
  description: 'What the principal wants and what happens next, in two or three lines. Rewrite it as things change.',
};
const PARENT_ARG: ColumnDef = {
  name: 'parent',
  type: 'string',
  description:
    'The project this is a strand of, by id. Strands go one level deep: a strand cannot be a project, and a project cannot be a strand.',
};
const LOOK_ARGS: ColumnDef[] = [
  {
    name: 'look',
    type: 'string',
    description:
      "The next look, once: a date and time in the principal's time zone (2026-10-14T09:00), or with its UTC offset.",
  },
  {
    name: 'look_cron',
    type: 'string',
    description:
      "The next look, repeating: a five-field cron expression in the principal's time zone, at most four times a day. For a date that comes back every year (0 9 14 3 *) or a project's step-back (0 9 * * 1).",
  },
];
const LINK_ARGS: ColumnDef[] = [
  {
    name: 'thread',
    type: 'string',
    description:
      'Email threads by key (mail-…), comma-separated. A thread sits in one open matter: placing it moves it.',
  },
  {
    name: 'event',
    type: 'string',
    description:
      'Calendar events, each as <calendar id>/<event id>, comma-separated. An event sits in one open matter: placing it moves it.',
  },
  {
    name: 'file',
    type: 'string',
    description: 'Drive files by file id, comma-separated. A file sits in one open matter: placing it moves it.',
  },
  {
    name: 'person',
    type: 'string',
    description:
      'People by their id in the people store (p-…), comma-separated. A person can be in any number of matters.',
  },
  {
    name: 'memory',
    type: 'string',
    description: 'Memory files by path (memory/…), comma-separated. A memory file can be in any number of matters.',
  },
];

registerResource({
  name: 'matter',
  plural: 'matters',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_matters',
  idColumn: 'id',
  description:
    "What you must come back to after this turn, however small: one matter each, with a title in the principal's words, the open loop (what they want and what happens next), links to where the facts live, the next look, and whether it is open. A thread, event or file sits in one open matter at a time. Only main may use them, and no one else ever sees one.",
  columns: [
    { name: 'id', type: 'string', description: 'The matter.', generated: true },
    { name: 'title', type: 'string', description: "The principal's words for it." },
    { name: 'open_loop', type: 'string', description: 'What the principal wants and what happens next.' },
    { name: 'parent_id', type: 'string', description: 'The project it is a strand of.' },
    { name: 'outcome', type: 'string', description: 'How it ended, once closed.' },
    { name: 'look_task_id', type: 'string', description: 'The scheduled task that is its next look.' },
    { name: 'updated_at', type: 'string', description: 'When it last changed.', generated: true },
  ],
  operations: {},
  customOperations: {
    open: {
      access: 'open',
      description:
        'Open a matter for something you must come back to, with its next look and the links you have.\n\n' +
        'A thread, event or file in another open matter moves here; the answer names where it came from. Give --parent to open it as a strand of a project, when part of the project needs its own next look; links the whole project shares stay with the project.',
      args: [
        { ...TITLE_ARG, required: true },
        { ...OPEN_LOOP_ARG, required: true },
        ...LOOK_ARGS,
        PARENT_ARG,
        ...LINK_ARGS,
      ],
      examples: [
        'ncl matters open --title "Acme renewal" --open-loop "Wants it signed by Friday. Waiting on their redlines." --look 2026-10-14T09:00 --thread mail-0a1b2c3d --person p-1a2b3c4d5e6f',
        'ncl matters open --title "Juno\'s birthday" --open-loop "Gift and a card every year." --look-cron "0 9 7 3 *" --person p-1a2b3c4d5e6f',
      ],
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const look = await nextLookFrom(args);
          if (look === undefined) throw new Error('A matter opens with its next look: give --look or --look-cron');
          return openMatterWithLook(
            {
              title: requiredString(args, 'title'),
              openLoop: requiredString(args, 'open_loop'),
              parentId: parentFrom(args) ?? undefined,
              links: linksFrom(args),
            },
            look,
          );
        }),
    },
    place: {
      access: 'open',
      description:
        'Place pieces in an open matter, or nowhere when nothing about them needs keeping.\n\n' +
        'A thread, event or file in another open matter moves here, and the answer names where it came from. To merge two matters, place one’s links in the other, then close it. With --nowhere, give threads, events or files and no matter: each leaves the open matter it was in, and no matter opens. ' +
        'A thread waits to be placed before you hand it over with email_handoff, and external-email reads none of its mail until you do.',
      args: [
        {
          name: 'id',
          type: 'string',
          description: 'The open matter to place them in, by id. Leave it out with --nowhere.',
        },
        { name: 'nowhere', type: 'boolean', description: 'Place the threads, events or files in no matter.' },
        ...LINK_ARGS,
      ],
      examples: [
        'ncl matters place m-1a2b3c4d5e6f --thread mail-0a1b2c3d --file 1AbCdEfGhIjK',
        'ncl matters place --nowhere --thread mail-0a1b2c3d',
      ],
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const links = linksFrom(args);
          if (args.nowhere === true) {
            if (args.id !== undefined) throw new Error('--nowhere places pieces in no matter: leave out the matter id');
            return { nowhere: await placeNowhere(links) };
          }
          const id = optionalString(args.id);
          if (id === undefined) throw new Error('--id is required: the matter to place them in, or --nowhere');
          return placeInMatter(id, links);
        }),
    },
    update: {
      access: 'open',
      description:
        'Change a matter: reword it, move its next look, change its project, or take links off it.\n\n' +
        'Its title, open loop and, once closed, its outcome change without reopening it. A next look replaces the one it has; on a closed matter it reopens it, unless one of its threads, events or files now sits in another open matter, which the refusal names. A repeating next look is never replaced by a one-off: a one-off follow-up, such as checking a gift arrived, is a matter of its own. --unlink and --parent apply to an open matter. To add links, use place.',
      args: [
        ID_ARG,
        TITLE_ARG,
        OPEN_LOOP_ARG,
        { name: 'outcome', type: 'string', description: "A closed matter's outcome, reworded: one line." },
        { ...PARENT_ARG, description: `${PARENT_ARG.description} "" makes it a matter of its own.` },
        ...LOOK_ARGS,
        {
          name: 'unlink',
          type: 'string',
          description:
            'Links to take off, each as kind:reference as `get` shows it (person:p-1a2b3c4d5e6f), comma-separated.',
        },
      ],
      examples: [
        'ncl matters update m-1a2b3c4d5e6f --open-loop "Redlines are back. They sign Thursday." --look 2026-10-16T10:00',
        'ncl matters update m-1a2b3c4d5e6f --unlink person:p-1a2b3c4d5e6f',
      ],
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const look = await nextLookFrom(args);
          return updateMatterAndLook(
            {
              id: requiredString(args, 'id'),
              title: optionalString(args.title),
              openLoop: optionalString(args.open_loop),
              outcome: optionalString(args.outcome),
              parentId: parentFrom(args),
              unlink: unlinksFrom(args),
            },
            look,
          );
        }),
    },
    close: {
      access: 'open',
      description:
        'Close a matter with its outcome in a line, when nothing is left to come back to. Its next look ends.\n\n' +
        'What lasts belongs in memory. A closed matter stays readable with `get`. A project closes after its strands. New mail on its threads waits for you to place them again.',
      args: [ID_ARG, { name: 'outcome', type: 'string', required: true, description: 'How it ended: one line.' }],
      examples: ['ncl matters close m-1a2b3c4d5e6f --outcome "Signed on the 9th; terms in memory/clients/acme.md"'],
      handler: async (args, ctx) =>
        asMain(ctx, async () =>
          closeMatterAndLook({ id: requiredString(args, 'id'), outcome: requiredString(args, 'outcome') }),
        ),
    },
    get: {
      access: 'open',
      description:
        'Read one matter, open or closed, as it stands now: its words, next look, project and strands, and each link read live from Gmail, Calendar and Drive.\n\n' +
        'The view says when its links were read. Read it again before acting on one read a while ago. A link whose source did not answer says so.',
      args: [ID_ARG],
      examples: ['ncl matters get m-1a2b3c4d5e6f'],
      // The view is the answer, printed as it is.
      formatHuman: (view) => String(view),
      handler: async (args, ctx) =>
        asMain(ctx, async () => {
          const id = requiredString(args, 'id');
          const matter = await getMatter(id);
          if (!matter) throw new Error(`No matter ${JSON.stringify(id.trim())} exists`);
          return renderMatter(matter);
        }),
    },
    look: {
      access: 'open',
      description:
        "A next look's pre-task script, which runs on its own when the look comes: whether it wakes you, and while the matter is open, the matter read live as get reads it. To read a matter yourself, use get.",
      args: [ID_ARG],
      examples: ['ncl matters look m-1a2b3c4d5e6f'],
      // The runner reads the last line of a script's output as its verdict: one line of JSON.
      formatHuman: (verdict) => JSON.stringify(verdict),
      handler: async (args, ctx) => asMain(ctx, () => lookVerdict(requiredString(args, 'id'))),
    },
    sync: {
      access: 'open',
      description:
        "The daily sync's pre-task script, which runs on its own once a day before the principal's day starts: it wakes you only when something has waited for you, a note you have not read or a thread to place. The host keeps the sync and its time; you never set it.",
      args: [],
      examples: ['ncl matters sync'],
      // The runner reads the last line of a script's output as its verdict: one line of JSON.
      formatHuman: (verdict) => JSON.stringify(verdict),
      handler: async (_args, ctx) => asMain(ctx, syncVerdict),
    },
    today: {
      access: 'open',
      description:
        "Today as matters hold it: today's looks, the matters handed back without one, and the threads waiting to be placed. It is the script of a morning rundown the principal asks for: an --in-conversation task, theirs to move or drop.",
      args: [],
      examples: [
        'ncl matters today',
        'ncl tasks create --in-conversation --name "morning rundown" --recurrence "30 7 * * 1-5" --script "ncl matters today" --prompt "Their morning rundown"',
      ],
      formatHuman: (verdict) => JSON.stringify(verdict),
      handler: async (_args, ctx) => asMain(ctx, todayVerdict),
    },
    list: {
      access: 'open',
      description:
        "List every open matter's title and open loop, most recently changed first, each project's strands under it; or, with --closed, the closed ones with their outcomes.",
      args: [
        { name: 'closed', type: 'boolean', description: 'List closed matters instead, most recently closed first.' },
      ],
      examples: ['ncl matters list', 'ncl matters list --closed'],
      handler: async (args, ctx) =>
        asMain(ctx, async () => (args.closed === true ? listClosedMatters() : listOpenMatters())),
    },
  },
});
