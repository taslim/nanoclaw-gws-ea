import { getDb } from '../../db/connection.js';
import { EMAIL_PATTERN, hasControlCharacters, normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { isValidTimezone } from '../../timezone.js';

export interface GwsEaProfile {
  readonly assistant_display_name: string | null;
  readonly assistant_workspace_email: string | null;
  readonly principal_display_name: string | null;
  readonly principal_timezone: string | null;
  readonly main_agent_group_id: string | null;
  readonly updated_at: string | null;
  /** The principal's email addresses, sorted. */
  readonly principal_emails: readonly string[];
}

export interface ReconcileGwsEaProfileInput {
  readonly assistantDisplayName: string;
  readonly assistantWorkspaceEmail: string;
  readonly principalDisplayName: string;
  readonly principalTimezone: string;
  readonly mainAgentGroupId: string;
  /**
   * The principal's addresses as create declared them; the profile then holds
   * exactly these. Absent once main is published, when the principal and the
   * operator change them one at a time.
   */
  readonly principalEmails?: readonly string[];
}

export interface VerifiedPrincipalUser {
  readonly user_id: string;
  readonly verified_at: string;
}

export interface PrincipalAddress {
  readonly email: string;
  readonly added_at: string;
}

function displayName(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized || normalized.length > 120 || hasControlCharacters(normalized)) {
    throw new Error(`${label} is invalid`);
  }
  return normalized;
}

