import { randomUUID } from 'node:crypto';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';

export const DOCUMENT_MIME_TYPE = 'application/vnd.google-apps.document';
export interface GoogleDocument {
  readonly id: string;
  readonly title: string;
  readonly text: string;
  readonly revision: string | undefined;
  /** Non-body strings (including link targets and image alt text) checked before a share or write. */
  readonly references: readonly string[];
}
export interface DocsApi {
  read(file: string): Promise<GoogleDocument>;
  create(input: {
    readonly title: string;
    readonly text: string;
    readonly folder: string;
    readonly requestKey: string;
  }): Promise<string>;
  /** Recover a create already attempted; an absent match is not authority to create another. */
  findCreated(requestKey: string): Promise<string | undefined>;
  replace(file: string, find: string, replace: string, revision: string): Promise<void>;
}

function readContent(value: unknown, text: string[], references: string[]): void {
  if (Array.isArray(value)) {
    for (const entry of value) readContent(entry, text, references);
  } else if (isRecord(value)) {
    for (const [key, entry] of Object.entries(value)) {
      if (key === 'textRun' && isRecord(entry)) {
        if (typeof entry.content === 'string') text.push(entry.content);
        for (const [name, field] of Object.entries(entry)) if (name !== 'content') readContent(field, [], references);
      } else if (typeof entry === 'string') {
        references.push(entry);
      } else readContent(entry, text, references);
    }
  }
}

export function createDocsApi(options: GoogleClientOptions): DocsApi {
  const url = (file: string) => `https://docs.googleapis.com/v1/documents/${encodeURIComponent(file)}`;
  return {
    async read(file) {
      const payload = await googleJson(options, `${url(file)}?includeTabsContent=true`);
      if (
        !isRecord(payload) ||
        typeof payload.documentId !== 'string' ||
        typeof payload.title !== 'string' ||
        !Array.isArray(payload.tabs)
      )
        throw new GoogleApiError(502, 'Google Docs returned an unreadable document');
      const text: string[] = [];
      const references: string[] = [];
      readContent(payload.tabs, text, references);
      return {
        id: payload.documentId,
        title: payload.title,
        text: text.join(''),
        references,
        revision: typeof payload.revisionId === 'string' ? payload.revisionId : undefined,
      };
    },
    async create(input) {
      const boundary = `nc_${randomUUID()}`;
      const metadata = {
        name: input.title,
        mimeType: DOCUMENT_MIME_TYPE,
        parents: [input.folder],
        appProperties: { nc_job_doc: input.requestKey },
      };
      const data = Buffer.from(
        `--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: text/plain; charset=UTF-8\r\n\r\n${input.text}\r\n--${boundary}--\r\n`,
      );
      const payload = await googleJson(
        options,
        'https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id',
        {
          method: 'POST',
          content: { type: `multipart/related; boundary=${boundary}`, data },
        },
      );
      if (!isRecord(payload) || typeof payload.id !== 'string')
        throw new GoogleApiError(502, 'Google Drive returned an unreadable document ID');
      return payload.id;
    },
    async findCreated(requestKey) {
      if (!/^[a-f0-9]{64}$/u.test(requestKey)) throw new Error('Invalid job document request key');
      const query = new URLSearchParams({
        q: `'me' in owners and mimeType = '${DOCUMENT_MIME_TYPE}' and appProperties has { key='nc_job_doc' and value='${requestKey}' }`,
        fields: 'files(id),nextPageToken,incompleteSearch',
        pageSize: '2',
      });
      const payload = await googleJson(options, `https://www.googleapis.com/drive/v3/files?${query.toString()}`);
      if (!isRecord(payload) || !Array.isArray(payload.files))
        throw new GoogleApiError(502, 'Google Drive returned an unreadable document search');
      if (payload.incompleteSearch === true || payload.nextPageToken !== undefined || payload.files.length > 1)
        throw new Error('Google could not uniquely confirm the earlier document creation');
      const file = payload.files[0] as unknown;
      if (file === undefined) return undefined;
      if (!isRecord(file) || typeof file.id !== 'string')
        throw new GoogleApiError(502, 'Google Drive returned an unreadable document ID');
      return file.id;
    },
    async replace(file, find, replace, revision) {
      await googleJson(options, `${url(file)}:batchUpdate`, {
        method: 'POST',
        body: {
          writeControl: { requiredRevisionId: revision },
          requests: [
            {
              replaceAllText: {
                containsText: { text: find, matchCase: true },
                replaceText: replace,
              },
            },
          ],
        },
      });
    },
  };
}
