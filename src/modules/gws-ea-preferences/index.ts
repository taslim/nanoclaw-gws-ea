import { registerResource, type ColumnDef } from '../../cli/crud.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { registerRequiredProjectDocSection, type RequiredProjectDocSection } from '../../project-doc-sections.js';
import {
  getSchedulingPreferences,
  getSchedulingPreferenceValues,
  PREFERENCE_KINDS,
  removeSchedulingPreference,
  setSchedulingPreference,
  WEEKDAY_NAMES,
  WEEKDAYS,
  type PreferenceKind,
  type PreferenceSource,
  type PreferenceTarget,
  type SchedulingPreferenceValues,
  type SetPreferenceInput,
  type Weekday,
} from './db.js';
import { gwsEaPreferencesMigration } from './migration.js';

registerMigration(gwsEaPreferencesMigration);

// ---------------------------------------------------------------------------
// Project-document summary: values only, never a basis or a reason.
// ---------------------------------------------------------------------------

const SOURCE_LABELS: Readonly<Record<PreferenceSource, string>> = {
  principal: 'set by the principal',
  learned: 'learned',
};

function days(weekdays: readonly Weekday[]): string {
  return weekdays.length === WEEKDAYS.length ? 'Every day' : weekdays.map((day) => WEEKDAY_NAMES[day]).join(', ');
}

function minutes(count: number): string {
  return `${count} minute${count === 1 ? '' : 's'}`;
}

/** Renders from the values type, so a main-only field cannot reach a project document. */
function summarizeSchedulingPreferences(values: SchedulingPreferenceValues): string | undefined {
  const source = (value: { readonly source: PreferenceSource }) => `(${SOURCE_LABELS[value.source]})`;
  const blocks = (
    [
      [
        'Working hours',
        values.working_hours.map(
          (value) =>
            `- ${WEEKDAY_NAMES[value.weekday]}: ${value.off ? 'not working' : `${value.start}-${value.end}`} ${source(value)}`,
        ),
      ],
      [
        'Protected times',
        values.protected_windows.map(
          (value) => `- ${days(value.weekdays)} ${value.start}-${value.end} ${source(value)}`,
        ),
      ],
      [
        'Default meeting lengths',
        values.meeting_lengths.map((value) => `- ${value.meeting_kind}: ${minutes(value.minutes)} ${source(value)}`),
      ],
      [
        'Buffers around meetings',
        values.buffers.map((value) => `- ${value.meeting_kind}: ${minutes(value.minutes)} ${source(value)}`),
      ],
      [
        'Preferred times',
        values.preferred_times.map(
          (value) => `- ${value.meeting_kind}: ${days(value.weekdays)} ${value.start}-${value.end} ${source(value)}`,
        ),
      ],
    ] as const
  )
    .filter(([, lines]) => lines.length > 0)
    .map(([title, lines]) => [`${title}:`, ...lines].join('\n'));
  if (blocks.length === 0) return undefined;
  return ["Times are the principal's local time. A value the principal set outranks a learned one.", ...blocks].join(
    '\n\n',
  );
}

async function preferencesSection(): Promise<RequiredProjectDocSection | undefined> {
  if (!(await getDb().hasTable('gws_ea_pref_working_hours'))) return undefined;
  const body = summarizeSchedulingPreferences(await getSchedulingPreferenceValues());
  return body === undefined ? undefined : { name: 'Scheduling Preferences', body };
}

registerRequiredProjectDocSection('gws-ea-preferences:summary', preferencesSection);

// ---------------------------------------------------------------------------
// `ncl preferences get | set | remove` — main's read and write path.
// ---------------------------------------------------------------------------

/** Flags every set or remove accepts whatever the kind, plus the dispatcher's group-scope auto-fill. */
const SHARED_FLAGS = new Set(['kind', 'source', 'basis', 'agent_group_id', 'group']);

const SET_FIELDS: Readonly<Record<PreferenceKind, readonly string[]>> = {
  'working-hours': ['weekday', 'start', 'end', 'off'],
  'protected-window': ['id', 'weekdays', 'start', 'end', 'reason'],
  'meeting-length': ['meeting_kind', 'minutes'],
  buffer: ['meeting_kind', 'minutes'],
  'preferred-time': ['meeting_kind', 'weekdays', 'start', 'end'],
};

const REMOVE_FIELD: Readonly<Record<PreferenceKind, string>> = {
  'working-hours': 'weekday',
  'protected-window': 'id',
  'meeting-length': 'meeting_kind',
  buffer: 'meeting_kind',
  'preferred-time': 'meeting_kind',
};

function flag(name: string): string {
  return `--${name.replace(/_/g, '-')}`;
}

