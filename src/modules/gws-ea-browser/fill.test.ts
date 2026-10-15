import { randomUUID } from 'node:crypto';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Page } from 'playwright-core';
import {
  bindBrowserSecretField,
  discoverAuthenticationCodeField,
  fillBoundBrowserSecret,
  validateFillSecret,
} from './fill.js';
import type { BrowserExecutionContext } from './queue.js';
import type { PinnedBrowserRef } from './observe.js';
import { observePage, pageHasSecret } from './observe.js';

const SECRET = 'fixture-secret-must-stay-host-only';
beforeEach(() => {
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', `/private/tmp/browser-test-disabled-${randomUUID()}.json`);
});
afterEach(() => {
  vi.unstubAllEnvs();
});
function fixture(origin = 'https://www.shop.example') {
  let url = `${origin}/login`;
  let activeElement: unknown;
  const nodes: Array<{ value: string }> = [];
  const form = {
    action: `${origin}/login`,
    method: 'post',
    target: '',
    elements: [] as unknown[],
    querySelector: (selector: string) => !selector.includes('cc-'),
  };
  const document = {
    get activeElement() {
      return activeElement;
    },
    location: {
      get origin() {
        return new URL(url).origin;
      },
    },
    defaultView: { HTMLFormElement: { prototype: { submit() {} } } },
  };
  const field = {
    tagName: 'INPUT',
    type: 'password',
    name: 'password',
    value: '',
    form,
    ownerDocument: document,
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
    ownerDocument: document,
    isConnected: true,
    getAttribute: (name: string) => (name === 'type' ? 'submit' : null),
  };
  form.elements = [field, button];
  nodes.push(field);
  let navigation: ((frame: unknown) => void) | undefined;
  const handle = (node: unknown) => ({
    ownerFrame: async () => frame,
    focus: async () => {
      activeElement = node;
    },
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
    isClosed: () => false,
    locator: () => ({ innerText: async () => '', ariaSnapshot: async () => `- alert: ${SECRET}` }),
    keyboard: {
      insertText: vi.fn(async (value: string) => {
        (activeElement as { value: string }).value = value;
      }),
    },
    on: (_event: string, callback: typeof navigation) => {
      navigation = callback;
    },
    off: () => undefined,
    waitForEvent: async () => undefined,
    once: () => undefined,
    context: () => ({
      newCDPSession: async () => ({
        on: () => undefined,
        send: async () => ({ frameTree: { frame: { loaderId: 'fixture-document' } } }),
      }),
    }),
  } as unknown as Page;
  const context = {
    assertActive: vi.fn(async () => undefined),
    remaining: () => 10_000,
    runtime: { closeJob: vi.fn(async () => undefined) },
    job: { id: 'job' },
  } as unknown as BrowserExecutionContext;
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
    setUrl: (value: string) => {
      url = value;
    },
    focus: (value: unknown) => {
      activeElement = value;
    },
    navigate: () => {
      url = `${origin}/`;
      navigation?.(frame);
    },
  };
}

it('inserts only via keyboard, blocks screenshots while active, clears same-page errors and redacts forever', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const original = vi.mocked(f.page.keyboard.insertText).getMockImplementation()!;
  vi.mocked(f.page.keyboard.insertText).mockImplementation(async (value) => {
    expect(await pageHasSecret(f.page)).toBe(true);
    await original(value);
  });
  const result = await fillBoundBrowserSecret(f.context, binding, async () => SECRET);
  expect(result).toEqual({ status: 'cleared_after_submit' });
  expect(f.field.value).toBe('');
  expect(JSON.stringify(await observePage(f.page))).not.toContain(SECRET);
  expect(JSON.stringify(result)).not.toContain(SECRET);
});

it('returns submitted after navigation and rechecks complete frame origin before resolving and inserting', async () => {
  const f = fixture();
  f.field.ownerDocument.defaultView.HTMLFormElement.prototype.submit = f.navigate;
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
  expect(f.page.keyboard.insertText).toHaveBeenCalledTimes(1);
});

it('judges iframe origins and refuses HTTP and card targets before any resolver runs', async () => {
  const insecure = fixture('http://shop.example');
  await expect(
    bindBrowserSecretField(insecure.page, insecure.target, insecure.submit, 'password'),
  ).rejects.toMatchObject({ reason: 'origin_mismatch' });
  const f = fixture('https://identity.example');
  f.page.url = () => 'https://shop.example/login';
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  expect(binding.origin).toBe('https://identity.example');
  f.field.getAttribute = (name) => (name === 'autocomplete' ? 'cc-number' : null);
  await expect(bindBrowserSecretField(f.page, f.target, f.submit, 'password')).rejects.toMatchObject({
    code: 'forbidden',
  });
});

it('detects focus drift and clears every field holding the value, including copied values', async () => {
  const f = fixture();
  const binding = await bindBrowserSecretField(f.page, f.target, f.submit, 'password');
  const other = { ...f.field, value: '' };
  f.nodes.push(other);
  vi.mocked(f.page.keyboard.insertText).mockImplementation(async (value) => {
    f.focus(other);
    other.value = value;
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
  expect(String(error)).not.toContain(SECRET);
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
