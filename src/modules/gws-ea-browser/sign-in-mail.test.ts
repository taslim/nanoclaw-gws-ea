import { useAvailableBrowser } from './testing/browser-runtime.js';
import * as loginStoreModule from './login-store.js';
import { testLoginStore } from './testing/login-store.js';
// Registers the browser module's migrations.
import './index.js';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ElementHandle, Frame, Page } from 'playwright-core';
const root = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-sign-in-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: root,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
vi.mock('./fill.js', async (original) => ({
  ...(await original<typeof import('./fill.js')>()),
  bindBrowserSecretFields: vi.fn(),
  fillBoundBrowserSecrets: vi.fn(),
}));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { BrowserStore } from './db.js';
import {
  answerSignInReply,
  registerSignInMailDelivery,
  type SignInReply,
  cleanupBrowserSignInMail,
  executeSignInCode,
  finishSignupVerification,
  openSignupVerification,
  recoverBrowserSignInMail,
  takeSignupVerification,
  validateSignInCode,
} from './sign-in-mail.js';
import { bindBrowserSecretFields, fillBoundBrowserSecrets, type BoundBrowserSecretFields } from './fill.js';
import { observePage, type PinnedBrowserRef } from './observe.js';
import { pageHasSecret } from './page-privacy.js';
import type { BrowserExecutionContext } from './actions.js';
import { getDeliveryAction } from '../../delivery.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { routeSignInMail } from '../gws-ea-inbox/route-mail.js';
import { parseGmailMessage } from '../gws-ea-inbox/mime.js';
import { resolveSystemSession } from '../../session-manager.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { GmailApi, GmailMessage } from '../gws-ea-inbox/gmail-api.js';
import { setActiveInbox, type InboxRuntime } from '../gws-ea-inbox/runtime.js';
import { getSignInClaim } from '../gws-ea-inbox/claims.js';
import { gwsEaInboxMigration } from '../gws-ea-inbox/migration.js';
import { registerMigration } from '../../db/migrations/index.js';
import '../gws-ea-profile/index.js';
import { addPrincipalAddress } from '../gws-ea-profile/db.js';
import { recordWebAlias } from '../gws-ea-profile/testing/web-alias.js';

registerMigration(gwsEaInboxMigration);
registerSignInMailDelivery();

/** The assistant's web alias: its email on every site. */
const ALIAS = 'tnatsissa@example.com';

