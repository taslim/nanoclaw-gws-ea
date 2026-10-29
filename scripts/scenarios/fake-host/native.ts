/* eslint-disable no-catch-all/no-catch-all -- the synthetic RPC boundary records and returns every transport/handler failure */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../../src/types.js';
import type { FakeCalendar } from '../../../src/modules/gws-ea-meetings/testing/fake-calendar.js';
import type { GmailMessage } from '../../../src/modules/gws-ea-inbox/gmail-api.js';
import { SYNTHETIC_IDENTITY, readState, writeState, type FixtureState } from './state.js';
import { syntheticGateway } from './gateway.js';
import { gogMail } from './gog-mail.js';
import { calendarTransport, googleJson } from './google-calendar.js';
import { SyntheticGmailTransport } from './google-mail.js';
import { parseGmailMessage } from '../../../src/modules/gws-ea-inbox/mime.js';

const PRINCIPAL = SYNTHETIC_IDENTITY.principalEmail;
const ASSISTANT = SYNTHETIC_IDENTITY.assistantEmail;

/** All Google HTTP requests stop here; the native token and API clients still run. */
export async function installSyntheticGoogle(
  root: string,
): Promise<{ calendar: FakeCalendar; mail: GmailMessage[]; gmail: SyntheticGmailTransport }> {
  const { FakeCalendar: Calendar } = await import('../../../src/modules/gws-ea-meetings/testing/fake-calendar.js');
  const { GOOGLE_SERVICES, GOOGLE_GRANT_FILE_ENV } = await import('../../../src/modules/gws-ea-google/grant.js');
  const calendar = new Calendar();
  calendar.calendars.set(PRINCIPAL, {
    id: PRINCIPAL,
    summary: 'Morgan',
    dataOwner: PRINCIPAL,
    accessRole: 'owner',
    conferenceTypes: ['hangoutsMeet'],
  });
  calendar.calendars.set(ASSISTANT, {
    id: ASSISTANT,
    summary: 'Assistant',
    accessRole: 'owner',
    conferenceTypes: ['hangoutsMeet'],
  });
  const fixture = readState(path.join(root, 'fixture.json'));
  for (const entry of fixture.calendars ?? []) calendar.calendars.set(entry.id, entry);
  for (const event of fixture.events) calendar.put(event);
  const mail = fixture.mail;
  const gmail = new SyntheticGmailTransport(mail);
  const grant = path.join(root, 'synthetic-google-grant.json');
  fs.writeFileSync(
    grant,
    JSON.stringify({
      schema_version: 3,
      account: ASSISTANT,
      sub: '100000000000000000001',
      client_id: 'synthetic-only',
      client_secret: 'synthetic-only',
      consents: [
        {
          refresh_token: 'synthetic-only',
          scopes: [...new Set(Object.values(GOOGLE_SERVICES).flatMap((service) => service.scopes))],
        },
      ],
      granted_at: '2026-11-01T00:00:00.000Z',
    }),
    { mode: 0o600 },
  );
  process.env[GOOGLE_GRANT_FILE_ENV] = grant;
  const gateway = syntheticGateway();
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.hostname === 'synthetic-onecli.invalid') return gateway(url, init);
    if (url.hostname === 'oauth2.googleapis.com' && url.pathname === '/token') {
      const body = new URLSearchParams(String(init?.body));
      return googleJson({ access_token: 'synthetic-only', expires_in: 3600, scope: body.get('scope') ?? '' });
    }
    if (url.hostname !== 'www.googleapis.com' && url.hostname !== 'gmail.googleapis.com')
      throw new Error(`Synthetic host refused external network: ${url.hostname}`);
    const before = { writes: calendar.writes.length, mail: mail.length };
    try {
      const response = url.pathname.startsWith('/calendar/v3/')
        ? await calendarTransport(calendar, url, init)
        : url.pathname.startsWith('/gmail/v1/users/me/')
          ? await gmail.request(url, init)
          : undefined;
      if (!response) throw new Error(`Unimplemented synthetic Google operation: ${url.pathname}`);
      fs.appendFileSync(
        path.join(root, 'google-http.jsonl'),
        JSON.stringify({
          method: init?.method ?? 'GET',
          path: url.pathname,
          query: url.search,
          ifMatch: new Headers(init?.headers).get('if-match'),
          status: response.status,
        }) + '\n',
      );
      return response;
    } catch (error) {
      fs.appendFileSync(
        path.join(root, 'google-http.jsonl'),
        JSON.stringify({
          method: init?.method ?? 'GET',
          path: url.pathname,
          query: url.search,
          ifMatch: new Headers(init?.headers).get('if-match'),
          transportFailure: String(error),
          appliedCalendarWrites: calendar.writes.length - before.writes,
          storedMail: mail.length - before.mail,
        }) + '\n',
      );
      throw error;
    } finally {
      const state = readState(path.join(root, 'fixture.json'));
      if (state.scenario) {
        for (const write of calendar.writes.slice(before.writes)) {
          const { tags: _tags, conference, ...fields } = write.fields ?? {};
          state.effects.push({
            kind: 'event',
            operation: write.op,
            target: write.op === 'insert' ? write.calendarId : `${write.calendarId}/${write.eventId}`,
            payload: {
              sendUpdates: write.sendUpdates,
              ...fields,
              ...(conference ? { videoCall: true } : {}),
              ...(write.guests ? { guests: write.guests } : {}),
            },
            actor: state.scenario.audience,
            attempt: state.attempt,
          });
        }
        for (const message of mail.slice(before.mail)) {
          const parsed = parseGmailMessage(message);
          state.effects.push({
            kind: 'message',
            operation: 'send',
            target: [...parsed.to, ...parsed.cc].every((entry) => entry.address === PRINCIPAL)
              ? 'principal'
              : 'outward',
            payload: {
              to: parsed.to.map((entry) => entry.address),
              cc: parsed.cc.map((entry) => entry.address),
              subject: parsed.subject,
              text: parsed.text,
            },
            actor: state.scenario.audience,
            attempt: state.attempt,
          });
        }
        state.events = [...calendar.events];
        state.mail = mail;
        writeState(path.join(root, 'fixture.json'), state);
      }
    }
  };
  return { calendar, mail, gmail };
}