function parseKind(value: unknown): PreferenceKind {
  const kind = PREFERENCE_KINDS.find((candidate) => candidate === value);
  if (!kind) throw new Error(`--kind must be one of: ${PREFERENCE_KINDS.join(', ')}`);
  return kind;
}

function onlyFields(args: Record<string, unknown>, kind: PreferenceKind, fields: readonly string[]): void {
  for (const [key, value] of Object.entries(args)) {
    if (value !== undefined && !SHARED_FLAGS.has(key) && !fields.includes(key)) {
      throw new Error(`${flag(key)} does not apply to ${kind}`);
    }
  }
}

function requiredString(args: Record<string, unknown>, key: string, kind: PreferenceKind): string {
  const value = args[key];
  if (typeof value !== 'string') throw new Error(`${flag(key)} is required for ${kind}`);
  return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}

function requiredNumber(args: Record<string, unknown>, key: string, kind: PreferenceKind): number {
  const value = args[key];
  if (typeof value !== 'number') throw new Error(`${flag(key)} is required for ${kind}`);
  return value;
}

function weekdayList(args: Record<string, unknown>): string[] | undefined {
  const value = optionalString(args, 'weekdays');
  return value === undefined
    ? undefined
    : value
        .split(',')
        .map((day) => day.trim())
        .filter((day) => day !== '');
}

