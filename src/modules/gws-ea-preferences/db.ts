import { randomBytes } from 'node:crypto';

import { getDb } from '../../db/connection.js';
import { parseLine, parseOptionalLine } from '../../gws-ea/validation.js';

export const WEEKDAYS = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'] as const;
export type Weekday = (typeof WEEKDAYS)[number];

export const WEEKDAY_NAMES: Readonly<Record<Weekday, string>> = {
  mon: 'Monday',
  tue: 'Tuesday',
  wed: 'Wednesday',
  thu: 'Thursday',
  fri: 'Friday',
  sat: 'Saturday',
  sun: 'Sunday',
};

export const PREFERENCE_KINDS = [
  'working-hours',
  'protected-window',
  'meeting-length',
  'buffer',
  'preferred-time',
] as const;
export type PreferenceKind = (typeof PREFERENCE_KINDS)[number];

export const PREFERENCE_SOURCES = ['principal', 'learned'] as const;
export type PreferenceSource = (typeof PREFERENCE_SOURCES)[number];

/**
 * Fields only `main` may read. A basis can quote the events a value was
 * learned from, and a reason says why the principal protects a time, so every
 * values read path (`getSchedulingPreferenceValues`, the project-document
 * summary, and any later compartment) leaves both out.
 */
export const MAIN_ONLY_PREFERENCE_FIELDS = ['basis', 'reason'] as const;
export type MainOnlyPreferenceField = (typeof MAIN_ONLY_PREFERENCE_FIELDS)[number];

interface Provenance {
  readonly source: PreferenceSource;
  /** A short account of where the value came from. Main-only. */
  readonly basis: string;
  readonly updated_at: string;
}

/** Hours for one weekday, or `off` when the principal does not work that day. Times are local `HH:MM`. */
export type WorkingHoursPreference = Provenance & { readonly weekday: Weekday } & (
    | { readonly off: false; readonly start: string; readonly end: string }
    | { readonly off: true }
  );

/** A weekly time kept free, identified by its days and hours; `id` is its handle. */
export interface ProtectedWindowPreference extends Provenance {
  readonly id: string;
  readonly weekdays: readonly Weekday[];
  readonly start: string;
  readonly end: string;
  /** Why the principal protects it. Main-only. */
  readonly reason: string | null;
}

/** The default length of a kind of meeting. */
export interface MeetingLengthPreference extends Provenance {
  readonly meeting_kind: string;
  readonly minutes: number;
}

/** Minutes kept free before and after a kind of meeting. */
export interface BufferPreference extends Provenance {
  readonly meeting_kind: string;
  readonly minutes: number;
}

/** When a kind of meeting should preferably take place. */
export interface PreferredTimePreference extends Provenance {
  readonly meeting_kind: string;
  readonly weekdays: readonly Weekday[];
  readonly start: string;
  readonly end: string;
}

export interface SchedulingPreferences {
  readonly working_hours: readonly WorkingHoursPreference[];
  readonly protected_windows: readonly ProtectedWindowPreference[];
  readonly meeting_lengths: readonly MeetingLengthPreference[];
  readonly buffers: readonly BufferPreference[];
  readonly preferred_times: readonly PreferredTimePreference[];
}

/** The stored shape of each kind of preference. */
export interface PreferenceByKind {
  readonly 'working-hours': WorkingHoursPreference;
  readonly 'protected-window': ProtectedWindowPreference;
  readonly 'meeting-length': MeetingLengthPreference;
  readonly buffer: BufferPreference;
  readonly 'preferred-time': PreferredTimePreference;
}

export type SchedulingPreference = PreferenceByKind[PreferenceKind];

/** A preference without its main-only fields; distributes so each variant keeps its own value fields. */
export type PreferenceValue<T> = T extends unknown ? Omit<T, MainOnlyPreferenceField> : never;

