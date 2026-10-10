/**
 * An in-memory Google Drive, as the assistant's host token sees it, for the
 * workspace tests. It keeps what Drive keeps:
 *
 * - a file's id is never issued twice; a trashed file keeps its id and its
 *   access until it is restored, and one deleted for good is not found;
 * - a person has one permission id on every file, whichever of their
 *   addresses a share named, and the access list shows their account's own
 *   address; an address with no Google account has a permission id but
 *   cannot be shared with unless Drive may email them, which the host never
 *   asks it to;
 * - a file lists the access it inherits from the folders above it, merged
 *   with its own, and inherited access cannot be removed from the file.
 *
 * Every call is recorded, reads included. A test makes the changes people
 * make in Drive itself (`trash`, `deleteForever`, `share`, `removeAccess`)
 * and makes a call fail once (`failNext`).
 */
import { GoogleApiError } from '../../gws-ea-inbox/gmail-api.js';
import type {
  DriveAccessProposal,
  DriveApi,
  DriveFile,
  DrivePermission,
  DrivePermissionDetail,
  ShareRole,
} from '../drive-api.js';

export type DriveOp = keyof DriveApi;

export interface DriveCall {
  readonly op: DriveOp;
  readonly fileId?: string;
  readonly input?: unknown;
}

const WRITES: ReadonlySet<DriveOp> = new Set(['createFile', 'updateFile', 'createPermission', 'deletePermission']);

/** Roles from least to most access, as Drive ranks them. */
const ROLE_RANK = ['reader', 'commenter', 'writer', 'fileOrganizer', 'organizer', 'owner'];

interface StoredFile {
  readonly id: string;
  name: string;
  readonly mimeType: string;
  readonly parents: readonly string[];
  trashed: boolean;
  deleted: boolean;
  /** The access granted on the file itself. */
  readonly permissions: DrivePermission[];
  readonly proposals: DriveAccessProposal[];
}

interface Account {
  readonly permissionId: string;
  /** The account's own address, which the access list shows. */
  readonly email: string;
}

function higher(a: string, b: string): string {
  return ROLE_RANK.indexOf(a) >= ROLE_RANK.indexOf(b) ? a : b;
}

export class FakeDrive implements DriveApi {
  readonly calls: DriveCall[] = [];
  private readonly files = new Map<string, StoredFile>();
  private readonly accounts = new Map<string, Account>();
  private readonly failures: { readonly op: DriveOp; readonly error: Error }[] = [];
  private nextFile = 1;
  private nextAccount = 1;

  /** `owner` is the assistant: the account every file it creates belongs to. */
  constructor(readonly owner: string) {
    this.addAccount(owner);
  }

  /** A Google account, reached at its own address and at each alias; returns its permission id. */
  addAccount(email: string, ...aliases: readonly string[]): string {
    const account = { permissionId: `0${String(800 + this.nextAccount++)}`, email: email.toLowerCase() };
    for (const address of [email, ...aliases]) this.accounts.set(address.toLowerCase(), account);
    return account.permissionId;
  }

  /** The calls that change something in Drive. */
  get writes(): DriveCall[] {
    return this.calls.filter((call) => WRITES.has(call.op));
  }

  /** The next call of `op` fails with `error`, before Drive applies anything. */
  failNext(op: DriveOp, error: Error): void {
    this.failures.push({ op, error });
  }

  /** The file as Drive holds it, deleted or not. */
  file(fileId: string): Readonly<StoredFile> | undefined {
    return this.files.get(fileId);
  }

  /** Someone moves the file to the trash. */
  trash(fileId: string): void {
    this.live(fileId).trashed = true;
  }

  /** Someone empties the trash: the file is gone for good. */
  deleteForever(fileId: string): void {
    this.live(fileId).deleted = true;
  }

  /** Someone shares the file by hand: a person, a group, a domain or anyone with the link. */
  share(fileId: string, permission: DrivePermission): void {
    this.live(fileId).permissions.push(permission);
  }

  /** Someone takes a person's access away by hand. */
  removeAccess(fileId: string, permissionId: string): void {
    const permissions = this.live(fileId).permissions;
    const index = permissions.findIndex((permission) => permission.id === permissionId);
    if (index < 0) throw new Error(`${permissionId} has no access to ${fileId} of its own`);
    permissions.splice(index, 1);
  }

  /** Someone asks for access to the file. */
  addProposal(fileId: string, proposal: DriveAccessProposal): void {
    this.live(fileId).proposals.push(proposal);
  }

  // -------------------------------------------------------------------------
  // DriveApi
  // -------------------------------------------------------------------------

  async getFile(fileId: string): Promise<DriveFile | undefined> {
    this.begin('getFile', fileId);
    const file = this.files.get(fileId);
    return file === undefined || file.deleted ? undefined : this.view(file);
  }

  async createFile(input: {
    readonly name: string;
    readonly mimeType: string;
    readonly parents?: readonly string[];
  }): Promise<DriveFile> {
    this.begin('createFile', undefined, input);
    for (const parent of input.parents ?? []) this.live(parent);
    const owner = this.account(this.owner);
    const file: StoredFile = {
      id: `file-${String(this.nextFile++)}`,
      name: input.name,
      mimeType: input.mimeType,
      parents: [...(input.parents ?? [])],
      trashed: false,
      deleted: false,
      permissions: [{ id: owner.permissionId, type: 'user', role: 'owner', emailAddress: owner.email }],
      proposals: [],
    };
    this.files.set(file.id, file);
    return this.view(file);
  }