let messages: GmailMessage[];
let nextReply: SignInReply;
let read: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  useAvailableBrowser();
  const logins = testLoginStore(`${root}/browser`);
  vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(logins.store);
  vi.stubEnv('GWS_EA_BROWSER_ROOT', `${root}/missing-${randomUUID()}.json`);
  await runMigrations(await initTestDb());
  await getDb().run(
    'UPDATE gws_ea_profile SET assistant_workspace_email = ? WHERE singleton = 1',
    'assistant@example.com',
  );
  await recordWebAlias(ALIAS);
  messages = [];
  nextReply = { kind: 'code', value: '642981' };
  await createAgentGroup({
    id: 'external-email',
    name: 'external-email',
    folder: 'external-email',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run(
    'UPDATE gws_ea_profile SET external_email_agent_group_id = ? WHERE singleton = 1',
    'external-email',
  );
  list = vi.fn(async () => messages.map(({ id, threadId }) => ({ id, threadId })));
  read = vi.fn(async (id: string) => messages.find((message) => message.id === id));
  setActiveInbox({
    gmail: { listMessages: list, getMessage: read } as unknown as GmailApi,
    gmailAddress: async () => 'assistant@example.com',
    knownGmailAddress: () => 'assistant@example.com',
    sleep: async () => undefined,
    wakeSignIn: () => undefined,
    now: () => new Date(),
  } as unknown as InboxRuntime);
});
afterEach(async () => {
  await recoverBrowserSignInMail();
  setActiveInbox(undefined);
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});
function receive(
  body: string,
  options: {
    spam?: boolean;
    signer?: string;
    subject?: string;
    html?: string;
    to?: string;
    from?: string;
    at?: number;
  } = {},
): void {
  const domain = options.signer ?? 'shop.example';
  messages.push({
    id: String(messages.length + 1),
    threadId: 'mail',
    labelIds: [options.spam ? 'SPAM' : 'INBOX'],
    internalDate: String(options.at ?? Date.now()),
    payload: {
      mimeType: options.html === undefined ? 'text/plain' : 'multipart/alternative',
      headers: [
        { name: 'Authentication-Results', value: `mx.google.com; dkim=pass header.d=${domain}` },
        { name: 'From', value: options.from ?? `login@${domain}` },
        ...(options.to === undefined ? [] : [{ name: 'To', value: options.to }]),
        ...(options.subject === undefined ? [] : [{ name: 'Subject', value: options.subject }]),
      ],
      ...(options.html === undefined
        ? { body: { data: Buffer.from(body).toString('base64url') } }
        : {
            parts: [
              { mimeType: 'text/plain', body: { data: Buffer.from(body).toString('base64url') } },
              { mimeType: 'text/html', body: { data: Buffer.from(options.html).toString('base64url') } },
            ],
          }),
    },
  });
}
/** Drive the real claim reservation and isolated mailbox, then act as the interpreter's typed tool answer. */
async function interpret(reply: SignInReply = nextReply): Promise<void> {
  for (const message of messages) await routeSignInMail(parseGmailMessage(message), new Date());
  const [session] = await getSessionsByAgentGroup('external-email');
  expect(session).toMatchObject({ messaging_group_id: null, thread_id: 'system:browser-sign-in:signin-request' });
  const request = { action: 'sign_in_reply', requestId: 'interpretation', ...reply };
  const outbound = new Database(outboundDbPath(session.agent_group_id, session.id));
  outbound
    .prepare('INSERT INTO messages_out(id,kind,timestamp,content) VALUES(?,?,?,?)')
    .run('interpretation', 'system', new Date().toISOString(), JSON.stringify(request));
  outbound.close();
  await getDeliveryAction('sign_in_reply')!(request, session);
  const inbound = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const answer = inbound.prepare('SELECT content FROM messages_in WHERE id = ?').get('action-resp-interpretation') as {
    content: string;
  };
  inbound.close();
  expect(JSON.parse(answer.content)).toMatchObject({ frame: { ok: true, data: { status: 'accepted' } } });
}

