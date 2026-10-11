/**
 * Each link of a matter as its source says it is now (KTD5, R4): read live
 * through the host's own Google clients whenever a matter is rendered, and
 * never stored, so "did that go out?" is answered by Gmail, not by a copy.
 *
 * - A thread: its latest message in Gmail, when it came, and whose turn it
 *   is. The latest is ours when the assistant sent it or it shows one of the
 *   principal's addresses, and theirs otherwise. A draft is not a message.
 * - An event: its time, whether it stands, and each guest's answer.
 * - A file: when it last changed and who changed it, and its open comments
 *   assigned to the assistant or mentioning it.
 * - A person by name, and a memory file as its path for `main` to read.
 *
 * Every link is read at once with the others, under its own five-second
 * deadline, as the link check's Drive reads are. One that fails or is late
 * renders "couldn't read just now", and the rest render all the same.
 *
 * The host's own words name someone only from what Google and the people
 * store say of an address: the principal and the assistant as themselves,
 * anyone with a record by name, and anyone the principal had forgotten by
 * neither name nor address (R26). What someone else wrote reaches `main`
 * framed as untrusted: a thread's subject, its From as written and Gmail's
 * excerpt, a file's title and comments, and another agent's account (KTD9).
 */
import { log } from '../../log.js';
import { formatLocalTime } from '../../timezone.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createGmailApi, GoogleApiError, type GmailApi } from '../gws-ea-inbox/gmail-api.js';
import {
  decodeEncodedWords,
  headerValues,
  htmlToText,
  normalizeAddress,
  oneLine,
  parseAddressList,
  parseGmailMessage,
} from '../gws-ea-inbox/mime.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { getThread, threadAccount } from '../gws-ea-inbox/thread-map.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import {
  createMeetingsCalendarApi,
  type EventAttendee,
  type EventTime,
  type MeetingsCalendarApi,
} from '../gws-ea-meetings/calendar-api.js';
import { findPeople, getPerson, loadForgottenMatcher } from '../gws-ea-people/db.js';
import { getGwsEaProfile, loadPrincipalRecognizer, type PrincipalRecognizer } from '../gws-ea-profile/db.js';
import {
  createDriveApi,
  FOLDER_MIME_TYPE,
  isDriveRateLimit,
  type DriveApi,
  type DriveComment,
  type DriveFile,
} from '../gws-ea-workspace/drive-api.js';
import type { MatterLink } from './db.js';

/** How long one read may take before its link renders as unread. */
export const READ_DEADLINE_MS = 5_000;
const UNREAD = "couldn't read just now";
const FORGOTTEN = 'someone forgotten';
const FRAME_LIMIT = 1_200;
const ACCOUNT_LIMIT = 2_000;
/** The guests an answer names before it counts the rest. */
const GUESTS_NAMED = 8;
/** The open comments for the assistant a file shows the words of, newest first. */
const COMMENTS_SHOWN = 3;
const DAY_MS = 24 * 60 * 60 * 1000;

/** What the agent working a thread last said of it (KTD9): its words, and when, ISO. */
export interface ThreadAccount {
  readonly text: string;
  readonly at: string;
}

/** Where a matter's links are read from. */
export interface LiveSources {
  readonly gmail: Pick<GmailApi, 'getThread'>;
  readonly calendar: Pick<MeetingsCalendarApi, 'getEvent'>;
  readonly drive: Pick<DriveApi, 'getFile' | 'listComments'>;
  /**
   * The account the agent working a thread last left on it, or undefined
   * while it has left none. Without this reader, no account is shown.
   */
  readonly threadAccount?: (threadKey: string) => Promise<ThreadAccount | undefined>;
}

let host: LiveSources | undefined;

/**
 * Google as the host's own tokens reach it, as the inbox, meetings and
 * Workspace reach it, and each thread's account from the thread map. Built
 * on first use.
 */
export function hostSources(): LiveSources {
  host ??= {
    gmail: createGmailApi({ token: () => hostGoogleAccessToken('gmail') }),
    calendar: createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') }),
    drive: createDriveApi({ token: () => hostGoogleAccessToken('drive-host') }),
    threadAccount,
  };
  return host;
}

/** Who the host's words may name, and the zone it gives times in: read once for a render. */
export interface Lens {
  readonly timezone: string;
  readonly principalName: string;
  readonly principal: PrincipalRecognizer;
  readonly assistant: ReadonlySet<string>;
  readonly isForgotten: (handle: string) => boolean;
}

