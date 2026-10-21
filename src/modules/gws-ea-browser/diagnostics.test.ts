import { EventEmitter } from 'node:events';

import type { Page, Request } from 'playwright-core';
import { expect, it } from 'vitest';

import {
  BrowserDiagnosticAttempt,
  beginBrowserDiagnosticAction,
  captureBrowserDiagnosticRefusal,
} from './diagnostics.js';
import { registerPageSecret } from './page-privacy.js';

function pageFixture() {
  const events = new EventEmitter();
  const page = Object.assign(events, {
    context: () => ({ browser: () => ({ version: () => '155.0.0.0' }) }),
  }) as unknown as Page;
  return { events, page };
}
function attempt(requestId = 'request-1') {
  return new BrowserDiagnosticAttempt({ jobId: 'job-1', requestId, action: 'browser', actionIndex: 0 });
}
function request(errorText?: string): Request {
  return {
    url: () => 'https://secret-sentinel.fixture.example/secret-sentinel?password=secret-sentinel#secret-sentinel',
    method: () => 'POST',
    resourceType: () => 'document',
    redirectedFrom: () => null,
    failure: () => (errorText ? { errorText } : null),
    headers: () => {
      throw new Error('Headers are private');
    },
    postData: () => {
      throw new Error('Bodies are private');
    },
  } as unknown as Request;
}

it('distinguishes received HTTP, explicit host refusal, DNS/TLS failure and runtime failure without invented status', () => {
  const { events, page } = pageFixture();
  const capture = attempt();
  capture.observe(page);
  const responseRequest = request();
  events.emit('request', responseRequest);
  events.emit('response', { request: () => responseRequest, status: () => 403 });
  captureBrowserDiagnosticRefusal(page)('document');
  for (const error of ['net::ERR_NAME_NOT_RESOLVED', 'net::ERR_CERT_AUTHORITY_INVALID']) {
    const failed = request(error);
    events.emit('request', failed);
    events.emit('requestfailed', failed);
  }
  const failure = {
    source: 'runtime_error' as const,
    category: 'execution' as const,
    raw_error: 'secret-sentinel',
    url: 'https://fixture.example/secret-sentinel',
    headers: { authorization: 'secret-sentinel' },
    body: 'secret-sentinel',
  };
  capture.record(failure);
  const result = capture.finish();
  expect(result.events).toMatchObject([
    { source: 'http_response', status: 403, site: 'fixture.example', method: 'POST', resource: 'document' },
    { source: 'host_refusal', category: 'document' },
    { source: 'transport_failure', category: 'dns' },
    { source: 'transport_failure', category: 'tls' },
    { source: 'runtime_error', category: 'execution' },
  ]);
  expect(result.events.slice(1).every((event) => !('status' in event))).toBe(true);
  expect(JSON.stringify(result)).not.toContain('secret-sentinel');
  expect(result.runtime).toMatchObject({ chrome: '155.0.0.0', playwright: '1.64.0' });
  registerPageSecret(page, 'FiXtUrE');
  const privateHost = attempt('request-private-host');
  privateHost.observe(page);
  events.emit('request', responseRequest);
  events.emit('response', { request: () => responseRequest, status: () => 403 });
  const redacted = privateHost.finish();
  expect(redacted.events).toContainEqual(expect.objectContaining({ source: 'http_response', status: 403 }));
  expect(JSON.stringify(redacted).toLowerCase()).not.toContain('fixture');
});

it('discards late responses, transport failures and captured refusals from a prior attempt on the same page', () => {
  const { events, page } = pageFixture();
  const first = attempt();
  first.observe(page);
  const oldRequest = request('net::ERR_NAME_NOT_RESOLVED');
  events.emit('request', oldRequest);
  const oldRefusal = captureBrowserDiagnosticRefusal(page);
  const second = attempt('request-2');
  second.observe(page);
  events.emit('response', { request: () => oldRequest, status: () => 403 });
  events.emit('requestfailed', oldRequest);
  oldRefusal('document');
  const currentRequest = request();
  events.emit('request', currentRequest);
  events.emit('response', { request: () => currentRequest, status: () => 200 });
  expect(first.finish().events).toEqual([]);
  const result = second.finish();
  expect(result).toMatchObject({
    request_id: 'request-2',
    action_index: 0,
    events: [{ source: 'http_response', status: 200 }],
  });
  events.emit('response', { request: () => currentRequest, status: () => 503 });
  expect(second.finish()).toEqual(result);
});

it('bounds evidence and allowlists unrecognized methods, resources and transport errors', () => {
  const { events, page } = pageFixture();
  const capture = attempt();
  capture.observe(page);
  const unsafe = {
    ...request('secret-sentinel error with URL'),
    method: () => 'secret-sentinel',
    resourceType: () => 'secret-sentinel',
  } as unknown as Request;
  events.emit('request', unsafe);
  events.emit('requestfailed', unsafe);
  for (let index = 0; index < 80; index++) captureBrowserDiagnosticRefusal(page)('action');
  const result = capture.finish();
  expect(result.events).toHaveLength(64);
  expect(result.omitted_events).toBe(17);
  expect(result.events[0]).toMatchObject({
    source: 'transport_failure',
    category: 'unknown',
    method: 'OTHER',
    resource: 'other',
  });
  expect(JSON.stringify(result)).not.toContain('secret-sentinel');
});

it('correlates redirects within an action and discards late events and redirects from an earlier action', () => {
  const { events, page } = pageFixture();
  const capture = attempt();
  capture.observe(page);
  beginBrowserDiagnosticAction(page, 0);
  const first = request();
  const redirected = { ...request(), redirectedFrom: () => first } as unknown as Request;
  events.emit('request', first);
  events.emit('response', { request: () => first, status: () => 302 });
  events.emit('requestfinished', first);
  events.emit('request', redirected);
  events.emit('response', { request: () => redirected, status: () => 403 });
  const late = request('net::ERR_NAME_NOT_RESOLVED');
  events.emit('request', late);
  const refuse = captureBrowserDiagnosticRefusal(page);
  beginBrowserDiagnosticAction(page, 1);
  events.emit('response', { request: () => late, status: () => 500 });
  events.emit('requestfailed', late);
  refuse('document');
  const lateRedirect = { ...request(), redirectedFrom: () => late } as unknown as Request;
  events.emit('request', lateRedirect);
  events.emit('response', { request: () => lateRedirect, status: () => 503 });
  const current = request();
  events.emit('request', current);
  events.emit('response', { request: () => current, status: () => 200 });
  const result = capture.finish();
  expect(result.events).toMatchObject([
    { source: 'http_response', status: 302, action_index: 0, request_index: 1 },
    { source: 'http_response', status: 403, action_index: 0, request_index: 2, redirected_from: 1 },
    { source: 'http_response', status: 200, action_index: 1 },
  ]);
  expect(JSON.stringify(result)).not.toContain('secret-sentinel');
});
