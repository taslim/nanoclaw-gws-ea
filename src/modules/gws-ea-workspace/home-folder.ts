/**
 * The home folder (R2, R3, KTD3): one folder in the assistant's Drive where
 * `main` keeps what it makes for the principal, shared with every one of the
 * principal's addresses, so a file made there opens from any of their
 * accounts without a request for access (AE1).
 *
 * The host keeps it on a timer, never at start. Each tick heals what changed
 * and leaves alone what people chose:
 *
 * - the folder exists: a trashed one is restored, and one deleted for good is
 *   made anew, its id recorded, and `main` told where it is;
 * - each principal address holds writer access, shared without Google
 *   emailing anyone, and matched by Drive permission id, so an alias or a
 *   dotted Gmail spelling of an account already shared is never shared again;
 * - an address Google refuses, such as one with no Google account, and a
 *   grant the principal removed by hand both wait until the principal's
 *   addresses change;
 * - an address no longer the principal's loses the host's grant, and only a
 *   grant the host made is ever revoked. Addresses come only from the
 *   profile, and every share names one person, so no group is ever granted.
 *
 * Until the sign-in holds Drive the tick stays quiet, logging once per
 * sign-in, as revocation does. Any other failure is logged, and the next
 * tick tries again from what the last one recorded.
 */
import { grantedScopes, HOST_GOOGLE_SERVICES, type GoogleGrant } from '../gws-ea-google/grant.js';
import { GoogleGrantRevokedError, GoogleScopeNotGrantedError } from '../gws-ea-google/tokens.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import type { NoteForMain, NoteForMainResult } from '../gws-ea-profile/main-note.js';
import {
  deleteFolderGrant,
  getHomeFolderId,
  listFolderGrants,
  recordAddressList,
  recordFolderGrant,
  recordHomeFolder,
  type FolderGrant,
} from './db.js';
import { FOLDER_MIME_TYPE, isShareRefusal, type DriveApi, type DrivePermission } from './drive-api.js';

export interface HomeFolderLog {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
}

export interface HomeFolderOptions {
  /** Drive, as the host's own Drive token reaches it. */
  readonly drive: DriveApi;
  /** The assistant's Google sign-in, or undefined before it signs in. */
  readonly readGrant: () => Promise<GoogleGrant | undefined>;
  /** How `main` hears where a new folder is (`writeNoteForMain`). */
  readonly writeNote: (note: NoteForMain) => Promise<NoteForMainResult>;
  readonly log: HomeFolderLog;
  readonly now?: () => Date;
}

export interface HomeFolder {
  /** The folder's id as last recorded, for what reads it synchronously at each spawn. */
  folderId(): string | undefined;
  /** Read the recorded folder from the database, as the host starts. */
  load(): Promise<void>;
  /** Reconcile once. Never throws: a failure is logged, and the next tick tries again. */
  tick(): Promise<void>;
}

const DRIVE_SCOPES = HOST_GOOGLE_SERVICES['drive-host'].scopes;

