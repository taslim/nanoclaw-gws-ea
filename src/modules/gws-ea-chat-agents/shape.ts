import { registerCapability } from '../../capabilities.js';

export const CHAT_TOOLS_CAPABILITY = 'gws-ea-chat-external';
export const JOB_DOCUMENTS_CAPABILITY = 'gws-ea-chat-documents';
export const EXTERNAL_CHAT_TEMPLATE = 'gws-ea/external-chat';
export const JOB_CHAT_TEMPLATE = 'gws-ea/chat-job';
export const EXTERNAL_CHAT_PLUGIN = 'gws-ea-external-chat';
export const JOB_CHAT_PLUGIN = 'gws-ea-chat-job';
export const CHAT_SHARED_SKILLS: readonly string[] = ['whatsapp-formatting'];

registerCapability(CHAT_TOOLS_CAPABILITY, {
  description: 'Chat-addressed reporting, expected replies, reminders and host-mediated scheduling',
  default: 'off',
  instructions: [CHAT_TOOLS_CAPABILITY],
});
registerCapability(JOB_DOCUMENTS_CAPABILITY, {
  description: 'Host-mediated documents scoped to the job chat and its members',
  default: 'off',
  instructions: [JOB_DOCUMENTS_CAPABILITY],
});

export const EXTERNAL_CHAT_CAPABILITIES: readonly string[] = [
  'reply',
  'files-read',
  'files-send',
  'web',
  'time',
  'request-status',
  CHAT_TOOLS_CAPABILITY,
];
export const JOB_CHAT_CAPABILITIES: readonly string[] = [
  ...EXTERNAL_CHAT_CAPABILITIES,
  'conversation-context',
  'files-write',
  JOB_DOCUMENTS_CAPABILITY,
];
