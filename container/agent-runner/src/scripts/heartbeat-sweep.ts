/**
 * Heartbeat pre-sweep script.
 *
 * Invoked by the agent-runner pre-task hook. Gathers calendar/contacts data,
 * applies deterministic tagging, dedupes against prior sweeps, and decides
 * whether to wake the agent. Output (last stdout line): { wakeAgent, data? }.
 *
 * Mounts read inside the container:
 *   - /home/node/.gws/service-account.json  (SA key, RO)
 *   - /home/node/.gws/calendars.json        (optional eventFilters, bot-wide; shared with calendar MCP)
 *   - /workspace/agent/heartbeat.json       (per-group config: assistantEmail)
 *   - /workspace/agent/sweep_state.json     (RW, dedup memory)
 *   - /workspace/inbound.db                 (matters projection, RO)
 */
import fs from 'fs';
import path from 'path';

import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';

import {
  getArtifactsForMatters,
  getLinkedArtifactIds,
  listOpenMattersUpdatedSince,
  type MatterStatus,
} from '../db/matters.js';

const SA_KEY_PATH = '/home/node/.gws/service-account.json';
const HEARTBEAT_CONFIG_PATH = '/workspace/agent/heartbeat.json';
const CALENDARS_CONFIG_PATH = '/home/node/.gws/calendars.json';
const SWEEP_STATE_PATH = '/workspace/agent/sweep_state.json';

const HOUR_MS = 60 * 60 * 1000;

// Heartbeat reports changes, not standing state. Matters older than this fall
// outside the window and don't surface — pull-on-demand via `find_matter` if
// the agent needs them. Window = sweep cadence so each sweep covers the gap.
const HEARTBEAT_RECENCY_MS = HOUR_MS;

// Cap on lookback after a missed sweep — past this, orphan threads are stale.
const MAX_LOOKBACK_MS = 24 * HOUR_MS;

// Inline scopes — heartbeat needs calendar RW (decline/accept), gmail read
// (thread metadata), contacts read (tier-1 detection). DWD grant superset
// in the admin console must include these.
const HEARTBEAT_SCOPES = [
  'https://www.googleapis.com/auth/calendar',
  'https://www.googleapis.com/auth/gmail.readonly',
  'https://www.googleapis.com/auth/contacts.readonly',
];

interface ParsedArtifact {
  type: string;
  id: string;
}

interface MatterSnapshot {
  id: number;
  title: string;
  description: string | null;
  status: MatterStatus;
  artifacts: ParsedArtifact[];
  context: string | null;
  updated_at: string;
}

interface ThreadMeta {
  thread_id: string;
  subject: string;
  last_message_from: string;
  last_message_date: string;
  // Gmail internalDate of the first message — drives one-shot orphan triage.
  first_message_at: number | null;
  message_count: number;
  snippet?: string;
}

interface EventMeta {
  event_id: string;
  calendar_id: string;
  summary: string;
  start: string;
  end: string;
  is_all_day: boolean;
  status: string;
  organizer: string;
  attendees: Array<{ email: string; responseStatus: string }>;
  hangout_link: string | null;
  location: string | null;
  updated: string;
}

interface MatterBrief {
  id: number;
  title: string;
  description: string | null;
  status: MatterStatus;
  artifacts: ParsedArtifact[];
  updated_at: string;
  tags: string[];
  threads: ThreadMeta[];
  events: EventMeta[];
}

interface CalendarBrief {
  event_id: string;
  calendar_id: string;
  summary: string;
  start: string;
  end: string;
  status: string;
  organizer: string;
  attendees: Array<{ email: string; responseStatus: string }>;
  hangout_link: string | null;
  location: string | null;
  tags: string[];
  conflict_with?: string;
}

interface Failure {
  source: string;
  operation: string;
  error: string;
  target_id?: string;
}

interface SweepBrief {
  generated_at: string;
  is_evening_preview: boolean;
  matters: MatterBrief[];
  calendar: CalendarBrief[];
  threads: ThreadMeta[];
  tomorrow?: CalendarBrief[];
  failures: Failure[];
}

