import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
  cleanupBrowserSignInMail,
  executeSignInCode,
  recoverBrowserSignInMail,
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
import { ANSWER_LATER } from '../../cli/delivery-action.js';
import { resolveSystemSession } from '../../session-manager.js';
import { inboundDbPath, outboundDbPath } from '../../mailbox/sqlite/paths.js';
import type { GmailApi, GmailMessage } from '../gws-ea-inbox/gmail-api.js';
import { setActiveInbox, type InboxRuntime } from '../gws-ea-inbox/runtime.js';
import { getSignInClaim } from '../gws-ea-inbox/claims.js';
import '../gws-ea-profile/index.js';

let messages: GmailMessage[];
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
  messages = [];
  list = vi.fn(async () => messages.map(({ id, threadId }) => ({ id, threadId })));
  read = vi.fn(async (id: string) => messages.find((message) => message.id === id));
  setActiveInbox({
    gmail: { listMessages: list, getMessage: read } as unknown as GmailApi,
    gmailAddress: async () => 'assistant@example.com',
    knownGmailAddress: () => 'assistant@example.com',
    sleep: async () => undefined,
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
  options: { spam?: boolean; signer?: string; subject?: string; html?: string } = {},
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
        { name: 'From', value: `login@${domain}` },
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
function fixture(username = false) {
  let url = 'https://www.shop.example/login';
  let loader = 'initial';
  const field = {
    ownerFrame: async () => frame,
    inputValue: async () => '',
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
  const pending = new Map<string, (allowed: boolean) => void>();
  const network: Array<{ url: string; allowed: boolean; headers?: unknown }> = [];
  const redirects: string[] = [];
  const cdp = {
    on: vi.fn((name: string, handler: (event: unknown) => void) => cdpEvents.set(name, handler)),
    detach: async () => undefined,
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === 'Fetch.continueRequest' || method === 'Fetch.failRequest') {
        const requestId = String(params?.requestId);
        network[Number(requestId)].allowed = method === 'Fetch.continueRequest';
        network[Number(requestId)].headers = params?.headers;
        pending.get(requestId)?.(method === 'Fetch.continueRequest');
      }
      return { frameTree: { frame: { loaderId: loader } } };
    }),
  };
  const request = async (next: string, resourceType: string): Promise<void> => {
    const requestId = String(network.length);
    network.push({ url: next, allowed: false });
    const completed = new Promise<boolean>((resolve) => pending.set(requestId, resolve));
    cdpEvents.get('Fetch.requestPaused')!({
      requestId,
      resourceType,
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
    context: () => ({ newCDPSession: async () => cdp }),
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
    if (username && values.length === 1) receive('Your code is 642981', { spam: true });
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
it('claims before sending an assistant email, discovers the next OTP document and reads Spam host-side', async () => {
  const f = fixture(true);
  await observePage(f.page);
  const fill = vi.mocked(fillBoundBrowserSecret).getMockImplementation()!;
  vi.mocked(fillBoundBrowserSecret).mockImplementation(async (...args) => {
    if (f.values.length === 0)
      expect(await getSignInClaim('signin-request')).toMatchObject({ domain: 'shop.example', gmail_message_id: null });
    return fill(...args);
  });
  const result = await executeSignInCode(f.context, payload);
  expect(result).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual(['assistant@example.com', '642981']);
  expect(list).toHaveBeenCalledWith(
    expect.objectContaining({ q: expect.stringContaining('in:anywhere'), includeSpamTrash: true }),
  );
  expect(JSON.stringify(result)).not.toContain('642981');
  expect(await getSignInClaim('signin-request')).toMatchObject({ state: 'finished', gmail_message_id: '1' });
});
it.each(['Codes 642981 and 529106', 'Your Code is ABCD or EFGH'])(
  'fills nothing from ambiguous codes or lookalike mail (%s)',
  async (body) => {
    const f = fixture(true);
    await observePage(f.page);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
      f.values.push(await resolve());
      receive('Code 111111', { signer: 'lookalike-shop.example' });
      receive(body);
      return { status: 'submitted' };
    });
    expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'ambiguous' });
    expect(f.values).toEqual(['assistant@example.com']);
    expect(await getSignInClaim('signin-request')).toMatchObject({ gmail_message_id: '2' });
  },
);

it.each(['ABCD12', 'AbCd12', 'ABCD'])('uses one explicitly labelled code with letters (%s)', async (code) => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
    f.values.push(await resolve());
    receive(`Your Code is ${code}`);
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual(['assistant@example.com', code]);
});