/** A sign-in page whose email field holds `current`; the same field stands in for the code field once sent. */
function fixture(current = '') {
  let url = 'https://www.shop.example/login';
  let loader = 'initial';
  const field = {
    ownerFrame: async () => frame,
    inputValue: async () => current,
    dispose: vi.fn(async () => undefined),
  } as unknown as ElementHandle;
  const frame = { isDetached: () => false, url: () => url, evaluate: async () => [] } as unknown as Frame;
  const target: PinnedBrowserRef = { ref: 'e1', generation: 1, element: field, frame };
  const control = { ownerFrame: async () => frame, dispose: vi.fn(async () => undefined) } as unknown as ElementHandle;
  const listeners = new Map<string, Array<(...values: unknown[]) => void>>();
  const cdpEvents = new Map<string, (event: unknown) => void>();
  const gateEvents = new Map<string, (event: unknown) => void>();
  const pending = new Map<string, (allowed: boolean) => void>();
  const network: Array<{ url: string; allowed: boolean; headers?: unknown }> = [];
  const redirects: string[] = [];
  let pageFetch = false;
  const answer = (method: string, params?: Record<string, unknown>): void => {
    if (method !== 'Fetch.continueRequest' && method !== 'Fetch.failRequest') return;
    const requestId = String(params?.requestId);
    network[Number(requestId)].allowed = method === 'Fetch.continueRequest';
    network[Number(requestId)].headers = params?.headers;
    pending.get(requestId)?.(method === 'Fetch.continueRequest');
  };
  // The page's own sessions: the guard pauses its other requests only while a sign-in scope strips Referer.
  const cdp = {
    once: () => undefined,
    on: vi.fn((name: string, handler: (event: unknown) => void) => cdpEvents.set(name, handler)),
    detach: async () => undefined,
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Fetch.enable' || method === 'Fetch.disable') pageFetch = method === 'Fetch.enable';
      answer(method, params);
      return { frameTree: { frame: { id: 'page-target', loaderId: loader } }, targetInfo: { targetId: 'page-target' } };
    }),
  };
  // The browser-level document gate pauses every document.
  const gate = {
    on: (name: string, handler: (event: unknown) => void) => gateEvents.set(name, handler),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => answer(method, params)),
  };
  const request = async (next: string, resourceType: string): Promise<void> => {
    const requestId = String(network.length);
    network.push({ url: next, allowed: false });
    const handler =
      resourceType === 'Document'
        ? gateEvents.get('Fetch.requestPaused')
        : pageFetch
          ? cdpEvents.get('Fetch.requestPaused')
          : undefined;
    if (!handler) {
      network[Number(requestId)].allowed = true;
      return;
    }
    const completed = new Promise<boolean>((resolve) => pending.set(requestId, resolve));
    handler({
      requestId,
      resourceType,
      frameId: 'page-target',
      request: { url: next, headers: { Referer: url, Cookie: 'host-cookie' } },
    });
    if (!(await completed)) throw new Error(`Navigation refused ${next}`);
  };
  const page = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    isClosed: () => false,
    locator: () => ({ ariaSnapshotJSON: async () => [{ role: 'heading', text: 'Signed in' }] }),
    getByRef: (ref: string) => ({ elementHandle: async () => (ref === 'e1' ? field : control) }),
    context: () => ({
      newCDPSession: async () => cdp,
      browser: () => ({ once: () => undefined, newBrowserCDPSession: async () => gate }),
    }),
    on: (name: string, callback: (...values: unknown[]) => void) =>
      listeners.set(name, [...(listeners.get(name) ?? []), callback]),
    off: () => undefined,
    once: () => undefined,
    goto: vi.fn(async (next: string) => {
      await request(next, 'Document');
      for (const redirected of next.includes('?') ? redirects : []) await request(redirected, 'Document');
      url = next;
      loader = `document-${next}`;
      for (const callback of listeners.get('framenavigated') ?? []) callback(frame);
      await request('https://www.shop.example/image.png', 'Image');
    }),
  } as unknown as Page;
  const values: string[] = [];
  vi.mocked(bindBrowserSecretFields).mockImplementation(async (_page, fields, submit, site) => ({
    page,
    frame,
    fields,
    ...(submit ? { submit } : {}),
    origin: new URL(url).origin,
    site,
    native: {} as BoundBrowserSecretFields['native'],
  }));
  vi.mocked(fillBoundBrowserSecrets).mockImplementation(async (_context, binding, resolve) => {
    values.push(...(await resolve()));
    return { status: binding.submit ? 'submitted' : 'filled' };
  });
  const context = {
    job: { id: 'job', thread_id: 'system:a2a:main:job' },
    request: { id: 'request' },
    session: {},
    signal: new AbortController().signal,
    deadline: Date.now() + 90_000,
    store: new BrowserStore(),
    runtime: { closeJob: vi.fn(async () => undefined) },
    page: async () => page,
    assertActive: async () => undefined,
    wakeWaiters: async () => undefined,
    remaining: () => 20_000,
  } as unknown as BrowserExecutionContext;
  return {
    page,
    frame,
    target,
    context,
    values,
    cdp,
    network,
    redirects,
    setUrl: (next: string) => {
      url = next;
    },
  };
}
const start = { email_field: { ref: 'e1', generation: 1 } };
const finish = { code_field: { ref: 'e1', generation: 1 }, submit: { ref: 'e2', generation: 1 } };
/** The alias is filled and its claim open; the agent's own press of Send code follows. */
async function started(f: ReturnType<typeof fixture>): Promise<void> {
  await observePage(f.page);
  expect(await executeSignInCode(f.context, start)).toEqual({ status: 'filled' });
}

