import { getDb } from '../../db/connection.js';
import { getMessagingGroup } from '../../db/messaging-groups.js';
import { registerWiringAdmissionPolicy } from '../../db/wiring-admission.js';

registerWiringAdmissionPolicy('gws-ea-profile:canonical-main', async ({ proposed }) => {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_profile'))) return;
  const profile = await db.get<{ main_agent_group_id: string | null }>(
    'SELECT main_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
  );
  if (profile?.main_agent_group_id === null || proposed.agent_group_id !== profile?.main_agent_group_id) return;

  const reject = (reason: string): never => {
    throw new Error(`Canonical main wiring rejected: ${reason}`);
  };
  const mg = await getMessagingGroup(proposed.messaging_group_id);
  if (!mg) throw new Error('Canonical main wiring rejected: messaging group does not exist');
  if (mg.is_group !== 0) reject('only direct messages are allowed');
  if (proposed.sender_scope !== 'known') reject("sender_scope must be 'known'");
  if (proposed.session_mode !== 'agent-shared') reject("session_mode must be 'agent-shared'");

  const verifiedMapping = await db.get<{ present: number }>(
    `SELECT 1 AS present
       FROM user_dms ud
       JOIN gws_ea_principal_users principal ON principal.user_id = ud.user_id
       JOIN user_roles owner
         ON owner.user_id = ud.user_id
        AND owner.role = 'owner'
        AND owner.agent_group_id IS NULL
       JOIN agent_group_members member
         ON member.user_id = ud.user_id
        AND member.agent_group_id = ?
      WHERE ud.messaging_group_id = ?
        AND ud.channel_type = ?
      LIMIT 1`,
    proposed.agent_group_id,
    mg.id,
    mg.channel_type,
  );
  if (!verifiedMapping) reject('the direct message is not mapped to a verified principal owner and member');
});
