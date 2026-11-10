import { closeDb, getDb, initSqliteTestDb } from '../../db/connection.js';
import Database from 'better-sqlite3';
import { SqliteDriver } from '../../db/drivers/sqlite.js';
import { BrowserStore } from './db.js';
import { browserSiteLeasesMigration } from './migration.js';
import { SiteLeaseStore } from './leases.js';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  readVaultSiteInfo,
  bindBrowserSecretFields,
  BrowserOriginMismatchError,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecrets,
  validateFillSecret,
} from './fill.js';
import type { BrowserExecutionContext } from './actions.js';
import type { PinnedBrowserRef } from './observe.js';
import { observePage, configureBrowserSiteInfo } from './observe.js';
import { pageFieldHoldsHostSecret, pageHasSecret } from './page-privacy.js';
import * as navigation from './commit-classifier.js';
import * as nativeAuthentication from './authentication-submit.js';
import * as isolatedFacts from './control-facts.js';
import * as consentEngine from './consent.js';
import { credentialAttempts } from './credential-attempts.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import * as loginStoreModule from './login-store.js';
import { LoginStoreError } from './login-store.js';
import { testLoginStore } from './testing/login-store.js';

const SECRET = 'fixture-secret-must-stay-host-only';
let directory: string;
let storeFixture: ReturnType<typeof testLoginStore>;
beforeEach(async () => {
  await browserSiteLeasesMigration.up(await initSqliteTestDb());
  directory = await mkdtemp(path.join(os.tmpdir(), 'fill-store-'));
  storeFixture = testLoginStore(path.join(directory, 'browser'));
  vi.spyOn(loginStoreModule, 'getLoginStore').mockResolvedValue(storeFixture.store);
  configureBrowserSiteInfo({ vault: readVaultSiteInfo });
  // A nonempty relative root is unavailable and cannot fall back to the operator's .env.
  vi.stubEnv('GWS_EA_BROWSER_ROOT', 'unconfigured-browser-root');
});
afterEach(async () => {
  await closeDb();
  await rm(directory, { recursive: true, force: true });
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});
function fixture(origin = 'https://www.shop.example') {
  let url = `${origin}/login`;
  const nodes: Array<{ value: string }> = [];
  const form = {
    action: `${origin}/login`,
    method: 'post',
    target: '',
  };
  const field = {
    tagName: 'INPUT',
    type: 'password',
    name: 'password',
    value: '',
    form,
    isConnected: true,
    getAttribute(name: string): string | null {
      return (
        ({ autocomplete: 'current-password', type: this.type, name: this.name } as Record<string, string>)[name] ?? null
      );
    },
  };
  const button = {
    tagName: 'BUTTON',
    type: 'submit',
    name: '',
    textContent: 'Sign in',
    form,
    isConnected: true,
    getAttribute: (name: string) => (name === 'type' ? 'submit' : null),
  };
  nodes.push(field);
  const navigations = new Set<(frame: unknown) => void>();
  const handle = (node: unknown) => ({
    ownerFrame: async () => frame,
    inputValue: async () => (node as { value: string }).value,
    evaluate: async (fn: (value: unknown, arg: unknown) => unknown, argument?: unknown) =>
      fn(
        node,
        argument && typeof argument === 'object' && 'node' in argument
          ? (argument as { node: unknown }).node
          : argument,
      ),
    dispose: async () => undefined,
    node,
  });
  const frame = {
    url: () => url,
    evaluate: async () => [],
    locator: () => ({ elementHandles: async () => nodes.map(handle) }),
  };
  const page = {
    url: () => url,
    frames: () => [frame],
    mainFrame: () => frame,
    isClosed: () => false,
    locator: () => ({ innerText: async () => '', ariaSnapshotJSON: async () => [{ role: 'alert', text: SECRET }] }),
    getByRef: (ref: string) => ({ elementHandle: async () => handle(ref === 'e1' ? field : button) }),
    keyboard: {
      insertText: vi.fn(),
    },
    on: (event: string, callback: (frame: unknown) => void) => {
      if (event === 'framenavigated') navigations.add(callback);
    },
    off: (_event: string, callback: (frame: unknown) => void) => {
      navigations.delete(callback);
    },
    waitForEvent: async () => undefined,
    once: () => undefined,
    context: () => ({
      newCDPSession: async () => ({
        on: () => undefined,
        send: async () => ({
          frameTree: { frame: { loaderId: 'fixture-document' } },
          targetInfo: { targetId: 'fixture-page' },
        }),
      }),
      browser: () => ({
        once: () => undefined,
        newBrowserCDPSession: async () => ({ on: () => undefined, send: async () => undefined }),
      }),
    }),
  } as unknown as Page;
  const context = {
    page: async () => page,
    assertActive: vi.fn(async () => undefined),
    remaining: () => 10_000,
    runtime: { closeJob: vi.fn(async () => undefined) },
    job: { id: 'job' },
    kind: 'request',
    request: { id: 'fixture-sign-in' },
    wakeWaiters: vi.fn(async () => undefined),
    store: new BrowserStore(getDb()),
  } as unknown as BrowserExecutionContext;
  vi.spyOn(navigation, 'ensureBrowserNavigationGuard').mockResolvedValue({
    reason: () => undefined,
    clearReason: () => undefined,
    holdSubmissions: () => undefined,
    allowSubmissions: () => undefined,
    actionsSettled: async () => undefined,
    runWithPolicy: async (_policy, operation) => operation(),
    duringAction: async (_budget, operation) => operation(),
  });
  // These tests double the external renderer boundary. Native node identity,
  // prototype isolation and submission are exercised in the real Chrome suite.
  vi.spyOn(isolatedFacts, 'readPageControlFacts').mockImplementation(async () => ({
    name: 'Sign in',
    visibleLabel: 'Sign in',
    role: '',
    tag: 'button',
    type: 'submit',
    href: null,
    formMethod: form.method,
    formAction: form.action,
    transaction: false,
  }));
  vi.spyOn(nativeAuthentication, 'inspectNativeCredentialControl').mockImplementation(async (element) => {
    const node = (element as unknown as { node: typeof field | typeof button }).node;
    return {
      frameId: 'fixture-frame',
      loaderId: 'fixture-document',
      controlBackendNodeId: node === field ? 1 : 3,
      formBackendNodeId: 2,
      facts: {
        origin: new URL(url).origin,
        tag: node.tagName,
        id: '',
        name: node.name,
        type: node.type,
        autocomplete: node.getAttribute('autocomplete') ?? '',
        required: false,
        override: null,
        form: {
          ...form,
          fields: [field, button].map((node) => ({
            name: node.name,
            type: node.type,
            autocomplete: node.getAttribute('autocomplete') ?? '',
            readonly: false,
            disabled: false,
          })),
        },
      },
    };
  });
  const nativeFill = vi.fn(async (value: string) => {
    field.value = value;
    return true;
  });
  vi.spyOn(nativeAuthentication, 'fillNativeCredentialGroup').mockImplementation(
    async (_frame, _group, values, assertActive) => {
      await assertActive();
      return (await nativeFill(values[0])) ? 'filled' : 'changed';
    },
  );
  const nativeSubmit = vi.fn(async () => undefined);
  vi.spyOn(consentEngine, 'runConsentPass').mockResolvedValue({ status: 'ready', agreements: [], addOns: [] });
  vi.spyOn(nativeAuthentication, 'activateNativeCredentialControl').mockImplementation(
    async (_frame, _group, values, assertActive) => {
      await assertActive();
      if (field.value !== values[0]) return 'changed';
      await nativeSubmit();
      return 'activated';
    },
  );
  const target = { ref: 'e1', generation: 1, element: handle(field), frame } as unknown as PinnedBrowserRef;
  const submit = { ref: 'e2', generation: 1, element: handle(button), frame } as unknown as PinnedBrowserRef;
  return {
    page,
    frame,
    field,
    target,
    submit,
    context,
    nodes,
    nativeSubmit,
    nativeFill,
    setUrl: (value: string) => {
      url = value;
    },
    navigate: () => {
      url = `${origin}/`;
      for (const callback of navigations) callback(frame);
    },
  };
}

