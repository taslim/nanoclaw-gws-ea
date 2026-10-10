/**
 * The host's Drive client: each call is one request with the host's own
 * Drive token in its header, shares only with one person at a time and never
 * emails them, and reads Google's answers the way the home folder relies on
 * (a file gone, a permission already gone, an address Google will not share
 * with, a rate limit that is only worth waiting out).
 */
import { describe, expect, it } from 'vitest';

import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { createDriveApi, FOLDER_MIME_TYPE, isShareRefusal } from './drive-api.js';

interface Recorded {
  readonly method: string;
  readonly url: URL;
  readonly headers: Record<string, string>;
  readonly body: unknown;
}

function stubGoogle(reply: (request: Recorded) => { status: number; body?: unknown }) {
  const requests: Recorded[] = [];
  const fetch = (async (input: string | URL, init?: RequestInit) => {
    const request: Recorded = {
      method: init?.method ?? 'GET',
      url: new URL(String(input)),
      headers: Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>)),
      body: typeof init?.body === 'string' ? JSON.parse(init.body) : undefined,
    };
    requests.push(request);
    const { status, body } = reply(request);
    return new Response(body === undefined ? null : JSON.stringify(body), { status });
  }) as typeof globalThis.fetch;
  const api = createDriveApi({ token: async () => 'host-drive-token', fetch });
  return { api, requests };
}

/** Drive's error body, as its v3 API words one. */
function driveError(status: number, reason: string, message: string) {
  return { status, body: { error: { code: status, message, errors: [{ domain: 'global', reason, message }] } } };
}

const FOLDER = {
  id: 'folder-1',
  name: 'Morgan Ellery · Juno',
  mimeType: FOLDER_MIME_TYPE,
  trashed: false,
  parents: ['root-1'],
};