const mailFooter = `
This code expires in 10 minutes. If you did not request it, ignore this email.
Shop Example, 1234 Market Street, San Francisco, CA 94105
Support: 800-555-1234
© 2026 Shop Example
Privacy: https://www.shop.example/privacy
Unsubscribe: https://www.shop.example/unsubscribe?id=840132
`;
it.each([
  { body: 'Your verification code is 642981.', code: '642981' },
  { body: 'Your verification code is:\n642981', code: '642981' },
  { body: 'Your verification code below:\n\n642981', code: '642981' },
  { body: 'Your verification code is below:\n\n642981', code: '642981' },
  { body: 'Your code is below.\n\n642981', code: '642981' },
  { body: 'Use the code below to sign in:\n642981', code: '642981' },
  { body: 'Your one-time code:\n\n642981', code: '642981' },
  { body: 'Use this passcode to sign in:\n642981', code: '642981' },
  { body: '642981 is your verification code.', code: '642981' },
  { body: '642981 is your Instagram code.', code: '642981' },
  { body: '642981 is your Shop Example verification code.', code: '642981' },
  { body: 'Your code is ABCD12.', code: 'ABCD12' },
  { body: 'Your code is 2026.', code: '2026' },
  { subject: '642981 is your verification code', body: 'Sign in to continue.', code: '642981' },
])(
  'uses a labelled code from realistic mail with unrelated footer numbers ($body)',
  async ({ body, code, subject }) => {
    const f = fixture(true);
    await observePage(f.page);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
      f.values.push(await resolve());
      receive(`${body}\n${mailFooter}`, { subject });
      return { status: 'submitted' };
    });
    const result = await executeSignInCode(f.context, payload);
    expect(result).toEqual({ status: 'code_filled' });
    expect(f.values).toEqual(['assistant@example.com', code]);
    expect(JSON.stringify(result)).not.toContain(code);
    expect(await getSignInClaim('signin-request')).toMatchObject({ state: 'finished', gmail_message_id: '1' });
  },
);

it.each([
  'Your verification code is 642981 or 529106.',
  'Your code is ABCD12. Your other code is EFGH34.',
  'Your verification code is 642981 or ABCD.',
  '642981 is your verification code or 529106.',
  'ABCD is your verification code or EFGH.',
  'Your verification codes:\n642981\n529106',
  'Your verification code is below:\n642981\n529106',
  '642981 is your Shop Example code or 529106.',
  '94105 is your ZIP code.',
  'ZIP code: 94105\nSupport: 800-555-1234\n© 2026 Shop Example',
])('fills nothing from ambiguous or absent authentication codes in realistic mail (%s)', async (body) => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
    f.values.push(await resolve());
    receive(`${body}\n${mailFooter}`);
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'ambiguous' });
  expect(f.values).toEqual(['assistant@example.com']);
  expect(f.page.goto).not.toHaveBeenCalled();
});

it.each(['plain', 'plain-next-line', 'html'] as const)(
  'uses one authentication link from realistic %s mail without following footer or asset links',
  async (format) => {
    const f = fixture(true);
    await observePage(f.page);
    const link = `https://www.shop.example/${format === 'plain' ? 'verify' : 'access'}?token=secret-bearer&source=email`;
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
      f.values.push(await resolve());
      receive(
        `${format === 'html' ? 'Use the sign-in button in this message.' : `Sign in:${format === 'plain' ? ' ' : '\n'}${link}`}\n${mailFooter}`,
        {
          ...(format === 'html'
            ? {
                html: `<a href="https://www.shop.example/"><img src="https://assets.shop.example/logo.png"></a>
                <p>Sign in to Shop Example.</p><a href="${link.replace(/&/gu, '&amp;')}">Sign in securely</a>
                <p>© 2026 Shop Example, 1234 Market Street, CA 94105. Support 800-555-1234.</p>
                <a href="https://www.shop.example/privacy">Privacy</a>
                <a href="https://www.shop.example/unsubscribe">Unsubscribe</a>`,
              }
            : {}),
        },
      );
      return { status: 'submitted' };
    });
    const result = await executeSignInCode(f.context, payload);
    expect(result).toEqual({ status: 'link_opened' });
    expect(f.values).toEqual(['assistant@example.com']);
    expect(vi.mocked(f.page.goto).mock.calls.map(([url]) => url)).toEqual([link, 'https://www.shop.example/']);
    expect(JSON.stringify(result) + JSON.stringify(await observePage(f.page))).not.toContain('secret-bearer');
    expect(f.cdp.send).toHaveBeenCalledWith('Page.resetNavigationHistory');
  },
);

