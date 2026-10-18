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
vi.mock('./commit-classifier.js', async (original) => ({
  ...(await original<typeof import('./commit-classifier.js')>()),
  activateControl: vi.fn(async () => undefined),
}));
vi.mock('./fill.js', async (original) => ({
  ...(await original<typeof import('./fill.js')>()),
  bindBrowserSecretField: vi.fn(),
  fillBoundBrowserSecret: vi.fn(),
  discoverAuthenticationCodeField: vi.fn(),
}));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { BrowserStore } from './db.js';
import { browserQueueMigration, browserSiteLeasesMigration } from './migration.js';
import { browserSignInMigration } from './sign-in-migration.js';
import {
  answerRelayCode,
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
import {
  bindBrowserSecretField,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecret,
  type BoundBrowserSecretField,
} from './fill.js';
import { observePage, pageHasSecret, type PinnedBrowserRef } from './observe.js';
import { BrowserQueue, type BrowserExecutionContext } from './queue.js';
import { getDeliveryAction } from '../../delivery.js';
import { ANSWER_LATER } from '../../cli/delivery-action.js';
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
import { writeBrowserAccess } from './testing/browser-access.js';

registerMigration(gwsEaInboxMigration);
registerSignInMailDelivery(() => {
  throw new Error('Principal queue is provided by its own test.');
});

/** The assistant's web alias: its email on every site (KTD14). */
const ALIAS = 'tnatsissa@example.com';

let messages: GmailMessage[];
let nextReply: SignInReply;
let read: ReturnType<typeof vi.fn>;
let list: ReturnType<typeof vi.fn>;
beforeEach(async () => {
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', `${root}/missing-${randomUUID()}.json`);
  await runMigrations(await initTestDb());
  await browserSiteLeasesMigration.up(getDb());
  await browserQueueMigration.up(getDb());
  await browserSignInMigration.up(getDb());
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
  options: { spam?: boolean; signer?: string; subject?: string; html?: string; to?: string; from?: string } = {},
): void {
  const domain = options.signer ?? 'shop.example';
  messages.push({
    id: String(messages.length + 1),
    threadId: 'mail',
    labelIds: [options.spam ? 'SPAM' : 'INBOX'],
    internalDate: String(Date.now()),
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

/** A sign-in page: its email field when `username`, holding `current`, else its code field. */
function fixture(username = false, current = '') {
  let url = 'https://www.shop.example/login';
  let loader = 'initial';
  const field = {
    ownerFrame: async () => frame,
    inputValue: async () => current,
    dispose: vi.fn(async () => undefined),
    evaluate: async () => ({
      tag: 'INPUT',
      name: username ? 'email' : 'otp',
      type: username ? 'email' : 'text',
      autocomplete: username ? 'username' : 'one-time-code',
    }),
  } as unknown as ElementHandle;
  const frame = { url: () => url, evaluate: async () => [] } as unknown as Frame;
  const target: PinnedBrowserRef = { ref: 'e1', generation: 1, element: field, frame };
  const control = { ownerFrame: async () => frame, dispose: vi.fn(async () => undefined) } as unknown as ElementHandle;
  const submit: PinnedBrowserRef = { ref: 'e2', generation: 1, element: control, frame };
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
    locator: () => ({ ariaSnapshot: async () => '- heading: Signed in' }),
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
  const binding = {
    page,
    target,
    submit,
    origin: 'https://www.shop.example',
    field: username ? 'username' : 'otp',
    authentication: {
      origin: 'https://www.shop.example',
      action: 'https://www.shop.example/login',
      frame,
      element: control,
    },
  } as BoundBrowserSecretField;
  const values: string[] = [];
  vi.mocked(bindBrowserSecretField).mockImplementation(async (_page, _target, _submit, kind) => ({
    ...binding,
    field: kind,
  }));
  vi.mocked(fillBoundBrowserSecret).mockImplementation(async (_context, _binding, resolve) => {
    values.push(await resolve());
    if (username && values.length === 1) {
      receive('Your code is 642981', {
        spam: true,
        html: '<a href="https://www.shop.example/access?token=temporary">Continue</a>',
      });
      await interpret();
    }
    return { status: 'submitted' };
  });
  vi.mocked(discoverAuthenticationCodeField).mockResolvedValue({ ...binding, field: 'otp' });
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
    remaining: () => 10_000,
  } as unknown as BrowserExecutionContext;
  return {
    page,
    frame,
    context,
    values,
    cdp,
    binding,
    network,
    redirects,
    setUrl: (next: string) => {
      url = next;
    },
  };
}
const payload = { target: { ref: 'e1', generation: 1 }, send: { ref: 'e2', generation: 1 } };
it('defaults to the assistant and refuses raw codes, links and arbitrary frame arguments', () => {
  expect(validateSignInCode(payload)).toMatchObject({ from: 'assistant' });
  for (const extra of [
    { code: '123456' },
    { url: 'https://shop.example' },
    { domain: 'shop.example' },
    { from: 'watch' },
  ])
    expect(() => validateSignInCode({ ...payload, ...extra })).toThrow();
});
it('registers the wait before sending, routes raw HTML to external-email, and resumes only the browser', async () => {
  const f = fixture(true);
  await observePage(f.page);
  const fill = vi.mocked(fillBoundBrowserSecret).getMockImplementation()!;
  vi.mocked(fillBoundBrowserSecret).mockImplementation(async (...args) => {
    if (f.values.length === 0) expect(await getSignInClaim('signin-request')).toMatchObject({ gmail_message_id: null });
    return fill(...args);
  });
  const result = await executeSignInCode(f.context, payload);
  expect(result).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual([ALIAS, '642981']);
  expect(list).not.toHaveBeenCalled();
  expect(read).not.toHaveBeenCalled();
  const [session] = await getSessionsByAgentGroup('external-email');
  const mailbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
  const rows = mailbox.prepare("SELECT channel_type, platform_id, content FROM messages_in WHERE kind = 'chat'").all();
  mailbox.close();
  expect(rows).toEqual([expect.objectContaining({ channel_type: null, platform_id: null })]);
  expect(JSON.stringify(rows)).toContain('https://www.shop.example/access?token=temporary');
  expect(JSON.stringify(result)).not.toContain('642981');
  expect(await answerSignInReply({ kind: 'code', value: '111111' }, session)).toEqual({ status: 'no_wait' });
});

it('returns ambiguity when the interpreter cannot identify one credential', async () => {
  const f = fixture(true);
  await observePage(f.page);
  nextReply = { kind: 'unavailable' };
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'ambiguous' });
  expect(f.values).toEqual([ALIAS]);
  expect(f.page.goto).not.toHaveBeenCalled();
});

describe("the assistant's email on a sign-in form (KTD14)", () => {
  it.each([
    // Never an address the assistant converses from, even one the site filled in (R26).
    ['an address it converses from', 'Assistant@example.com', ALIAS],
    // The +tag spelling of the alias an account was registered with.
    ['a +tag of the alias', ' Tnatsissa+Shop@example.com ', 'tnatsissa+shop@example.com'],
  ])('signs in with the alias when the field holds %s', async (_case, current, email) => {
    const f = fixture(true, current);
    await observePage(f.page);
    expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'code_filled' });
    expect(f.values).toEqual([email, '642981']);
  });

  it('stops with alias_unavailable while no alias is recorded, before any wait or send (R23)', async () => {
    await getDb().run('UPDATE gws_ea_profile SET assistant_alias = NULL WHERE singleton = 1');
    const f = fixture(true, 'assistant@example.com');
    await observePage(f.page);
    expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'alias_unavailable' });
    expect(f.values).toEqual([]);
    expect(await getSignInClaim('signin-request')).toBeUndefined();
  });
});