/** A sign-in, as the refresher identifies one: a new sign-in is a new identity. */
function grantIdentity(grant: GoogleGrant): string {
  return `${grant.account}\0${grant.granted_at}`;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Named for the principal and the assistant, as both see it in Drive. */
function homeFolderName(principal: string, assistant: string): string {
  return `${principal} · ${assistant}`;
}

function noteText(folderId: string, replacing: boolean): string {
  return replacing
    ? `Your home folder in Google Drive was deleted for good, so there is a new one, with the id \`${folderId}\`. Make what you create for the principal there from now on, not in the old folder.`
    : `Your home folder in Google Drive is ready, with the id \`${folderId}\`. Make what you create for the principal there: every one of their addresses can open it.`;
}

export function createHomeFolder(options: HomeFolderOptions): HomeFolder {
  const { drive, log } = options;
  const now = options.now ?? (() => new Date());
  let current: string | undefined;
  let quietFor: string | undefined;

  /** Say once per sign-in why the folder waits. */
  function waitFor(grant: GoogleGrant, reason: string): void {
    const identity = grantIdentity(grant);
    if (quietFor === identity) return;
    quietFor = identity;
    log.info(reason, { account: grant.account });
  }

  async function ensureFolder(name: string, at: string): Promise<string> {
    const recorded = await getHomeFolderId();
    if (recorded !== null) {
      const folder = await drive.getFile(recorded);
      if (folder !== undefined) {
        if (folder.trashed === true) {
          await drive.updateFile(recorded, { trashed: false });
          log.info('Restored the home folder from the trash', { folderId: recorded });
        }
        current = recorded;
        return recorded;
      }
      log.warn('The home folder was deleted for good; making a new one', { folderId: recorded });
    }
    const made = await drive.createFile({ name, mimeType: FOLDER_MIME_TYPE });
    await recordHomeFolder(made.id, at);
    current = made.id;
    log.info('Made the home folder', { folderId: made.id });
    // A running session learns of it now; the next spawn carries it in its environment.
    const told = await options.writeNote({
      id: `gws-ea-workspace-home-folder-${made.id}`,
      timestamp: at,
      text: noteText(made.id, recorded !== null),
      wake: false,
    });
    if (told === 'no-main' || told === 'no-principal') {
      log.info('Nobody to tell where the home folder is yet; main learns it when it next starts', { result: told });
    }
    return made.id;
  }

  async function shareWithPrincipal(folderId: string, addresses: readonly string[], at: string): Promise<void> {
    await recordAddressList(addresses, at);
    const grants = new Map((await listFolderGrants()).map((grant) => [grant.email, grant]));
    const access = new Map(
      (await drive.listPermissions(folderId))
        .filter((permission) => permission.deleted !== true)
        .map((permission) => [permission.id, permission]),
    );
    const record = async (grant: FolderGrant): Promise<void> => {
      await recordFolderGrant(grant, at);
      grants.set(grant.email, grant);
    };
    // Aliases of one account share its permission: whether the host made it is the account's, not the address's.
    const madeByHost = (permissionId: string): boolean =>
      [...grants.values()].some(
        (grant) => grant.state === 'granted' && grant.permissionId === permissionId && grant.hostMade,
      );

    for (const email of addresses) {
      const grant = grants.get(email);
      if (grant !== undefined) {
        if (grant.state !== 'granted' || access.has(grant.permissionId)) continue;
        await record({ ...grant, state: 'removed' });
        log.info('A principal address lost the home folder by hand; it stays off until their addresses change', {
          email,
        });
        continue;
      }
      const permissionId = await drive.permissionId(email);
      const held =
        (permissionId === undefined ? undefined : access.get(permissionId)) ??
        [...access.values()].find((permission) => permission.emailAddress?.toLowerCase() === email);
      if (held !== undefined) {
        await record({ email, state: 'granted', permissionId: held.id, hostMade: madeByHost(held.id) });
        continue;
      }
      let made: DrivePermission;
      try {
        made = await drive.createPermission(folderId, { emailAddress: email, role: 'writer' });
      } catch (error) {
        if (!isShareRefusal(error)) throw error;
        await record({ email, state: 'refused', permissionId: permissionId ?? null, hostMade: false });
        log.warn(
          "Google refused to share the home folder with one of the principal's addresses; it is asked again when their addresses change",
          { email, reason: message(error) },
        );
        continue;
      }
      // Drive answers a share for an account that already had access with that access.
      const hostMade = !access.has(made.id) || madeByHost(made.id);
      access.set(made.id, made);
      await record({ email, state: 'granted', permissionId: made.id, hostMade });
      log.info("Shared the home folder with one of the principal's addresses", { email });
    }

    const wanted = new Set(addresses);
    const stillWanted = (permissionId: string): boolean =>
      [...grants.values()].some(
        (grant) => wanted.has(grant.email) && grant.state === 'granted' && grant.permissionId === permissionId,
      );
    for (const grant of grants.values()) {
      if (wanted.has(grant.email)) continue;
      if (
        grant.state === 'granted' &&
        grant.hostMade &&
        access.has(grant.permissionId) &&
        !stillWanted(grant.permissionId)
      ) {
        await drive.deletePermission(folderId, grant.permissionId);
        log.info("Took the home folder from an address that is no longer the principal's", { email: grant.email });
      }
      await deleteFolderGrant(grant.email);
    }
  }

  async function reconcile(): Promise<void> {
    const profile = await getGwsEaProfile();
    if (profile.principal_display_name === null || profile.assistant_display_name === null) return;
    const at = now().toISOString();
    const name = homeFolderName(profile.principal_display_name, profile.assistant_display_name);
    const folderId = await ensureFolder(name, at);
    await shareWithPrincipal(folderId, profile.principal_emails, at);
  }

  return {
    folderId: () => current,

    async load() {
      current = (await getHomeFolderId()) ?? undefined;
    },

    async tick() {
      let grant: GoogleGrant | undefined;
      /* eslint-disable no-catch-all/no-catch-all -- a background loop: every failure is logged and the next tick tries again */
      try {
        grant = await options.readGrant();
        if (grant === undefined) return;
        if (grantedScopes(DRIVE_SCOPES, grant.scopes).length === 0) {
          waitFor(grant, "The home folder waits until the assistant's Google sign-in includes Drive");
          return;
        }
        await reconcile();
      } catch (error) {
        if (grant !== undefined && error instanceof GoogleScopeNotGrantedError) {
          waitFor(grant, "The home folder waits until the assistant's Google sign-in includes Drive");
          return;
        }
        if (grant !== undefined && error instanceof GoogleGrantRevokedError) {
          waitFor(grant, "The home folder waits for a new Google sign-in: Google no longer accepts the assistant's");
          return;
        }
        log.warn('Could not keep the home folder; the next tick tries again', { error: message(error) });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    },
  };
}
