/**
 * The Drive calls the host makes with its own Drive token (KTD1, KTD3): a
 * file and its access list, the permission id Drive gives an address, and a
 * file's pending access requests. No client library: each call is one
 * `fetch` with the token in its header, so the token never reaches a
 * container or an argument list. A share names one person, never a group,
 * and never asks Google to email them.
 *
 * A leaf (KTD4): it imports only the shared Google helper, so the link
 * check and the inbox's notices can use it without loading a module's entry
 * point. Tests use a fake with the same interface (`testing/fake-drive.ts`).
 */
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';

export const FOLDER_MIME_TYPE = 'application/vnd.google-apps.folder';

/** A file as the host reads it. */
export interface DriveFile {
  readonly id: string;
  readonly name?: string;
  readonly mimeType?: string;
  /** In the trash, from where it can be restored. A file deleted for good is not found at all. */
  readonly trashed?: boolean;
  readonly parents?: readonly string[];
}

/** Where one person's access to a file comes from: the file itself, or a folder above it. */
export interface DrivePermissionDetail {
  readonly permissionType?: string;
  readonly role?: string;
  readonly inherited?: boolean;
  /** The folder the access is inherited from. */
  readonly inheritedFrom?: string;
}

/** One entry on a file's access list. */
export interface DrivePermission {
  /** For a person, the same id on every file: the id `permissionId` gives their address. */
  readonly id: string;
  /** `user`, `group`, `domain` or `anyone`. */
  readonly type: string;
  /** `owner`, `organizer`, `fileOrganizer`, `writer`, `commenter` or `reader`. */
  readonly role: string;
  /** The account's own address, which may differ from the address a share named. */
  readonly emailAddress?: string;
  readonly domain?: string;
  readonly deleted?: boolean;
  readonly expirationTime?: string;
  readonly view?: string;
  readonly permissionDetails?: readonly DrivePermissionDetail[];
}

/** The access a host share gives. */
export type ShareRole = 'reader' | 'commenter' | 'writer';

/** Someone's request for access to a file, waiting for an approver. */
export interface DriveAccessProposal {
  readonly proposalId: string;
  readonly fileId?: string;
  readonly requesterEmailAddress?: string;
  readonly recipientEmailAddress?: string;
  /** The requester's own words: someone else's text. */
  readonly requestMessage?: string;
  readonly createTime?: string;
  readonly rolesAndViews: readonly { readonly role?: string; readonly view?: string }[];
}

export interface DriveApi {
  /** Undefined when the file no longer exists, or the assistant cannot see it. A trashed file still exists. */
  getFile(fileId: string): Promise<DriveFile | undefined>;
  createFile(input: {
    readonly name: string;
    readonly mimeType: string;
    readonly parents?: readonly string[];
  }): Promise<DriveFile>;
  /** Rename a file, or move it to the trash and back. */
  updateFile(fileId: string, changes: { readonly name?: string; readonly trashed?: boolean }): Promise<DriveFile>;
  /** Everyone with access to a file, access inherited from a folder above it included. */
  listPermissions(fileId: string): Promise<DrivePermission[]>;
  /**
   * Share a file with one person, without Google emailing them. When Google
   * will not share with that address, the error is a share refusal
   * (`isShareRefusal`).
   */
  createPermission(
    fileId: string,
    input: { readonly emailAddress: string; readonly role: ShareRole },
  ): Promise<DrivePermission>;
  /** False when the permission was already gone. */
  deletePermission(fileId: string, permissionId: string): Promise<boolean>;
  /** The permission id Drive gives an address's account (Drive v2), so an alias matches its account's grant. */
  permissionId(emailAddress: string): Promise<string | undefined>;
  /** A file's pending requests for access; only someone who can share the file sees them. */
  listAccessProposals(fileId: string): Promise<DriveAccessProposal[]>;
}

/** Drive's 403 reasons that only ask the caller to slow down. */
const RATE_LIMITS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'sharingRateLimitExceeded',
  'dailyLimitExceeded',
]);

/**
 * Whether a failed share is Google's final answer for that address: a 400,
 * such as `invalidSharingRequest` for an address with no Google account, or
 * a 403 that is not a rate limit, such as the organization's sharing policy.
 * Asking again changes nothing until the address does. A rate limit, a
 * server error, an expired token or no answer at all is worth asking again.
 */
