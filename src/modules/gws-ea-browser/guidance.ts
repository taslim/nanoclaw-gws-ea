import path from 'node:path';
import { registerCapability } from '../../capabilities.js';
import { getDb } from '../../db/connection.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';
import { registerA2aInboundFraming } from '../agent-to-agent/agent-route.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { getBrowserAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';
import { readBrowserPolicy } from './policy.js';

export const BROWSER_DELEGATE_CAPABILITY = 'browser-delegate';
export const BROWSER_NOT_ENABLED =
  'When a task needs the browser, tell the principal their operator needs to enable the browser for this assistant.';
registerCapability(BROWSER_DELEGATE_CAPABILITY, {
  description: 'Delegate browser errands, cancel jobs and relay principal sign-in codes through the host',
  default: 'on',
});

async function pointer(which: 'main' | 'browser'): Promise<string | null> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return null;
  return which === 'main' ? getMainAgentGroupId() : getBrowserAgentGroupId();
}

registerGuidance('gws-ea-browser:main-guidance', {
  agent: 'main',
  heading: 'Browser delegation',
  file: path.join('src', 'modules', 'gws-ea-browser', 'main-guidance.md'),
  agentGroupId: async () => ((await readBrowserPolicy()).enabled ? pointer('main') : null),
});
registerRequiredProjectDocSection('gws-ea-browser:disabled-guidance', async (group) => {
  if (group.id !== (await pointer('main')) || (await readBrowserPolicy()).enabled) return undefined;
  return { name: 'Browser delegation', body: BROWSER_NOT_ENABLED };
});
registerGuidance('gws-ea-browser:job-guidance', {
  agent: 'browser',
  heading: 'Browser errand',
  file: path.join('templates', 'gws-ea', 'browser', 'instructions.md'),
  agentGroupId: () => pointer('browser'),
});
registerA2aInboundFraming((content) => {
  const value: unknown = JSON.parse(content);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    throw new Error('Invalid A2A message envelope');
  const message = value as Record<string, unknown>;
  return JSON.stringify({
    ...message,
    text: untrusted(typeof message.text === 'string' ? message.text : '', 24_000, 'browser'),
  });
});
