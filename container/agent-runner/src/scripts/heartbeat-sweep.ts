/**
 * Heartbeat pre-sweep script
 *
 * Runs inside the container via the task `script` field BEFORE the agent wakes.
 * Gathers data from Google APIs, applies deterministic rules, deduplicates
 * against prior sweeps, and decides whether to wake the agent.
 *
 * Output (stdout, last line): { "wakeAgent": boolean, "data"?: SweepBrief }
 */
import fs from 'fs';
import path from 'path';

import { google } from 'googleapis';
import type { calendar_v3 } from 'googleapis';
import type { OAuth2Client } from 'google-auth-library';

// ── Paths ──────────────────────────────────────────────────────────────────

const WORKSPACE_MCP_DIR = '/home/node/.workspace-mcp';
const KEYS_PATH = path.join(WORKSPACE_MCP_DIR, 'gcp-oauth.keys.json');
const CREDS_PATH = path.join(WORKSPACE_MCP_DIR, 'credentials.json');
const CALENDARS_CONFIG_PATH = path.join(WORKSPACE_MCP_DIR, 'calendars.json');
const MATTERS_PATH = '/workspace/ipc/current_matters.json';
const SWEEP_STATE_PATH = '/workspace/group/sweep_state.json';

// ── Types ──────────────────────────────────────────────────────────────────

interface MatterSnapshot {
  id: number;
  title: string;
  status: string;
  artifacts: string | null;
  context: string | null;
  updated_at: string;
}

interface ParsedArtifact {
  type: string;
  id: string;
}

interface ThreadMeta {
  thread_id: string;
  subject: string;
  last_message_from: string;
  last_message_date: string;
  message_count: number;
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
  status: string;
  context: string | null;
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
  tomorrow?: CalendarBrief[];
  failures: Failure[];
}

interface SweepState {
  last_sweep_at: string;
  matters: Record<string, { updated_at: string; reported_at: string }>;
  calendar: Record<string, { updated: string; reported_at: string }>;
}

interface EventFilter {
  action: 'exclude' | 'includeOnly';
  where: string;
  inValuesOf?: string;
  equals?: string;
  calendarIds?: string[];
}

// ── Helpers ────────────────────────────────────────────────────────────────

function log(msg: string): void {
  process.stderr.write(`[heartbeat-sweep] ${msg}\n`);
}

