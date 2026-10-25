import { ensureContainerConfig } from '../../../db/container-configs.js';
import { createAgentGroup } from '../../../db/index.js';
import { reconcileGwsEaProfile } from '../db.js';

export const ASSISTANT_NAME = 'Juno';
export const ASSISTANT_EMAIL = 'juno@example.test';
export const PRINCIPAL_EMAIL = 'morgan@example.test';
export const ALIAS = 'onuj@example.test';

export async function publishAliasTestProfile(): Promise<void> {
  await createAgentGroup({
    id: 'ag-main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: '2026-10-17T00:00:00.000Z',
  });
  await ensureContainerConfig('ag-main');
  await reconcileGwsEaProfile({
    assistantName: { firstName: ASSISTANT_NAME, lastName: null },
    assistantWorkspaceEmail: ASSISTANT_EMAIL,
    principalName: { firstName: 'Morgan', lastName: 'Ellery' },
    principalTimezone: 'America/New_York',
    mainAgentGroupId: 'ag-main',
    principalEmails: [PRINCIPAL_EMAIL],
  });
}
