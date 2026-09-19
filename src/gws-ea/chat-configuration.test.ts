import { mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { confirmChatConfiguration, isChatConfigurationConfirmed } from './chat-configuration.js';
import { resolveControlPlanePaths } from './paths.js';
import { allocateInstanceId, reserveInstance, writeInstanceMarker } from './registry.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe('Google Chat configuration confirmation', () => {
  it('records one owner-only receipt bound to the reserved project and endpoint', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-chat-confirmation-'));
    roots.push(root);
    const paths = resolveControlPlanePaths({
      configRoot: path.join(root, 'config'),
      stateRoot: path.join(root, 'state'),
    });
    const instanceId = allocateInstanceId();
    const projectId = `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
    await reserveInstance(paths, {
      instance_id: instanceId,
      checkout_realpath: paths.checkoutRoot(instanceId),
      release_track: 'dogfood',
      source_remote: 'https://example.test/nanoclaw.git',
      deployed_commit: 'a'.repeat(40),
      allocated_ports: { nanoclaw_webhook: 43_001, onecli_app: 43_002, onecli_gateway: 43_003 },
      exclusive_resource_claims: {
        endpoint_url: 'https://assistant.example.test/webhook/gchat',
        gcp_project_id: projectId,
        gcp_account: 'operator@example.test',
        gchat_service_account: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
        workspace_email: 'assistant@example.test',
        onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
      },
    });
    await mkdir(paths.checkoutRoot(instanceId), { recursive: true, mode: 0o700 });
    await writeInstanceMarker(paths, instanceId);

    expect(await isChatConfigurationConfirmed(paths, instanceId)).toBe(false);
    await confirmChatConfiguration(paths, instanceId);
    await confirmChatConfiguration(paths, instanceId);

    expect(await isChatConfigurationConfirmed(paths, instanceId)).toBe(true);
    expect((await stat(paths.chatConfigurationFile(instanceId))).mode & 0o777).toBe(0o600);
  });
});