export async function loadLens(timezone: string): Promise<Lens> {
  const profile = await getGwsEaProfile();
  return {
    timezone,
    principalName: profile.principal_display_name ?? 'the principal',
    principal: await loadPrincipalRecognizer(),
    assistant: await assistantAddresses(),
    isForgotten: await loadForgottenMatcher(),
  };
}

/** Someone, by an address Google gave, in the host's own words. */
async function who(value: string, lens: Lens): Promise<string> {
  const address = normalizeAddress(value);
  if (address === undefined) return 'someone';
  if (lens.principal.has(address)) return lens.principalName;
  if (lens.assistant.has(address)) return 'the assistant';
  if (lens.isForgotten(`email:${address}`)) return FORGOTTEN;
  const [person] = (await findPeople(`email:${address}`)).people;
  return person?.name ?? address;
}

function reasonOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

type Read<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly error: unknown };

/** `read`'s answer, or why there is none: it failed, or missed the read deadline. Never rejects. */
async function within<T>(what: string, read: () => Promise<T>): Promise<Read<T>> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_answer, fail) => {
    timer = setTimeout(() => fail(new Error(`No answer within ${READ_DEADLINE_MS} ms`)), READ_DEADLINE_MS);
  });
  /* eslint-disable no-catch-all/no-catch-all -- a source that fails or is late costs its own link's line, never the render */
  try {
    return { ok: true, value: await Promise.race([read(), late]) };
  } catch (error) {
    log.warn('A matter link could not be read', { link: what, reason: reasonOf(error) });
    return { ok: false, error };
  } finally {
    clearTimeout(timer);
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** A link as its source says it is: the host's own words, and what someone else wrote that comes with it, framed. */
interface LinkState {
  readonly line: string;
  readonly framed?: string;
}

// ---------------------------------------------------------------------------
// Threads
// ---------------------------------------------------------------------------

async function threadState(threadKey: string, gmail: LiveSources['gmail'], lens: Lens): Promise<LinkState> {
  const thread = await getThread(threadKey);
  if (thread === undefined) return { line: 'no such thread' };
  if (thread.gmailThreadId === null) return { line: 'nothing sent yet' };
  const messages = await gmail.getThread(thread.gmailThreadId);
  if (messages === undefined) return { line: 'no longer in Gmail' };
  const latest = messages.filter((message) => !(message.labelIds ?? []).includes('DRAFT')).at(-1);
  if (latest === undefined) return { line: 'no messages yet' };

  const mail = parseGmailMessage(latest);
  const at = mail.receivedAt ?? new Date(headerValues(mail.headers, 'Date')[0] ?? '');
  const when = Number.isNaN(at.getTime()) ? 'latest' : `latest ${formatLocalTime(at.toISOString(), lens.timezone)}`;
  const fromAsWritten = oneLine(decodeEncodedWords(headerValues(mail.headers, 'From').join(', ')));
  const written = parseAddressList(fromAsWritten) ?? [];
  if (written.some(({ address }) => lens.isForgotten(`email:${address}`))) {
    return { line: `${when}, from ${FORGOTTEN}: waiting on us` };
  }

  const excerpt = latest.snippet === undefined ? '' : oneLine(htmlToText(latest.snippet));
  const said = [
    ...(mail.subject === '' ? [] : [`Subject: ${mail.subject}`]),
    ...(fromAsWritten === '' ? [] : [`From: ${fromAsWritten}`]),
    ...(excerpt === '' ? [] : [`Excerpt: ${excerpt}`]),
  ];
  const framed = said.length === 0 ? {} : { framed: untrusted(said.join('\n'), FRAME_LIMIT) };
  if (mail.labelIds.includes('SENT')) return { line: `${when}, sent by the assistant: waiting on them`, ...framed };
  if (lens.principal.has(mail.from?.address)) {
    return { line: `${when}, from ${lens.principalName}'s address: waiting on them`, ...framed };
  }
  return { line: `${when}, from them: waiting on us`, ...framed };
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

/** A date, `YYYY-MM-DD`, as the principal reads it. */
function day(date: string): string {
  return new Date(`${date}T00:00:00Z`).toLocaleDateString('en-US', {
    timeZone: 'UTC',
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** When an event is, in the principal's zone: an end on the same day by its time alone; an all-day event by its days. */
function eventTime(start: EventTime | undefined, end: EventTime | undefined, timezone: string): string | undefined {
  if (start?.dateTime !== undefined) {
    const from = formatLocalTime(start.dateTime, timezone);
    if (end?.dateTime === undefined) return from;
    // "Oct 14, 2026, 4:00 PM": the day, then after its last comma the time.
    const to = formatLocalTime(end.dateTime, timezone);
    const cut = to.lastIndexOf(', ');
    const sameDay = from.slice(0, from.lastIndexOf(', ')) === to.slice(0, cut);
    return `${from} to ${sameDay ? to.slice(cut + 2) : to}`;
  }
  if (start?.date === undefined) return undefined;
  // An all-day event ends the day after its last.
  const last =
    end?.date === undefined
      ? start.date
      : new Date(Date.parse(`${end.date}T00:00:00Z`) - DAY_MS).toISOString().slice(0, 10);
  return last > start.date ? `${day(start.date)} to ${day(last)}, all day` : `${day(start.date)}, all day`;
}

const ANSWERS = [
  ['declined', 'declined'],
  ['tentative', 'maybe'],
  ['accepted', 'accepted'],
  ['needsAction', 'no answer yet'],
] as const;

/** Each answer the guests gave, with who gave it; rooms are no one. */
async function answers(attendees: readonly EventAttendee[], lens: Lens): Promise<string[]> {
  const guests = await Promise.all(
    attendees.flatMap((attendee) =>
      attendee.resource === true || attendee.email === undefined
        ? []
        : [who(attendee.email, lens).then((name) => ({ name, answer: attendee.responseStatus }))],
    ),
  );
  return ANSWERS.flatMap(([answer, label]) => {
    const names = guests.filter((guest) => guest.answer === answer).map((guest) => guest.name);
    if (names.length === 0) return [];
    const rest = names.length - GUESTS_NAMED;
    return [`${label}: ${names.slice(0, GUESTS_NAMED).join(', ')}${rest > 0 ? ` and ${rest} more` : ''}`];
  });
}

async function eventState(reference: string, calendar: LiveSources['calendar'], lens: Lens): Promise<LinkState> {
  const slash = reference.indexOf('/');
  const event = await calendar.getEvent(reference.slice(0, slash), reference.slice(slash + 1));
  if (event === undefined) return { line: 'not on the calendar' };
  const time = eventTime(event.start, event.end, lens.timezone);
  const parts = time === undefined ? [] : [time];
  if (event.status === 'cancelled') return { line: [...parts, 'cancelled'].join('; ') };
  if (event.status === 'confirmed' || event.status === 'tentative') parts.push(event.status);
  parts.push(...(await answers(event.attendees ?? [], lens)));
  return { line: parts.join('; ') };
}

// ---------------------------------------------------------------------------
// Files
// ---------------------------------------------------------------------------

/** A file's comments, or undefined when Drive's final word is that the assistant does not see them, as on a file it can only view. */
async function commentsOn(fileId: string, drive: LiveSources['drive']): Promise<DriveComment[] | undefined> {
  try {
    return await drive.listComments(fileId);
  } catch (error) {
    if (error instanceof GoogleApiError && !error.retryable && !isDriveRateLimit(error)) return undefined;
    throw error;
  }
}

/** Open comments assigned to the assistant or mentioning it, newest first. */
function forAssistant(comments: readonly DriveComment[], assistant: ReadonlySet<string>): DriveComment[] {
  return comments
    .filter(
      (comment) =>
        comment.resolved !== true &&
        [comment.assigneeEmailAddress, ...(comment.mentionedEmailAddresses ?? [])].some(
          (address) => address !== undefined && assistant.has(address.toLowerCase()),
        ),
    )
    .sort((left, right) => (right.modifiedTime ?? '').localeCompare(left.modifiedTime ?? ''));
}

async function changed(file: DriveFile, lens: Lens): Promise<string[]> {
  if (file.modifiedTime === undefined) return [];
  const at = formatLocalTime(file.modifiedTime, lens.timezone);
  const by = file.lastModifyingUser?.emailAddress;
  return [by === undefined ? `changed ${at}` : `changed ${at} by ${await who(by, lens)}`];
}

async function fileState(fileId: string, drive: LiveSources['drive'], lens: Lens): Promise<LinkState> {
  const [read, comments] = await Promise.all([
    within(`file ${fileId}`, () => drive.getFile(fileId)),
    within(`comments on file ${fileId}`, () => commentsOn(fileId, drive)),
  ]);
  if (!read.ok) return { line: UNREAD };
  const file = read.value;
  if (file === undefined) return { line: 'gone, or not shared with the assistant' };

  const parts = [...(file.trashed === true ? ['in the trash'] : []), ...(await changed(file, lens))];
  const open = comments.ok && comments.value !== undefined ? forAssistant(comments.value, lens.assistant) : [];
  if (!comments.ok) {
    parts.push(`comments: ${UNREAD}`);
  } else if (comments.value !== undefined && file.mimeType !== FOLDER_MIME_TYPE) {
    const latest = open[0]?.modifiedTime;
    parts.push(
      open.length === 0
        ? 'no open comments for the assistant'
        : `${open.length} open comment${open.length === 1 ? '' : 's'} for the assistant` +
            (latest === undefined ? '' : `, the latest ${formatLocalTime(latest, lens.timezone)}`),
    );
  }
  const said = [
    ...(file.name === undefined ? [] : [`Title: ${file.name}`]),
    ...open.slice(0, COMMENTS_SHOWN).map((comment) => `Comment: ${oneLine(comment.content ?? '')}`),
  ];
  return {
    line: parts.join('; '),
    ...(said.length === 0 ? {} : { framed: untrusted(said.join('\n'), FRAME_LIMIT, 'drive') }),
  };
}

// ---------------------------------------------------------------------------
// People
// ---------------------------------------------------------------------------

async function personState(personId: string, lens: Lens): Promise<LinkState> {
  const person = await getPerson(personId);
  if (person === undefined) return { line: 'no record of them' };
  if (person.identities.some((identity) => lens.isForgotten(identity.handle))) return { line: FORGOTTEN };
  return { line: person.name };
}

// ---------------------------------------------------------------------------
// A link's lines
// ---------------------------------------------------------------------------

async function linkState(link: MatterLink, sources: LiveSources, lens: Lens): Promise<LinkState> {
  const what = `${link.kind} ${link.reference}`;
  const settled = async (read: () => Promise<LinkState>): Promise<LinkState> => {
    const state = await within(what, read);
    return state.ok ? state.value : { line: UNREAD };
  };
  switch (link.kind) {
    case 'thread':
      return settled(() => threadState(link.reference, sources.gmail, lens));
    case 'event':
      return settled(() => eventState(link.reference, sources.calendar, lens));
    case 'file':
      return fileState(link.reference, sources.drive, lens);
    case 'person':
      return settled(() => personState(link.reference, lens));
    case 'memory':
      return { line: '' };
    default: {
      const unreachable: never = link.kind;
      throw new Error(`Unknown link kind: ${String(unreachable)}`);
    }
  }
}

/** Who works the link besides `main`, and the account it last left on a thread (R7, KTD9). */
async function handlerLines(link: MatterLink, sources: LiveSources, lens: Lens): Promise<string[]> {
  if (link.handler === null) return [];
  const handled = `  handled by ${link.handler}`;
  const accountOf = sources.threadAccount;
  if (link.kind !== 'thread' || accountOf === undefined) return [handled];
  const account = await within(`account on ${link.reference}`, () => accountOf(link.reference));
  if (!account.ok) return [`${handled}; its account: ${UNREAD}`];
  if (account.value === undefined) return [handled];
  return [
    `${handled}; its account, ${formatLocalTime(account.value.at, lens.timezone)}:`,
    untrusted(account.value.text, ACCOUNT_LIMIT, link.handler),
  ];
}

/**
 * Each link as one compact line, in the order given: its kind, its
 * reference, and what its source says of it now, with what someone else
 * wrote framed under it, then who works it and their account.
 */
export async function readLinks(links: readonly MatterLink[], sources: LiveSources, lens: Lens): Promise<string[]> {
  return Promise.all(
    links.map(async (link) => {
      const [state, handled] = await Promise.all([linkState(link, sources, lens), handlerLines(link, sources, lens)]);
      return [
        `- ${link.kind} ${link.reference}${state.line === '' ? '' : `: ${state.line}`}`,
        ...(state.framed === undefined ? [] : [state.framed]),
        ...handled,
      ].join('\n');
    }),
  );
}