it('starts with the email field and finishes with the code field, never taking a raw code, link or mailbox', () => {
  expect(validateSignInCode(start)).toEqual(start);
  expect(validateSignInCode(finish)).toEqual(finish);
  expect(validateSignInCode({})).toEqual({});
  for (const fields of [
    { ...start, ...finish },
    { code_field: finish.code_field },
    { submit: finish.submit },
    { code_field: finish.code_field, submit: finish.code_field },
    { target: start.email_field, send: finish.submit },
    { ...finish, code: '123456' },
    { ...finish, url: 'https://shop.example' },
    { ...start, domain: 'shop.example' },
    { ...start, from: 'principal' },
  ])
    expect(() => validateSignInCode(fields)).toThrow();
  // A code the principal sends reaches the browser in main's message: no relay waits for it.
  expect(getDeliveryAction('relay_code')).toBeUndefined();
});

it('opens the wait before the alias reaches the page, presses nothing, and fills the emailed code in a later step', async () => {
  const f = fixture();
  await observePage(f.page);
  const fill = vi.mocked(fillBoundBrowserSecrets).getMockImplementation()!;
  vi.mocked(fillBoundBrowserSecrets).mockImplementation(async (...args) => {
    if (f.values.length === 0)
      expect(await getSignInClaim('signin-request')).toMatchObject({ state: 'waiting', gmail_message_id: null });
    return fill(...args);
  });
  expect(await executeSignInCode(f.context, start)).toEqual({ status: 'filled' });
  expect(vi.mocked(bindBrowserSecretFields).mock.calls[0].slice(2)).toEqual([undefined, 'shop.example']);
  receive('Your code is 642981', {
    spam: true,
    html: '<a href="https://www.shop.example/access?token=temporary">Continue</a>',
    to: ALIAS,
  });
  await interpret();
  const result = await executeSignInCode(f.context, finish);
  expect(result).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual([ALIAS, '642981']);
  expect(vi.mocked(bindBrowserSecretFields).mock.calls[1][1]).toEqual([{ field: 'code', target: f.target }]);
  expect(list).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  const [session] = await getSessionsByAgentGroup('external-email');
  const mailbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = mailbox.prepare("SELECT channel_type, platform_id, content FROM messages_in WHERE kind = 'chat'").all();
  mailbox.close();
  expect(rows).toEqual([expect.objectContaining({ channel_type: null, platform_id: null })]);
  expect(JSON.stringify(rows)).toContain('https://www.shop.example/access?token=temporary');
  expect(JSON.stringify(result)).not.toContain('642981');
  // The code is spent once it may have reached the site.
  expect(await answerSignInReply({ kind: 'code', value: '111111' }, session)).toEqual({ status: 'no_wait' });
  expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'not_watched' });
});

it('takes only mail to the alias it filled', async () => {
  const f = fixture();
  await started(f);
  receive('Code 642981', { to: 'assistant@example.com' });
  expect(await routeSignInMail(parseGmailMessage(messages[0]), new Date())).toBe(false);
  expect(await getSignInClaim('signin-request')).toMatchObject({ gmail_message_id: null });
});

it('ignores mail that arrived before the code was requested', async () => {
  const f = fixture();
  receive('Code 111111', { to: ALIAS, at: Date.now() - 60_000 });
  await started(f);
  expect(await routeSignInMail(parseGmailMessage(messages[0]), new Date())).toBe(false);
  expect(await executeSignInCode({ ...f.context, remaining: () => 10_500 }, finish)).toEqual({
    status: 'nothing_arrived',
  });
});

it('returns ambiguity when the interpreter cannot identify one credential', async () => {
  const f = fixture();
  await started(f);
  receive('Welcome aboard', { to: ALIAS });
  await interpret({ kind: 'unavailable' });
  expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'ambiguous' });
  expect(f.values).toEqual([ALIAS]);
  expect(f.page.goto).not.toHaveBeenCalled();
});

it('keeps a code until a step names its field, then fills it', async () => {
  const f = fixture();
  await started(f);
  receive('Code 642981', { to: ALIAS });
  await interpret();
  expect(await executeSignInCode(f.context, {})).toEqual({ status: 'code_field_needed' });
  expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'code_filled' });
});

