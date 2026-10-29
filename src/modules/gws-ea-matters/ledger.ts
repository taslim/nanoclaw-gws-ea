import { parseInboundContent } from '../../channels/inbound-content.js';
import { register } from '../../cli/registry.js';
import type { CallerContext } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { TIMEZONE } from '../../config.js';
import { formatLocalTimeWithZone } from '../../timezone.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { isRecord } from '../../gws-ea/validation.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { createMeetingsCalendarApi } from '../gws-ea-meetings/calendar-api.js';
import { calendarFindings, loadCalendarWeek } from '../gws-ea-meetings/days.js';
import { eventSpan } from '../gws-ea-meetings/slots.js';
import {
  completeCalendarWriteFindings,
  getCalendarWrite,
  listCalendarWriteGaps,
} from '../gws-ea-meetings/week/write-log.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { loadTimeline, zoneAt } from '../gws-ea-whereabouts/timeline.js';
import { getOpenCloseRun, lastCompletedClose, recordCloseLedger, type ConsumedCalendarWrite } from './close-runs.js';

export interface DaySection {
  readonly key: 'principal' | 'sends' | 'writes' | 'notes' | 'findings';
  entries: string[];
  unavailable: boolean;
  omitted: number;
}
export interface DayLedger {
  readonly from: string | null;
  readonly through: string;
  readonly sections: DaySection[];
}
const LIMIT = 60_000;
const DAY = 86_400_000;
const framed = (text: string, source: string): string => untrusted(text, Math.max(1, text.length), source);
const inWindow = (at: string, from: string | null, through: string): boolean =>
  Number.isFinite(Date.parse(at)) &&
  (from === null || Date.parse(at) >= Date.parse(from)) &&
  Date.parse(at) < Date.parse(through);
interface LoggedWrite {
  readonly request_id: string;
  readonly updated_at: string;
}
interface PendingNotice {
  readonly message_id: string;
  readonly calendar_id: string;
  readonly event_id: string;
  readonly change_kind: string;
  readonly received_at: string;
}