it.each(['session', 'job', 'expiry', 'cancellation', 'restart'] as const)(
  'refuses a mismatched or ended interpretation wait (%s)',
  async (mode) => {
    const f = fixture(true);
    await observePage(f.page);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
      f.values.push(await resolve());
      receive('Code 642981');
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
      await recoverBrowserSignInMail();
      return { status: 'submitted' };
    });
    expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'nothing_arrived' });
    expect(f.values).toEqual([ALIAS]);
  },
);

it('refuses a foreign group and invalid typed reply without echoing a credential', async () => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
    receive('Code 642981');
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
    await recoverBrowserSignInMail();
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'nothing_arrived' });
});

it.each(['/security/lock', '/reset-password', '/auth/revoke', '/%73ecurity/lock'])(
  'refuses a typed account-security link before navigation (%s)',
  async (path) => {
    const f = fixture(true);
    await observePage(f.page);
    nextReply = { kind: 'link', value: `https://www.shop.example${path}?token=security-response` };
    await expect(executeSignInCode(f.context, payload)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.page.goto).not.toHaveBeenCalled();
  },
);

it.each(['https://www.shop.example:8443/login', 'http://www.shop.example/login', 'https://other.shop.example/login'])(
  'refuses full-origin drift before releasing a mail code (%s)',
  async (next) => {
    const f = fixture(true);
    await observePage(f.page);
    const fill = vi.mocked(fillBoundBrowserSecret).getMockImplementation()!;
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (...args) => {
      const result = await fill(...args);
      f.setUrl(next);
      return result;
    });
    expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'origin_mismatch' });
    expect(f.values).toEqual([ALIAS]);
  },
);
it('taints bearer documents before traffic and returns only after fresh sanitized navigation and history reset', async () => {
  const f = fixture(true);
  await observePage(f.page);
  const secret = 'magic-bearer-7622';
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
    receive('Follow the sign-in button.');
    await interpret({ kind: 'link', value: `https://www.shop.example/verify?token=${secret}` });
    return { status: 'submitted' };
  });
  const original = vi.mocked(f.page.goto).getMockImplementation()!;
  vi.mocked(f.page.goto).mockImplementation(async (...args) => {
    expect(await pageHasSecret(f.page)).toBe(true);
    return original(...args);
  });
  const result = await executeSignInCode(f.context, payload);
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
});