describe('the Drive client', () => {
  it('reads a file with the host token, asking only for what the host reads, and says when it is gone', async () => {
    const { api, requests } = stubGoogle((request) =>
      request.url.pathname.endsWith('/folder-1') ? { status: 200, body: FOLDER } : { status: 404 },
    );
    expect(await api.getFile('folder-1')).toEqual(FOLDER);
    expect(await api.getFile('deleted-1')).toBeUndefined();
    const [request] = requests;
    expect(request.method).toBe('GET');
    expect(request.url.origin).toBe('https://www.googleapis.com');
    expect(request.url.pathname).toBe('/drive/v3/files/folder-1');
    expect(request.url.searchParams.get('fields')).toBe('id,name,mimeType,trashed,parents');
    expect(request.url.searchParams.get('supportsAllDrives')).toBe('true');
    expect(request.headers.authorization).toBe('Bearer host-drive-token');
  });

  it('creates a file with its name, type and parents, and reads back what it made', async () => {
    const { api, requests } = stubGoogle(() => ({ status: 200, body: { ...FOLDER, id: 'folder-2' } }));
    expect(await api.createFile({ name: 'Morgan Ellery · Juno', mimeType: FOLDER_MIME_TYPE })).toMatchObject({
      id: 'folder-2',
      trashed: false,
    });
    await api.createFile({
      name: 'Trip plan',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-2'],
    });
    const [folder, document] = requests;
    expect(folder.method).toBe('POST');
    expect(folder.url.pathname).toBe('/drive/v3/files');
    expect(folder.url.searchParams.get('fields')).toBe('id,name,mimeType,trashed,parents');
    expect(folder.body).toEqual({ name: 'Morgan Ellery · Juno', mimeType: FOLDER_MIME_TYPE });
    expect(document.body).toEqual({
      name: 'Trip plan',
      mimeType: 'application/vnd.google-apps.document',
      parents: ['folder-2'],
    });
  });

  it('trashes and restores a file in place', async () => {
    const { api, requests } = stubGoogle((request) => ({
      status: 200,
      body: { ...FOLDER, trashed: (request.body as { trashed: boolean }).trashed },
    }));
    expect(await api.updateFile('folder-1', { trashed: true })).toMatchObject({ trashed: true });
    expect(await api.updateFile('folder-1', { trashed: false })).toMatchObject({ trashed: false });
    expect(requests.map((request) => [request.method, request.url.pathname, request.body])).toEqual([
      ['PATCH', '/drive/v3/files/folder-1', { trashed: true }],
      ['PATCH', '/drive/v3/files/folder-1', { trashed: false }],
    ]);
  });

  it("reads a file's whole access list across pages, inherited access included", async () => {
    const owner = { id: '0800', type: 'user', role: 'owner', emailAddress: 'juno@northwind.example' };
    const inherited = {
      id: '0812',
      type: 'user',
      role: 'writer',
      emailAddress: 'morgan.fixture@gmail.com',
      permissionDetails: [{ permissionType: 'file', role: 'writer', inherited: true, inheritedFrom: 'folder-1' }],
    };
    const { api, requests } = stubGoogle((request) =>
      request.url.searchParams.get('pageToken') === null
        ? { status: 200, body: { permissions: [owner], nextPageToken: 'p2' } }
        : { status: 200, body: { permissions: [inherited, { type: 'user' }] } },
    );
    expect(await api.listPermissions('doc-1')).toEqual([owner, inherited]);
    expect(requests).toHaveLength(2);
    expect(requests[0].url.pathname).toBe('/drive/v3/files/doc-1/permissions');
    expect(requests[0].url.searchParams.get('fields')).toBe(
      'nextPageToken,permissions(id,type,role,emailAddress,domain,deleted,expirationTime,view,permissionDetails(permissionType,role,inherited,inheritedFrom))',
    );
    expect(requests[1].url.searchParams.get('pageToken')).toBe('p2');
  });

  it('shares with one person by address, never emailing them, and reads back the permission Drive made', async () => {
    const { api, requests } = stubGoogle(() => ({
      status: 200,
      body: { id: '0812', type: 'user', role: 'writer', emailAddress: 'morgan.fixture@gmail.com' },
    }));
    expect(
      await api.createPermission('folder-1', { emailAddress: 'morgan.fixture@gmail.com', role: 'writer' }),
    ).toEqual({ id: '0812', type: 'user', role: 'writer', emailAddress: 'morgan.fixture@gmail.com' });
    const [request] = requests;
    expect(request.method).toBe('POST');
    expect(request.url.pathname).toBe('/drive/v3/files/folder-1/permissions');
    expect(request.url.searchParams.get('sendNotificationEmail')).toBe('false');
    expect(request.body).toEqual({ type: 'user', role: 'writer', emailAddress: 'morgan.fixture@gmail.com' });
  });

  it('removes a permission, and says when it was already gone', async () => {
    const { api, requests } = stubGoogle((request) =>
      request.url.pathname.endsWith('/0812') ? { status: 204 } : { status: 404 },
    );
    expect(await api.deletePermission('folder-1', '0812')).toBe(true);
    expect(await api.deletePermission('folder-1', '0899')).toBe(false);
    expect(requests[0].method).toBe('DELETE');
    expect(requests[0].url.pathname).toBe('/drive/v3/files/folder-1/permissions/0812');
  });

  it("finds an address's permission id through Drive v2, and nothing when Drive knows none", async () => {
    const { api, requests } = stubGoogle((request) =>
      request.url.pathname.includes('morgan.fixture') ? { status: 200, body: { id: '0812' } } : { status: 404 },
    );
    expect(await api.permissionId('morgan.fixture@gmail.com')).toBe('0812');
    expect(await api.permissionId('nobody@nowhere.example')).toBeUndefined();
    expect(requests[0].url.origin).toBe('https://www.googleapis.com');
    expect(requests[0].url.pathname).toBe('/drive/v2/permissionIds/morgan.fixture%40gmail.com');
  });

  it("lists a file's pending access requests across pages", async () => {
    const proposal = {
      fileId: 'doc-1',
      proposalId: 'ap-1',
      requesterEmailAddress: 'remy@acme.example',
      recipientEmailAddress: 'juno@northwind.example',
      requestMessage: 'Could I see the agenda?',
      createTime: '2026-10-09T08:00:00.000Z',
      rolesAndViews: [{ role: 'reader' }],
    };
    const { api, requests } = stubGoogle((request) =>
      request.url.searchParams.get('pageToken') === null
        ? { status: 200, body: { accessProposals: [proposal], nextPageToken: 'p2' } }
        : { status: 200, body: {} },
    );
    expect(await api.listAccessProposals('doc-1')).toEqual([proposal]);
    expect(requests.map((request) => request.url.pathname)).toEqual([
      '/drive/v3/files/doc-1/accessproposals',
      '/drive/v3/files/doc-1/accessproposals',
    ]);
  });

  it('refuses an unreadable answer rather than guessing', async () => {
    const { api } = stubGoogle(() => ({ status: 200, body: { name: 'no id' } }));
    await expect(api.getFile('folder-1')).rejects.toMatchObject({ name: 'GoogleApiError', status: 502 });
    await expect(api.createFile({ name: 'x', mimeType: FOLDER_MIME_TYPE })).rejects.toMatchObject({ status: 502 });
  });
});

