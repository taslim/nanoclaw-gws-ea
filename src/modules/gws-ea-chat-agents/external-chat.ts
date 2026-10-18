import { getDb } from '../../db/connection.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { getExternalChatAgentGroupId, recordExternalChatAgentGroupId } from '../gws-ea-profile/db.js';
import { reconcileChatGateway } from './gateway.js';
import { EXTERNAL_CHAT_CAPABILITIES, EXTERNAL_CHAT_TEMPLATE, JOB_CHAT_CAPABILITIES } from './shape.js';

export async function reconcileChatShape(group: string, kind: 'external-chat' | 'job'): Promise<void> {
  await updateContainerConfigScalars(group, { cli_scope: 'disabled' });
  await updateContainerConfigJson(group, 'capabilities', [
    ...(kind === 'external-chat' ? EXTERNAL_CHAT_CAPABILITIES : JOB_CHAT_CAPABILITIES),
  ]);
  await updateContainerConfigJson(group, 'skills', []);
}

/** The pointer and group are published atomically; gateway readiness is checked before any session starts. */
export async function ensureExternalChatGroup(): Promise<string> {
  const group = await getDb().transaction(async () => {
    const existing = await getExternalChatAgentGroupId();
    if (existing !== null) return existing;
    const created = await createAgentFromTemplate(EXTERNAL_CHAT_TEMPLATE, { name: 'external-chat' });
    await reconcileChatShape(created.group.id, 'external-chat');
    await recordExternalChatAgentGroupId(created.group.id);
    return created.group.id;
  });
  await reconcileChatGateway(group);
  return group;
}
