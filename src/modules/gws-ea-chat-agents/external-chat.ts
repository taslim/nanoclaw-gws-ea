import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { parseStoredCapabilities } from '../../capabilities.js';
import { updateContainerConfigJson, updateContainerConfigScalars } from '../../db/container-configs.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import {
  getExternalChatAgentGroupId,
  nameAssistantAgent,
  recordExternalChatAgentGroupId,
} from '../gws-ea-profile/db.js';
import { reconcileChatGateway } from './gateway.js';
import {
  CHAT_SHARED_SKILLS,
  EXTERNAL_CHAT_CAPABILITIES,
  EXTERNAL_CHAT_TEMPLATE,
  JOB_CHAT_CAPABILITIES,
} from './shape.js';

export async function reconcileChatShape(group: string, kind: 'external-chat' | 'job'): Promise<void> {
  await nameAssistantAgent(group);
  await updateContainerConfigScalars(group, { cli_scope: 'disabled' });
  const selection = parseStoredCapabilities((await getContainerConfig(group))?.capabilities, group);
  const browser = kind === 'job' && selection !== 'all' && selection.includes('browser-delegate');
  await updateContainerConfigJson(group, 'capabilities', [
    ...(kind === 'external-chat' ? EXTERNAL_CHAT_CAPABILITIES : JOB_CHAT_CAPABILITIES),
    ...(browser ? ['browser-delegate'] : []),
  ]);
  await updateContainerConfigJson(group, 'skills', [...CHAT_SHARED_SKILLS]);
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
