import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import * as onepassword from './onepassword.js';
import * as artifacts from './artifacts-connector.js';
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
  it('does no provider work when neither connector is installed', async () => {
    const { paths, id } = await assistant();
    const result = await withInstanceOperation(paths, id, (operation) => provisionInstalledConnectors(operation, {}));
    expect(result).toEqual({ pending: [], next_actions: [] });
  });
  it('continues from a vault failure to artifacts, preserving ordered next actions for a serving caller', async () => {
    const { paths, id } = await assistant();
    const called: string[] = [];
    vi.spyOn(onepassword, 'provisionAssistantVault').mockImplementation(async () => {
      called.push('onepassword');
      throw new GwsEaError('rate_limited', 'The vault request limit is exhausted.');
    });
    vi.spyOn(artifacts, 'provisionAssistantArtifacts').mockImplementation(async () => {
      called.push('artifacts');
      return {
        instance_id: id,
        outcome: 'pending',
        reason: 'profile_incomplete',
        message: 'Complete the assistant profile.',
        changed: false,
      };
    });
    const result = await withInstanceOperation(paths, id, (operation) => provisionInstalledConnectors(operation, {}));
    expect(called).toEqual(['onepassword', 'artifacts']);
    expect(result?.pending).toEqual([
      { name: 'onepassword', reason: 'rate_limited', message: 'The vault request limit is exhausted.' },
      { name: 'artifacts', reason: 'profile_incomplete', message: 'Complete the assistant profile.' },
    ]);
    expect(result?.next_actions).toEqual([
      { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
      { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'artifacts'] },
    ]);
  });
  it('shares the rate-limit fence across assistants while retaining their separate pending results', async () => {
    const { paths, id } = await assistant();
    const rateLimitState = { limited: false };
    const vault = vi.spyOn(onepassword, 'provisionAssistantVault').mockImplementation(async (_operation, deps) => {
      expect(deps?.rateLimitState).toBe(rateLimitState);
      rateLimitState.limited = true;
      return {
        instance_id: id,
        outcome: 'pending',
        reason: 'rate_limited',
        message: 'Retry after the account resets.',
        changed: false,
        vault_id: null,
        runtime_service_account_id: null,
        retired_service_account_ids: [],
      };
    });
    vi.spyOn(artifacts, 'provisionAssistantArtifacts').mockResolvedValue(undefined);
    for (let turn = 0; turn < 2; turn++) {
      const result = await withInstanceOperation(paths, id, (operation) =>
        provisionInstalledConnectors(operation, {}, { onePassword: { rateLimitState } }),
      );
      expect(result?.pending[0]).toMatchObject({ name: 'onepassword', reason: 'rate_limited' });
    }
    expect(vault).toHaveBeenCalledTimes(2);
    expect(rateLimitState.limited).toBe(true);
  });
});
