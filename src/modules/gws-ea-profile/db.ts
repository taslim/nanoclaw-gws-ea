import { getDb } from '../../db/connection.js';
import { hasControlCharacters } from '../../gws-ea/validation.js';
import { isValidTimezone } from '../../timezone.js';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/u;

export interface GwsEaProfile {
  readonly assistant_display_name: string | null;
  readonly assistant_workspace_email: string | null;
  readonly principal_display_name: string | null;
  readonly principal_timezone: string | null;
  readonly main_agent_group_id: string | null;
  readonly updated_at: string | null;
}

export interface ReconcileGwsEaProfileInput {
  readonly assistantDisplayName: string;
  readonly assistantWorkspaceEmail: string;
  readonly principalDisplayName: string;
  readonly principalTimezone: string;
  readonly mainAgentGroupId: string;
}

export interface VerifiedPrincipalUser {
  readonly user_id: string;
  readonly verified_at: string;
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
  };
}

export async function getGwsEaProfile(): Promise<GwsEaProfile> {
  const profile = await getDb().get<GwsEaProfile>(
    `SELECT assistant_display_name, assistant_workspace_email, principal_display_name,
            principal_timezone, main_agent_group_id, updated_at
       FROM gws_ea_profile
      WHERE singleton = 1`,
  );
  if (!profile) throw new Error('GWS-EA profile singleton is missing');
  return profile;
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
      new Date().toISOString(),
    );
  });
  return getGwsEaProfile();
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