it.each(['http://www.shop.example/verify?token=magic-bearer', 'https://elsewhere.example/verify?token=magic-bearer'])(
  'refuses an insecure or foreign redirect before following it and scrubs its failure (%s)',
  async (redirect) => {
    const f = fixture(true);
    await observePage(f.page);
    f.redirects.push(redirect);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
      receive('Follow the sign-in button.');
      await interpret({ kind: 'link', value: 'https://www.shop.example/verify?token=magic-bearer' });
      return { status: 'submitted' };
    });
    await expect(executeSignInCode(f.context, payload)).rejects.toMatchObject({
      code: 'forbidden',
      message: 'The host could not safely consume this sign-in link.',
    });
    expect(f.network.find((request) => request.url === redirect)?.allowed).toBe(false);
    expect(f.context.runtime.closeJob).toHaveBeenCalledWith('job');
    expect(JSON.stringify(await observePage(f.page))).not.toContain('magic-bearer');
    expect(await pageHasSecret(f.page)).toBe(true);
  },
);

it.each(['http://www.shop.example/verify?token=magic-bearer', 'https://elsewhere.example/verify?token=magic-bearer'])(
  'refuses an insecure or foreign original link without navigating (%s)',
  async (link) => {
    const f = fixture(true);
    await observePage(f.page);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
      receive('Follow the sign-in button.');
      await interpret({ kind: 'link', value: link });
      return { status: 'submitted' };
    });
    await expect(executeSignInCode(f.context, payload)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.page.goto).not.toHaveBeenCalled();
  },
);

it('refuses an assistant code request immediately when its inbox is unavailable', async () => {
  const f = fixture();
  setActiveInbox(undefined);
  await expect(executeSignInCode(f.context, payload)).rejects.toMatchObject({
    code: 'forbidden',
    message: 'The assistant inbox is unavailable.',
  });
  expect(await getSignInClaim('signin-request')).toBeUndefined();
});

it.each(['timer', 'abort', 'inactive'] as const)(
  'ends a pending interpretation on %s and refuses late credentials',
  async (mode) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let active = true;
    try {
      const f = fixture(true);
      await observePage(f.page);
      let ready!: () => void;
      const sent = new Promise<void>((resolve) => {
        ready = resolve;
      });
      vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
        f.values.push(await resolve());
        receive('Code 642981');
        await routeSignInMail(parseGmailMessage(messages[0]), new Date());
        ready();
        return { status: 'submitted' };
      });
      const context = {
        ...f.context,
        signal: controller.signal,
        remaining: () => 10_000,
        assertActive: async () => {
          if (!active || controller.signal.aborted) throw new Error('The request ended.');
        },
      };
      const outcome = executeSignInCode(context, payload).then(
        (value) => ({ value }),
        (error: unknown) => ({ error }),
      );
      await sent;
      await vi.advanceTimersByTimeAsync(0);
      const [session] = await getSessionsByAgentGroup('external-email');
      if (mode === 'timer') await vi.advanceTimersByTimeAsync(9_000);
      else if (mode === 'abort') controller.abort();
      else {
        active = false;
        expect(await answerSignInReply({ kind: 'code', value: '642981' }, session)).toEqual({ status: 'no_wait' });
      }
      const result = await outcome;
      if (mode === 'timer') expect(result).toEqual({ value: { status: 'nothing_arrived' } });
      else expect(result).toMatchObject({ error: { code: 'forbidden' } });
      expect(await answerSignInReply({ kind: 'code', value: '642981' }, session)).toEqual({ status: 'no_wait' });
      expect(f.values).toEqual([ALIAS]);
      expect(f.page.goto).not.toHaveBeenCalled();
    } finally {
      controller.abort();
      vi.useRealTimers();
    }
  },
);