interface SweepState {
  last_sweep_at: string;
  matters: Record<string, { updated_at: string; reported_at: string; fingerprint?: string }>;
  calendar: Record<string, { updated: string; reported_at: string; fingerprint?: string }>;
}

interface EventFilter {
  action: 'exclude' | 'includeOnly';
  where: string;
  inValuesOf?: string;
  equals?: string;
  calendarIds?: string[];
}

interface HeartbeatConfig {
  assistantEmail: string;
}

function log(msg: string): void {
  process.stderr.write(`[heartbeat-sweep] ${msg}\n`);
}

function loadHeartbeatConfig(): HeartbeatConfig {
  const raw = fs.readFileSync(HEARTBEAT_CONFIG_PATH, 'utf-8');
  const parsed = JSON.parse(raw) as HeartbeatConfig;
  if (!parsed.assistantEmail) {
    throw new Error(`heartbeat.json missing assistantEmail at ${HEARTBEAT_CONFIG_PATH}`);
  }
  return parsed;
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = obj;
  for (const key of dotPath.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function getEventTime(event: calendar_v3.Schema$Event, field: 'start' | 'end'): string {
  const dt = event[field];
  if (!dt) return '';
  return dt.dateTime || dt.date || '';
}

function isAllDay(event: calendar_v3.Schema$Event): boolean {
  return !event.start?.dateTime && !!event.start?.date;
}

function getHour(isoDate: string): number {
  return new Date(isoDate).getHours();
}

function hasExternalAttendees(
  attendees: Array<{ email: string }>,
  organizerEmail: string,
  assistantEmail: string,
): boolean {
  const organizerDomain = organizerEmail.split('@')[1] || '';
  if (!organizerDomain) return false;
  return attendees.some((a) => {
    const domain = a.email.split('@')[1] || '';
    return domain !== organizerDomain && a.email !== assistantEmail;
  });
}

function eventsOverlap(a: { start: string; end: string }, b: { start: string; end: string }): boolean {
  if (!a.start || !a.end || !b.start || !b.end) return false;
  const aStart = new Date(a.start).getTime();
  const aEnd = new Date(a.end).getTime();
  const bStart = new Date(b.start).getTime();
  const bEnd = new Date(b.end).getTime();
  return aStart < bEnd && bStart < aEnd;
}

function toEventMeta(event: calendar_v3.Schema$Event, calendarId: string): EventMeta {
  return {
    event_id: event.id || '',
    calendar_id: calendarId,
    summary: event.summary || '(no title)',
    start: getEventTime(event, 'start'),
    end: getEventTime(event, 'end'),
    is_all_day: isAllDay(event),
    status: event.status || '',
    organizer: event.organizer?.email || '',
    attendees: (event.attendees || []).map((a) => ({
      email: a.email || '',
      responseStatus: a.responseStatus || '',
    })),
    hangout_link: event.hangoutLink || null,
    location: event.location || null,
    updated: event.updated || '',
  };
}

function toCalendarBrief(meta: EventMeta, tags: string[], conflictWith?: string): CalendarBrief {
  return {
    event_id: meta.event_id,
    calendar_id: meta.calendar_id,
    summary: meta.summary,
    start: meta.start,
    end: meta.end,
    status: meta.status,
    organizer: meta.organizer,
    attendees: meta.attendees,
    hangout_link: meta.hangout_link,
    location: meta.location,
    tags,
    ...(conflictWith && { conflict_with: conflictWith }),
  };
}

function createAuthClient(assistantEmail: string): InstanceType<typeof google.auth.JWT> {
  const saKey = JSON.parse(fs.readFileSync(SA_KEY_PATH, 'utf-8'));
  return new google.auth.JWT({
    email: saKey.client_email,
    key: saKey.private_key,
    scopes: HEARTBEAT_SCOPES,
    subject: assistantEmail,
  });
}

function loadEventFilters(): EventFilter[] {
  try {
    const config = JSON.parse(fs.readFileSync(CALENDARS_CONFIG_PATH, 'utf-8'));
    return config.eventFilters || [];
  } catch {
    return [];
  }
}

function applyEventFilters(
  events: Array<{ event: calendar_v3.Schema$Event; calendarId: string }>,
  filters: EventFilter[],
): Array<{ event: calendar_v3.Schema$Event; calendarId: string }> {
  let result = events;

  for (const filter of filters) {
    if (filter.action !== 'exclude') continue;

    if (filter.inValuesOf) {
      const valueSet = new Set<string>();
      for (const { event } of result) {
        const val = getNestedValue(event as unknown as Record<string, unknown>, filter.inValuesOf);
        if (typeof val === 'string') valueSet.add(val);
      }
      result = result.filter(({ event }) => {
        const fieldVal = getNestedValue(event as unknown as Record<string, unknown>, filter.where);
        return typeof fieldVal !== 'string' || !valueSet.has(fieldVal);
      });
    } else if (filter.equals !== undefined) {
      result = result.filter(({ event, calendarId }) => {
        if (filter.calendarIds && !filter.calendarIds.includes(calendarId)) return true;
        const fieldVal = getNestedValue(event as unknown as Record<string, unknown>, filter.where);
        return fieldVal !== filter.equals;
      });
    }
  }

  return result;
}

function loadSweepState(): SweepState {
  try {
    return JSON.parse(fs.readFileSync(SWEEP_STATE_PATH, 'utf-8'));
  } catch {
    return { last_sweep_at: '', matters: {}, calendar: {} };
  }
}

function saveSweepState(state: SweepState): void {
  fs.mkdirSync(path.dirname(SWEEP_STATE_PATH), { recursive: true });
  fs.writeFileSync(SWEEP_STATE_PATH, JSON.stringify(state, null, 2));
}

interface CalendarInfo {
  id: string;
  summary: string;
  accessRole: string;
}

async function discoverCalendars(
  calendarClient: calendar_v3.Calendar,
): Promise<CalendarInfo[]> {
  const res = await calendarClient.calendarList.list({ maxResults: 100 });
  return (res.data.items || [])
    .filter((c) => c.accessRole && ['owner', 'writer', 'reader', 'freeBusyReader'].includes(c.accessRole))
    .map((c) => ({ id: c.id || '', summary: c.summary || '', accessRole: c.accessRole || '' }));
}

async function fetchCalendarEvents(
  calendarClient: calendar_v3.Calendar,
  calendarId: string,
  timeMin: string,
  timeMax: string,
): Promise<calendar_v3.Schema$Event[]> {
  const events: calendar_v3.Schema$Event[] = [];
  let pageToken: string | undefined;

  do {
    const res = await calendarClient.events.list({
      calendarId,
      timeMin,
      timeMax,
      singleEvents: true,
      orderBy: 'startTime',
      maxResults: 250,
      pageToken,
    });
    events.push(...(res.data.items || []));
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return events;
}

function parseInternalDate(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) ? n : null;
}

async function fetchThreadMeta(
  gmail: ReturnType<typeof google.gmail>,
  threadId: string,
): Promise<ThreadMeta> {
  const res = await gmail.users.threads.get({
    userId: 'me',
    id: threadId,
    format: 'metadata',
    metadataHeaders: ['From', 'Subject', 'Date'],
  });

  const messages = res.data.messages || [];
  const lastMsg = messages[messages.length - 1];
  const headers = lastMsg?.payload?.headers || [];

  const getHeader = (name: string): string =>
    headers.find((h) => h.name?.toLowerCase() === name.toLowerCase())?.value || '';

  const firstMsg = messages[0];
  const firstHeaders = firstMsg?.payload?.headers || [];
  const subject =
    firstHeaders.find((h) => h.name?.toLowerCase() === 'subject')?.value || '';

  return {
    thread_id: threadId,
    subject,
    last_message_from: getHeader('From'),
    last_message_date: getHeader('Date'),
    first_message_at: parseInternalDate(firstMsg?.internalDate),
    message_count: messages.length,
    snippet: lastMsg?.snippet ?? undefined,
  };
}

async function listRecentInboxThreadIds(
  gmail: ReturnType<typeof google.gmail>,
  hours: number,
): Promise<string[]> {
  const res = await gmail.users.threads.list({
    userId: 'me',
    q: `newer_than:${Math.ceil(hours)}h in:inbox`,
    maxResults: 100,
  });
  return (res.data.threads ?? [])
    .map((t) => t.id)
    .filter((id): id is string => typeof id === 'string');
}

async function fetchContacts(
  people: ReturnType<typeof google.people>,
): Promise<Set<string>> {
  const emails = new Set<string>();
  let pageToken: string | undefined;

  do {
    const res = await people.people.connections.list({
      resourceName: 'people/me',
      personFields: 'emailAddresses',
      pageSize: 1000,
      pageToken,
    });
    for (const person of res.data.connections || []) {
      for (const email of person.emailAddresses || []) {
        if (email.value) emails.add(email.value.toLowerCase());
      }
    }
    pageToken = res.data.nextPageToken || undefined;
  } while (pageToken);

  return emails;
}

// String mirrored from src/modules/matters/context-file.ts — host/container
// tsconfig split prevents sharing.
const PENDING_SECTION_RE = /(^|\n)## Pending\b/;

function tagMatters(
  snapshots: MatterSnapshot[],
  briefById: ReadonlyMap<number, MatterBrief>,
  assistantEmail: string,
): void {
  const SEVENTY_TWO_HOURS = 72 * HOUR_MS;
  const now = Date.now();

  for (const snap of snapshots) {
    const brief = briefById.get(snap.id);
    if (!brief) continue;

    if (snap.status === 'escalated' && !brief.tags.includes('skip_escalated')) {
      brief.tags.push('skip_escalated');
    }

    if (snap.context && PENDING_SECTION_RE.test(snap.context)) {
      brief.tags.push('has_pending');
    }

    for (const thread of brief.threads) {
      const fromAssistant = thread.last_message_from
        .toLowerCase()
        .includes(assistantEmail.toLowerCase());
      if (fromAssistant && thread.last_message_date) {
        const msgTime = new Date(thread.last_message_date).getTime();
        if (now - msgTime > SEVENTY_TWO_HOURS) {
          brief.tags.push('stalled_followup');
        }
      }
    }
  }
}

function tagCalendarEvents(
  events: EventMeta[],
  contactEmails: Set<string>,
  assistantEmail: string,
  freeBusyCalendarIds: Set<string>,
): Array<{ meta: EventMeta; tags: string[]; conflictWith?: string }> {
  const tagged: Array<{ meta: EventMeta; tags: string[]; conflictWith?: string }> = [];

  for (const meta of events) {
    const tags: string[] = [];
    const isFreeBusy = freeBusyCalendarIds.has(meta.calendar_id);

    if (!meta.is_all_day && !isFreeBusy) {
      const hour = getHour(meta.start);
      if (hour >= 22 || hour < 7) {
        tags.push('late_night');
      }

      if (
        !meta.hangout_link &&
        !meta.location &&
        meta.attendees.length > 0 &&
        hasExternalAttendees(meta.attendees, meta.organizer, assistantEmail)
      ) {
        tags.push('maybe_missing_link');
      }

      if (meta.status === 'tentative' || meta.attendees.some(
        (a) => a.email === assistantEmail && a.responseStatus === 'needsAction',
      )) {
        const organizerInContacts = contactEmails.has(meta.organizer.toLowerCase());
        if (organizerInContacts) {
          tags.push('safe_to_accept');
        } else {
          tags.push('needs_review');
        }
      }

      const startMs = new Date(meta.start).getTime();
      const hoursOut = (startMs - Date.now()) / HOUR_MS;
      if (hoursOut > 0 && hoursOut <= 3 &&
          hasExternalAttendees(meta.attendees, meta.organizer, assistantEmail)) {
        tags.push('needs_prep');
      }
    }

    tagged.push({ meta, tags });
  }

  for (let i = 0; i < tagged.length; i++) {
    for (let j = i + 1; j < tagged.length; j++) {
      const a = tagged[i];
      const b = tagged[j];
      if (a.meta.is_all_day || b.meta.is_all_day) continue;
      if (a.meta.calendar_id === b.meta.calendar_id) continue;
      if (eventsOverlap(a.meta, b.meta)) {
        const aIsFreeBusy = freeBusyCalendarIds.has(a.meta.calendar_id);
        const bIsFreeBusy = freeBusyCalendarIds.has(b.meta.calendar_id);
        if (!aIsFreeBusy && !a.tags.includes('conflict')) {
          a.tags.push('conflict');
          a.conflictWith = b.meta.event_id;
        }
        if (!bIsFreeBusy && !b.tags.includes('conflict')) {
          b.tags.push('conflict');
          b.conflictWith = a.meta.event_id;
        }
      }
    }
  }

  for (const t of tagged) {
    const safeIdx = t.tags.indexOf('safe_to_accept');
    if (safeIdx !== -1 && t.tags.includes('conflict')) {
      t.tags.splice(safeIdx, 1);
    }
  }

  const nonAllDay = tagged
    .filter((t) => !t.meta.is_all_day)
    .map((t) => ({ ...t, startMs: new Date(t.meta.start).getTime(), endMs: new Date(t.meta.end).getTime() }));
  for (const t of nonAllDay) {
    if (freeBusyCalendarIds.has(t.meta.calendar_id)) continue;
    const overlapping = nonAllDay.filter((other) =>
      other !== t && other.startMs < t.startMs + 3600000 && other.endMs > t.startMs,
    );
    if (overlapping.length >= 2 && !t.tags.includes('triple_stacked')) {
      t.tags.push('triple_stacked');
    }
  }

  return tagged;
}

// Reads from the matters projection in `/workspace/inbound.db` (host writes
// it on every container wake — see src/modules/matters/write-matters.ts).
// Filters to open statuses and the recency window so the sweep reports
// changes, not standing state. Context body is read for `has_pending`
// tagging but not surfaced to the agent — agent pulls via `find_matter`.
function loadMatters(): MatterSnapshot[] {
  const sinceIso = new Date(Date.now() - HEARTBEAT_RECENCY_MS).toISOString();
  const matters = listOpenMattersUpdatedSince(sinceIso);
  if (matters.length === 0) return [];

  const byMatter = new Map<number, ParsedArtifact[]>();
  for (const a of getArtifactsForMatters(matters.map((m) => m.id))) {
    const list = byMatter.get(a.matter_id) ?? [];
    list.push({ type: a.artifact_type, id: a.artifact_id });
    byMatter.set(a.matter_id, list);
  }

  log(`Loaded ${matters.length} open matter(s) updated since ${sinceIso}`);

  return matters.map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    status: m.status,
    artifacts: byMatter.get(m.id) ?? [],
    context: m.context,
    updated_at: m.updated_at,
  }));
}

