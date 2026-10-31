import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as web from './web-connector.js';
import { provisionInstalledConnectors } from './connector-provisioning.js';
import { reserveInstance, withInstanceOperation } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import { deriveGcpClaims } from './gcp-identity.js';
import { GwsEaError } from './types.js';

const roots: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
async function assistant() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'connector-provisioning-'));
  roots.push(root);
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const id = randomUUID();
  await reserveInstance(paths, {
    instance_id: id,
    release_track: 'dogfood',
    source_remote: 'https://example.test/repo.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 32001, onecli_gateway: 32002 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(id),
      gcp_account: 'operator@example.test',
      workspace_email: 'aya@example.test',
      onecli_project: 'aya',
    },
  });
  return { paths, id };
}
describe('optional connector provisioning', () => {
  it('keeps a web provisioning failure as pending for a serving caller', async () => {
    const { paths, id } = await assistant();
    vi.spyOn(web, 'provisionAssistantWeb').mockRejectedValue(
      new GwsEaError('web_unavailable', 'Web setup is unavailable.'),
    );
    const result = await withInstanceOperation(paths, id, (operation) => provisionInstalledConnectors(operation, {}));
    expect(result).toEqual({
      pending: [{ name: 'web', reason: 'web_unavailable', message: 'Web setup is unavailable.' }],
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'web'] }],
    });
  });
  it('does no provider work when web is not installed', async () => {
    const { paths, id } = await assistant();
    const result = await withInstanceOperation(paths, id, (operation) => provisionInstalledConnectors(operation, {}));
    expect(result).toEqual({ pending: [], next_actions: [] });
  });
  it.each(['web_name_unusable', 'web_hostname_claimed', 'web_hostname_foreign'])(
    'offers web recovery only for a foreign hostname (%s)',
    async (reason) => {
      const { paths, id } = await assistant();
      vi.spyOn(web, 'provisionAssistantWeb').mockResolvedValue({
        instance_id: id,
        outcome: 'pending',
        reason,
        message: 'Web pending.',
        changed: false,
      });
      const result = await withInstanceOperation(paths, id, (operation) => provisionInstalledConnectors(operation, {}));
      expect(result?.pending).toEqual([{ name: 'web', reason, message: 'Web pending.' }]);
      expect(result?.next_actions).toEqual(
        reason === 'web_hostname_foreign'
          ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'web'] }]
          : [],
      );
    },
  );
});