it('blocks screenshots during target-bound insertion, clears same-page errors and redacts forever', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  const original = f.nativeFill.getMockImplementation()!;
  f.nativeFill.mockImplementation(async (value) => {
    expect(await pageHasSecret(f.page)).toBe(true);
    return original(value);
  });
  const result = await fillBoundBrowserSecrets(f.context, binding, async () => [SECRET]);
  expect(result).toEqual({ status: 'cleared_after_submit' });
  expect(f.field.value).toBe('');
  expect(JSON.stringify(await observePage(f.page))).not.toContain(SECRET);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

it('returns submitted after navigation and rechecks complete frame origin before resolving and inserting', async () => {
  const f = fixture();
  f.nativeSubmit.mockImplementation(async () => {
    f.navigate();
  });
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  expect(await fillBoundBrowserSecrets(f.context, binding, async () => [SECRET])).toEqual({ status: 'submitted' });
  const resolve = vi.fn(async () => [SECRET]);
  f.setUrl('https://www.shop.example:8443/login');
  expect(await fillBoundBrowserSecrets(f.context, binding, resolve)).toEqual({ status: 'origin_mismatch' });
  expect(resolve).not.toHaveBeenCalled();
  f.setUrl('https://www.shop.example/login');
  resolve.mockImplementation(async () => {
    f.setUrl('http://www.shop.example/login');
    return [SECRET];
  });
  expect(await fillBoundBrowserSecrets(f.context, binding, resolve)).toEqual({ status: 'origin_mismatch' });
  expect(f.nativeFill).toHaveBeenCalledTimes(1);
  expect(f.page.keyboard.insertText).not.toHaveBeenCalled();
});

it('judges iframe origins and refuses HTTP and card targets before any resolver runs', async () => {
  const insecure = fixture('http://shop.example');
  await expect(
    bindBrowserSecretFields(insecure.page, [{ field: 'password', target: insecure.target }], insecure.submit),
  ).rejects.toBeInstanceOf(BrowserOriginMismatchError);
  const f = fixture('https://identity.example');
  f.page.url = () => 'https://shop.example/login';
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  expect(binding.origin).toBe('https://identity.example');
  f.field.getAttribute = (name) => (name === 'autocomplete' ? 'cc-number' : null);
  await expect(
    bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit),
  ).rejects.toMatchObject({
    code: 'forbidden',
  });
});