  async updateFile(
    fileId: string,
    changes: { readonly name?: string; readonly trashed?: boolean },
  ): Promise<DriveFile> {
    this.begin('updateFile', fileId, changes);
    const file = this.live(fileId);
    if (changes.name !== undefined) file.name = changes.name;
    if (changes.trashed !== undefined) file.trashed = changes.trashed;
    return this.view(file);
  }

  async listPermissions(fileId: string): Promise<DrivePermission[]> {
    this.begin('listPermissions', fileId);
    const merged = new Map<string, DrivePermission>();
    const add = (permission: DrivePermission, detail: DrivePermissionDetail) => {
      const held = merged.get(permission.id);
      merged.set(permission.id, {
        ...(held ?? permission),
        role: held === undefined ? permission.role : higher(held.role, permission.role),
        permissionDetails: [...(held?.permissionDetails ?? []), detail],
      });
    };
    const file = this.live(fileId);
    for (const permission of file.permissions) {
      add(permission, { permissionType: 'file', role: permission.role, inherited: false });
    }
    for (const ancestor of this.ancestors(file)) {
      for (const permission of ancestor.permissions) {
        add(permission, { permissionType: 'file', role: permission.role, inherited: true, inheritedFrom: ancestor.id });
      }
    }
    return [...merged.values()];
  }

  async createPermission(
    fileId: string,
    input: { readonly emailAddress: string; readonly role: ShareRole },
  ): Promise<DrivePermission> {
    this.begin('createPermission', fileId, input);
    const file = this.live(fileId);
    const account = this.accounts.get(input.emailAddress.toLowerCase());
    if (account === undefined) {
      throw new GoogleApiError(
        400,
        `Google refused /drive/v3/files/${fileId}/permissions: Bad Request. User message: "You are trying to invite ${input.emailAddress}. Since there is no Google account associated with this email address, you must check the 'Notify people' box to invite this recipient."`,
        { reason: 'invalidSharingRequest' },
      );
    }
    const index = file.permissions.findIndex((permission) => permission.id === account.permissionId);
    const held = file.permissions[index];
    if (held !== undefined) {
      // Sharing again with someone who has access raises their role, never lowers it.
      const raised = { ...held, role: higher(held.role, input.role) };
      file.permissions[index] = raised;
      return raised;
    }
    const permission: DrivePermission = {
      id: account.permissionId,
      type: 'user',
      role: input.role,
      emailAddress: account.email,
    };
    file.permissions.push(permission);
    return permission;
  }

  async deletePermission(fileId: string, permissionId: string): Promise<boolean> {
    this.begin('deletePermission', fileId, { permissionId });
    const file = this.live(fileId);
    const index = file.permissions.findIndex((permission) => permission.id === permissionId);
    if (index >= 0) {
      file.permissions.splice(index, 1);
      return true;
    }
    if (this.ancestors(file).some((ancestor) => ancestor.permissions.some((p) => p.id === permissionId))) {
      throw new GoogleApiError(403, 'Google refused the deletion: the permission is inherited', {
        reason: 'cannotDeletePermission',
      });
    }
    return false;
  }

  async permissionId(emailAddress: string): Promise<string | undefined> {
    this.begin('permissionId', undefined, { emailAddress });
    // Drive gives an address with no Google account an id of its own, ending in `k`.
    return this.accounts.get(emailAddress.toLowerCase())?.permissionId ?? `${emailAddress.toLowerCase()}k`;
  }

  async listAccessProposals(fileId: string): Promise<DriveAccessProposal[]> {
    this.begin('listAccessProposals', fileId);
    return [...this.live(fileId).proposals];
  }

  // -------------------------------------------------------------------------

  private begin(op: DriveOp, fileId?: string, input?: unknown): void {
    this.calls.push({ op, ...(fileId === undefined ? {} : { fileId }), ...(input === undefined ? {} : { input }) });
    const index = this.failures.findIndex((failure) => failure.op === op);
    if (index < 0) return;
    const [failure] = this.failures.splice(index, 1);
    throw failure.error;
  }

  private live(fileId: string): StoredFile {
    const file = this.files.get(fileId);
    if (file === undefined || file.deleted) {
      throw new GoogleApiError(404, `Google refused /drive/v3/files/${fileId}: File not found: ${fileId}.`, {
        reason: 'notFound',
      });
    }
    return file;
  }

  private account(email: string): Account {
    const account = this.accounts.get(email.toLowerCase());
    if (account === undefined) throw new Error(`${email} has no Google account`);
    return account;
  }

  private ancestors(file: StoredFile): StoredFile[] {
    const found: StoredFile[] = [];
    const pending = [...file.parents];
    while (pending.length > 0) {
      const parent = this.files.get(pending.shift() ?? '');
      if (parent === undefined || parent.deleted || found.includes(parent)) continue;
      found.push(parent);
      pending.push(...parent.parents);
    }
    return found;
  }

  private view(file: StoredFile): DriveFile {
    return { id: file.id, name: file.name, mimeType: file.mimeType, trashed: file.trashed, parents: [...file.parents] };
  }
}
