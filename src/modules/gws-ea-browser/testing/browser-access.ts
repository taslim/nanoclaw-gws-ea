import fs from 'node:fs';
import { parseStoredCapabilities } from '../../../capabilities.js';
import { vi } from 'vitest';

import { ensureContainerConfig, getContainerConfig, updateContainerConfigJson } from '../../../db/container-configs.js';
import '../../capabilities/index.js';
import { getAllAgentGroups } from '../../../db/agent-groups.js';

/** Configure a native browser root and explicit delegation grants for the test's existing groups. */
export async function configureBrowserAccess(root: string, agentGroupIds: readonly string[] = []): Promise<void> {
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  vi.stubEnv('GWS_EA_BROWSER_ROOT', root);
  for (const group of await getAllAgentGroups()) {
    await ensureContainerConfig(group.id);
    const selected = parseStoredCapabilities((await getContainerConfig(group.id))?.capabilities, group.id);
    const kept = selected === 'all' ? [] : selected.filter((key) => key !== 'browser-delegate');
    await updateContainerConfigJson(
      group.id,
      'capabilities',
      agentGroupIds.includes(group.id) ? [...kept, 'browser-delegate'] : kept,
    );
  }
}