export type SchedulingPreferenceValues = {
  readonly [K in keyof SchedulingPreferences]: readonly PreferenceValue<SchedulingPreferences[K][number]>[];
};

interface ClockRangeInput {
  /** Local 24-hour `HH:MM`. */
  readonly start: string;
  /** Local 24-hour `HH:MM`; `24:00` ends at midnight. */
  readonly end: string;
}

/** Unvalidated caller input: the store checks every field against its kind's shape. */
export type SetPreferenceInput = {
  /** `principal` when the principal stated or corrected it; `learned` when derived from calendar history. */
  readonly source: string;
  readonly basis: string;
} & (
  | { readonly kind: 'working-hours'; readonly weekday: string; readonly hours: ClockRangeInput | 'off' }
  | ({
      readonly kind: 'protected-window';
      /** Updates this window; without it, the window with the same days and hours is updated or a new one added. */
      readonly id?: string;
      /** Every day when omitted. */
      readonly weekdays?: readonly string[];
      readonly reason?: string;
    } & ClockRangeInput)
  | { readonly kind: 'meeting-length' | 'buffer'; readonly meetingKind: string; readonly minutes: number }
  | ({
      readonly kind: 'preferred-time';
      readonly meetingKind: string;
      /** Every day when omitted. */
      readonly weekdays?: readonly string[];
    } & ClockRangeInput)
);

/** Which preference to remove, and who is removing it: the principal, or the assistant on its own inference. */
export type PreferenceTarget = { readonly source: string } & (
  | { readonly kind: 'working-hours'; readonly weekday: string }
  | { readonly kind: 'protected-window'; readonly id: string }
  | { readonly kind: 'meeting-length' | 'buffer' | 'preferred-time'; readonly meetingKind: string }
);

export type RemovedPreference =
  | { readonly kind: 'working-hours'; readonly weekday: Weekday }
  | { readonly kind: 'protected-window'; readonly id: string }
  | { readonly kind: 'meeting-length' | 'buffer' | 'preferred-time'; readonly meeting_kind: string };

const MINUTES_PER_DAY = 24 * 60;
const BASIS_MAX_LENGTH = 280;
const REASON_MAX_LENGTH = 200;
const MEETING_KIND_MAX_LENGTH = 40;
const CLOCK_PATTERN = /^(\d{1,2}):(\d{2})$/u;
const MEETING_KIND_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const WEEKDAY_ALIASES: ReadonlyMap<string, Weekday> = new Map(
  WEEKDAYS.flatMap((day) => [
    [day, day],
    [WEEKDAY_NAMES[day].toLowerCase(), day],
  ]),
);

/** The tables keyed by kind of meeting, with the words their messages use. */
const MEETING_KIND_TABLES = {
  'meeting-length': { table: 'gws_ea_pref_meeting_lengths', label: 'meeting length' },
  buffer: { table: 'gws_ea_pref_buffers', label: 'buffer' },
  'preferred-time': { table: 'gws_ea_pref_preferred_times', label: 'preferred time' },
} as const;

// ---------------------------------------------------------------------------
// Parsing: every value is checked here before it reaches the schema's checks.
// ---------------------------------------------------------------------------

function parseWeekday(value: string): Weekday {
  const weekday = WEEKDAY_ALIASES.get(value.trim().toLowerCase());
  if (!weekday) {
    throw new Error(`Weekday ${JSON.stringify(value)} is invalid: use mon, tue, wed, thu, fri, sat, or sun`);
  }
  return weekday;
}

/** A canonical, ordered, duplicate-free weekday set; every day when omitted. */
function parseWeekdays(values: readonly string[] | undefined): Weekday[] {
  if (values === undefined) return [...WEEKDAYS];
  const days = new Set(values.map(parseWeekday));
  if (days.size === 0) throw new Error('At least one weekday is required');
  return WEEKDAYS.filter((day) => days.has(day));
}

function decodeWeekdays(stored: string): Weekday[] {
  return parseWeekdays(stored.split(','));
}

