import '../capabilities/index.js';
import '../gws-ea-profile/index.js';
import path from 'node:path';
import { registerProtectedGroupPolicy } from '../../cli/guard.js';
import { register } from '../../cli/registry.js';
import { TIMEZONE } from '../../config.js';
import { registerSessionAdmissionPolicy } from '../../container-runner.js';
import { registerDeliveryAction } from '../../delivery.js';
import { getDb } from '../../db/connection.js';
import { registerMigration } from '../../db/migrations/index.js';
import { getSession } from '../../db/sessions.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { resolveTimezone } from '../../timezone.js';
import { getExternalChatAgentGroupId, getGwsEaProfile } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';
import { escapeMarkdownInline } from '../gws-ea-profile/markdown.js';
import { chatAgentDrift } from './drift.js';
import { ensureExternalChatGroup, reconcileChatShape } from './external-chat.js';
import { reconcileChatGateway, retiredChatGatewayDrift } from './gateway.js';
import { safeErrorMessage } from '../../gws-ea/redact.js';
import { getJobAgent, listJobAgents } from './jobs.js';
import { chatAgentsMigration } from './migration.js';
import { retireJobAgent } from './retire.js';
import { JOB_DOCUMENT_ACTIONS } from './docs.js';
import { jobDocumentsMigration } from './docs-migration.js';
import { getChat } from '../gws-ea-chats/db.js';

export { ensureExternalChatGroup } from './external-chat.js';
export {
  createJobAgent,
  activateJobAgent,
  getJobAgent,
  getJobAgentForChat,
  listJobAgents,
  type JobAgent,
} from './jobs.js';
export { retireJobAgent } from './retire.js';
export {
  EXTERNAL_CHAT_CAPABILITIES,
  JOB_CHAT_CAPABILITIES,
  CHAT_TOOLS_CAPABILITY,
  JOB_DOCUMENTS_CAPABILITY,
} from './shape.js';

registerMigration(chatAgentsMigration);
registerMigration(jobDocumentsMigration);
for (const [action, handler, guard] of JOB_DOCUMENT_ACTIONS) registerDeliveryAction(action, handler, guard);

async function kind(group: string): Promise<'external-chat' | 'job' | undefined> {
  if (group === (await getExternalChatAgentGroupId())) return 'external-chat';
  return (await getJobAgent(group)) ? 'job' : undefined;
}

export async function reconcileChatAgents(): Promise<void> {
  const external = await ensureExternalChatGroup();
  await reconcileChatShape(external, 'external-chat');
  await resumeRetiringJobAgents();
  for (const job of await listJobAgents()) {
    if (job.state === 'retired' || job.state === 'retiring') continue;
    await reconcileChatShape(job.agent_group_id, 'job');
    if (job.state === 'creating' && (await getChat(job.messaging_group_id))?.state === 'moving') continue;
    await reconcileChatGateway(job.agent_group_id);
  }
}

/** Each chat lifecycle sweep re-runs this, so a retirement that failed or met a held instance lock resumes. */
export async function resumeRetiringJobAgents(): Promise<void> {
  for (const job of await listJobAgents()) {
    if (job.state === 'retired') continue;
    const chat = await getChat(job.messaging_group_id);
    const unserved =
      chat &&
      (chat.state === 'detached' ||
        chat.state === 'declined' ||
        (job.state === 'active'
          ? chat.serving_agent_group_id !== job.agent_group_id
          : job.state === 'creating' && chat.state !== 'moving'));
    if (job.state !== 'retiring' && !unserved) continue;
    try {
      await retireJobAgent(job.agent_group_id);
      // eslint-disable-next-line no-catch-all/no-catch-all -- retiring jobs retain their pending state; one failed cleanup must not starve its peers.
    } catch (error) {
      if (error instanceof GwsEaError && error.code === 'instance_busy')
        log.info('Job retirement waits for the current instance operation', { agentGroupId: job.agent_group_id });
      else log.error('Job retirement will resume', { agentGroupId: job.agent_group_id, error });
    }
  }
}

// As with external-email, creating the chat agents needs no published main: a new
// assistant's host starts before main exists, and publishing main names them.
// Chat admission waits for the bound principal separately (`decideJoin`).
onHostStart(async () => {
  if (!(await getDb().hasTable('gws_ea_profile'))) return;
  await reconcileChatAgents();
});

registerProtectedGroupPolicy('gws-ea-chat-agents:host-owned', async (group) =>
  (await kind(group)) ? 'chat agents are configured only by the host' : undefined,
);

export async function chatAgentHealth(group: string, sessionProvider?: string | null): Promise<string[]> {
  const type = await kind(group);
  if (!type) return [];
  const job = type === 'job' ? await getJobAgent(group) : undefined;
  const state = job && job.state !== 'active' ? [`its job-agent state is ${job.state}`] : [];
  return [...state, ...(await chatAgentDrift(group, type, sessionProvider))];
}

registerSessionAdmissionPolicy('gws-ea-chat-agents:authorized-shape', async ({ key }) => {
  const session = await getSession(key.sessionId);
  const problems = await chatAgentHealth(key.agentGroupId, session?.agent_provider);
  if (problems.length > 0) throw new Error(`Chat agent may not start: ${problems.join('; ')}`);
});

registerRequiredProjectDocSection('gws-ea-chat-agents:principal', async (group) => {
  if (!(await kind(group.id))) return undefined;
  const profile = await getGwsEaProfile();
  const principal =
    profile.principal_display_name === null ? 'the principal' : escapeMarkdownInline(profile.principal_display_name);
  return {
    name: 'Principal',
    body: `You work for ${principal}, whose home time zone is ${resolveTimezone(profile.principal_timezone ?? TIMEZONE)}.`,
  };
});
for (const [type, file] of [
  ['external-chat', 'external-chat.guidance.md'],
  ['job', 'job.guidance.md'],
] as const)
  registerGuidance(`gws-ea-chat-agents:${type}-guidance`, {
    agent: type,
    heading: type === 'job' ? 'Job Chat' : 'External Chat',
    file: path.join('src', 'modules', 'gws-ea-chat-agents', file),
    receives: async (group) => (await kind(group)) === type,
  });

register({
  name: 'gws-ea-chat-agents-health',
  description: 'Read the host-owned chat agent identities and lifecycle states.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    if (Object.keys(raw).length > 0) throw new Error('Chat agent health takes no arguments');
    return undefined;
  },
  async handler() {
    const external = await getExternalChatAgentGroupId();
    const health = async (group: string, retired = false) => {
      try {
        const problems = retired ? await retiredChatGatewayDrift(group) : await chatAgentHealth(group);
        return {
          status: problems.length ? ('degraded' as const) : ('ok' as const),
          reason: problems.length ? problems.join('; ') : null,
        };
        // eslint-disable-next-line no-catch-all/no-catch-all -- Each unavailable observation belongs to this group, not the whole report.
      } catch (error) {
        return { status: 'unknown' as const, reason: safeErrorMessage(error) };
      }
    };
    return {
      external_chat: {
        agent_group_id: external,
        ...(external
          ? await health(external)
          : { status: 'degraded' as const, reason: 'External-chat has not been created.' }),
      },
      jobs: await Promise.all(
        (await listJobAgents()).map(async (job) => ({
          ...job,
          health: await health(job.agent_group_id, job.state === 'retired'),
        })),
      ),
    };
  },
});