function getNestedValue(obj: Record<string, unknown>, dotPath: string): unknown {
  let current: unknown = obj;
  for (const key of dotPath.split('.')) {
    if (current == null || typeof current !== 'object') return undefined;
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

function parseArtifacts(raw: string | null): ParsedArtifact[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (a: unknown): a is ParsedArtifact =>
        typeof a === 'object' &&
        a !== null &&
        typeof (a as ParsedArtifact).type === 'string' &&
        typeof (a as ParsedArtifact).id === 'string',
    );
  } catch {
    return [];
  }
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

// ── OAuth2 Client ──────────────────────────────────────────────────────────

function createOAuth2Client(): OAuth2Client {
  const keys = JSON.parse(fs.readFileSync(KEYS_PATH, 'utf-8'));
  const credsFile = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
  const creds = credsFile.normal || credsFile;

  const clientConfig = keys.installed || keys.web;
  const oauth2Client = new google.auth.OAuth2(
    clientConfig.client_id,
    clientConfig.client_secret,
    clientConfig.redirect_uris?.[0],
  );

  oauth2Client.setCredentials({
    access_token: creds.access_token,
    refresh_token: creds.refresh_token,
    expiry_date: creds.expiry_date,
  });

  // Persist refreshed tokens back to disk
  oauth2Client.on('tokens', (tokens) => {
    const existing = JSON.parse(fs.readFileSync(CREDS_PATH, 'utf-8'));
    const target = existing.normal || existing;
    if (tokens.access_token) target.access_token = tokens.access_token;
    if (tokens.refresh_token) target.refresh_token = tokens.refresh_token;
    if (tokens.expiry_date) target.expiry_date = tokens.expiry_date;
    fs.writeFileSync(CREDS_PATH, JSON.stringify(existing, null, 2));
  });

  return oauth2Client;
}

async function getAssistantEmail(oauth2Client: OAuth2Client): Promise<string> {
  const { token } = await oauth2Client.getAccessToken();
  if (!token) throw new Error('No access token available');
  const tokenInfo = await oauth2Client.getTokenInfo(token);
  return tokenInfo.email || '';
}

// ── Event Filters ──────────────────────────────────────────────────────────

function loadEventFilters(): EventFilter[] {
  if (!fs.existsSync(CALENDARS_CONFIG_PATH)) return [];
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
      // Cross-event filter: collect all values at inValuesOf path, exclude events whose
      // 'where' field matches any of them
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

// ── Sweep State ────────────────────────────────────────────────────────────

function loadSweepState(): SweepState {
  if (!fs.existsSync(SWEEP_STATE_PATH)) {
    return { last_sweep_at: '', matters: {}, calendar: {} };
  }
  try {
    return JSON.parse(fs.readFileSync(SWEEP_STATE_PATH, 'utf-8'));
  } catch {
    return { last_sweep_at: '', matters: {}, calendar: {} };
  }
}

function saveSweepState(state: SweepState): void {
  fs.writeFileSync(SWEEP_STATE_PATH, JSON.stringify(state, null, 2));
}

// ── Data Gathering ─────────────────────────────────────────────────────────

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
    message_count: messages.length,
  };
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

// ── Deterministic Rules ────────────────────────────────────────────────────

function tagMatters(
  matters: MatterBrief[],
  assistantEmail: string,
): void {
  const SEVENTY_TWO_HOURS = 72 * 60 * 60 * 1000;
  const now = Date.now();

  for (const matter of matters) {
    if (matter.status === 'escalated' && !matter.tags.includes('skip_escalated')) {
      matter.tags.push('skip_escalated');
    }

    // Check for stalled follow-ups: last thread message from assistant, >72h ago
    for (const thread of matter.threads) {
      const fromAssistant = thread.last_message_from
        .toLowerCase()
        .includes(assistantEmail.toLowerCase());
      if (fromAssistant && thread.last_message_date) {
        const msgTime = new Date(thread.last_message_date).getTime();
        if (now - msgTime > SEVENTY_TWO_HOURS) {
          matter.tags.push('stalled_followup');
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

    // FreeBusyReader events only participate in conflict detection (below),
    // they don't get individual tags since we can't see their details.
    if (!meta.is_all_day && !isFreeBusy) {
      // Late night: 10pm-7am
      const hour = getHour(meta.start);
      if (hour >= 22 || hour < 7) {
        tags.push('late_night');
      }

      // Missing meeting link
      if (
        !meta.hangout_link &&
        !meta.location &&
        meta.attendees.length > 0 &&
        hasExternalAttendees(meta.attendees, meta.organizer, assistantEmail)
      ) {
        tags.push('maybe_missing_link');
      }

      // Pending invites
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

      // Meeting prep: next 2-3 hours with external attendees
      const startMs = new Date(meta.start).getTime();
      const hoursOut = (startMs - Date.now()) / (60 * 60 * 1000);
      if (hoursOut > 0 && hoursOut <= 3 &&
          hasExternalAttendees(meta.attendees, meta.organizer, assistantEmail)) {
        tags.push('needs_prep');
      }
    }

    tagged.push({ meta, tags });
  }

  // Conflicts: check all pairs across different calendars.
  // FreeBusyReader events participate as time blocks but don't get tagged —
  // only the full-access side gets the conflict tag.
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

  // Conflicts override safe_to_accept
  for (const t of tagged) {
    const safeIdx = t.tags.indexOf('safe_to_accept');
    if (safeIdx !== -1 && t.tags.includes('conflict')) {
      t.tags.splice(safeIdx, 1);
    }
  }

  // Triple-stacked: 3+ events in same 1-hour slot.
  // FreeBusy events count toward the total but don't get tagged.
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

// ── Main ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const now = new Date();
  const nowIso = now.toISOString();
  const failures: Failure[] = [];

  // 1. Create OAuth2 client
  const oauth2Client = createOAuth2Client();

  // 2. Derive assistant email
  const assistantEmail = await getAssistantEmail(oauth2Client);
  log(`Assistant email: ${assistantEmail}`);

  // 3. Read matters snapshot
  let mattersSnapshot: MatterSnapshot[] = [];
  if (fs.existsSync(MATTERS_PATH)) {
    try {
      mattersSnapshot = JSON.parse(fs.readFileSync(MATTERS_PATH, 'utf-8'));
    } catch {
      log('Failed to parse matters snapshot');
    }
  }

  // 4. Load sweep state
  const prevState = loadSweepState();

  // 5. Check evening preview (hour === 21 in local TZ)
  const localHour = parseInt(
    new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: process.env.TZ || 'UTC',
    }).format(now),
    10,
  );
  const isEveningPreview = localHour === 21;

  // ── Gather data in parallel ──────────────────────────────────────────

  const calendarClient = google.calendar({ version: 'v3', auth: oauth2Client });
  const gmail = google.gmail({ version: 'v1', auth: oauth2Client });
  const people = google.people({ version: 'v1', auth: oauth2Client });

  // ── Gather data in parallel ──────────────────────────────────────────
  //
  // Phase 1: calendar discovery + contacts (independent)
  // Phase 2: bulk calendar events + matter thread fetches (need calendars)
  // Matter-linked events are looked up from bulk results, no extra API calls.

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

  // Parse matter artifacts and build thread fetch list
  const matterBriefs: MatterBrief[] = [];
  const matterById = new Map<number, MatterBrief>();
  const threadFetches: Array<{ matterId: number; threadId: string }> = [];
  const matterEventIds: Array<{ matterId: number; eventId: string }> = [];

  for (const m of mattersSnapshot) {
    const artifacts = parseArtifacts(m.artifacts);
    const brief: MatterBrief = {
      id: m.id,
      title: m.title,
      status: m.status,
      context: m.context,
      artifacts,
      updated_at: m.updated_at,
      tags: [],
      threads: [],
      events: [],
    };

    // Check if this escalated matter is unchanged — skip fetching
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

    for (const a of artifacts) {
      if (a.type === 'email_thread') threadFetches.push({ matterId: m.id, threadId: a.id });
      if (a.type === 'calendar_event') matterEventIds.push({ matterId: m.id, eventId: a.id });
    }

    matterBriefs.push(brief);
    matterById.set(m.id, brief);
  }

  // Fetch bulk calendar events and threads in parallel
  const calendars = await calendarDiscoveryPromise;
  const sevenDaysFromNow = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);

  const [calendarFetchResults, threadResults] = await Promise.all([
    // Bulk calendar events across all calendars
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
    // Thread fetches for matters
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
  ]);

  // Build event ID → EventMeta map from bulk results
  const allRawEvents: Array<{ event: calendar_v3.Schema$Event; calendarId: string }> = [];
  for (const batch of calendarFetchResults) {
    allRawEvents.push(...batch);
  }

  const bulkEventMap = new Map<string, EventMeta>();
  for (const { event, calendarId } of allRawEvents) {
    if (event.id) bulkEventMap.set(event.id, toEventMeta(event, calendarId));
  }

  // Attach threads to matters
  for (const result of threadResults) {
    if (!result) continue;
    const brief = matterById.get(result.matterId);
    if (brief) brief.threads.push(result.meta);
  }

  // Attach events to matters — look up from bulk results (no extra API calls)
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

  // Tag matters
  tagMatters(matterBriefs, assistantEmail);

  // Apply event filters from calendars.json
  const filters = loadEventFilters();
  const filteredEvents = applyEventFilters(allRawEvents, filters);

  // Build set of event IDs linked to surviving (non-dropped) matters
  const matterLinkedEventIds = new Set<string>();
  for (const m of matterBriefs) {
    if (m.tags.includes('skip_escalated') && prevState.matters[String(m.id)]?.updated_at === m.updated_at) {
      continue; // Dropped matter — don't exclude its events from calendar section
    }
    for (const a of m.artifacts) {
      if (a.type === 'calendar_event') matterLinkedEventIds.add(a.id);
    }
  }

  // Convert to EventMeta, exclude matter-linked events
  const calendarEvents: EventMeta[] = [];
  for (const { event, calendarId } of filteredEvents) {
    if (event.id && matterLinkedEventIds.has(event.id)) continue;
    calendarEvents.push(toEventMeta(event, calendarId));
  }

  // Apply calendar rules
  const contactEmails = await contactsPromise;
  const freeBusyCalendarIds = new Set(
    calendars.filter((c) => c.accessRole === 'freeBusyReader').map((c) => c.id),
  );
  const taggedCalendar = tagCalendarEvents(calendarEvents, contactEmails, assistantEmail, freeBusyCalendarIds);

  // Only keep events with at least one tag (the rest are "clean" — no issues)
  const calendarFindings = taggedCalendar.filter((t) => t.tags.length > 0);

  // ── Evening preview: tomorrow's events ──────────────────────────────

  let tomorrowBriefs: CalendarBrief[] | undefined;
  if (isEveningPreview) {
    const tomorrowStart = new Date(now);
    tomorrowStart.setDate(tomorrowStart.getDate() + 1);
    tomorrowStart.setHours(0, 0, 0, 0);
    const tomorrowEnd = new Date(tomorrowStart);
    tomorrowEnd.setDate(tomorrowEnd.getDate() + 1);

    // Filter from already-fetched events (they're within the 7-day window)
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

  // ── Dedup against sweep state ───────────────────────────────────────

  const newState: SweepState = {
    last_sweep_at: nowIso,
    matters: {},
    calendar: {},
  };

  // Dedup matters
  const survivingMatters: MatterBrief[] = [];
  for (const m of matterBriefs) {
    const key = String(m.id);
    const prev = prevState.matters[key];

    if (prev && prev.updated_at === m.updated_at) {
      newState.matters[key] = prev;
    } else {
      survivingMatters.push(m);
      newState.matters[key] = { updated_at: m.updated_at, reported_at: nowIso };
    }
  }

  // Dedup calendar findings
  const survivingCalendar: CalendarBrief[] = [];
  for (const finding of calendarFindings) {
    const key = `${finding.meta.calendar_id}:${finding.meta.event_id}`;
    const prev = prevState.calendar[key];

    if (prev && prev.updated === finding.meta.updated) {
      newState.calendar[key] = prev;
    } else {
      survivingCalendar.push(toCalendarBrief(finding.meta, finding.tags, finding.conflictWith));
      newState.calendar[key] = { updated: finding.meta.updated, reported_at: nowIso };
    }
  }

  // ── Decide: wake agent or not ───────────────────────────────────────

  const isQuiet =
    survivingMatters.length === 0 &&
    survivingCalendar.length === 0 &&
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
    ...(tomorrowBriefs && { tomorrow: tomorrowBriefs }),
    failures,
  };

  log(
    `Waking agent: ${survivingMatters.length} matters, ${survivingCalendar.length} calendar findings, ${failures.length} failures`,
  );
  console.log(JSON.stringify({ wakeAgent: true, data: brief }));
}

main().catch((err) => {
  log(`Fatal error: ${err instanceof Error ? err.message : String(err)}`);
  // Let the script crash — agent-runner will wake agent with full sweep as fallback
  process.exit(1);
});