function formatClock(minutes: number): string {
  return `${String(Math.floor(minutes / 60)).padStart(2, '0')}:${String(minutes % 60).padStart(2, '0')}`;
}

function parseClock(value: string, edge: 'Start' | 'End'): number {
  const match = CLOCK_PATTERN.exec(value.trim());
  const minutes = match ? Number(match[1]) * 60 + Number(match[2]) : Number.NaN;
  const inDay = edge === 'Start' ? minutes < MINUTES_PER_DAY : minutes > 0 && minutes <= MINUTES_PER_DAY;
  if (!match || Number(match[2]) > 59 || !inDay) {
    const bounds = edge === 'Start' ? '00:00 to 23:59' : '00:01 to 24:00';
    throw new Error(`${edge} time ${JSON.stringify(value)} is invalid: use 24-hour HH:MM from ${bounds}`);
  }
  return minutes;
}

function parseRange(input: ClockRangeInput): { readonly start: number; readonly end: number } {
  const start = parseClock(input.start, 'Start');
  const end = parseClock(input.end, 'End');
  if (end <= start) {
    throw new Error(`The end time must be after the start time (got ${formatClock(start)} to ${formatClock(end)})`);
  }
  return { start, end };
}

function parseMinutes(value: number, minimum: 0 | 1, label: string): number {
  if (!Number.isInteger(value) || value < minimum || value > MINUTES_PER_DAY) {
    throw new Error(`${label} minutes must be a whole number from ${minimum} to ${MINUTES_PER_DAY}`);
  }
  return value;
}

function parseMeetingKind(value: string): string {
  const kind = value.trim().toLowerCase();
  if (kind.length > MEETING_KIND_MAX_LENGTH || !MEETING_KIND_PATTERN.test(kind)) {
    throw new Error(
      `Meeting kind ${JSON.stringify(value)} is invalid: use a short lowercase name such as one-on-one or default`,
    );
  }
  return kind;
}

function parseSource(value: string): PreferenceSource {
  const source = PREFERENCE_SOURCES.find((candidate) => candidate === value);
  if (!source) throw new Error(`Source ${JSON.stringify(value)} is invalid: use principal or learned`);
  return source;
}

function parseReason(value: string | undefined): string | null {
  return value === undefined ? null : parseOptionalLine(value, 'Reason', REASON_MAX_LENGTH);
}

function newWindowId(): string {
  return `w-${randomBytes(4).toString('hex')}`;
}

// ---------------------------------------------------------------------------
// Reads. The values path never selects a main-only column.
// ---------------------------------------------------------------------------

interface ValueRow {
  readonly source: PreferenceSource;
  readonly updated_at: string;
}
interface WorkingHoursRow extends ValueRow {
  readonly weekday: Weekday;
  readonly start_minute: number | null;
  readonly end_minute: number | null;
}
interface WeeklyRangeRow extends ValueRow {
  readonly weekdays: string;
  readonly start_minute: number;
  readonly end_minute: number;
}
interface WindowRow extends WeeklyRangeRow {
  readonly id: string;
}
interface MinutesRow extends ValueRow {
  readonly meeting_kind: string;
  readonly minutes: number;
}
interface PreferredTimeRow extends WeeklyRangeRow {
  readonly meeting_kind: string;
}
interface BasisRow {
  readonly basis: string;
}
interface ReasonRow {
  readonly reason: string | null;
}

