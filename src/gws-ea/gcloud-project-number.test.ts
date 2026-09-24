import { describe, expect, it, vi } from 'vitest';

import { deriveGcpProjectId, getOwnedGcpProjectNumber } from './gcloud.js';

const instanceId = '12345678-1234-4234-8234-123456789abc';
const projectId = deriveGcpProjectId(instanceId);
const input = { instanceId, projectId, account: 'operator@example.test', cwd: process.cwd() };

function projectDescription(projectNumber: unknown, managed = true): string {
  return JSON.stringify({
    projectId,
    projectNumber,
    lifecycleState: 'ACTIVE',
    labels: { 'gws-ea-instance': instanceId, 'gws-ea-managed': managed ? 'true' : 'false' },
  });
}

describe('owned Google Cloud project number', () => {
  it('reads the exact number only from the dedicated owned project', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription('441811502258'),
      stderr: '',
      exitCode: 0,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).resolves.toBe('441811502258');
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['projects', 'describe', projectId, '--account=operator@example.test', '--format=json', '--quiet'],
      }),
    );
  });

  it('rejects a project without the assistant ownership marker', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription('441811502258', false),
      stderr: '',
      exitCode: 0,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).rejects.toMatchObject({
      code: 'gcp_project_owner_mismatch',
    });
  });

  it.each([undefined, 'invalid', '0'])('rejects invalid project number %s', async (projectNumber) => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription(projectNumber),
      stderr: '',
      exitCode: 0,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).rejects.toMatchObject({
      code: 'invalid_gcloud_output',
    });
  });
});
