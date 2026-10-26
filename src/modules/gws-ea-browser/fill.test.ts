import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  readVaultSiteInfo,
  bindBrowserSecretField,
  BrowserOriginMismatchError,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecret,
  validateFillSecret,
} from './fill.js';
import type { BrowserExecutionContext } from './actions.js';
import type { PinnedBrowserRef } from './observe.js';
import { observePage, configureBrowserSiteInfo } from './observe.js';
import { pageHasSecret } from './page-privacy.js';
import * as nativeAuthentication from './authentication-submit.js';
import * as isolatedFacts from './control-facts.js';
import * as consentEngine from './consent.js';
import { browserVault, BrowserVaultError, websitePermitsOrigin } from './onepassword.js';

const SECRET = 'fixture-secret-must-stay-host-only';
beforeEach(() => {
  configureBrowserSiteInfo({ vault: readVaultSiteInfo });
  vi.stubEnv('GWS_EA_BROWSER_ROOT', join(tmpdir(), `browser-test-disabled-${randomUUID()}.json`));
});
afterEach(() => {
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
    assertActive: vi.fn(async () => undefined),
    remaining: () => 10_000,
    runtime: { closeJob: vi.fn(async () => undefined) },
    job: { id: 'job' },
    store: { db: {} },
  } as unknown as BrowserExecutionContext;
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
  vi.spyOn(nativeAuthentication, 'inspectNativeAuthenticationControl').mockImplementation(async (element) => ({
    frameId: 'fixture-frame',
    loaderId: 'fixture-document',
    controlBackendNodeId: 1,
    formBackendNodeId: 2,
    facts: {
      origin: new URL(url).origin,
      action: form.action,
      method: form.method,
      target: form.target,
      submit: true,
      control:
        (element as unknown as { node: unknown }).node === field
          ? { tag: 'INPUT', name: field.name, type: field.type, autocomplete: field.getAttribute('autocomplete') ?? '' }
          : { tag: 'BUTTON', name: '', type: 'submit', autocomplete: '' },
      fields: [field, button].map((node) => ({
        name: node.name,
        type: node.type,
        autocomplete: node.getAttribute('autocomplete') ?? '',
      })),
    },
  }));
  const nativeFill = vi.fn(async (value: string) => {
    field.value = value;
    return true;
  });
  vi.spyOn(nativeAuthentication, 'fillNativeAuthenticationField').mockImplementation(
    async (_frame, _field, _submit, value, assertActive) => {
      await assertActive();
      return nativeFill(value);
    },
  );
  const nativeSubmit = vi.fn(async () => undefined);
  // The consent engine's isolated-world pass has its own native suite (open-web-native).
  vi.spyOn(consentEngine, 'runConsentPass').mockResolvedValue({ status: 'ready', agreements: [], addOns: [] });
  vi.spyOn(nativeAuthentication, 'submitNativeAuthenticationForm').mockImplementation(
    async (_frame, _binding, assertActive) => {
      await assertActive?.();
      await nativeSubmit();
      return true;
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
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const original = f.nativeFill.getMockImplementation()!;
  f.nativeFill.mockImplementation(async (value) => {
    expect(await pageHasSecret(f.page)).toBe(true);
    return original(value);
  });
  const result = await fillBoundBrowserSecret(f.context, binding, async () => SECRET);
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
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  expect(await fillBoundBrowserSecret(f.context, binding, async () => SECRET)).toEqual({ status: 'submitted' });
  const resolve = vi.fn(async () => SECRET);
  f.setUrl('https://www.shop.example:8443/login');
  expect(await fillBoundBrowserSecret(f.context, binding, resolve)).toEqual({ status: 'origin_mismatch' });
  expect(resolve).not.toHaveBeenCalled();
  f.setUrl('https://www.shop.example/login');
  resolve.mockImplementation(async () => {
    f.setUrl('http://www.shop.example/login');
    return SECRET;
  });
  expect(await fillBoundBrowserSecret(f.context, binding, resolve)).toEqual({ status: 'origin_mismatch' });
  expect(f.nativeFill).toHaveBeenCalledTimes(1);
  expect(f.page.keyboard.insertText).not.toHaveBeenCalled();
});

it('judges iframe origins and refuses HTTP and card targets before any resolver runs', async () => {
  const insecure = fixture('http://shop.example');
  await expect(
    bindBrowserSecretField(insecure.page, insecure.target, insecure.submit, 'password'),
  ).rejects.toBeInstanceOf(BrowserOriginMismatchError);
  const f = fixture('https://identity.example');
  f.page.url = () => 'https://shop.example/login';
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  expect(binding.origin).toBe('https://identity.example');
  f.field.getAttribute = (name) => (name === 'autocomplete' ? 'cc-number' : null);
  await expect(bindBrowserSecretField(f.page, f.target, f.submit, 'password')).rejects.toMatchObject({
    code: 'forbidden',
  });
});

it('detects a changed target value and clears every field holding the value, including copied values', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const other = { ...f.field, value: '' };
  f.nodes.push(other);
  f.nativeFill.mockImplementation(async (value) => {
    other.value = value;
    return true;
  });
  await expect(fillBoundBrowserSecret(f.context, binding, async () => SECRET)).rejects.toMatchObject({
    code: 'forbidden',
  });
  expect(f.nodes.map((node) => node.value)).toEqual(['', '']);
});