export function isShareRefusal(error: unknown): boolean {
  if (!(error instanceof GoogleApiError)) return false;
  return error.status === 400 || (error.status === 403 && !RATE_LIMITS.has(error.reason ?? ''));
}

// ---------------------------------------------------------------------------
// Response shapes: fields read are checked; anything else is ignored.
// ---------------------------------------------------------------------------

function unreadable(what: string): GoogleApiError {
  return new GoogleApiError(502, `Google Drive returned an unreadable ${what}`);
}

function textField<K extends string>(record: Record<string, unknown>, key: K): { readonly [P in K]?: string } {
  const value = record[key];
  return (typeof value === 'string' ? { [key]: value } : {}) as { readonly [P in K]?: string };
}

function booleanField<K extends string>(record: Record<string, unknown>, key: K): { readonly [P in K]?: boolean } {
  const value = record[key];
  return (typeof value === 'boolean' ? { [key]: value } : {}) as { readonly [P in K]?: boolean };
}

function toFile(value: unknown): DriveFile {
  if (!isRecord(value) || typeof value.id !== 'string') throw unreadable('file');
  const parents = Array.isArray(value.parents)
    ? value.parents.filter((parent): parent is string => typeof parent === 'string')
    : undefined;
  return {
    id: value.id,
    ...textField(value, 'name'),
    ...textField(value, 'mimeType'),
    ...booleanField(value, 'trashed'),
    ...(parents === undefined ? {} : { parents }),
  };
}

function toDetail(value: unknown): DrivePermissionDetail[] {
  if (!isRecord(value)) return [];
  return [
    {
      ...textField(value, 'permissionType'),
      ...textField(value, 'role'),
      ...booleanField(value, 'inherited'),
      ...textField(value, 'inheritedFrom'),
    },
  ];
}

/** An access-list entry, or undefined for one without the id, type and role every entry has. */
function toPermission(value: unknown): DrivePermission | undefined {
  if (
    !isRecord(value) ||
    typeof value.id !== 'string' ||
    typeof value.type !== 'string' ||
    typeof value.role !== 'string'
  ) {
    return undefined;
  }
  return {
    id: value.id,
    type: value.type,
    role: value.role,
    ...textField(value, 'emailAddress'),
    ...textField(value, 'domain'),
    ...booleanField(value, 'deleted'),
    ...textField(value, 'expirationTime'),
    ...textField(value, 'view'),
    ...(Array.isArray(value.permissionDetails) ? { permissionDetails: value.permissionDetails.flatMap(toDetail) } : {}),
  };
}

function toProposal(value: unknown): DriveAccessProposal[] {
  if (!isRecord(value) || typeof value.proposalId !== 'string') return [];
  const rolesAndViews = Array.isArray(value.rolesAndViews)
    ? value.rolesAndViews.flatMap((entry) =>
        isRecord(entry) ? [{ ...textField(entry, 'role'), ...textField(entry, 'view') }] : [],
      )
    : [];
  return [
    {
      proposalId: value.proposalId,
      ...textField(value, 'fileId'),
      ...textField(value, 'requesterEmailAddress'),
      ...textField(value, 'recipientEmailAddress'),
      ...textField(value, 'requestMessage'),
      ...textField(value, 'createTime'),
      rolesAndViews,
    },
  ];
}

// ---------------------------------------------------------------------------
// The client
// ---------------------------------------------------------------------------

const DRIVE = 'https://www.googleapis.com/drive/v3';
const DRIVE_V2 = 'https://www.googleapis.com/drive/v2';
const FILE_FIELDS = 'id,name,mimeType,trashed,parents';
const PERMISSION_FIELDS =
  'id,type,role,emailAddress,domain,deleted,expirationTime,view,permissionDetails(permissionType,role,inherited,inheritedFrom)';
/** Pages read before a list is refused as too long: an access list and its requests are short. */
const MAX_PAGES = 20;