it('refuses a held iframe site before resolving any secret after its central lease disappeared', async () => {
  const result = await credentialAttempts.prepareSignup({
    jobId: 'another-job',
    origin: 'https://identity.example',
    username: 'soren_handle',
  });
  if (result.status !== 'prepared') throw new Error(result.status);
  await credentialAttempts.disclose(result.attempt.id, { jobId: 'another-job', origin: 'https://identity.example' });
  const f = fixture('https://identity.example');
  f.page.url = () => 'https://shop.example/login';
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  const resolve = vi.fn(async () => [SECRET]);
  const reads = storeFixture.keyReads();
  expect(await fillBoundBrowserSecrets(f.context, binding, resolve)).toEqual({ status: 'site_busy' });
  expect(resolve).not.toHaveBeenCalled();
  expect(f.nativeFill).not.toHaveBeenCalled();
  expect(storeFixture.keyReads()).toBe(reads);
});

it('detects a changed target value and clears every field holding the value, including copied values', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  const other = { ...f.field, value: '' };
  f.nodes.push(other);
  f.nativeFill.mockImplementation(async (value) => {
    other.value = value;
    return true;
  });
  await expect(fillBoundBrowserSecrets(f.context, binding, async () => [SECRET])).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(f.nodes.map((node) => node.value)).toEqual(['', '']);
});

it('closes the job when a filled value cannot be cleared, and keeps refusing agent presses until it closes', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  // A page copy of the value whose setter ignores clearing.
  let held = '';
  const stuck = {
    get value(): string {
      return held;
    },
    set value(value: string) {
      if (value) held = value;
    },
  };
  f.nodes.push(stuck);
  f.nativeFill.mockImplementation(async (value) => {
    f.field.value = value;
    stuck.value = value;
    return true;
  });
  expect(await fillBoundBrowserSecrets(f.context, binding, async () => [SECRET])).toEqual({
    status: 'cleared_after_submit',
  });
  expect(f.context.runtime.closeJob).toHaveBeenCalledWith('job');
  expect(await pageFieldHoldsHostSecret(f.page)).toBe(true);
});