async function collect(sections: readonly DaySection[], read: () => Promise<void>): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- Availability is a ledger fact; database and provider errors must never reach the model. */
  try {
    await read();
  } catch {
    for (const section of sections) section.unavailable = true;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function hasHostPrincipalMessageMark(content: string, messageId: string): boolean {
  try {
    const parsed: unknown = JSON.parse(content);
    return (
      isRecord(parsed) &&
      isRecord(parsed.principalMessage) &&
      parsed.principalMessage.id === messageId &&
      typeof parsed.principalMessage.messagingGroupId === 'string'
    );
  } catch (error) {
    if (error instanceof SyntaxError) return false;
    throw error;
  }
}

/** Reads facts only. It neither settles notices nor acknowledges findings. */
export async function readDayLedger(ctx: CallerContext): Promise<DayLedger> {
  const through = new Date().toISOString();
  let main: string | null;
  let from: string | null;
  try {
    main = await getMainAgentGroupId();
    from = (await lastCompletedClose())?.ledger_through_at ?? null;
  } catch (error) {
    throw new Error('The day ledger’s host records are unavailable just now.', { cause: error });
  }
  if (ctx.caller === 'agent' && (main === null || ctx.agentGroupId !== main))
    throw new Error('Only main may read the day ledger.');
  const timeline = await loadTimeline().catch((_error: unknown) => undefined);
  const displayAt = (at: string): string => {
    const zone = ctx.caller === 'host' ? TIMEZONE : timeline && zoneAt(timeline, Date.parse(at));
    return zone ? formatLocalTimeWithZone(at, zone) : `${at} (local zone unavailable)`;
  };
  const section = (key: DaySection['key']): DaySection => ({ key, entries: [], unavailable: false, omitted: 0 });
  const principal = section('principal');
  const sends = section('sends');
  const writes = section('writes');
  const notes = section('notes');
  const findings = section('findings');
  const result: DayLedger = { from, through, sections: [principal, sends, writes, notes, findings] };
  const consumed = new Map<string, ConsumedCalendarWrite>();
  await collect([principal, notes, sends], async () => {
    for (const session of main === null ? [] : await getSessionsByAgentGroup(main)) {
      if (session.messaging_group_id === null && session.thread_id?.startsWith('system:')) continue;
      await collect([principal, notes, sends], async () => {
        const read = await withExistingMailboxSession(session.agent_group_id, session.id, async (mailbox) => {
          await collect([principal, notes], async () => {
            for (const message of mailbox.getInboundRecords(from === null ? {} : { since: from })) {
              if (
                !inWindow(message.timestamp, from, through) ||
                (message.kind !== 'chat' && message.kind !== 'chat-sdk' && message.kind !== 'webhook')
              )
                continue;
              const text = parseInboundContent(message.content).text;
              if (!text) continue;
              if (hasHostPrincipalMessageMark(message.content, message.id))
                principal.entries.push(`${displayAt(message.timestamp)}; conversation ${session.id}\n${text}`);
              else
                notes.entries.push(
                  `${displayAt(message.timestamp)}; conversation ${session.id}\n${framed(text, 'conversation_note')}`,
                );
            }
          });
          await collect([sends], async () => {
            for (const message of mailbox.getOutboundHistory(Number.MAX_SAFE_INTEGER))
              if (
                inWindow(message.timestamp, from, through) &&
                !['system', 'task_log', 'cli_request'].includes(message.kind)
              )
                sends.entries.push(
                  `${displayAt(message.timestamp)}; conversation ${session.id}\n${framed(message.content, 'main_send')}`,
                );
          });
          return true;
        });
        if (read === undefined) {
          principal.unavailable = true;
          notes.unavailable = true;
          sends.unavailable = true;
        }
      });
    }
  });
  const calendar = createMeetingsCalendarApi({ token: () => hostGoogleAccessToken('calendar-host') });
  await collect([writes], async () => {
    const gaps = new Set((await listCalendarWriteGaps()).map((write) => write.requestId));
    const rows = await getDb().all<LoggedWrite>(
      'SELECT request_id,updated_at FROM gws_ea_calendar_write_log WHERE updated_at<=? ORDER BY updated_at,request_id',
      through,
    );
    for (const row of rows) {
      const write = await getCalendarWrite(row.request_id);
      if (!write) continue;
      let checked: string;
      if (write.state === 'pending') checked = 'Outcome not confirmed; this write is pending. Findings not checked.';
      else
        try {
          if (!timeline) throw new Error('The local clock is unavailable.');
          checked = await calendarFindings(
            await loadCalendarWeek(calendar, {
              start: Date.parse(write.affectedStart),
              end: Date.parse(write.affectedEnd),
              timeline,
            }),
          );
          if (gaps.has(write.requestId)) await completeCalendarWriteFindings(write.requestId);
          // eslint-disable-next-line no-catch-all/no-catch-all -- A failed recheck leaves the durable gap open.
        } catch {
          checked = gaps.has(write.requestId) ? 'Findings gap: recheck unavailable.' : 'Findings unavailable.';
        }
      const current = await getDb().get<LoggedWrite>(
        'SELECT request_id,updated_at FROM gws_ea_calendar_write_log WHERE request_id=?',
        write.requestId,
      );
      const entry = `${write.requestId}: ${write.action}; ${displayAt(write.affectedStart)} to ${displayAt(write.affectedEnd)}\n${framed(JSON.stringify({ calendar: write.calendarId, event: write.eventId, request: write.request, outcome: write.outcome }), 'calendar_write')}\n${checked}`;
      writes.entries.push(entry);
      if (current && write.state === 'applied')
        consumed.set(entry, { requestId: write.requestId, updatedAt: current.updated_at });
    }
  });
  await collect([notes], async () => {
    for (const notice of await getDb().all<PendingNotice>(
      'SELECT * FROM gws_ea_pending_calendar_changes WHERE received_at<=? ORDER BY received_at,message_id',
      through,
    )) {
      let checked: string;
      try {
        if (!timeline) throw new Error('The local clock is unavailable.');
        const event = await calendar.getEvent(notice.calendar_id, notice.event_id);
        const span = event && eventSpan(event, zoneAt(timeline, Date.parse(notice.received_at)) ?? 'UTC');
        checked = await calendarFindings(
          await loadCalendarWeek(calendar, {
            ...(span ?? { start: Date.parse(notice.received_at) - DAY, end: Date.parse(notice.received_at) + DAY }),
            timeline,
          }),
        );
        // eslint-disable-next-line no-catch-all/no-catch-all -- Pending notices remain pending even when their fresh findings are unavailable.
      } catch {
        checked = 'Findings unavailable.';
      }
      notes.entries.push(
        `${displayAt(notice.received_at)}; pending calendar notice\n${framed(JSON.stringify({ calendar: notice.calendar_id, event: notice.event_id, change: notice.change_kind }), 'calendar_notice')}\n${checked}`,
      );
    }
  });
  await collect([findings], async () => {
    if (!timeline) throw new Error('The local clock is unavailable.');
    findings.entries.push(
      await calendarFindings(
        await loadCalendarWeek(calendar, {
          start: from === null ? Date.parse(through) - DAY : Date.parse(from),
          end: Date.parse(through),
          timeline,
        }),
      ),
    );
  });
  let serializedLength = JSON.stringify(result).length;
  for (const current of [sends, notes, writes, findings, principal]) {
    let removed = 0;
    while (serializedLength > LIMIT && removed < current.entries.length) {
      serializedLength -= JSON.stringify(current.entries[removed]).length;
      if (current.entries.length - removed > 1) serializedLength -= 1;
      serializedLength += String(current.omitted + 1).length - String(current.omitted).length;
      removed += 1;
      current.omitted += 1;
    }
    if (removed) current.entries = current.entries.slice(removed);
  }
  if (ctx.caller === 'agent') {
    try {
      const run = await getOpenCloseRun(ctx.sessionId);
      if (run)
        await recordCloseLedger(run.id, ctx.sessionId, {
          from,
          through,
          writes: writes.entries.flatMap((entry) => {
            const held = consumed.get(entry);
            return held ? [held] : [];
          }),
        });
    } catch (error) {
      throw new Error(
        'The day ledger could not be recorded for this close. Read it again before marking the close done.',
        { cause: error },
      );
    }
  }
  return result;
}

/** to: main */
register({
  name: 'day',
  access: 'open',
  description:
    'Read the day since the last completed close: principal messages, main sends, notes, calendar writes and findings. Only main may read it.',
  parseArgs(raw) {
    if (Object.keys(raw).length) throw new Error('ncl day takes no arguments.');
    return raw;
  },
  handler: (_args, ctx) => readDayLedger(ctx),
  formatHuman: (data) =>
    [
      'Day ledger since the last completed close',
      ...data.sections.map((section) =>
        [
          section.key,
          ...(section.unavailable ? ['Some evidence is unavailable.'] : []),
          ...section.entries,
          ...(section.omitted ? [`${section.omitted} earlier entries omitted.`] : []),
        ].join('\n'),
      ),
    ].join('\n\n'),
});
