import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { runInstanceNclJson } from './ncl.js';
import type { InstanceRuntimeConfig } from './service.js';

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function instanceWithNcl(script: string): Promise<InstanceRuntimeConfig> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-ncl-')));
  roots.push(root);
  const checkout = path.join(root, 'nanoclaw');
  const secrets = path.join(root, 'secrets');
  await mkdir(path.join(checkout, 'bin'), { recursive: true });
  await writeFile(path.join(checkout, 'bin', 'ncl'), `#!/bin/sh\n${script}\n`, { mode: 0o755 });
  const project = `gws-ea-${INSTANCE_ID.replaceAll('-', '')}`.slice(0, 30);
  return {
    schema_version: 1,
    instance_id: INSTANCE_ID,
    install_id: INSTANCE_ID.replaceAll('-', ''),
    deployed_commit: 'a'.repeat(40),
    checkout_realpath: checkout,
    node_path: '/usr/bin/node',
    home_directory: root,
    allocated_ports: { nanoclaw_webhook: 31_001, onecli_app: 31_002, onecli_gateway: 31_003 },
    agent_egress_network: `${project}-agent-egress`,
    onecli_project: project,
    onecli_app_url: 'http://127.0.0.1:31002',
    onecli_gateway_url: 'http://127.0.0.1:31003',
    onecli_gateway_container: `${project}-gateway-1`,
    onecli_cli_path: '/opt/onecli',
    selected_provider: 'claude',
    endpoint_url: 'https://aya.example.test/webhook/gchat',
    docker_endpoint: 'unix:///var/run/docker.sock',
    secret_files: {
      gchat_credentials: path.join(secrets, 'gchat-service-account.json'),
      onecli_runtime_api_key: path.join(secrets, 'onecli-runtime-api-key'),
      onecli_admin_api_key: path.join(secrets, 'onecli-admin-api-key'),
    },
  };
}

function frameScript(frame: unknown, exitCode: number): string {
  return `printf '%s\\n' '${JSON.stringify(frame, null, 2)}'\nexit ${exitCode}`;
}

describe('GWS-EA ncl boundary', () => {
  it('returns the data of a successful frame', async () => {
    const config = await instanceWithNcl(frameScript({ id: 'r1', ok: true, data: [{ id: 'main' }] }, 0));
    await expect(runInstanceNclJson(config, ['groups', 'list'])).resolves.toEqual([{ id: 'main' }]);
  });

  it("surfaces NanoClaw's own error message when ncl exits 1 with an ok:false frame", async () => {
    const config = await instanceWithNcl(
      frameScript({ id: 'r1', ok: false, error: { code: 'handler-error', message: 'No agent group named main' } }, 1),
    );

    await expect(runInstanceNclJson(config, ['gws-ea-profile', 'get'])).rejects.toMatchObject({
      code: 'ncl_failed',
      message: expect.stringContaining('No agent group named main'),
      details: expect.objectContaining({ nclCode: 'handler-error', exitCode: 1 }),
    });
  });

  it('reports the failed command with its stderr when ncl exits without a frame', async () => {
    const config = await instanceWithNcl("printf 'ncl: cannot connect to /x/cli.sock\\n' >&2\nexit 2");

    await expect(runInstanceNclJson(config, ['groups', 'list'])).rejects.toMatchObject({
      code: 'command_failed',
      details: expect.objectContaining({
        exitCode: 2,
        args: ['groups', 'list', '--json'],
        stderrTail: 'ncl: cannot connect to /x/cli.sock',
      }),
    });
  });

  it('rejects a successful exit whose output is not a frame', async () => {
    const config = await instanceWithNcl("printf 'not json'");
    await expect(runInstanceNclJson(config, ['groups', 'list'])).rejects.toMatchObject({
      code: 'invalid_child_output',
    });
  });
});