it('sanitizes browser and resolver failures and accepts no raw values or references', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const error = await fillBoundBrowserSecret(f.context, binding, async () => {
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
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  for (const reason of ['rate_limited', 'vault_unavailable', 'no_item_for_site', 'origin_mismatch'] as const)
    expect(
      await fillBoundBrowserSecret(f.context, binding, async () => {
        throw new BrowserVaultError(reason);
      }),
    ).toEqual({ status: reason });
  expect(f.nativeFill).not.toHaveBeenCalled();
  expect(f.nativeSubmit).not.toHaveBeenCalled();
});

it('discovers a native OTP transition after old handles detach, while retaining the exact frame origin', async () => {
  const previous = fixture();
  const binding = await bindBrowserSecretField(previous.page, previous.target, previous.submit, 'password');
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
  expect(discovered?.field).toBe('otp');
  expect(discovered?.target.element).toBe(next.target.element);
  expect(discovered?.origin).toBe('https://www.shop.example');
  previous.setUrl('https://www.shop.example:8443/verify');
  expect(await discoverAuthenticationCodeField(previous.page, binding)).toBeUndefined();
});

it('refuses secret resolution while Playwright protocol debugging could disclose native keyboard values', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const resolve = vi.fn(async () => SECRET);
  vi.stubEnv('DEBUG', 'pw:protocol');
  await expect(fillBoundBrowserSecret(f.context, binding, resolve)).rejects.toMatchObject({ code: 'forbidden' });
  expect(resolve).not.toHaveBeenCalled();
});

it('offers ExactDomain vault handles after redirecting to a different HTTPS origin on the same site', async () => {
  const f = fixture();
  const website = { url: 'https://login.shop.example', autofillBehavior: 'ExactDomain' };
  vi.spyOn(browserVault, 'itemsForOrigin').mockImplementation(async (origin) =>
    websitePermitsOrigin(website, origin) ? [{ item_handle: 'vault_exact-login', title: 'Site login' }] : [],
  );
  expect((await observePage(f.page)).site?.vault_items).toEqual([]);
  f.setUrl('https://login.shop.example/login');
  expect((await observePage(f.page)).site?.vault_items).toEqual([
    { item_handle: 'vault_exact-login', title: 'Site login' },
  ]);
  expect((await observePage(f.page)).site).toBeUndefined();
});

it('offers a newly attached login iframe origin without repeatedly refreshing an unchanged origin set', async () => {
  const f = fixture();
  vi.spyOn(browserVault, 'itemsForOrigin').mockImplementation(async (origin) =>
    origin === 'https://identity.example' ? [{ item_handle: 'vault_frame-login', title: 'Identity login' }] : [],
  );
  expect((await observePage(f.page)).site?.vault_items).toEqual([]);
  const child = { url: () => 'https://identity.example/login', evaluate: async () => [] };
  f.page.frames = () => [f.frame, child] as unknown as ReturnType<Page['frames']>;
  expect((await observePage(f.page)).site?.vault_items).toEqual([
    { item_handle: 'vault_frame-login', title: 'Identity login' },
  ]);
  expect((await observePage(f.page)).site).toBeUndefined();
});

// These fake pages have no native DOM; Chrome suites exercise collection. Keep actual taint and redaction.
vi.mock('./control-facts.js', async (original) => ({
  ...(await original<typeof import('./control-facts.js')>()),
  readPageSecretValues: vi.fn(async () => []),
}));