it('sanitizes browser and resolver failures and accepts no raw values or references', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  const error = await fillBoundBrowserSecrets(f.context, binding, async () => {
    throw new Error(SECRET);
  }).catch((value: unknown) => value);
  expect(error).toMatchObject({
    code: 'forbidden',
    message: 'The host could not safely complete this sign-in. Take a fresh observation.',
  });
  expect(String(error)).not.toContain(SECRET);
  expect(f.nativeFill).not.toHaveBeenCalled();
  expect(f.nativeSubmit).not.toHaveBeenCalled();
  expect(() =>
    validateFillSecret({
      item_handle: 'op://vault/item/password',
      field: 'password',
      target: { ref: 'e1', generation: 1 },
      submit: { ref: 'e2', generation: 1 },
    }),
  ).toThrow();
  expect(() =>
    validateFillSecret({
      item_handle: 'vault_opaque',
      field: 'password',
      value: SECRET,
      target: { ref: 'e1', generation: 1 },
      submit: { ref: 'e2', generation: 1 },
    }),
  ).toThrow();
});

it('returns a vault refusal as its own bounded outcome before anything reaches the page', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  for (const reason of ['vault_unavailable', 'no_item_for_site', 'origin_mismatch'] as const)
    expect(
      await fillBoundBrowserSecrets(f.context, binding, async () => {
        throw new LoginStoreError(reason);
      }),
    ).toEqual({ status: reason });
  expect(f.nativeFill).not.toHaveBeenCalled();
  expect(f.nativeSubmit).not.toHaveBeenCalled();
});

it('discovers a native OTP transition after old handles detach, while retaining the exact frame origin', async () => {
  const previous = fixture();
  const binding = await bindBrowserSecretFields(
    previous.page,
    [{ field: 'password', target: previous.target }],
    previous.submit,
  );
  const next = fixture();
  next.field.getAttribute = (name) =>
    ({ autocomplete: 'one-time-code', type: 'text', name: 'code' })[name as 'autocomplete' | 'type' | 'name'] ?? null;
  Object.assign(previous.target.element, { ownerFrame: async () => null });
  Object.assign(next.target.element, {
    ownerFrame: async () => previous.frame,
    evaluateHandle: async () => ({ asElement: () => next.submit.element, dispose: async () => undefined }),
  });
  Object.assign(next.submit.element, { ownerFrame: async () => previous.frame });
  Object.assign(previous.frame, {
    locator: () => ({ count: async () => 1, elementHandle: async () => next.target.element }),
  });
  const discovered = await discoverAuthenticationCodeField(previous.page, binding);
  expect(discovered?.fields[0].field).toBe('otp');
  expect(discovered?.fields[0].target.element).toBe(next.target.element);
  expect(discovered?.origin).toBe('https://www.shop.example');
  previous.setUrl('https://www.shop.example:8443/verify');
  expect(await discoverAuthenticationCodeField(previous.page, binding)).toBeUndefined();
});

it('refuses secret resolution while Playwright protocol debugging could disclose native keyboard values', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
  const resolve = vi.fn(async () => [SECRET]);
  vi.stubEnv('DEBUG', 'pw:protocol');
  await expect(fillBoundBrowserSecrets(f.context, binding, resolve)).rejects.toMatchObject({ code: 'forbidden' });
  expect(resolve).not.toHaveBeenCalled();
});

it('rejects stored OTP fill while preserving email-code field classification', () => {
  expect(() =>
    validateFillSecret({
      item_handle: 'vault_opaque',
      field: 'otp',
      target: { ref: 'e1', generation: 1 },
      submit: { ref: 'e2', generation: 1 },
    }),
  ).toThrow();
});

