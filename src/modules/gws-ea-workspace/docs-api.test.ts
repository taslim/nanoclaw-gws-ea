import { expect, it, vi } from 'vitest';
import { createDocsApi } from './docs-api.js';

it('reads all document tabs, table text, headers and link targets through a host-only authenticated request', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({
      documentId: 'doc-1',
      title: 'Itinerary',
      revisionId: 'revision-7',
      tabs: [
        {
          tabProperties: { title: 'First tab' },
          documentTab: {
            body: {
              content: [
                {
                  paragraph: {
                    elements: [
                      { textRun: { content: 'First ', textStyle: { link: { url: 'https://example.com/private' } } } },
                      { textRun: { content: 'day\n' } },
                    ],
                  },
                },
                {
                  table: {
                    tableRows: [
                      {
                        tableCells: [{ content: [{ paragraph: { elements: [{ textRun: { content: 'Cabin\n' } }] } }] }],
                      },
                    ],
                  },
                },
              ],
            },
            headers: { header: { content: [{ paragraph: { elements: [{ textRun: { content: 'Header\n' } }] } }] } },
          },
          childTabs: [
            {
              documentTab: {
                body: { content: [{ paragraph: { elements: [{ textRun: { content: 'Second tab\n' } }] } }] },
              },
            },
          ],
        },
      ],
    }),
  );
  const docs = createDocsApi({ token: async () => 'host-token', fetch });
  const result = await docs.read('doc-1');
  expect(result.text).toBe('First day\nCabin\nHeader\nSecond tab\n');
  expect(result.references).toContain('https://example.com/private');
  expect(result.references).toContain('First tab');
  expect(result.revision).toBe('revision-7');
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe('https://docs.googleapis.com/v1/documents/doc-1?includeTabsContent=true');
  expect(new Headers(init?.headers).get('authorization')).toBe('Bearer host-token');
});
it('uses revision-bound case-sensitive replacement rather than accepting arbitrary Google requests', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async () =>
    Response.json({ replies: [{ replaceAllText: { occurrencesChanged: 2 } }] }),
  );
  const docs = createDocsApi({ token: async () => 'host-token', fetch });
  await docs.replace('doc-1', 'Friday', 'Saturday', 'revision-7');
  expect(
    fetch.mock.calls.map(([url, init]) => ({
      url: String(url),
      method: init?.method,
      body: JSON.parse(String(init?.body)) as unknown,
    })),
  ).toEqual([
    {
      url: 'https://docs.googleapis.com/v1/documents/doc-1:batchUpdate',
      method: 'POST',
      body: {
        writeControl: { requiredRevisionId: 'revision-7' },
        requests: [{ replaceAllText: { containsText: { text: 'Friday', matchCase: true }, replaceText: 'Saturday' } }],
      },
    },
  ]);
});
it('creates the initial text and private recovery marker together, and searches only that assistant-owned marked document', async () => {
  const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) =>
    Response.json(init?.method === 'POST' ? { id: 'doc-1' } : { files: [{ id: 'doc-1' }] }),
  );
  const docs = createDocsApi({ token: async () => 'host-token', fetch });
  const requestKey = 'a'.repeat(64);
  expect(await docs.create({ title: 'Trip plan', text: 'Friday\nCabin', folder: 'job-folder', requestKey })).toBe(
    'doc-1',
  );
  const [url, init] = fetch.mock.calls[0];
  expect(String(url)).toBe('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id');
  expect(new Headers(init?.headers).get('content-type')).toMatch(/^multipart\/related; boundary=/u);
  const body = Buffer.from(init?.body as Uint8Array).toString('utf8');
  expect(body).toContain(
    JSON.stringify({
      name: 'Trip plan',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['job-folder'],
      appProperties: { nc_job_doc: requestKey },
    }),
  );
  expect(body).toContain('Content-Type: text/plain; charset=UTF-8\r\n\r\nFriday\nCabin');
  expect(await docs.findCreated(requestKey)).toBe('doc-1');
  const query = new URL(String(fetch.mock.calls[1][0])).searchParams.get('q');
  expect(query).toContain("'me' in owners");
  expect(query).toContain(`appProperties has { key='nc_job_doc' and value='${requestKey}' }`);
});
