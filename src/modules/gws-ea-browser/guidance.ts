import path from 'node:path';
import { registerCapability } from '../../capabilities.js';
import { getDb } from '../../db/connection.js';
import { registerA2aInboundFraming } from '../agent-to-agent/agent-route.js';
import { untrusted } from '../gws-ea-inbox/untrusted.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import { registerGuidance } from '../gws-ea-profile/guidance.js';
import { hasBrowserAccess, isMainAgentGroup } from './access.js';

/** Whether a group may delegate to the browser, whether or not the operator has it enabled now (KTD15). */
async function delegates(agentGroupId: string): Promise<boolean> {
  return (await getDb().hasTable('gws_ea_profile')) && hasBrowserAccess(agentGroupId);
}

/**
 * The delegate tools reach exactly the groups the browser access setting
 * names, so enablement changes need no container restart; every request is
 * still checked by the host.
 */
export const BROWSER_DELEGATE_CAPABILITY = 'browser-delegate';
registerCapability(BROWSER_DELEGATE_CAPABILITY, {
  description: 'Delegate browser errands, cancel jobs and relay principal sign-in codes through the host',
  default: 'off',
  grantedTo: delegates,
});

/**
 * Main records the purchases of a group whose browser access was removed (purchase-outcome.ts), so the tool
 * reaches main and every delegator, whatever the setting lists (KTD16); the host checks each recording's errand.
 */
export const PURCHASE_OUTCOME_CAPABILITY = 'browser-purchase-outcome';
registerCapability(PURCHASE_OUTCOME_CAPABILITY, {
  description: 'record_purchase_outcome: settle a browser purchase the page left unconfirmed',
  default: 'off',
  grantedTo: async (agentGroupId) =>
    (await getDb().hasTable('gws_ea_profile')) &&
    ((await isMainAgentGroup(agentGroupId)) || (await hasBrowserAccess(agentGroupId))),
});

registerGuidance('gws-ea-browser:main-guidance', {
  agent: 'a delegating agent',
  heading: 'Browser delegation',
  file: path.join('src', 'modules', 'gws-ea-browser', 'main-guidance.md'),
  receives: delegates,
});
registerGuidance('gws-ea-browser:job-guidance', {
  agent: 'browser',
  heading: 'Browser errand',
  file: path.join('templates', 'gws-ea', 'browser', 'instructions.md'),
  agentGroupId: async () => ((await getDb().hasTable('gws_ea_profile')) ? getBrowserAgentGroupId() : null),
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