it('offers site logins across HTTPS subdomains without reading the key', async () => {
  const f = fixture('https://other.example');
  const item = await storeFixture.store.create({
    site: 'login.shop.example',
    username: 'mira@example.com',
    title: 'Site login',
    password: SECRET,
  });
  vi.spyOn(credentialAttempts, 'accountForLogin').mockResolvedValue('principal');
  storeFixture.setUnavailable(true);
  const reads = storeFixture.keyReads();
  expect((await observePage(f.page)).site?.vault_items).toEqual([]);
  f.setUrl('https://shop.example/login');
  expect((await observePage(f.page)).site?.vault_items).toEqual([
    { item_handle: item.id, title: 'Site login', account: 'principal' },
  ]);
  expect((await observePage(f.page)).site).toBeUndefined();
  expect(storeFixture.keyReads()).toBe(reads);
});

it('offers a newly attached login iframe origin without repeatedly refreshing an unchanged origin set', async () => {
  const f = fixture();
  const item = await storeFixture.store.create({
    site: 'identity.example',
    username: 'mira@example.com',
    title: 'Identity login',
    password: SECRET,
  });
  vi.spyOn(credentialAttempts, 'accountForLogin').mockResolvedValue('principal');
  expect((await observePage(f.page)).site?.vault_items).toEqual([]);
  const child = { url: () => 'https://identity.example/login', evaluate: async () => [] };
  f.page.frames = () => [f.frame, child] as unknown as ReturnType<Page['frames']>;
  expect((await observePage(f.page)).site?.vault_items).toEqual([
    { item_handle: item.id, title: 'Identity login', account: 'principal' },
  ]);
  expect((await observePage(f.page)).site).toBeUndefined();
});

it('labels each site login without exposing usernames or reading the key', async () => {
  const f = fixture();
  const assistant = await storeFixture.store.create({
    site: 'shop.example',
    username: 'mira.web@example.com',
    title: 'Assistant login',
    password: SECRET,
  });
  const principal = await storeFixture.store.create({
    site: 'shop.example',
    username: 'rowan@example.com',
    title: 'Principal login',
    password: SECRET,
  });
  vi.spyOn(credentialAttempts, 'accountForLogin').mockImplementation(async (login) =>
    login.id === assistant.id ? 'assistant' : 'principal',
  );
  storeFixture.setUnavailable(true);
  const reads = storeFixture.keyReads();
  const observation = await observePage(f.page);
  expect(observation.site?.vault_items).toEqual([
    { item_handle: assistant.id, title: 'Assistant login', account: 'assistant' },
    { item_handle: principal.id, title: 'Principal login', account: 'principal' },
  ]);
  expect(JSON.stringify(observation.site)).not.toMatch(/username|password|rowan@|mira.web@/u);
  expect(storeFixture.keyReads()).toBe(reads);
});

// These fake pages have no native DOM; Chrome suites exercise collection. Keep actual taint and redaction.
vi.mock('./control-facts.js', async (original) => ({
  ...(await original<typeof import('./control-facts.js')>()),
  readPageSecretValues: vi.fn(async () => []),
}));

it('leases the iframe login site before resolving its secret so another errand waits', async () => {
  const db = new SqliteDriver(new Database(':memory:'));
  await browserSiteLeasesMigration.up(db);
  try {
    const f = fixture('https://identity.example');
    f.page.url = () => 'https://shop.example/login';
    const binding = await bindBrowserSecretFields(f.page, [{ field: 'password', target: f.target }], f.submit);
    const prepared = await credentialAttempts.prepareSignup({
      jobId: 'another-job',
      origin: binding.origin,
      username: 'soren_handle',
    });
    if (prepared.status !== 'prepared') throw new Error(prepared.status);
    let otherAcquired = false;
    const context: BrowserExecutionContext = {
      ...f.context,
      kind: 'request',
      request: { id: 'iframe-sign-in' },
      store: new BrowserStore(db),
      wakeWaiters: async () => undefined,
    };
    expect(
      await fillBoundBrowserSecrets(context, binding, async () => {
        const lease = await new SiteLeaseStore(db).acquire('another-job', binding.origin);
        otherAcquired = lease.acquired;
        if (lease.acquired)
          await credentialAttempts.disclose(prepared.attempt.id, { jobId: 'another-job', origin: binding.origin });
        return [SECRET];
      }),
    ).toEqual({ status: 'cleared_after_submit' });
    expect(otherAcquired).toBe(false);
    expect(await credentialAttempts.get(prepared.attempt.id)).toMatchObject({ phase: 'saved' });
  } finally {
    await db.close();
  }
});