it('returns nothing_arrived within the remaining request budget', async () => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => ({ status: 'submitted' }));
  expect(await executeSignInCode({ ...f.context, remaining: () => 500 }, payload)).toEqual({
    status: 'nothing_arrived',
  });
});

it.each(['fill', 'restart'] as const)(
  'defers a principal relay immediately and retains only host references (%s)',
  async (mode) => {
    const f = fixture();
    await observePage(f.page);
    for (const id of ['main', 'browser', 'research'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await getDb().run(
      'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
      'main',
      'browser',
    );
    // The setting lists a second group: it may use the browser, but its relays reach only its own errands (R28, KTD15).
    writeBrowserAccess(`${root}/browser/policy.json`, { agentGroupIds: ['main', 'research'] });
    const source = (await resolveSystemSession('main', 'system:principal')).session;
    const research = (await resolveSystemSession('research', 'system:principal')).session;
    const browser = (await resolveSystemSession('browser', 'system:a2a:main:job')).session;
    const job = (await f.context.store.jobForSession(browser))!;
    const context = { ...f.context, job, session: browser };
    const waiting = await executeSignInCode(context, { ...payload, from: 'principal' });
    expect(waiting).toEqual({ status: 'awaiting_code', site: 'shop.example', origin: 'https://www.shop.example' });
    const code = '817264';
    const request = { action: 'relay_code', requestId: 'main-relay', thread: job.id, code };
    const foreign = { action: 'relay_code', requestId: 'research-relay', thread: job.id, code: '552918' };
    for (const [from, sent] of [
      [source, request],
      [research, foreign],
    ] as const) {
      const outbound = new Database(outboundDbPath(from.agent_group_id, from.id));
      outbound
        .prepare('INSERT INTO messages_out(id,kind,timestamp,content) VALUES(?,?,?,?)')
        .run(sent.requestId, 'system', new Date().toISOString(), JSON.stringify(sent));
      outbound.close();
    }
    const queue = new BrowserQueue(context.store, {
      pageForJob: async () => f.page,
      connection: async () => {
        throw new Error('No Chrome in this fixture');
      },
      closeJob: async () => undefined,
      onDisconnected: () => () => undefined,
    });
    if (mode === 'fill') await queue.start();
    let unlock!: () => void;
    const blocked = new Promise<void>((resolve) => {
      unlock = resolve;
    });
    const lock = queue.withJobLock(job.id, () => blocked);
    await expect(answerRelayCode(request, browser, 'main-relay', queue)).rejects.toThrow(
      'Only an agent with browser access',
    );
    expect(await answerRelayCode(foreign, research, 'research-relay', queue)).toEqual({ status: 'no_wait' });
    expect(await context.store.pending(job.id)).toEqual([]);
    expect(await answerRelayCode(request, source, 'main-relay', queue)).toBe(ANSWER_LATER);
    const pending = await context.store.pending(job.id);
    expect(pending).toHaveLength(1);
    expect(JSON.parse(pending[0].payload_json)).toEqual({
      source_session_id: source.id,
      source_request_id: 'main-relay',
      claim_id: 'signin-request',
    });
    expect(JSON.stringify(pending)).not.toContain(code);
    expect(f.values).toEqual([]);
    if (mode === 'restart') {
      await recoverBrowserSignInMail();
      await queue.start();
    }
    unlock();
    await lock;
    await queue.idle();
    await queue.stop();
    expect(f.values).toEqual(mode === 'fill' ? [code] : []);
    for (const session of [source, browser]) {
      const mailbox = new Database(inboundDbPath(session.agent_group_id, session.id), { readonly: true });
      const contents = mailbox.prepare('SELECT content FROM messages_in').all();
      mailbox.close();
      expect(JSON.stringify(contents)).toContain(
        mode === 'fill' ? 'code_filled' : session === source ? 'origin_mismatch' : 'interrupted',
      );
      expect(JSON.stringify(contents)).not.toContain(code);
    }
    expect(await getSignInClaim('signin-request')).toMatchObject({ state: 'finished' });
  },
);

it('refuses a relay after cancellation cleanup instead of reusing its pinned field', async () => {
  const f = fixture();
  await observePage(f.page);
  await createAgentGroup({
    id: 'main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'main');
  await executeSignInCode(f.context, { ...payload, from: 'principal' });
  await cleanupBrowserSignInMail('job');
  expect(
    await answerRelayCode(
      { thread: 'job', code: '817264' },
      { agent_group_id: 'main' } as never,
      'relay',
      {} as BrowserQueue,
    ),
  ).toEqual({ status: 'no_wait' });
  expect(f.values).toEqual([]);
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

  it('watches a signup under the alias, and under a +tag of it, as mail to the assistant (KTD14)', async () => {
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