function identifier(value: string, label: string): string {
  if (!value || value.length > 256 || /\s/u.test(value) || hasControlCharacters(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** A principal address as the profile stores it (`normalizePrincipalEmail`); anything else is refused. */
function principalEmail(value: string): string {
  const email = normalizePrincipalEmail(value);
  if (email === undefined) throw new Error(`Principal email address is invalid: ${JSON.stringify(value)}`);
  return email;
}

/** The assistant and the principal are separate people, so no address is both. */
function assertNotAssistant(email: string, assistantWorkspaceEmail: string | null): void {
  if (email === assistantWorkspaceEmail) {
    throw new Error(`${email} is the assistant's own address, not one of the principal's`);
  }
}

function principalEmails(values: readonly string[], assistantWorkspaceEmail: string): readonly string[] {
  const emails = [...new Set(values.map(principalEmail))];
  if (emails.length === 0) throw new Error('The principal needs at least one email address');
  for (const email of emails) assertNotAssistant(email, assistantWorkspaceEmail);
  return emails;
}

export function validateGwsEaProfileInput(input: ReconcileGwsEaProfileInput): ReconcileGwsEaProfileInput {
  const assistantWorkspaceEmail = input.assistantWorkspaceEmail.trim().toLowerCase();
  if (!EMAIL_PATTERN.test(assistantWorkspaceEmail) || assistantWorkspaceEmail.length > 254) {
    throw new Error('Assistant Workspace email is invalid');
  }
  if (!isValidTimezone(input.principalTimezone)) throw new Error('Principal timezone is invalid');
  return {
    assistantDisplayName: displayName(input.assistantDisplayName, 'Assistant display name'),
    assistantWorkspaceEmail,
    principalDisplayName: displayName(input.principalDisplayName, 'Principal display name'),
    principalTimezone: input.principalTimezone,
    mainAgentGroupId: identifier(input.mainAgentGroupId, 'Main agent group ID'),
    ...(input.principalEmails === undefined
      ? {}
      : { principalEmails: principalEmails(input.principalEmails, assistantWorkspaceEmail) }),
  };
}

export async function listPrincipalAddresses(): Promise<PrincipalAddress[]> {
  return getDb().all<PrincipalAddress>('SELECT email, added_at FROM gws_ea_principal_addresses ORDER BY email');
}

/** The canonical main's agent group, or null until setup names one. */
export async function getMainAgentGroupId(): Promise<string | null> {
  const row = await getDb().get<{ main_agent_group_id: string | null }>(
    'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  return row?.main_agent_group_id ?? null;
}

export async function getGwsEaProfile(): Promise<GwsEaProfile> {
  const profile = await getDb().get<Omit<GwsEaProfile, 'principal_emails'>>(
    `SELECT assistant_display_name, assistant_workspace_email, principal_display_name,
            principal_timezone, main_agent_group_id, updated_at
       FROM gws_ea_profile
      WHERE singleton = 1`,
  );
  if (!profile) throw new Error('GWS-EA profile singleton is missing');
  return { ...profile, principal_emails: (await listPrincipalAddresses()).map((address) => address.email) };
}

/** Make the profile hold exactly `emails`, keeping when each one it already held was added. */
async function replacePrincipalAddresses(emails: readonly string[], addedAt: string): Promise<void> {
  const db = getDb();
  const wanted = new Set(emails);
  for (const { email } of await listPrincipalAddresses()) {
    if (!wanted.has(email)) await db.run('DELETE FROM gws_ea_principal_addresses WHERE email = ?', email);
  }
  for (const email of emails) {
    await db.run(
      'INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING',
      email,
      addedAt,
    );
  }
}

export async function reconcileGwsEaProfile(input: ReconcileGwsEaProfileInput): Promise<GwsEaProfile> {
  const validated = validateGwsEaProfileInput(input);
  const db = getDb();
  await db.transaction(async () => {
    const profile = await db.get<{ main_agent_group_id: string | null }>(
      'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
    );
    const group = await db.get<{ id: string }>('SELECT id FROM agent_groups WHERE id = ?', validated.mainAgentGroupId);
    if (!profile) throw new Error('GWS-EA profile singleton is missing');
    if (!group) throw new Error(`Canonical main agent group does not exist: ${validated.mainAgentGroupId}`);
    if (profile.main_agent_group_id !== null && profile.main_agent_group_id !== validated.mainAgentGroupId) {
      throw new Error(`Canonical main is already bound to ${profile.main_agent_group_id}`);
    }
    const now = new Date().toISOString();
    await db.run(
      `UPDATE gws_ea_profile
          SET assistant_display_name = ?,
              assistant_workspace_email = ?,
              principal_display_name = ?,
              principal_timezone = ?,
              main_agent_group_id = ?,
              updated_at = ?
        WHERE singleton = 1`,
      validated.assistantDisplayName,
      validated.assistantWorkspaceEmail,
      validated.principalDisplayName,
      validated.principalTimezone,
      validated.mainAgentGroupId,
      now,
    );
    if (validated.principalEmails) await replacePrincipalAddresses(validated.principalEmails, now);
  });
  return getGwsEaProfile();
}

async function assistantWorkspaceEmail(): Promise<string | null> {
  const profile = await getDb().get<{ assistant_workspace_email: string | null }>(
    'SELECT assistant_workspace_email FROM gws_ea_profile WHERE singleton = 1',
  );
  return profile?.assistant_workspace_email ?? null;
}

/** Add one of the principal's addresses; adding one the profile already holds changes nothing. */
export async function addPrincipalAddress(value: string): Promise<{ readonly email: string; readonly added: boolean }> {
  const email = principalEmail(value);
  const db = getDb();
  return db.transaction(async () => {
    assertNotAssistant(email, await assistantWorkspaceEmail());
    const result = await db.run(
      'INSERT INTO gws_ea_principal_addresses (email, added_at) VALUES (?, ?) ON CONFLICT(email) DO NOTHING',
      email,
      new Date().toISOString(),
    );
    return { email, added: result.changes > 0 };
  });
}

/** Remove one of the principal's addresses. The principal always keeps at least one. */
export async function removePrincipalAddress(
  value: string,
): Promise<{ readonly email: string; readonly removed: true }> {
  const email = principalEmail(value);
  const db = getDb();
  return db.transaction(async () => {
    const held = (await listPrincipalAddresses()).map((address) => address.email);
    if (!held.includes(email)) throw new Error(`${email} is not one of the principal's addresses`);
    if (held.length === 1) {
      throw new Error(`${email} is the principal's last address; add another before removing it`);
    }
    await db.run('DELETE FROM gws_ea_principal_addresses WHERE email = ?', email);
    return { email, removed: true };
  });
}

export async function bindVerifiedPrincipalUser(userId: string, verifiedAt: string): Promise<void> {
  identifier(userId, 'Principal user ID');
  const parsed = new Date(verifiedAt);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== verifiedAt) {
    throw new Error('Principal verification timestamp is invalid');
  }
  await getDb().run(
    `INSERT INTO gws_ea_principal_users (user_id, verified_at)
     VALUES (?, ?)
     ON CONFLICT(user_id) DO UPDATE SET verified_at = excluded.verified_at`,
    userId,
    verifiedAt,
  );
}

export async function listVerifiedPrincipalUsers(): Promise<VerifiedPrincipalUser[]> {
  return getDb().all<VerifiedPrincipalUser>(
    'SELECT user_id, verified_at FROM gws_ea_principal_users ORDER BY verified_at, user_id',
  );
}

export async function isVerifiedPrincipalUser(userId: string): Promise<boolean> {
  return (
    (await getDb().get<{ present: number }>(
      'SELECT 1 AS present FROM gws_ea_principal_users WHERE user_id = ? LIMIT 1',
      userId,
    )) !== undefined
  );
}
