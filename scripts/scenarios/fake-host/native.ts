/* eslint-disable no-catch-all/no-catch-all -- the synthetic RPC boundary records and returns every transport/handler failure */
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Session } from '../../../src/types.js';
import type { FakeCalendar, StoredEvent } from '../../../src/modules/gws-ea-meetings/testing/fake-calendar.js';
import type { GmailMessage } from '../../../src/modules/gws-ea-inbox/gmail-api.js';
import { SYNTHETIC_IDENTITY, type FixtureState } from './state.js';
import { syntheticGateway } from './gateway.js';
import { gogMail } from './gog-mail.js';

const PRINCIPAL = SYNTHETIC_IDENTITY.principalEmail;
const ASSISTANT = SYNTHETIC_IDENTITY.assistantEmail;
const json = (value: unknown, status = 200): Response =>
  new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

/** All Google HTTP requests stop here; the native token and API clients still run. */
export async function installSyntheticGoogle(root: string): Promise<{ calendar: FakeCalendar; mail: GmailMessage[] }> {
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
  const fixture = JSON.parse(fs.readFileSync(path.join(root, 'fixture.json'), 'utf8')) as FixtureState;
  for (const event of fixture.events) calendar.put(event);
  const mail = fixture.mail;
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
      return json({ access_token: 'synthetic-only', expires_in: 3600, scope: body.get('scope') ?? '' });
    }
    if (url.hostname !== 'www.googleapis.com' && url.hostname !== 'gmail.googleapis.com')
      throw new Error(`Synthetic host refused external network: ${url.hostname}`);
    const parts = url.pathname.split('/').filter(Boolean).map(decodeURIComponent);
    if (url.pathname.endsWith('/calendarList'))
      return json({
        items: [...calendar.calendars.values()].map((entry) => ({
          ...entry,
          conferenceProperties: { allowedConferenceSolutionTypes: entry.conferenceTypes },
        })),
      });
    const calendarListIndex = parts.indexOf('calendarList');
    if (calendarListIndex >= 0) {
      const entry = calendar.calendars.get(parts[calendarListIndex + 1] ?? '');
      return json(
        entry
          ? {
              ...entry,
              conferenceProperties: { allowedConferenceSolutionTypes: entry.conferenceTypes },
            }
          : { error: 'Calendar not found' },
        entry ? 200 : 404,
      );
    }
    const calendarIndex = parts.indexOf('calendars');
    if (calendarIndex >= 0) {
      const id = parts[calendarIndex + 1] ?? '';
      if (parts[calendarIndex + 2] !== 'events')
        return json(
          calendar.calendars.get(id) ?? { error: 'Calendar not found' },
          calendar.calendars.has(id) ? 200 : 404,
        );
      const eventId = parts[calendarIndex + 3];
      if (init?.method && init.method !== 'GET')
        throw new Error('This initial native transport has no Google write fixture. No write was made.');
      if (eventId) {
        const event = calendar.event(id, eventId);
        return json(event ? googleEvent(event) : { error: 'Event not found' }, event ? 200 : 404);
      }
      const min = url.searchParams.get('timeMin');
      const max = url.searchParams.get('timeMax');
      const events = min && max ? await calendar.listEvents(id, min, max) : calendar.live(id);
      return json({ items: events.map((event) => googleEvent(event as StoredEvent)) });
    }
    if (init?.method && init.method !== 'GET')
      throw new Error('This native fixture has no Gmail send/write transport. No email was sent.');
    const messages = parts.indexOf('messages');
    const threads = parts.indexOf('threads');
    if (messages >= 0) {
      const id = parts[messages + 1];
      if (id) {
        const message = mail.find((entry) => entry.id === id);
        return json(message ?? { error: 'Message not found' }, message ? 200 : 404);
      }
      return json({ messages: mail.map(({ id, threadId }) => ({ id, threadId })), resultSizeEstimate: mail.length });
    }
    if (threads >= 0) {
      const id = parts[threads + 1];
      return json({ id, messages: mail.filter((message) => message.threadId === id) });
    }
    throw new Error(`Unimplemented synthetic Google read: ${url.pathname}`);
  };
  return { calendar, mail };
}
function googleEvent(event: StoredEvent): Readonly<Record<string, unknown>> {
  const { calendarId: _calendar, tags, conference, ...fields } = event;
  return {
    ...fields,
    ...(tags ? { extendedProperties: { private: tags } } : {}),
    ...(conference?.uri ? { conferenceData: { entryPoints: [{ entryPointType: 'video', uri: conference.uri }] } } : {}),
  };
}

export async function serveNativeHost(
  root: string,
  session: Session,
  calendar: FakeCalendar,
  mail: GmailMessage[],
): Promise<void> {
  const { dispatch } = await import('../../../src/cli/dispatch.js');
  const { parseArgv } = await import('../../../src/cli/parse-argv.js');
  const { formatResponse } = await import('../../../src/cli/format.js');
  const { getDeliveryAction } = await import('../../../src/delivery.js');
  const { inboundDbPath } = await import('../../../src/mailbox/sqlite/paths.js');
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
  const { getManualSections } = await import('../../../src/modules/gws-ea-manual/db.js');
  const snapshot = async (): Promise<unknown> => ({
    observedAt: new Date().toISOString(),
    calendars: [...calendar.calendars.values()],
    events: calendar.events,
    mail,
    session,
    chat: session.messaging_group_id
      ? await getDb().get('SELECT * FROM gws_ea_chats WHERE messaging_group_id = ?', session.messaging_group_id)
      : undefined,
    principalAddresses: await getDb().all('SELECT * FROM gws_ea_principal_addresses'),
    matters: await getDb().all('SELECT * FROM gws_ea_matters'),
    people: await Promise.all((await listPeople()).map((person) => getPerson(person.id))),
    whereabouts: await getWhereabouts(),
    manual: await getManualSections(),
    memory: memory(),
    tasks: await nativeCli(['tasks', 'list', '--json']),
  });
  const save = (): void => {
    const state = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as FixtureState;
    state.events = [...calendar.events];
    state.mail = mail;
    fs.writeFileSync(fixtureFile, JSON.stringify(state, null, 2));
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
      else if (body.method === 'ncl') {
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
        const action = String(body.args.action);
        const handler = getDeliveryAction(action);
        if (!handler) throw new Error(`No native delivery action: ${action}`);
        await handler(body.args, session);
        const db = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
        try {
          const answer = db
            .prepare('SELECT content FROM messages_in WHERE id=?')
            .get(`action-resp-${String(body.args.requestId)}`) as { content: string } | undefined;
          value = answer ? JSON.parse(answer.content) : { pending: true };
        } finally {
          db.close();
        }
      } else if (body.method === 'outbound') {
        const state = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as FixtureState;
        const sequence = state.outbound.length * 2 + 1;
        const row = createOutboundRecord(parseOutboundWrite(body.args.draft), sequence, new Date().toISOString());
        state.outbound.push({ ...row });
        fs.writeFileSync(fixtureFile, JSON.stringify(state, null, 2));
        value = row;
      } else if (body.method === 'effect') {
        const state = JSON.parse(fs.readFileSync(fixtureFile, 'utf8')) as FixtureState;
        state.effects.push({ ...(body.args as unknown as FixtureState['effects'][number]), attempt: state.attempt });
        fs.writeFileSync(fixtureFile, JSON.stringify(state, null, 2));
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