describe("the assistant's email on a sign-in form", () => {
  it.each([
    // Never an address the assistant converses from, even one the site filled in.
    ['an address it converses from', 'Assistant@example.com', ALIAS],
    // The +tag spelling of the alias an account was registered with.
    ['a +tag of the alias', ' Tnatsissa+Shop@example.com ', 'tnatsissa+shop@example.com'],
  ])('fills the alias when the field holds %s', async (_case, current, email) => {
    const f = fixture(current);
    await started(f);
    expect(f.values).toEqual([email]);
    expect(JSON.parse((await getSignInClaim('signin-request'))!.binding_json)).toEqual({ username: email });
  });

  it('stops with alias_unavailable while no alias is recorded, before any fill or wait', async () => {
    await getDb().run('UPDATE gws_ea_profile SET assistant_alias = NULL WHERE singleton = 1');
    const f = fixture('assistant@example.com');
    await observePage(f.page);
    expect(await executeSignInCode(f.context, start)).toEqual({ status: 'alias_unavailable' });
    expect(f.values).toEqual([]);
    expect(await getSignInClaim('signin-request')).toBeUndefined();
  });
});

it.each(['session', 'job', 'expiry', 'cancellation', 'restart'] as const)(
  'refuses a mismatched or ended interpretation wait (%s)',
  async (mode) => {
    const f = fixture();
    await started(f);
    receive('Code 642981', { to: ALIAS });
    await routeSignInMail(parseGmailMessage(messages[0]), new Date());
    const [session] = await getSessionsByAgentGroup('external-email');
    const caller =
      mode === 'session'
        ? (await resolveSystemSession('external-email', 'system:browser-sign-in:foreign')).session
        : session;
    if (mode === 'job') await getDb().run('UPDATE gws_ea_browser_sign_in_claims SET job_id = ?', 'another-job');
    if (mode === 'expiry')
      await getDb().run(
        'UPDATE gws_ea_browser_sign_in_claims SET expires_at = ?',
        new Date(Date.now() - 1).toISOString(),
      );
    if (mode === 'cancellation') await cleanupBrowserSignInMail('job');
    if (mode === 'restart') await recoverBrowserSignInMail();
    expect(await answerSignInReply({ kind: 'code', value: '642981' }, caller)).toEqual({ status: 'no_wait' });
    expect(await executeSignInCode({ ...f.context, remaining: () => 10_500 }, finish)).toEqual({
      status: mode === 'cancellation' || mode === 'restart' ? 'not_watched' : 'nothing_arrived',
    });
    expect(f.values).toEqual([ALIAS]);
  },
);

it('refuses a foreign group and invalid typed reply without echoing a credential', async () => {
  const f = fixture();
  await started(f);
  receive('Code 642981', { to: ALIAS });
  await routeSignInMail(parseGmailMessage(messages[0]), new Date());
  const [session] = await getSessionsByAgentGroup('external-email');
  await expect(
    answerSignInReply({ kind: 'code', value: '642981' }, { ...session, agent_group_id: 'foreign' }),
  ).rejects.toMatchObject({ code: 'forbidden', message: 'Only the host sign-in interpreter may answer.' });
  for (const fields of [
    { kind: 'code', value: '642981', claim: 'other' },
    { kind: 'unavailable', value: '642981' },
  ]) {
    await expect(answerSignInReply(fields, session)).rejects.toMatchObject({
      code: 'invalid-args',
      message: 'Return one sign-in code, one link, or unavailable.',
    });
  }
});

it.each(['/security/lock', '/reset-password', '/auth/revoke', '/%73ecurity/lock'])(
  'refuses a typed account-security link before navigation (%s)',
  async (path) => {
    const f = fixture();
    await started(f);
    receive('Follow the link.', { to: ALIAS });
    await interpret({ kind: 'link', value: `https://www.shop.example${path}?token=security-response` });
    await expect(executeSignInCode(f.context, {})).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.page.goto).not.toHaveBeenCalled();
  },
);

