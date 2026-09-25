import { describe, expect, it, vi } from 'vitest';

import { deriveGcpProjectId, getOwnedGcpProjectNumber } from './gcloud.js';
import { deriveWorkspaceAddOnIdentity } from './gcp-identity.js';

const instanceId = '12345678-1234-4234-8234-123456789abc';
const projectId = deriveGcpProjectId(instanceId);
const input = { instanceId, projectId, account: 'operator@example.test', cwd: process.cwd() };

/** `gcloud projects describe --format=json`, as the Cloud SDK prints it. */
function projectDescription(projectNumber: unknown, labels?: Record<string, string>): string {
  return `${JSON.stringify(
    {
      createTime: '2026-09-20T17:02:11.442Z',
      ...(labels ? { labels } : {}),
      lifecycleState: 'ACTIVE',
      name: 'GWS-EA assistant',
      parent: { id: '281734958812', type: 'organization' },
      projectId,
      ...(projectNumber === undefined ? {} : { projectNumber }),
    },
    null,
    2,
  )}\n`;
}

const OWNED = { 'gws-ea-instance': instanceId, 'gws-ea-managed': 'true' };

describe('owned Google Cloud project number', () => {
  it('reads the exact number only from the dedicated owned project, for the add-on signing identity', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription('441811502258', { ...OWNED, team: 'assistants' }),
      stderr: '',
      exitCode: 0,
    }));

    const projectNumber = await getOwnedGcpProjectNumber(input, { runCommand });

    expect(projectNumber).toBe('441811502258');
    expect(deriveWorkspaceAddOnIdentity(projectNumber)).toBe(
      'service-441811502258@gcp-sa-gsuiteaddons.iam.gserviceaccount.com',
    );
    expect(runCommand).toHaveBeenCalledWith(
      expect.objectContaining({
        args: ['projects', 'describe', projectId, '--format=json', '--account=operator@example.test', '--quiet'],
      }),
    );
  });

  it.each([
    ['a project marked unmanaged', { ...OWNED, 'gws-ea-managed': 'false' }],
    ['a project with no labels', undefined],
  ])('refuses %s, naming it', async (_case, labels) => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription('441811502258', labels),
      stderr: '',
      exitCode: 0,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).rejects.toMatchObject({
      code: 'gcp_project_owner_mismatch',
      message: expect.stringContaining(projectId),
    });
  });

  it.each([undefined, 'invalid', '0'])('rejects invalid project number %s', async (projectNumber) => {
    const runCommand = vi.fn(async () => ({
      stdout: projectDescription(projectNumber, OWNED),
      stderr: '',
      exitCode: 0,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).rejects.toMatchObject({
      code: 'invalid_gcloud_output',
    });
  });

  it('reports a project Google will not describe as the failed command', async () => {
    const runCommand = vi.fn(async () => ({
      stdout: '',
      stderr: `ERROR: (gcloud.projects.describe) [operator@example.test] does not have permission to access projects instance [${projectId}] (or it may not exist): The caller does not have permission.`,
      exitCode: 1,
    }));

    await expect(getOwnedGcpProjectNumber(input, { runCommand })).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining(projectId),
      details: { program: 'gcloud', exitCode: 1, stderrTail: expect.stringContaining('(or it may not exist)') },
    });
  });
});