/** What each values read selects; `mainOnly` columns are appended only for the full read. */
const READS = {
  working_hours: { table: 'gws_ea_pref_working_hours', columns: 'weekday, start_minute, end_minute', order: 'weekday' },
  protected_windows: {
    table: 'gws_ea_pref_protected_windows',
    columns: 'id, weekdays, start_minute, end_minute',
    order: 'start_minute, end_minute, id',
  },
  meeting_lengths: { table: 'gws_ea_pref_meeting_lengths', columns: 'meeting_kind, minutes', order: 'meeting_kind' },
  buffers: { table: 'gws_ea_pref_buffers', columns: 'meeting_kind, minutes', order: 'meeting_kind' },
  preferred_times: {
    table: 'gws_ea_pref_preferred_times',
    columns: 'meeting_kind, weekdays, start_minute, end_minute',
    order: 'meeting_kind',
  },
} as const satisfies Record<keyof SchedulingPreferences, { table: string; columns: string; order: string }>;

function selectSql(read: (typeof READS)[keyof typeof READS], mainOnly: readonly MainOnlyPreferenceField[]): string {
  const columns = [read.columns, 'source', 'updated_at', ...mainOnly].join(', ');
  return `SELECT ${columns} FROM ${read.table} ORDER BY ${read.order}`;
}

function workingHoursValue(row: WorkingHoursRow): PreferenceValue<WorkingHoursPreference> {
  const base = { weekday: row.weekday, source: row.source, updated_at: row.updated_at };
  return row.start_minute === null || row.end_minute === null
    ? { ...base, off: true }
    : { ...base, off: false, start: formatClock(row.start_minute), end: formatClock(row.end_minute) };
}

function weeklyRange(row: WeeklyRangeRow) {
  return {
    weekdays: decodeWeekdays(row.weekdays),
    start: formatClock(row.start_minute),
    end: formatClock(row.end_minute),
    source: row.source,
    updated_at: row.updated_at,
  };
}

function windowValue(row: WindowRow): PreferenceValue<ProtectedWindowPreference> {
  return { id: row.id, ...weeklyRange(row) };
}

function minutesValue(row: MinutesRow): PreferenceValue<MeetingLengthPreference | BufferPreference> {
  return { meeting_kind: row.meeting_kind, minutes: row.minutes, source: row.source, updated_at: row.updated_at };
}

function preferredTimeValue(row: PreferredTimeRow): PreferenceValue<PreferredTimePreference> {
  return { meeting_kind: row.meeting_kind, ...weeklyRange(row) };
}

function byWeekday<T extends { readonly weekday: Weekday }>(values: T[]): T[] {
  return values.sort((left, right) => WEEKDAYS.indexOf(left.weekday) - WEEKDAYS.indexOf(right.weekday));
}

/** Every stored preference with its main-only basis and reason. For `main` and the host only. */
export async function getSchedulingPreferences(): Promise<SchedulingPreferences> {
  const db = getDb();
  const withBasis = <T extends object>(value: T, row: BasisRow) => ({ ...value, basis: row.basis });
  return {
    working_hours: byWeekday(
      (await db.all<WorkingHoursRow & BasisRow>(selectSql(READS.working_hours, ['basis']))).map((row) =>
        withBasis(workingHoursValue(row), row),
      ),
    ),
    protected_windows: (
      await db.all<WindowRow & BasisRow & ReasonRow>(selectSql(READS.protected_windows, ['basis', 'reason']))
    ).map((row) => ({ ...withBasis(windowValue(row), row), reason: row.reason })),
    meeting_lengths: (await db.all<MinutesRow & BasisRow>(selectSql(READS.meeting_lengths, ['basis']))).map((row) =>
      withBasis(minutesValue(row), row),
    ),
    buffers: (await db.all<MinutesRow & BasisRow>(selectSql(READS.buffers, ['basis']))).map((row) =>
      withBasis(minutesValue(row), row),
    ),
    preferred_times: (await db.all<PreferredTimeRow & BasisRow>(selectSql(READS.preferred_times, ['basis']))).map(
      (row) => withBasis(preferredTimeValue(row), row),
    ),
  };
}

