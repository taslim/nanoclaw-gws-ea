/**
 * The home folder's store (see migration.ts): the folder's Drive id, the
 * principal's addresses its grants were last reconciled against, and the
 * host's record of each address's grant. Every timestamp is passed in as an
 * ISO string; SQL never reads the clock.
 */
import { getDb } from '../../db/connection.js';

/**
 * One principal address's grant on the folder. `granted`: it holds access
 * through that Drive permission. `removed`: it did, until the principal took
 * it away by hand. `refused`: Google would not share with it. Only a grant
 * the host made is ever revoked.
 */
export type FolderGrant =
  | {
      readonly email: string;
      readonly state: 'granted' | 'removed';
      readonly permissionId: string;
      readonly hostMade: boolean;
    }
  | {
      readonly email: string;
      readonly state: 'refused';
      /** The permission id Drive gave the address, when it gave one. */
      readonly permissionId: string | null;
      readonly hostMade: false;
    };

interface GrantRow {
  readonly email: string;
  readonly permission_id: string | null;
  readonly state: FolderGrant['state'];
  readonly host_made: number;
}

function toGrant(row: GrantRow): FolderGrant {
  if (row.state === 'refused') {
    return { email: row.email, state: 'refused', permissionId: row.permission_id, hostMade: false };
  }
  if (row.permission_id === null) throw new Error(`The home folder grant for ${row.email} has no permission`);
  return { email: row.email, state: row.state, permissionId: row.permission_id, hostMade: row.host_made === 1 };
}

/** The folder the host recorded, or null until it makes one. */
export async function getHomeFolderId(): Promise<string | null> {
  const row = await getDb().get<{ folder_id: string | null }>(
    'SELECT folder_id FROM gws_ea_workspace_folder WHERE singleton = 1',
  );
  return row?.folder_id ?? null;
}

/** Record a new folder. The grants recorded for the folder before it went with it. */
export async function recordHomeFolder(folderId: string, at: string): Promise<void> {
  const db = getDb();
  await db.transaction(async () => {
    await db.run('UPDATE gws_ea_workspace_folder SET folder_id = ?, updated_at = ? WHERE singleton = 1', folderId, at);
    await db.run('DELETE FROM gws_ea_workspace_grants');
  });
}

/**
 * Reconcile against these principal addresses. When they differ from the
 * last ones, a refused address is asked about again and a grant the
 * principal removed by hand may be made again: both waited for a change.
 */
export async function recordAddressList(addresses: readonly string[], at: string): Promise<void> {
  const list = JSON.stringify([...addresses].sort());
  const db = getDb();
  await db.transaction(async () => {
    const row = await db.get<{ address_list: string | null }>(
      'SELECT address_list FROM gws_ea_workspace_folder WHERE singleton = 1',
    );
    if (row?.address_list === list) return;
    await db.run("DELETE FROM gws_ea_workspace_grants WHERE state IN ('refused', 'removed')");
    await db.run('UPDATE gws_ea_workspace_folder SET address_list = ?, updated_at = ? WHERE singleton = 1', list, at);
  });
}

export async function listFolderGrants(): Promise<FolderGrant[]> {
  const rows = await getDb().all<GrantRow>(
    'SELECT email, permission_id, state, host_made FROM gws_ea_workspace_grants ORDER BY email',
  );
  return rows.map(toGrant);
}

export async function recordFolderGrant(grant: FolderGrant, at: string): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_workspace_grants (email, permission_id, state, host_made, recorded_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(email) DO UPDATE SET
       permission_id = excluded.permission_id,
       state = excluded.state,
       host_made = excluded.host_made,
       recorded_at = excluded.recorded_at`,
    grant.email,
    grant.permissionId,
    grant.state,
    grant.hostMade ? 1 : 0,
    at,
  );
}

export async function deleteFolderGrant(email: string): Promise<void> {
  await getDb().run('DELETE FROM gws_ea_workspace_grants WHERE email = ?', email);
}
