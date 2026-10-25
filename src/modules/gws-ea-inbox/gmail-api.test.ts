/**
 * The host's Gmail client as a matter reads a thread: one request for
 * the thread's messages with only their headers, which name who wrote each,
 * when and about what beside the headers a send is found by, and Gmail's own
 * excerpt of each. Nothing of a message's body is fetched.
 */
import { describe, expect, it } from 'vitest';

import { createGmailApi } from './gmail-api.js';

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly authorization: string | undefined;
}

function stubGmail(reply: (request: Recorded) => { status: number; body?: unknown }) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const headers = (init?.headers ?? {}) as Record<string, string>;
    const request: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      authorization: headers.authorization,
    };
    requests.push(request);
    const { status, body } = reply(request);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  return { api: createGmailApi({ token: async () => 'host-gmail-token', fetch }), requests };
}

const THREAD = {
  id: 'g-thread-1',
  messages: [
    {
      id: 'g-1',
      threadId: 'g-thread-1',
      labelIds: ['SENT'],
      internalDate: '1791720000000',
      snippet: 'Hi Juno, could you send the revised quote by Friday?',
      payload: {
        headers: [
          { name: 'From', value: 'Assistant to Morgan <assistant@ellery.example>' },
          { name: 'Date', value: 'Fri, 9 Oct 2026 14:00:00 +0000' },
          { name: 'Subject', value: 'Revised quote' },
          { name: 'Message-ID', value: '<sent-1@ellery.example>' },
        ],
      },
    },
    {
      id: 'g-2',
      threadId: 'g-thread-1',
      labelIds: ['INBOX', 'UNREAD'],
      internalDate: '1791813720000',
      snippet: 'Here it is &mdash; 4% lower than last year&#39;s.',
      payload: { headers: [{ name: 'From', value: 'Juno Hale <juno@acme.example>' }] },
    },
  ],
};

it('searches Spam and the inbox only when the native caller asks for both', async () => {
  const { api, requests } = stubGmail(() => ({ status: 200, body: { messages: [] } }));
  await api.listMessages({ q: 'in:anywhere after:1792047600', maxResults: 100, includeSpamTrash: true });
  expect(requests[0].url.searchParams.get('includeSpamTrash')).toBe('true');
  await api.listMessages({ maxResults: 100 });
  expect(requests[1].url.searchParams.has('includeSpamTrash')).toBe(false);
});

describe('the Gmail client reading a thread', () => {
  it("asks only for each message's headers: who, when, what about, and the ones a send is found by", async () => {
    const { api, requests } = stubGmail(() => ({ status: 200, body: THREAD }));
    await api.getThread('g-thread-1');
    const [request] = requests;
    expect(request.method).toBe('GET');
    expect(request.url.pathname).toBe('/gmail/v1/users/me/threads/g-thread-1');
    expect(request.url.searchParams.get('format')).toBe('metadata');
    expect(request.url.searchParams.getAll('metadataHeaders')).toEqual([
      'Message-ID',
      'X-Google-Original-Message-ID',
      'From',
      'Date',
      'Subject',
    ]);
    expect(request.authorization).toBe('Bearer host-gmail-token');
  });

  it("reads each message's labels, Gmail's time, headers and excerpt, oldest first", async () => {
    const { api } = stubGmail(() => ({ status: 200, body: THREAD }));
    expect(await api.getThread('g-thread-1')).toEqual([
      {
        id: 'g-1',
        threadId: 'g-thread-1',
        labelIds: ['SENT'],
        internalDate: '1791720000000',
        snippet: 'Hi Juno, could you send the revised quote by Friday?',
        payload: THREAD.messages[0].payload,
      },
      {
        id: 'g-2',
        threadId: 'g-thread-1',
        labelIds: ['INBOX', 'UNREAD'],
        internalDate: '1791813720000',
        snippet: 'Here it is &mdash; 4% lower than last year&#39;s.',
        payload: THREAD.messages[1].payload,
      },
    ]);
  });

  it('says when the thread is gone', async () => {
    const { api } = stubGmail(() => ({ status: 404 }));
    expect(await api.getThread('g-gone')).toBeUndefined();
  });
});