/** The preference values with their source and update time, never their main-only basis or reason. */
export async function getSchedulingPreferenceValues(): Promise<SchedulingPreferenceValues> {
  const db = getDb();
  return {
    working_hours: byWeekday(
      (await db.all<WorkingHoursRow>(selectSql(READS.working_hours, []))).map(workingHoursValue),
    ),
    protected_windows: (await db.all<WindowRow>(selectSql(READS.protected_windows, []))).map(windowValue),
    meeting_lengths: (await db.all<MinutesRow>(selectSql(READS.meeting_lengths, []))).map(minutesValue),
    buffers: (await db.all<MinutesRow>(selectSql(READS.buffers, []))).map(minutesValue),
    preferred_times: (await db.all<PreferredTimeRow>(selectSql(READS.preferred_times, []))).map(preferredTimeValue),
  };
}

// ---------------------------------------------------------------------------
// Writes
// ---------------------------------------------------------------------------

/**
 * Store one preference, replacing the value it names. Rejects a value outside
 * its kind's shape. Whether a learned value should replace what the principal
 * said is main's judgment; the source and basis say which it was.
 */
export function setSchedulingPreference<I extends SetPreferenceInput>(input: I): Promise<PreferenceByKind[I['kind']]>;
export async function setSchedulingPreference(input: SetPreferenceInput): Promise<SchedulingPreference> {
  const source = parseSource(input.source);
  const basis = parseLine(input.basis, 'Basis', BASIS_MAX_LENGTH);
  const provenance: Provenance = { source, basis, updated_at: new Date().toISOString() };
  const db = getDb();

  switch (input.kind) {
    case 'working-hours': {
      const weekday = parseWeekday(input.weekday);
      const range = input.hours === 'off' ? null : parseRange(input.hours);
      await db.run(
        `INSERT INTO gws_ea_pref_working_hours (weekday, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (weekday) DO UPDATE
            SET start_minute = excluded.start_minute,
                end_minute = excluded.end_minute,
                source = excluded.source,
                basis = excluded.basis,
                updated_at = excluded.updated_at`,
        weekday,
        range?.start ?? null,
        range?.end ?? null,
        provenance.source,
        provenance.basis,
        provenance.updated_at,
      );
      return range === null
        ? { weekday, off: true, ...provenance }
        : { weekday, off: false, start: formatClock(range.start), end: formatClock(range.end), ...provenance };
    }
    case 'protected-window': {
      const weekdays = parseWeekdays(input.weekdays);
      const range = parseRange(input);
      const given = parseReason(input.reason);
      // A write that gives no reason keeps the window's own: relearning a window never erases why it is protected.
      const { id, reason } = await db.transaction(async () => {
        const sameShape = await db.get<{ readonly id: string; readonly reason: string | null }>(
          `SELECT id, reason FROM gws_ea_pref_protected_windows
            WHERE weekdays = ? AND start_minute = ? AND end_minute = ?`,
          weekdays.join(','),
          range.start,
          range.end,
        );
        let target: string;
        let kept: string | null;
        if (input.id === undefined) {
          target = sameShape?.id ?? newWindowId();
          kept = given ?? sameShape?.reason ?? null;
        } else {
          target = input.id.trim();
          const existing = await db.get<{ readonly reason: string | null }>(
            'SELECT reason FROM gws_ea_pref_protected_windows WHERE id = ?',
            target,
          );
          if (!existing) throw new Error(`No protected window ${JSON.stringify(target)} exists`);
          if (sameShape && sameShape.id !== target) {
            throw new Error(`Protected window ${sameShape.id} already protects those days and hours`);
          }
          kept = given ?? existing.reason;
        }
        await db.run(
          `INSERT INTO gws_ea_pref_protected_windows
             (id, weekdays, start_minute, end_minute, reason, source, basis, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT (id) DO UPDATE
              SET weekdays = excluded.weekdays,
                  start_minute = excluded.start_minute,
                  end_minute = excluded.end_minute,
                  reason = excluded.reason,
                  source = excluded.source,
                  basis = excluded.basis,
                  updated_at = excluded.updated_at`,
          target,
          weekdays.join(','),
          range.start,
          range.end,
          kept,
          provenance.source,
          provenance.basis,
          provenance.updated_at,
        );
        return { id: target, reason: kept };
      });
      return {
        id,
        weekdays,
        start: formatClock(range.start),
        end: formatClock(range.end),
        reason,
        ...provenance,
      };
    }
    case 'meeting-length':
    case 'buffer': {
      const { table } = MEETING_KIND_TABLES[input.kind];
      const meetingKind = parseMeetingKind(input.meetingKind);
      const minutes = parseMinutes(
        input.minutes,
        input.kind === 'meeting-length' ? 1 : 0,
        input.kind === 'meeting-length' ? 'Meeting length' : 'Buffer',
      );
      await db.run(
        `INSERT INTO ${table} (meeting_kind, minutes, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT (meeting_kind) DO UPDATE
            SET minutes = excluded.minutes,
                source = excluded.source,
                basis = excluded.basis,
                updated_at = excluded.updated_at`,
        meetingKind,
        minutes,
        provenance.source,
        provenance.basis,
        provenance.updated_at,
      );
      return { meeting_kind: meetingKind, minutes, ...provenance };
    }
    case 'preferred-time': {
      const meetingKind = parseMeetingKind(input.meetingKind);
      const weekdays = parseWeekdays(input.weekdays);
      const range = parseRange(input);
      await db.run(
        `INSERT INTO gws_ea_pref_preferred_times
           (meeting_kind, weekdays, start_minute, end_minute, source, basis, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (meeting_kind) DO UPDATE
            SET weekdays = excluded.weekdays,
                start_minute = excluded.start_minute,
                end_minute = excluded.end_minute,
                source = excluded.source,
                basis = excluded.basis,
                updated_at = excluded.updated_at`,
        meetingKind,
        weekdays.join(','),
        range.start,
        range.end,
        provenance.source,
        provenance.basis,
        provenance.updated_at,
      );
      return {
        meeting_kind: meetingKind,
        weekdays,
        start: formatClock(range.start),
        end: formatClock(range.end),
        ...provenance,
      };
    }
    default: {
      const unreachable: never = input;
      throw new Error(`Unknown preference kind: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Forget one preference, returning it to unset. Rejects a preference that is not set. */
export async function removeSchedulingPreference(target: PreferenceTarget): Promise<RemovedPreference> {
  parseSource(target.source);
  const db = getDb();
  /** Remove the one row `where` names. */
  const removeRow = async (table: string, where: string, key: string | number, missing: string) => {
    await db.transaction(async () => {
      if (!(await db.get(`SELECT 1 FROM ${table} WHERE ${where} = ?`, key))) throw new Error(missing);
      await db.run(`DELETE FROM ${table} WHERE ${where} = ?`, key);
    });
  };
  switch (target.kind) {
    case 'working-hours': {
      const weekday = parseWeekday(target.weekday);
      const day = WEEKDAY_NAMES[weekday];
      await removeRow('gws_ea_pref_working_hours', 'weekday', weekday, `No working hours are set for ${day}`);
      return { kind: target.kind, weekday };
    }
    case 'protected-window': {
      const id = target.id.trim();
      await removeRow('gws_ea_pref_protected_windows', 'id', id, `No protected window ${JSON.stringify(id)} exists`);
      return { kind: target.kind, id };
    }
    case 'meeting-length':
    case 'buffer':
    case 'preferred-time': {
      const { table, label } = MEETING_KIND_TABLES[target.kind];
      const meetingKind = parseMeetingKind(target.meetingKind);
      await removeRow(table, 'meeting_kind', meetingKind, `No ${label} is set for ${meetingKind}`);
      return { kind: target.kind, meeting_kind: meetingKind };
    }
    default: {
      const unreachable: never = target;
      throw new Error(`Unknown preference kind: ${JSON.stringify(unreachable)}`);
    }
  }
}