async function main(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const failures: Failure[] = [];

  const config = loadHeartbeatConfig();
  const assistantEmail = config.assistantEmail;
  log(`Assistant email: ${assistantEmail}`);

  const authClient = createAuthClient(assistantEmail);

  const mattersSnapshot = loadMatters();
  const prevState = loadSweepState();

  const sinceLastSweepMs = prevState.last_sweep_at
    ? now.getTime() - new Date(prevState.last_sweep_at).getTime()
    : HEARTBEAT_RECENCY_MS;
  const lookbackMs = Math.min(
    MAX_LOOKBACK_MS,
    Math.max(HEARTBEAT_RECENCY_MS, sinceLastSweepMs),
  );
  const recencyCutoffMs = now.getTime() - lookbackMs;
  const queryHours = lookbackMs / HOUR_MS;

  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: process.env.TZ || 'UTC',
    }).format(now),
    10,
  );
  const isEveningPreview = localHour === 21;

  const calendarClient = google.calendar({ version: 'v3', auth: authClient });
  const gmail = google.gmail({ version: 'v1', auth: authClient });
  const people = google.people({ version: 'v1', auth: authClient });

  const calendarDiscoveryPromise = discoverCalendars(calendarClient).catch((err) => {
    failures.push({
      source: 'calendar',
      operation: 'calendarList.list',
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as CalendarInfo[];
  });

  const contactsPromise = fetchContacts(people).catch((err) => {
    failures.push({
      source: 'contacts',
      operation: 'connections.list',
      error: err instanceof Error ? err.message : String(err),
    });
    return new Set<string>();
  });

  const unlinkedScanPromise = listRecentInboxThreadIds(gmail, queryHours).catch((err) => {
    failures.push({
      source: 'gmail',
      operation: 'threads.list',
      error: err instanceof Error ? err.message : String(err),
    });
    return [] as string[];
  });

  const matterBriefs: MatterBrief[] = [];
  const matterById = new Map<number, MatterBrief>();
  const threadFetches: Array<{ matterId: number; threadId: string }> = [];
  const matterEventIds: Array<{ matterId: number; eventId: string }> = [];

  for (const m of mattersSnapshot) {
    const brief: MatterBrief = {
      id: m.id,
      title: m.title,
      description: m.description,
      status: m.status,
      artifacts: m.artifacts,
      updated_at: m.updated_at,
      tags: [],
      threads: [],
      events: [],
    };

    const stateKey = String(m.id);
    if (
      m.status === 'escalated' &&
      prevState.matters[stateKey]?.updated_at === m.updated_at
    ) {
      brief.tags.push('skip_escalated');
      matterBriefs.push(brief);
      matterById.set(m.id, brief);
      continue;
    }

    for (const a of m.artifacts) {
      if (a.type === 'gmail_thread_id') threadFetches.push({ matterId: m.id, threadId: a.id });
      if (a.type === 'gcal_id') matterEventIds.push({ matterId: m.id, eventId: a.id });
    }

    matterBriefs.push(brief);
    matterById.set(m.id, brief);
  }

  const calendars = await calendarDiscoveryPromise;
  const recentInboxThreadIds = await unlinkedScanPromise;
  const linkedThreadIds = getLinkedArtifactIds('gmail_thread_id');
  const unlinkedCandidateIds = recentInboxThreadIds.filter((id) => !linkedThreadIds.has(id));
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * HOUR_MS);

  const [calendarFetchResults, threadResults, unlinkedFetchResults] = await Promise.all([
    Promise.all(
      calendars.map(async (cal) => {
        try {
          const events = await fetchCalendarEvents(
            calendarClient,
            cal.id,
            nowIso,
            sevenDaysFromNow.toISOString(),
          );
          return events.map((e) => ({ event: e, calendarId: cal.id }));
        } catch (err) {
          failures.push({
            source: 'calendar',
            operation: 'events.list',
            error: err instanceof Error ? err.message : String(err),
            target_id: cal.id,
          });
          return [];
        }
      }),
    ),
    Promise.all(
      threadFetches.map(async ({ matterId, threadId }) => {
        try {
          const meta = await fetchThreadMeta(gmail, threadId);
          return { matterId, meta };
        } catch (err) {
          failures.push({
            source: 'gmail',
            operation: 'threads.get',
            error: err instanceof Error ? err.message : String(err),
            target_id: threadId,
          });
          return null;
        }
      }),
    ),
    Promise.all(
      unlinkedCandidateIds.map(async (id) => {
        try {
          return await fetchThreadMeta(gmail, id);
        } catch (err) {
          failures.push({
            source: 'gmail',
            operation: 'threads.get',
            error: err instanceof Error ? err.message : String(err),
            target_id: id,
          });
          return null;
        }
      }),
    ),
  ]);

  const allRawEvents: Array<{ event: calendar_v3.Schema$Event; calendarId: string }> = [];
  for (const batch of calendarFetchResults) {
    allRawEvents.push(...batch);
  }

  const bulkEventMap = new Map<string, EventMeta>();
  for (const { event, calendarId } of allRawEvents) {
    if (event.id) bulkEventMap.set(event.id, toEventMeta(event, calendarId));
  }

  for (const result of threadResults) {
    if (!result) continue;
    const brief = matterById.get(result.matterId);
    if (brief) brief.threads.push(result.meta);
  }

  for (const { matterId, eventId } of matterEventIds) {
    const meta = bulkEventMap.get(eventId);
    if (meta) {
      const brief = matterById.get(matterId);
      if (brief) brief.events.push(meta);
    } else {
      failures.push({
        source: 'calendar',
        operation: 'events.get',
        error: 'Event not found in 7-day window',
        target_id: eventId,
      });
    }
  }

  tagMatters(mattersSnapshot, matterById, assistantEmail);

  const filters = loadEventFilters();
  const filteredEvents = applyEventFilters(allRawEvents, filters);

  const matterLinkedEventIds = new Set<string>();
  for (const m of matterBriefs) {
    if (m.tags.includes('skip_escalated') && prevState.matters[String(m.id)]?.updated_at === m.updated_at) {
      continue;
    }
    for (const a of m.artifacts) {
      if (a.type === 'gcal_id') matterLinkedEventIds.add(a.id);
    }
  }

  const calendarEvents: EventMeta[] = [];
  for (const { event, calendarId } of filteredEvents) {
    if (event.id && matterLinkedEventIds.has(event.id)) continue;
    calendarEvents.push(toEventMeta(event, calendarId));
  }

  const contactEmails = await contactsPromise;
  const freeBusyCalendarIds = new Set(
    calendars.filter((c) => c.accessRole === 'freeBusyReader').map((c) => c.id),
  );
  const taggedCalendar = tagCalendarEvents(calendarEvents, contactEmails, assistantEmail, freeBusyCalendarIds);

  const calendarFindings = taggedCalendar.filter((t) => t.tags.length > 0);

  let tomorrowBriefs: CalendarBrief[] | undefined;
  if (isEveningPreview) {
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    const tomorrowEvents = filteredEvents
      .filter(({ event }) => {
        const start = getEventTime(event, 'start');
        if (!start) return false;
        const startDate = new Date(start);
        return startDate >= tomorrowStart && startDate < tomorrowEnd;
      })
      .map(({ event, calendarId }) => toEventMeta(event, calendarId));

    tomorrowBriefs = tomorrowEvents.map((meta) => toCalendarBrief(meta, []));
  }

  const newState: SweepState = {
    last_sweep_at: nowIso,
    matters: {},
    calendar: {},
  };

  const survivingMatters: MatterBrief[] = [];
  for (const m of matterBriefs) {
    const key = String(m.id);
    const prev = prevState.matters[key];
    const fingerprint = `${m.updated_at}|${m.tags.sort().join(',')}`;

    if (prev && prev.fingerprint === fingerprint) {
      newState.matters[key] = prev;
    } else {
      survivingMatters.push(m);
      newState.matters[key] = { updated_at: m.updated_at, reported_at: nowIso, fingerprint };
    }
  }

  const survivingCalendar: CalendarBrief[] = [];
  for (const finding of calendarFindings) {
    const key = `${finding.meta.calendar_id}:${finding.meta.event_id}`;
    const prev = prevState.calendar[key];
    const fingerprint = `${finding.meta.updated}|${finding.tags.sort().join(',')}|${finding.conflictWith ?? ''}`;

    if (prev && prev.fingerprint === fingerprint) {
      newState.calendar[key] = prev;
    } else {
      survivingCalendar.push(toCalendarBrief(finding.meta, finding.tags, finding.conflictWith));
      newState.calendar[key] = { updated: finding.meta.updated, reported_at: nowIso, fingerprint };
    }
  }

  const survivingThreads: ThreadMeta[] = unlinkedFetchResults.filter(
    (meta): meta is ThreadMeta =>
      meta?.first_message_at != null && meta.first_message_at >= recencyCutoffMs,
  );

  const isQuiet =
    survivingMatters.length === 0 &&
    survivingCalendar.length === 0 &&
    survivingThreads.length === 0 &&
    failures.length === 0 &&
    !isEveningPreview;

  saveSweepState(newState);

  if (isQuiet) {
    log('Quiet sweep — nothing to report');
    console.log(JSON.stringify({ wakeAgent: false }));
    return;
  }

  const brief: SweepBrief = {
    generated_at: nowIso,
    is_evening_preview: isEveningPreview,
    matters: survivingMatters,
    calendar: survivingCalendar,
    threads: survivingThreads,
    ...(tomorrowBriefs && { tomorrow: tomorrowBriefs }),
    failures,
  };

  log(
    `Waking agent: ${survivingMatters.length} matters, ${survivingCalendar.length} calendar findings, ${survivingThreads.length} unlinked threads, ${failures.length} failures`,
  );
  console.log(JSON.stringify({ wakeAgent: true, data: brief }));
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