it('keeps multiple authentication links ambiguous after ignoring realistic footer links', async () => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
    receive(`Sign in: https://www.shop.example/verify?token=first
      Or sign in: https://www.shop.example/verify?token=second\n${mailFooter}`);
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'ambiguous' });
  expect(f.page.goto).not.toHaveBeenCalled();
});

it.each([
  { label: "Didn't try to sign in? Secure your account:", path: '/access' },
  { label: 'Did not request this sign-in? Report it:', path: '/verify' },
  { label: 'Not you? Sign in to lock your account:', path: '/login' },
  { label: 'Sign in:', path: '/security/lock' },
  { label: 'Sign in:', path: '/reset-password' },
  { label: 'Sign in:', path: '/auth/revoke' },
  { label: 'Sign in:', path: '/%73ecurity/lock' },
])('never navigates a security-response link ($label $path)', async ({ label, path }) => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
    receive(`${label} https://www.shop.example${path}?token=security-response\n${mailFooter}`);
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'ambiguous' });
  expect(f.page.goto).not.toHaveBeenCalled();
});

it('ignores an HTML security-response link while consuming its labelled OTP', async () => {
  const f = fixture(true);
  await observePage(f.page);
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async (_context, _binding, resolve) => {
    f.values.push(await resolve());
    receive(`642981 is your Shop code.\n${mailFooter}`, {
      html: '<p>642981 is your Shop code.</p><a href="https://www.shop.example/security/lock?token=security-response">Didn’t try to sign in? Secure your account</a>',
    });
    return { status: 'submitted' };
  });
  expect(await executeSignInCode(f.context, payload)).toEqual({ status: 'code_filled' });
  expect(f.values).toEqual(['assistant@example.com', '642981']);
  expect(f.page.goto).not.toHaveBeenCalled();
});

it.each(['http://www.shop.example', 'https://elsewhere.example'])(
  'refuses an unsafe authentication link in realistic mail with unrelated safe links (%s)',
  async (origin) => {
    const f = fixture(true);
    await observePage(f.page);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
      receive(`Sign in: ${origin}/verify?token=secret-bearer\n${mailFooter}`);
      return { status: 'submitted' };
    });
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
    expect(f.values).toEqual(['assistant@example.com']);
  },
);
it('taints bearer documents before traffic and returns only after fresh sanitized navigation and history reset', async () => {
  const f = fixture(true);
  await observePage(f.page);
  const secret = 'magic-bearer-7622';
  vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
    receive(`https://www.shop.example/verify?token=${secret}`);
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
  expect(
    f.network.every(
      (request) => Array.isArray(request.headers) && !JSON.stringify(request.headers).toLowerCase().includes('referer'),
    ),
  ).toBe(true);
});

it.each(['http://www.shop.example/verify?token=magic-bearer', 'https://elsewhere.example/verify?token=magic-bearer'])(
  'refuses an insecure or foreign redirect before following it and scrubs its failure (%s)',
  async (redirect) => {
    const f = fixture(true);
    await observePage(f.page);
    f.redirects.push(redirect);
    vi.mocked(fillBoundBrowserSecret).mockImplementationOnce(async () => {
      receive('https://www.shop.example/verify?token=magic-bearer');
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
      receive(link);
      return { status: 'submitted' };
    });
    await expect(executeSignInCode(f.context, payload)).rejects.toMatchObject({ code: 'forbidden' });
    expect(f.page.goto).not.toHaveBeenCalled();
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
    for (const id of ['main', 'browser'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await getDb().run(
      'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
      'main',
      'browser',
    );
    const source = (await resolveSystemSession('main', 'system:principal')).session;
    const browser = (await resolveSystemSession('browser', 'system:a2a:main:job')).session;
    const job = (await f.context.store.jobForSession(browser))!;
    const context = { ...f.context, job, session: browser };
    const waiting = await executeSignInCode(context, { ...payload, from: 'principal' });
    expect(waiting).toEqual({ status: 'awaiting_code', site: 'shop.example', origin: 'https://www.shop.example' });
    const code = '817264';
    const request = { action: 'relay_code', requestId: 'main-relay', thread: job.id, code };
    const outbound = new Database(outboundDbPath(source.agent_group_id, source.id));
    outbound
      .prepare('INSERT INTO messages_out(id,kind,timestamp,content) VALUES(?,?,?,?)')
      .run('main-relay', 'system', new Date().toISOString(), JSON.stringify(request));
    outbound.close();
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
    await expect(answerRelayCode(request, browser, 'main-relay', queue)).rejects.toThrow('Only main');
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