function fileUrl(fileId: string, path = '', params: Record<string, string> = {}): string {
  const search = new URLSearchParams({ supportsAllDrives: 'true', ...params });
  return `${DRIVE}/files/${encodeURIComponent(fileId)}${path}?${search.toString()}`;
}

/** Every page of a listing, each item read by `read`; `key` names the page's array. */
async function listPages<T>(
  options: GoogleClientOptions,
  url: (pageToken: string | undefined) => string,
  key: string,
  read: (value: unknown) => T[],
  what: string,
): Promise<T[]> {
  const items: T[] = [];
  let pageToken: string | undefined;
  for (let page = 0; page < MAX_PAGES; page += 1) {
    const payload = await googleJson(options, url(pageToken));
    if (!isRecord(payload)) throw unreadable(what);
    const entries = payload[key];
    if (Array.isArray(entries)) items.push(...entries.flatMap(read));
    pageToken = typeof payload.nextPageToken === 'string' ? payload.nextPageToken : undefined;
    if (pageToken === undefined) return items;
  }
  throw new GoogleApiError(502, `Google Drive returned a ${what} too long to read`);
}

/** The real client, over Drive's REST API. */
export function createDriveApi(options: GoogleClientOptions): DriveApi {
  return {
    async getFile(fileId) {
      const payload = await googleJson(options, fileUrl(fileId, '', { fields: FILE_FIELDS }), { allowNotFound: true });
      return payload === undefined ? undefined : toFile(payload);
    },

    async createFile(input) {
      const search = new URLSearchParams({ supportsAllDrives: 'true', fields: FILE_FIELDS });
      const payload = await googleJson(options, `${DRIVE}/files?${search.toString()}`, {
        method: 'POST',
        body: {
          name: input.name,
          mimeType: input.mimeType,
          ...(input.parents === undefined ? {} : { parents: [...input.parents] }),
        },
      });
      return toFile(payload);
    },

    async updateFile(fileId, changes) {
      const payload = await googleJson(options, fileUrl(fileId, '', { fields: FILE_FIELDS }), {
        method: 'PATCH',
        body: {
          ...(changes.name === undefined ? {} : { name: changes.name }),
          ...(changes.trashed === undefined ? {} : { trashed: changes.trashed }),
        },
      });
      return toFile(payload);
    },

    async listPermissions(fileId) {
      return listPages(
        options,
        (pageToken) =>
          fileUrl(fileId, '/permissions', {
            fields: `nextPageToken,permissions(${PERMISSION_FIELDS})`,
            pageSize: '100',
            ...(pageToken === undefined ? {} : { pageToken }),
          }),
        'permissions',
        (value) => {
          const permission = toPermission(value);
          return permission === undefined ? [] : [permission];
        },
        'access list',
      );
    },

    async createPermission(fileId, input) {
      const payload = await googleJson(
        options,
        fileUrl(fileId, '/permissions', { sendNotificationEmail: 'false', fields: PERMISSION_FIELDS }),
        { method: 'POST', body: { type: 'user', role: input.role, emailAddress: input.emailAddress } },
      );
      const permission = toPermission(payload);
      if (permission === undefined) throw unreadable('permission');
      return permission;
    },

    async deletePermission(fileId, permissionId) {
      // Drive answers a deletion with an empty 204, so a 404 is told apart by its status.
      try {
        await googleJson(options, fileUrl(fileId, `/permissions/${encodeURIComponent(permissionId)}`), {
          method: 'DELETE',
        });
        return true;
      } catch (error) {
        if (error instanceof GoogleApiError && error.status === 404) return false;
        throw error;
      }
    },

    async permissionId(emailAddress) {
      const payload = await googleJson(options, `${DRIVE_V2}/permissionIds/${encodeURIComponent(emailAddress)}`, {
        allowNotFound: true,
      });
      if (payload === undefined) return undefined;
      if (!isRecord(payload) || typeof payload.id !== 'string') throw unreadable('permission id');
      return payload.id;
    },

    async listAccessProposals(fileId) {
      return listPages(
        options,
        (pageToken) =>
          fileUrl(fileId, '/accessproposals', {
            pageSize: '100',
            ...(pageToken === undefined ? {} : { pageToken }),
          }),
        'accessProposals',
        toProposal,
        'list of access requests',
      );
    },
  };
}
