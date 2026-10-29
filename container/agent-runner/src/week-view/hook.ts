import fs from 'node:fs';
import { DateTime } from 'luxon';
import { parseClockTimeline, readWeekViewFile, timelineZoneAt, WEEK_VIEW_FILE } from './clock.js';
import {
  fingerprint,
  isRecord,
  readDelivered,
  recordDelivered,
  validDays,
  type DeliveredView,
  type ViewDay,
} from './state.js';

export const WEEK_VIEW_HOOK_COMMAND = 'bun /app/src/week-view/hook.ts';
const STALE_AFTER_MS = 26 * 60 * 60_000;
const DIFF_CHARACTERS = 4_000;

function differences(previous: DeliveredView | undefined, days: readonly ViewDay[], manual: string): string {
  const changes: string[] = [];
  for (const day of days) {
    const held = previous?.days.find((entry) => entry.date === day.date);
    if (!held || held.header !== day.header) changes.push(day.header);
    const heldEntries = new Set(held?.entries.map((entry) => JSON.stringify([entry.id, entry.text, entry.version])));
    const currentIds = new Set(day.entries.map((entry) => entry.id));
    for (const entry of day.entries)
      if (!heldEntries.has(JSON.stringify([entry.id, entry.text, entry.version])))
        changes.push(`${day.date}: ${entry.text}`);
    for (const old of held?.entries ?? [])
      if (!currentIds.has(old.id)) changes.push(`${day.date}: removed ${old.text}`);
  }
  const lines: string[] = [];
  let size = 0;
  for (const change of changes) {
    if (size + change.length + 45 > DIFF_CHARACTERS) break;
    lines.push(change);
    size += change.length + 1;
  }
  if (lines.length < changes.length) lines.push(`+${changes.length - lines.length} more`);
  return [manual !== previous?.manual ? `Current Principal Manual\n${manual}` : '', lines.join('\n')]
    .filter(Boolean)
    .join('\n\n');
}

function write(text: string): void {
  const bytes = Buffer.from(`${text}\n`);
  for (let offset = 0; offset < bytes.length; ) offset += fs.writeSync(1, bytes, offset);
}

function run(): void {
  const raw: unknown = JSON.parse(fs.readFileSync(0, 'utf8'));
  if (!isRecord(raw) || (raw.hook_event_name !== 'SessionStart' && raw.hook_event_name !== 'UserPromptSubmit')) return;
  const value = readWeekViewFile(process.argv[2] ?? WEEK_VIEW_FILE);
  const asOf = typeof value?.asOf === 'string' ? value.asOf : 'unknown';
  const clock = parseClockTimeline(value?.timeline);
  const now = Date.now();
  if (
    !value ||
    value.schema !== 1 ||
    typeof value.version !== 'string' ||
    typeof value.text !== 'string' ||
    value.text.length > 8_000 ||
    typeof value.manual !== 'string' ||
    value.manual.length > 8_000 ||
    !validDays(value.days) ||
    !clock ||
    !Number.isFinite(Date.parse(asOf)) ||
    now - Date.parse(asOf) > STALE_AFTER_MS
  ) {
    write(
      `view as of ${
        Number.isFinite(Date.parse(asOf))
          ? DateTime.fromISO(asOf)
              .setZone(process.env.TZ ?? 'UTC')
              .toFormat('yyyy-MM-dd HH:mm ZZZZ')
          : 'unknown'
      } unavailable; use days`,
    );
    return;
  }
  const id = typeof raw.session_id === 'string' && raw.session_id ? raw.session_id : undefined;
  const stateDir = process.argv[3];
  const previous = id ? readDelivered(id, stateDir) : undefined;
  const snapshot: DeliveredView = {
    fingerprint: fingerprint([value.text, value.manual, value.timeline, value.days]),
    days: value.days,
    manual: value.manual,
  };
  if (
    raw.hook_event_name === 'SessionStart' &&
    raw.source === 'resume' &&
    snapshot.fingerprint === previous?.fingerprint
  )
    return;
  const zone = timelineZoneAt(clock, now) ?? process.env.TZ ?? 'UTC';
  const local = DateTime.fromMillis(now, { zone });
  const night = local.hour >= 22 || local.hour < 7;
  const nowText = `Now: ${local.toFormat('yyyy-MM-dd HH:mm')} (${zone}; ${night ? 'night' : 'day'})`;
  const body =
    raw.hook_event_name === 'SessionStart'
      ? `Coming days (as of ${DateTime.fromISO(asOf).setZone(zone).toFormat('yyyy-MM-dd HH:mm')})\n${value.text}\n\nCurrent Principal Manual\n${value.manual}`
      : differences(previous, value.days, value.manual);
  write([nowText, body].filter(Boolean).join('\n'));
  if (id) recordDelivered(id, snapshot, stateDir);
}

if (import.meta.main) {
  try {
    run();
  } catch {
    // Context availability must never block a turn.
  }
  process.exitCode = 0;
}