it.each(['http://www.shop.example/verify', 'https://elsewhere.example/verify'])(
  'answers origin_mismatch for a code field off the claimed site and keeps the code for its own site (%s)',
  async (next) => {
    const f = fixture();
    await started(f);
    receive('Code 642981', { to: ALIAS });
    await interpret();
    f.setUrl(next);
    expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'origin_mismatch' });
    expect(f.values).toEqual([ALIAS]);
    f.setUrl('https://login.shop.example/verify');
    expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'code_filled' });
    expect(f.values).toEqual([ALIAS, '642981']);
  },
);

it('taints bearer documents before traffic and returns only after fresh sanitized navigation and history reset', async () => {
  const f = fixture();
  await started(f);
  const secret = 'magic-bearer-7622';
  receive('Follow the sign-in button.', { to: ALIAS });
  await interpret({ kind: 'link', value: `https://www.shop.example/verify?token=${secret}` });
  const original = vi.mocked(f.page.goto).getMockImplementation()!;
  vi.mocked(f.page.goto).mockImplementation(async (...args) => {
    expect(await pageHasSecret(f.page)).toBe(true);
    return original(...args);
  });
  const result = await executeSignInCode(f.context, {});
  expect(result).toEqual({ status: 'link_opened' });
  expect(f.page.url()).toBe('https://www.shop.example/');
  expect(f.cdp.send).toHaveBeenCalledWith('Page.resetNavigationHistory');
  expect(JSON.stringify(result) + JSON.stringify(await observePage(f.page))).not.toContain(secret);
  expect(await pageHasSecret(f.page)).toBe(false);
  // Each request clears its Referer: Chrome restores one an override merely leaves out.
  for (const request of f.network)
    expect(
      (request.headers as Array<{ name: string; value: string }>).filter(({ name }) => /^referr?er$/iu.test(name)),
    ).toEqual([{ name: 'Referer', value: '' }]);
  expect(await executeSignInCode(f.context, {})).toEqual({ status: 'not_watched' });
});

it.each(['http://www.shop.example/verify?token=magic-bearer', 'https://elsewhere.example/verify?token=magic-bearer'])(
  'refuses an insecure or foreign redirect before following it and scrubs its failure (%s)',
  async (redirect) => {
    const f = fixture();
    await started(f);
    f.redirects.push(redirect);
    receive('Follow the sign-in button.', { to: ALIAS });
    await interpret({ kind: 'link', value: 'https://www.shop.example/verify?token=magic-bearer' });
    await expect(executeSignInCode(f.context, {})).rejects.toMatchObject({
      code: 'forbidden',
      message: 'The host could not safely open this verification link.',
    });
    expect(f.network.find((request) => request.url === redirect)?.allowed).toBe(false);
    expect(f.context.runtime.closeJob).toHaveBeenCalledWith('job');
    expect(JSON.stringify(await observePage(f.page))).not.toContain('magic-bearer');
    expect(await pageHasSecret(f.page)).toBe(true);
  },
);

it.each(['http://www.shop.example/verify?token=magic-bearer', 'https://elsewhere.example/verify?token=magic-bearer'])(
  'refuses an insecure or off-site magic link without navigating (%s)',
  async (link) => {
    const f = fixture();
    await started(f);
    receive('Follow the sign-in button.', { to: ALIAS });
    await interpret({ kind: 'link', value: link });
    await expect(executeSignInCode(f.context, {})).rejects.toMatchObject({
      code: 'forbidden',
      message: 'The host refused an insecure or off-site sign-in link.',
    });
    expect(f.page.goto).not.toHaveBeenCalled();
  },
);

it('refuses to start a sign-in while the assistant inbox is unavailable', async () => {
  const f = fixture();
  setActiveInbox(undefined);
  await expect(executeSignInCode(f.context, start)).rejects.toMatchObject({
    code: 'forbidden',
    message: 'The assistant inbox is unavailable.',
  });
  expect(await getSignInClaim('signin-request')).toBeUndefined();
  expect(f.values).toEqual([]);
});