describe('Google refusing a share', () => {
  it("is final for an address Google will not share with: no Google account, or the sharing policy's no", async () => {
    const noAccount = driveError(
      400,
      'invalidSharingRequest',
      'Bad Request. User message: "There is no Google account associated with this email address."',
    );
    const policy = driveError(403, 'shareOutNotPermitted', 'Sharing outside the organization is not allowed.');
    for (const answer of [noAccount, policy]) {
      const { api } = stubGoogle(() => answer);
      const error: unknown = await api
        .createPermission('folder-1', { emailAddress: 'morgan@nowhere.example', role: 'writer' })
        .catch((caught: unknown) => caught);
      expect(error).toBeInstanceOf(GoogleApiError);
      expect(isShareRefusal(error)).toBe(true);
    }
  });

  it("carries Google's reason with the error", async () => {
    const { api } = stubGoogle(() => driveError(400, 'invalidSharingRequest', 'Bad Request.'));
    await expect(
      api.createPermission('folder-1', { emailAddress: 'morgan@nowhere.example', role: 'writer' }),
    ).rejects.toMatchObject({ status: 400, reason: 'invalidSharingRequest' });
  });

  it('is never a rate limit, a server error, an expired token, or no answer at all', async () => {
    const answers = [
      driveError(
        403,
        'sharingRateLimitExceeded',
        'Rate limit exceeded. User message: "Sorry, you have exceeded your sharing quota."',
      ),
      driveError(403, 'userRateLimitExceeded', 'User rate limit exceeded.'),
      driveError(429, 'rateLimitExceeded', 'Rate limit exceeded.'),
      driveError(503, 'backendError', 'Backend Error'),
      driveError(401, 'authError', 'Invalid Credentials'),
    ];
    for (const answer of answers) {
      const { api } = stubGoogle(() => answer);
      const error: unknown = await api
        .createPermission('folder-1', { emailAddress: 'morgan.fixture@gmail.com', role: 'writer' })
        .catch((caught: unknown) => caught);
      expect(error, JSON.stringify(answer)).toBeInstanceOf(GoogleApiError);
      expect(isShareRefusal(error), JSON.stringify(answer)).toBe(false);
    }
    const unreachable = createDriveApi({
      token: async () => 'host-drive-token',
      fetch: (async () => {
        throw new TypeError('fetch failed');
      }) as typeof globalThis.fetch,
    });
    const error: unknown = await unreachable
      .createPermission('folder-1', { emailAddress: 'morgan.fixture@gmail.com', role: 'writer' })
      .catch((caught: unknown) => caught);
    expect(error).toMatchObject({ status: 0 });
    expect(isShareRefusal(error)).toBe(false);
    expect(isShareRefusal(new Error('not from Google'))).toBe(false);
  });
});
