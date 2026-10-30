import fs from 'node:fs';
import { DateTime } from 'luxon';
import { parseClockTimeline, readWeekViewFile, timelineZoneAt, WEEK_VIEW_FILE } from './clock.js';
import {
  fingerprint,
  isRecord,
  readDelivered,
  recordDelivered,
  validDays,
  validSections,
  type DeliveredView,
  type ViewDay,
} from './state.js';

export const WEEK_VIEW_HOOK_COMMAND = 'bun /app/src/week-view/hook.ts';
const PROJECT_DOCUMENT = '/workspace/agent/CLAUDE.md';
/** Claude Code skips a larger project document, so it then holds no Manual at all. */
const PROJECT_DOCUMENT_MAX_BYTES = 4 * 1_048_576;
const STALE_AFTER_MS = 26 * 60 * 60_000;
const DIFF_CHARACTERS = 4_000;
const MANUAL_CHARACTERS = 8_000;

function dayChanges(
  previous: DeliveredView | undefined,
  days: readonly ViewDay[],
): { readonly text: string; readonly delivered: readonly ViewDay[] } {
  const heldDays = new Map(previous?.days.map((day) => [day.date, day]));
  const changes: { readonly text: string; readonly remember: () => void }[] = [];
  const remember = (day: ViewDay, entries: ViewDay['entries']) => heldDays.set(day.date, { ...day, entries });
  for (const day of days) {
    const held = previous?.days.find((entry) => entry.date === day.date);
    if (held?.version !== day.version)
      changes.push({ text: day.header, remember: () => remember(day, heldDays.get(day.date)?.entries ?? []) });
    const heldVersions = new Map(held?.entries.map((entry) => [entry.id, entry.version]));
    const currentIds = new Set(day.entries.map((entry) => entry.id));
    for (const entry of day.entries)
      if (heldVersions.get(entry.id) !== entry.version)
        changes.push({
          text: `${day.date}: ${entry.text}`,
          remember: () =>
            remember(day, [...(heldDays.get(day.date)?.entries ?? []).filter((e) => e.id !== entry.id), entry]),
        });
    for (const old of held?.entries ?? [])
      if (!currentIds.has(old.id))
        changes.push({
          text: `${day.date}: no longer shown: ${old.text}`,
          remember: () =>
            remember(
              day,
              (heldDays.get(day.date)?.entries ?? []).filter((e) => e.id !== old.id),
            ),
        });
  }
  const lines: string[] = [];
  let size = 0;
  for (const change of changes) {
    // An indivisible framed entry may exceed the usual budget; deliver it alone instead of starving it.
    if (lines.length && size + change.text.length + 45 > DIFF_CHARACTERS) break;
    lines.push(change.text);
    size += change.text.length + 1;
    change.remember();
  }
  const complete = lines.length === changes.length;
  if (!complete) lines.push(`+${changes.length - lines.length} more`);
  return {
    text: lines.join('\n'),
    delivered: complete ? days : days.flatMap((day) => heldDays.get(day.date) ?? []),
  };
}

function projectDocument(file: string): string {
  try {
    return fs.statSync(file).size > PROJECT_DOCUMENT_MAX_BYTES ? '' : fs.readFileSync(file, 'utf8');
  } catch {
    return '';
  }
}

/**
 * The Manual sections this session does not hold. A fresh context holds only its project document, composed
 * when the container started; otherwise the session holds what it last received.
 */
function manualChanges(sections: readonly string[], held: readonly string[] | undefined, file: string): string {
  const document = held === undefined ? `\n\n${projectDocument(file)}\n\n` : '';
  const changed = sections.filter((section) =>
    held === undefined ? !document.includes(`\n\n${section}\n\n`) : !held.includes(section),
  );
  return changed.length ? `Principal Manual sections changed (current text)\n${changed.join('\n\n')}` : '';
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
    !validSections(value.manual) ||
    value.manual.join('\n\n').length > MANUAL_CHARACTERS ||
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
  const sections = value.manual;
  const snapshot = (days: readonly ViewDay[]): DeliveredView => ({
    fingerprint: fingerprint([
      days.map((day) => [day.date, day.version, day.entries.map((entry) => [entry.id, entry.version])]),
      sections,
      clock,
    ]),
    days,
    manual: sections,
  });
  const start = raw.hook_event_name === 'SessionStart';
  if (start && raw.source === 'resume' && snapshot(value.days).fingerprint === previous?.fingerprint) return;
  // Startup, clear and compaction leave the session only its project document; a resume keeps its transcript.
  const fresh = start && raw.source !== 'resume';
  const zone = timelineZoneAt(clock, now) ?? process.env.TZ ?? 'UTC';
  const local = DateTime.fromMillis(now, { zone });
  const night = local.hour >= 22 || local.hour < 7;
  const nowText = `Now: ${local.toFormat('yyyy-MM-dd HH:mm')} (${zone}; ${night ? 'night' : 'day'}; default night 22:00–07:00)`;
  const changes = start
    ? {
        text: `Coming days (as of ${DateTime.fromISO(asOf).setZone(zone).toFormat('yyyy-MM-dd HH:mm')})\n${value.text}`,
        delivered: value.days,
      }
    : dayChanges(previous, value.days);
  const manual = manualChanges(value.manual, fresh ? undefined : previous?.manual, process.argv[4] ?? PROJECT_DOCUMENT);
  write([nowText, [changes.text, manual].filter(Boolean).join('\n\n')].filter(Boolean).join('\n'));
  if (id) recordDelivered(id, snapshot(changes.delivered), stateDir);
}

if (import.meta.main) {
  try {
    run();
  } catch {
    // Context availability must never block a turn.
  }
  process.exitCode = 0;
}