it('holds an answer that arrives after a step stopped waiting, for the next step within the claim', async () => {
  const f = fixture();
  await started(f);
  expect(await executeSignInCode({ ...f.context, remaining: () => 10_300 }, finish)).toEqual({
    status: 'nothing_arrived',
  });
  receive('Code 642981', { to: ALIAS });
  await interpret();
  expect(await executeSignInCode(f.context, finish)).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual([ALIAS, '642981']);
});

it('ends its wait on abort and refuses an inactive step without filling', async () => {
  const controller = new AbortController();
  const f = fixture();
  await started(f);
  const waiting = executeSignInCode(
    {
      ...f.context,
      signal: controller.signal,
      assertActive: async () => {
        if (controller.signal.aborted) throw new Error('The request ended.');
      },
    },
    finish,
  ).then(
    (value) => ({ value }),
    (error: unknown) => ({ error }),
  );
  controller.abort();
  expect(await waiting).toMatchObject({ error: { code: 'forbidden' } });
  expect(f.values).toEqual([ALIAS]);
});

describe('a signup waiting for its email verification', () => {
  const signup = {
    jobId: 'job',
    claimId: 'signup-request',
    attemptId: 'attempt-1',
    origin: 'https://www.shop.example',
    username: 'assistant@example.com',
  };
  const context = (jobId = 'job', remaining = 200) =>
    ({
      job: { id: jobId },
      signal: new AbortController().signal,
      remaining: () => remaining,
      assertActive: async () => undefined,
    }) as unknown as BrowserExecutionContext;
  /** Route everything received, then answer as the isolated interpreter of that claim's session, if it got the mail. */
  async function interpretFor(claimId: string, reply: SignInReply): Promise<unknown> {
    for (const message of messages) await routeSignInMail(parseGmailMessage(message), new Date());
    const session = (await getSessionsByAgentGroup('external-email')).find(
      (candidate) => candidate.thread_id === `system:browser-sign-in:${claimId}`,
    );
    return session ? answerSignInReply({ ...reply }, session) : undefined;
  }

  it('holds the interpreter answer for that signup alone until its verify step takes it, once', async () => {
    expect(await openSignupVerification(signup)).toBe(true);
    receive('Your verification code is 642981', { to: 'Assistant@example.com' });
    expect(await interpretFor('signup-request', { kind: 'code', value: '642981' })).toEqual({ status: 'accepted' });
    expect(await interpretFor('signup-request', { kind: 'code', value: '111111' })).toEqual({ status: 'no_wait' });
    expect(await takeSignupVerification(context('another-job'), 'attempt-1')).toEqual({ status: 'not_watched' });
    expect(await takeSignupVerification(context(), 'attempt-2')).toEqual({ status: 'not_watched' });
    const taken = await takeSignupVerification(context(), 'attempt-1');
    expect(taken).toMatchObject({ status: 'arrived', reply: { kind: 'code', value: '642981' } });
    // Taking does not spend it: a step that cannot use it yet leaves it for the next.
    expect(await takeSignupVerification(context(), 'attempt-1')).toMatchObject({ status: 'arrived' });
    await finishSignupVerification('attempt-1');
    expect(await takeSignupVerification(context(), 'attempt-1')).toEqual({ status: 'not_watched' });
    expect(await getSignInClaim('signup-request')).toMatchObject({ state: 'finished' });
  });

  it("keeps a signup's wait open when a second signup in the same job opens its own", async () => {
    await openSignupVerification(signup);
    await openSignupVerification({
      ...signup,
      claimId: 'signup-second',
      attemptId: 'attempt-2',
      username: 'assistant+second@example.com',
    });
    receive('Your verification code is 642981', { to: 'assistant@example.com' });
    receive('Your verification code is 135790', { to: 'assistant+second@example.com' });
    expect(await interpretFor('signup-request', { kind: 'code', value: '642981' })).toEqual({ status: 'accepted' });
    expect(await interpretFor('signup-second', { kind: 'code', value: '135790' })).toEqual({ status: 'accepted' });
    expect(await takeSignupVerification(context(), 'attempt-1')).toMatchObject({
      status: 'arrived',
      reply: { value: '642981' },
    });
    expect(await takeSignupVerification(context(), 'attempt-2')).toMatchObject({
      status: 'arrived',
      reply: { value: '135790' },
    });
  });

  it('wakes a verify step already waiting when the answer arrives, and reports an unreadable email', async () => {
    await openSignupVerification(signup);
    const waiting = takeSignupVerification(context('job', 5_000), 'attempt-1');
    receive('Welcome aboard!', { to: 'assistant@example.com' });
    await interpretFor('signup-request', { kind: 'unavailable' });
    expect(await waiting).toEqual({ status: 'unavailable' });
  });

  it('leaves principal mail, other senders and mail to another account to their ordinary routing', async () => {
    await addPrincipalAddress('remy.vance@example.com');
    await openSignupVerification(signup);
    receive('Code 111111 from the principal', { to: 'assistant@example.com', from: 'remy.vance@example.com' });
    receive('Code 222222 from elsewhere', { to: 'assistant@example.com', signer: 'other.example' });
    receive('Code 333333 for someone else', { to: 'juno.hale@example.com' });
    for (const message of messages) expect(await routeSignInMail(parseGmailMessage(message), new Date())).toBe(false);
    expect(await getSessionsByAgentGroup('external-email')).toEqual([]);
    expect(await getSignInClaim('signup-request')).toMatchObject({ state: 'waiting', gmail_message_id: null });
    // Still watched: nothing has arrived yet, which a later verify step may still find.
    expect(await takeSignupVerification(context(), 'attempt-1')).toEqual({ status: 'nothing_arrived' });
  });

  it('watches a signup under the alias, and under a +tag of it, as mail to the assistant', async () => {
    expect(await openSignupVerification({ ...signup, username: ALIAS })).toBe(true);
    expect(
      await openSignupVerification({
        ...signup,
        claimId: 'signup-tagged',
        attemptId: 'attempt-2',
        username: 'tnatsissa+store@example.com',
      }),
    ).toBe(true);
    receive('Your verification code is 642981', { to: ALIAS });
    receive('Your verification code is 135790', { to: 'tnatsissa+store@example.com' });
    expect(await interpretFor('signup-request', { kind: 'code', value: '642981' })).toEqual({ status: 'accepted' });
    expect(await interpretFor('signup-tagged', { kind: 'code', value: '135790' })).toEqual({ status: 'accepted' });
    expect(await takeSignupVerification(context(), 'attempt-1')).toMatchObject({
      status: 'arrived',
      reply: { value: '642981' },
    });
    expect(await takeSignupVerification(context(), 'attempt-2')).toMatchObject({
      status: 'arrived',
      reply: { value: '135790' },
    });
  });

  it("opens no wait for an account outside the assistant's mailbox, or without an inbox", async () => {
    expect(await openSignupVerification({ ...signup, username: 'morgan.ellery@elsewhere.example' })).toBe(false);
    setActiveInbox(undefined);
    expect(await openSignupVerification(signup)).toBe(false);
    expect(await getSignInClaim('signup-request')).toBeUndefined();
    // A verify step learns at once that nothing will arrive, rather than waiting forever.
    expect(await takeSignupVerification(context(), 'attempt-1')).toEqual({ status: 'not_watched' });
  });

  it.each(['cancellation', 'restart'] as const)('drops a held answer on %s', async (mode) => {
    await openSignupVerification(signup);
    receive('Your verification code is 642981', { to: 'assistant@example.com' });
    await interpretFor('signup-request', { kind: 'code', value: '642981' });
    if (mode === 'cancellation') await cleanupBrowserSignInMail('job');
    else await recoverBrowserSignInMail();
    expect(await takeSignupVerification(context(), 'attempt-1')).toEqual({ status: 'not_watched' });
  });
});

// These fake pages have no native DOM; Chrome suites exercise collection. Keep actual taint and redaction.
vi.mock('./control-facts.js', async (original) => ({
  ...(await original<typeof import('./control-facts.js')>()),
  readPageSecretValues: vi.fn(async () => []),
}));