export async function serveNativeHost(
  root: string,
  session: Session,
  google: Awaited<ReturnType<typeof installSyntheticGoogle>>,
  refreshView: () => Promise<void>,
): Promise<void> {
  const { calendar, mail } = google;
  const { dispatch } = await import('../../../src/cli/dispatch.js');
  const { parseArgv } = await import('../../../src/cli/parse-argv.js');
  const { formatResponse } = await import('../../../src/cli/format.js');
  const { getDeliveryAction, deliverSessionMessages } = await import('../../../src/delivery.js');
  const { getMessagingGroup } = await import('../../../src/db/messaging-groups.js');
  const { inboundDbPath, outboundDbPath } = await import('../../../src/mailbox/sqlite/paths.js');
  const { getDb } = await import('../../../src/db/connection.js');
  const { createOutboundRecord, parseOutboundWrite } = await import('../../../src/mailbox/model.js');
  const Database = (await import('better-sqlite3')).default;
  const fixtureFile = path.join(root, 'fixture.json');
  const observations = path.join(root, 'tool-results.jsonl');
  const nativeCli = async (argv: string[]) => {
    const parsed = parseArgv(argv);
    const frame = await dispatch(
      { id: randomUUID(), command: parsed.command, args: parsed.args },
      {
        caller: 'agent',
        agentGroupId: session.agent_group_id,
        sessionId: session.id,
        messagingGroupId: session.messaging_group_id ?? '',
      },
    );
    return {
      frame,
      stdout:
        !parsed.json && frame.ok && frame.human !== undefined
          ? frame.human
          : formatResponse(frame, parsed.json ? 'json' : 'human'),
    };
  };
  const nativeAction = async (args: Record<string, unknown>, acting: Session = session): Promise<unknown> => {
    const action = String(args.action);
    const handler = getDeliveryAction(action);
    if (!handler) throw new Error(`No native delivery action: ${action}`);
    await handler(args, acting);
    const inbox = new Database(inboundDbPath(acting.agent_group_id, acting.id), { readonly: true });
    try {
      const answer = inbox
        .prepare('SELECT content FROM messages_in WHERE id=?')
        .get(`action-resp-${String(args.requestId)}`) as { content: string } | undefined;
      return answer ? (JSON.parse(answer.content) as unknown) : { pending: true };
    } finally {
      inbox.close();
    }
  };
  const memory = (): Readonly<Record<string, string>> => {
    const files: Record<string, string> = {};
    const visit = (directory: string): void => {
      if (!fs.lstatSync(directory, { throwIfNoEntry: false })?.isDirectory()) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) visit(file);
        else if (entry.isFile() && entry.name.endsWith('.md'))
          files[path.relative(path.join(root, 'agent'), file)] = fs.readFileSync(file, 'utf8');
      }
    };
    visit(path.join(root, 'agent', 'memory'));
    return files;
  };
  const { listPeople, getPerson } = await import('../../../src/modules/gws-ea-people/db.js');
  const { getWhereabouts } = await import('../../../src/modules/gws-ea-whereabouts/db.js');
  const { loadTimeline } = await import('../../../src/modules/gws-ea-whereabouts/timeline.js');
  const { getManualSections } = await import('../../../src/modules/gws-ea-manual/db.js');
  const { getSchedulingPreferences } = await import('../../../src/modules/gws-ea-preferences/db.js');
  const { listPrivateValues } = await import('../../../src/modules/gws-ea-privacy/db.js');
  const queuedHandoffs = async () =>
    (await getDb().all<{ id: string; agent_group_id: string }>('SELECT id,agent_group_id FROM sessions')).map(
      (entry) => {
        const inbox = new Database(inboundDbPath(entry.agent_group_id, entry.id), { readonly: true });
        try {
          return {
            sessionId: entry.id,
            agentGroupId: entry.agent_group_id,
            messages: inbox
              .prepare("SELECT id,timestamp,content,status FROM messages_in WHERE id LIKE 'handoff-%'")
              .all(),
          };
        } finally {
          inbox.close();
        }
      },
    );
  const snapshot = async (): Promise<unknown> => ({
    observedAt: new Date().toISOString(),
    closeRuns: await getDb().all('SELECT * FROM gws_ea_close_runs'),
    closeSchedules: await getDb().all('SELECT * FROM gws_ea_close_schedule'),
    timeAnchors: await getDb().all('SELECT * FROM gws_ea_time_anchors'),
    morningLooks: await getDb().all('SELECT * FROM gws_ea_morning_looks'),
    mailboxes: (
      await getDb().all<{ id: string; agent_group_id: string }>('SELECT id,agent_group_id FROM sessions')
    ).map((entry) => {
      const inbox = new Database(inboundDbPath(entry.agent_group_id, entry.id), { readonly: true });
      try {
        return {
          sessionId: entry.id,
          rows: inbox
            .prepare('SELECT id,kind,status,timestamp,content,trigger,process_after,series_id FROM messages_in')
            .all(),
        };
      } finally {
        inbox.close();
      }
    }),
    calendars: [...calendar.calendars.values()],
    events: calendar.events,
    calendarWrites: calendar.writes,
    calendarWriteLog: await getDb().all('SELECT * FROM gws_ea_calendar_write_log'),
    mail,
    session,
    sessions: await getDb().all('SELECT * FROM sessions'),
    queuedHandoffs: await queuedHandoffs(),
    chat: session.messaging_group_id
      ? await getDb().get('SELECT * FROM gws_ea_chats WHERE messaging_group_id = ?', session.messaging_group_id)
      : undefined,
    principalAddresses: await getDb().all('SELECT * FROM gws_ea_principal_addresses'),
    matters: await getDb().all('SELECT * FROM gws_ea_matters'),
    bookings: await getDb().all('SELECT * FROM gws_ea_bookings'),
    bookingRequests: await getDb().all('SELECT * FROM gws_ea_booking_requests'),
    threadSends: await getDb().all('SELECT * FROM gws_ea_thread_sends'),
    threadMessages: await getDb().all('SELECT * FROM gws_ea_thread_messages'),
    threadAddresses: await getDb().all('SELECT * FROM gws_ea_thread_addresses'),
    threads: await getDb().all('SELECT * FROM gws_ea_threads'),
    people: await Promise.all((await listPeople()).map((person) => getPerson(person.id))),
    whereabouts: await getWhereabouts(),
    whereaboutsTimeline: await loadTimeline(),
    manual: await getManualSections(),
    preferences: await getSchedulingPreferences(),
    privateValues: await listPrivateValues(),
    memory: memory(),
    tasks: await nativeCli(['tasks', 'list', '--json']),
  });
  const save = (): void => {
    const state = readState(fixtureFile);
    state.events = [...calendar.events];
    state.mail = mail;
    writeState(fixtureFile, state);
  };
  const handle = async (request: http.IncomingMessage, response: http.ServerResponse): Promise<void> => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    let body: { method: string; args: Record<string, unknown> };
    try {
      body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as typeof body;
    } catch {
      response.writeHead(400).end();
      return;
    }
    let value: unknown;
    try {
      if (body.method === 'snapshot') value = await snapshot();
      else if (body.method === 'refresh-view') {
        await refreshView();
        value = { refreshed: true };
      } else if (body.method === 'probe') {
        // Native writes run on this host; only their invented remote records and DB transaction are restored.
        const events = structuredClone(calendar.events);
        const writes = structuredClone(calendar.writes);
        const messages = structuredClone(mail);
        const fixture = fs.readFileSync(fixtureFile, 'utf8');
        const inboxes = await Promise.all(
          (await getDb().all<{ id: string; agent_group_id: string }>('SELECT id,agent_group_id FROM sessions')).map(
            async (entry) => {
              const file = inboundDbPath(entry.agent_group_id, entry.id);
              const inbox = new Database(file);
              try {
                return { file, rows: inbox.prepare('SELECT * FROM messages_in').all() as Record<string, unknown>[] };
              } finally {
                inbox.close();
              }
            },
          ),
        );
        const rollback = new Error('Rollback isolated native scenario proof');
        const steps = body.args.steps as readonly {
          method: 'ncl' | 'action' | 'main-action';
          args: Record<string, unknown>;
        }[];
        const results: { answer: unknown; snapshot: unknown }[] = [];
        try {
          await getDb().transaction(async () => {
            for (const step of steps) {
              let answer: unknown;
              if (step.method === 'main-action') {
                const { getMainAgentGroupId } = await import('../../../src/modules/gws-ea-profile/db.js');
                const { getSession } = await import('../../../src/db/sessions.js');
                const row = await getDb().get<{ id: string }>(
                  'SELECT id FROM sessions WHERE agent_group_id=? AND thread_id IS NULL',
                  await getMainAgentGroupId(),
                );
                const main = row ? await getSession(row.id) : undefined;
                if (!main) throw new Error('Native main conversation is unavailable for this isolated proof');
                answer = await nativeAction(step.args, main);
              } else
                answer =
                  step.method === 'action'
                    ? await nativeAction(step.args)
                    : await nativeCli(step.args.argv as string[]);
              results.push({ answer, snapshot: structuredClone(await snapshot()) });
            }
            throw rollback;
          });
        } catch (error) {
          if (error !== rollback) throw error;
        } finally {
          calendar.events.splice(0, calendar.events.length, ...events);
          calendar.writes.splice(0, calendar.writes.length, ...writes);
          mail.splice(0, mail.length, ...messages);
          for (const saved of inboxes) {
            const inbox = new Database(saved.file);
            try {
              inbox.transaction(() => {
                inbox.prepare('DELETE FROM messages_in').run();
                for (const row of saved.rows) {
                  const names = Object.keys(row);
                  inbox
                    .prepare(`INSERT INTO messages_in (${names.join(',')}) VALUES (${names.map(() => '?').join(',')})`)
                    .run(...names.map((name) => row[name]));
                }
              })();
            } finally {
              inbox.close();
            }
          }
          fs.writeFileSync(fixtureFile, fixture);
        }
        value = { results, restored: await snapshot() };
      } else if (body.method === 'ncl') {
        const argv = body.args.argv;
        if (!Array.isArray(argv) || !argv.every((entry): entry is string => typeof entry === 'string'))
          throw new Error('Invalid ncl argv');
        value = await nativeCli(argv);
      } else if (body.method === 'gog') {
        const argv = body.args.argv;
        if (!Array.isArray(argv) || !argv.every((entry): entry is string => typeof entry === 'string'))
          throw new Error('Invalid gog argv');
        const [service, verb] = argv;
        if (service === 'calendar' && verb === 'calendars') value = { calendars: [...calendar.calendars.values()] };
        else if (service === 'gmail') value = gogMail(argv, mail);
        else if (service === 'people' && verb === 'search') {
          const query = (argv[2] ?? '').toLocaleLowerCase('en');
          const people = await Promise.all((await listPeople()).map((person) => getPerson(person.id)));
          value = {
            people: people
              .filter((person) => person?.name.toLocaleLowerCase('en').includes(query))
              .flatMap(
                (person) =>
                  person?.identities
                    .filter((identity) => identity.handle.startsWith('email:'))
                    .map((identity) => ({ name: person.name, email: identity.handle.slice(6) })) ?? [],
              ),
          };
        } else throw new Error(`Unimplemented synthetic gog service: ${service}`);
      } else if (body.method === 'action') {
        value = await nativeAction(body.args);
      } else if (body.method === 'deliver') {
        const route = session.messaging_group_id ? await getMessagingGroup(session.messaging_group_id) : undefined;
        if (route?.channel_type !== 'email' || session.thread_id === null || typeof body.args.messageId !== 'string')
          throw new Error('Only the native email session can use this synthetic delivery transport');
        const outbox = new Database(outboundDbPath(session.agent_group_id, session.id));
        try {
          outbox
            .prepare(
              `INSERT OR IGNORE INTO messages_out (id,timestamp,kind,platform_id,channel_type,thread_id,content)
            VALUES (?,?,'chat',?,'email',?,?)`,
            )
            .run(
              body.args.messageId,
              new Date().toISOString(),
              route.platform_id,
              session.thread_id,
              JSON.stringify(body.args.content),
            );
        } finally {
          outbox.close();
        }
        await deliverSessionMessages(session);
        const inbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
        try {
          const receipt = inbox.prepare('SELECT * FROM delivered WHERE message_out_id=?').get(body.args.messageId) as
            | { status: string }
            | undefined;
          if (receipt?.status !== 'delivered')
            throw new Error(`Native email delivery is ${receipt?.status ?? 'pending'}`);
          value = { receipt };
        } finally {
          inbox.close();
        }
      } else if (body.method === 'transport-fault') {
        if (body.args.op === 'mail-after-send') google.gmail.failAfterNextSend = true;
        else if (body.args.op === 'insert-after-write')
          calendar.failNext({
            op: 'insert',
            afterApplying: true,
            error: new Error('Synthetic Calendar insert response lost after storing'),
          });
        else if (body.args.op === 'calendar-after-write') {
          const op = body.args.write;
          if (op !== 'patch' && op !== 'delete' && op !== 'guests' && op !== 'own')
            throw new Error('Unknown synthetic Calendar write fault');
          calendar.failNext({
            op,
            afterApplying: true,
            error: new Error(`Synthetic Calendar ${op} response lost after storing`),
          });
        } else throw new Error('Unknown synthetic transport fault');
        value = { armed: true };
      } else if (body.method === 'outbound') {
        const state = readState(fixtureFile);
        const sequence = state.outbound.length * 2 + 1;
        const row = createOutboundRecord(parseOutboundWrite(body.args.draft), sequence, new Date().toISOString());
        state.outbound.push({ ...row });
        writeState(fixtureFile, state);
        value = row;
      } else if (body.method === 'effect') {
        const state = readState(fixtureFile);
        state.effects.push({ ...(body.args as unknown as FixtureState['effects'][number]), attempt: state.attempt });
        writeState(fixtureFile, state);
        value = { recorded: true };
      } else if (body.method === 'stop') {
        response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true }));
        server.close();
        return;
      } else throw new Error(`Unknown synthetic host operation: ${body.method}`);
      save();
      fs.appendFileSync(observations, JSON.stringify({ method: body.method, input: body.args, result: value }) + '\n');
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ok: true, value }));
    } catch (error) {
      save();
      fs.appendFileSync(
        observations,
        JSON.stringify({ method: body.method, input: body.args, error: String(error) }) + '\n',
      );
      response
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify({ ok: false, error: String(error) }));
    }
  };
  const server = http.createServer((request, response) => {
    void handle(request, response).catch((error: unknown) => {
      fs.appendFileSync(observations, JSON.stringify({ error: String(error) }) + '\n');
      if (!response.headersSent) response.writeHead(500);
      response.end('Synthetic host transport failed');
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Synthetic host failed to bind');
  fs.writeFileSync(path.join(root, 'host-endpoint.json'), JSON.stringify({ url: `http://127.0.0.1:${address.port}` }));
  console.log('synthetic-host-ready');
  await new Promise<void>((resolve) => server.once('close', resolve));
}