function setInput(args: Record<string, unknown>): SetPreferenceInput {
  const kind = parseKind(args.kind);
  onlyFields(args, kind, SET_FIELDS[kind]);
  const provenance = { source: requiredString(args, 'source', kind), basis: requiredString(args, 'basis', kind) };
  switch (kind) {
    case 'working-hours': {
      const weekday = requiredString(args, 'weekday', kind);
      if (args.off === true) {
        if (args.start !== undefined || args.end !== undefined) {
          throw new Error(`Use either --off or --start and --end for ${kind}`);
        }
        return { kind, weekday, hours: 'off', ...provenance };
      }
      const hours = { start: requiredString(args, 'start', kind), end: requiredString(args, 'end', kind) };
      return { kind, weekday, hours, ...provenance };
    }
    case 'protected-window':
      return {
        kind,
        id: optionalString(args, 'id'),
        weekdays: weekdayList(args),
        start: requiredString(args, 'start', kind),
        end: requiredString(args, 'end', kind),
        reason: optionalString(args, 'reason'),
        ...provenance,
      };
    case 'meeting-length':
    case 'buffer':
      return {
        kind,
        meetingKind: requiredString(args, 'meeting_kind', kind),
        minutes: requiredNumber(args, 'minutes', kind),
        ...provenance,
      };
    case 'preferred-time':
      return {
        kind,
        meetingKind: requiredString(args, 'meeting_kind', kind),
        weekdays: weekdayList(args),
        start: requiredString(args, 'start', kind),
        end: requiredString(args, 'end', kind),
        ...provenance,
      };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown preference kind: ${String(unreachable)}`);
    }
  }
}

function removeTarget(args: Record<string, unknown>): PreferenceTarget {
  const kind = parseKind(args.kind);
  const field = REMOVE_FIELD[kind];
  onlyFields(args, kind, [field]);
  const value = requiredString(args, field, kind);
  switch (kind) {
    case 'working-hours':
      return { kind, weekday: value };
    case 'protected-window':
      return { kind, id: value };
    case 'meeting-length':
    case 'buffer':
    case 'preferred-time':
      return { kind, meetingKind: value };
    default: {
      const unreachable: never = kind;
      throw new Error(`Unknown preference kind: ${String(unreachable)}`);
    }
  }
}

/**
 * The guard admits the host and any agent whose CLI scope reaches this
 * resource; the preferences, with their main-only basis and reason, belong to
 * the canonical main alone.
 */
async function assertMainCaller(ctx: CallerContext): Promise<void> {
  if (ctx.caller === 'host') return;
  const profile = await getDb().get<{ main_agent_group_id: string | null }>(
    'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  const mainAgentGroupId = profile?.main_agent_group_id ?? null;
  if (mainAgentGroupId === null || ctx.agentGroupId !== mainAgentGroupId) {
    throw new Error("The principal's scheduling preferences are available only to main");
  }
}

const KIND_ARG: ColumnDef = {
  name: 'kind',
  type: 'string',
  description: 'Which preference.',
  required: true,
  enum: [...PREFERENCE_KINDS],
};
const WEEKDAY_ARG: ColumnDef = {
  name: 'weekday',
  type: 'string',
  description: 'working-hours: one weekday (mon, tue, wed, thu, fri, sat, sun).',
};
const ID_ARG: ColumnDef = {
  name: 'id',
  type: 'string',
  description: 'protected-window: the window to change or remove (from `get`).',
};
const MEETING_KIND_ARG: ColumnDef = {
  name: 'meeting_kind',
  type: 'string',
  description:
    'meeting-length, buffer, preferred-time: a short lowercase name such as one-on-one or external; `default` applies to any meeting without its own value.',
};

registerResource({
  name: 'preference',
  plural: 'preferences',
  // Custom verbs only: the generic CRUD handlers that read `table` and `idColumn` are not enabled.
  table: 'gws_ea_pref_working_hours',
  idColumn: 'id',
  description:
    "The principal's scheduling preferences: working hours, protected times, default meeting lengths, buffers, and preferred times by kind of meeting. Times are the principal's local 24-hour HH:MM. Only main may use them.",
  columns: [
    KIND_ARG,
    { name: 'source', type: 'string', description: 'principal or learned.', enum: ['principal', 'learned'] },
    { name: 'basis', type: 'string', description: 'Where the value came from. Main-only.' },
    { name: 'reason', type: 'string', description: 'protected-window: why the time is protected. Main-only.' },
    { name: 'updated_at', type: 'string', description: 'When the value was last set.', generated: true },
  ],
  operations: {},
  customOperations: {
    get: {
      access: 'open',
      description:
        'Read every stored preference with its source, basis, and update time, and each protected window with its reason and ID.',
      args: [],
      handler: async (_args, ctx) => {
        await assertMainCaller(ctx);
        return getSchedulingPreferences();
      },
    },
    set: {
      access: 'open',
      description:
        'Store one preference, replacing the value it names.\n\n' +
        'Use --source principal for what the principal states or corrects, and --source learned for a value derived from calendar history. ' +
        'A learned value never replaces one the principal set. --basis is a short account of where the value came from.\n\n' +
        'Shapes by --kind:\n' +
        '  working-hours     --weekday with --start and --end, or --off for a day the principal does not work\n' +
        '  protected-window  --start and --end, optional --weekdays (every day when omitted) and --reason; --id changes an existing window\n' +
        '  meeting-length    --meeting-kind and --minutes (1 or more)\n' +
        '  buffer            --meeting-kind and --minutes kept free before and after (0 or more)\n' +
        '  preferred-time    --meeting-kind, --start and --end, optional --weekdays (every day when omitted)',
      args: [
        KIND_ARG,
        {
          name: 'source',
          type: 'string',
          description: 'Who set the value.',
          required: true,
          enum: ['principal', 'learned'],
        },
        { name: 'basis', type: 'string', description: 'Where the value came from, in one short line.', required: true },
        WEEKDAY_ARG,
        {
          name: 'weekdays',
          type: 'string',
          description: 'protected-window, preferred-time: comma-separated weekdays, e.g. mon,wed,fri.',
        },
        { name: 'start', type: 'string', description: 'Start time, local 24-hour HH:MM.' },
        { name: 'end', type: 'string', description: 'End time, local 24-hour HH:MM (24:00 for midnight).' },
        { name: 'off', type: 'boolean', description: 'working-hours: the principal does not work that day.' },
        ID_ARG,
        { name: 'reason', type: 'string', description: 'protected-window: why the time is protected.' },
        MEETING_KIND_ARG,
        { name: 'minutes', type: 'number', description: 'meeting-length, buffer: whole minutes.' },
      ],
      examples: [
        'ncl preferences set --kind working-hours --weekday mon --start 09:00 --end 17:00 --source principal --basis "Said Mondays run 9 to 5"',
        'ncl preferences set --kind protected-window --weekdays mon,tue,wed,thu,fri --start 12:00 --end 13:00 --reason "Lunch" --source principal --basis "Asked to keep lunch free"',
        'ncl preferences set --kind meeting-length --meeting-kind one-on-one --minutes 30 --source learned --basis "Most common one-on-one length over eight weeks"',
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx);
        return setSchedulingPreference(setInput(args));
      },
    },
    remove: {
      access: 'open',
      description:
        'Forget one preference, returning it to unset: --weekday for working-hours, --id for protected-window, --meeting-kind otherwise.',
      args: [KIND_ARG, WEEKDAY_ARG, ID_ARG, MEETING_KIND_ARG],
      examples: [
        'ncl preferences remove --kind working-hours --weekday mon',
        'ncl preferences remove --kind protected-window --id w-1a2b3c4d',
      ],
      handler: async (args, ctx) => {
        await assertMainCaller(ctx);
        return { removed: await removeSchedulingPreference(removeTarget(args)) };
      },
    },
  },
});
