import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteOwnedGcpProject,
  deriveGcpProjectId,
  preflightGcloud,
  reconcileGcpProject,
  verifyGcpProject,
  type GcloudCommandRunner,
} from './gcloud.js';
import { allocateInstanceId } from './registry.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-gcloud-'));
  roots.push(root);
  return root;
}

interface FakeGcpState {
  project: boolean;
  lifecycle: 'ACTIVE' | 'DELETE_REQUESTED';
  labels: Record<string, string>;
  api: boolean;
  serviceAccount: boolean;
  keys: Set<string>;
  mutations: string[];
}

function fakeRunner(state: FakeGcpState, credentialFile: string): GcloudCommandRunner {
  return async (command) => {
    const signature = command.args.join(' ');
    const ok = (stdout = '') => ({ stdout, stderr: '', exitCode: 0 });
    const missing = () => ({ stdout: '', stderr: 'NOT_FOUND: resource was not found', exitCode: 1 });

    if (signature.startsWith('version ')) return ok('{}');
    if (signature.startsWith('auth list ')) return ok('operator@example.com\n');
    if (signature.startsWith('auth print-access-token ')) return ok('discard-me');
    if (signature.startsWith('projects describe ')) {
      return state.project
        ? ok(
            JSON.stringify({
              projectId: deriveGcpProjectId(INSTANCE_ID),
              lifecycleState: state.lifecycle,
              labels: state.labels,
            }),
          )
        : missing();
    }
    if (signature.startsWith('projects create ')) {
      state.project = true;
      state.labels = { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' };
      state.mutations.push(signature);
      return ok('{}');
    }
    if (signature.startsWith('projects delete ')) {
      state.lifecycle = 'DELETE_REQUESTED';
      state.mutations.push(signature);
      return ok('{}');
    }
    if (signature.startsWith('services list ')) return ok(state.api ? 'chat.googleapis.com\niam.googleapis.com\n' : '');
    if (signature.startsWith('services enable ')) {
      state.api = true;
      state.mutations.push(signature);
      return ok('');
    }
    if (signature.startsWith('iam service-accounts describe ')) {
      return state.serviceAccount
        ? ok(
            JSON.stringify({
              email: SERVICE_ACCOUNT,
              displayName: 'GWS-EA Google Chat',
              description: `Owned by GWS-EA instance ${INSTANCE_ID}`,
            }),
          )
        : missing();
    }
    if (signature.startsWith('iam service-accounts create ')) {
      state.serviceAccount = true;
      state.mutations.push(signature);
      return ok('{}');
    }
    if (signature.startsWith('iam service-accounts keys list ')) {
      return ok(
        JSON.stringify(
          [...state.keys].map((id) => ({
            name: `projects/test/serviceAccounts/${SERVICE_ACCOUNT}/keys/${id}`,
            keyType: 'USER_MANAGED',
          })),
        ),
      );
    }
    if (signature.startsWith('iam service-accounts keys create ')) {
      const keyId = 'key-1';
      state.keys.add(keyId);
      await mkdir(path.dirname(credentialFile), { recursive: true, mode: 0o700 });
      await writeFile(
        credentialFile,
        JSON.stringify({
          type: 'service_account',
          project_id: deriveGcpProjectId(INSTANCE_ID),
          private_key_id: keyId,
          private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
          client_email: SERVICE_ACCOUNT,
          client_id: '123',
          auth_uri: 'https://accounts.google.com/o/oauth2/auth',
          token_uri: 'https://oauth2.googleapis.com/token',
          auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
          client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/gws-ea-chat',
          universe_domain: 'googleapis.com',
        }),
        { mode: 0o600 },
      );
      state.mutations.push(signature);
      return ok('{}');
    }
    throw new Error(`Unexpected gcloud command: ${signature}`);
  };
}

const INSTANCE_ID = '12345678-1234-4234-8234-123456789abc';
const PROJECT_ID = deriveGcpProjectId(INSTANCE_ID);
const SERVICE_ACCOUNT = `gws-ea-chat@${PROJECT_ID}.iam.gserviceaccount.com`;

describe('Google Cloud provisioning', () => {
  it('fails before local allocation with one actionable install message when gcloud is unavailable', async () => {
    await expect(
      preflightGcloud({
        cwd: process.cwd(),
        runCommand: async () => {
          throw new Error('spawn ENOENT');
        },
      }),
    ).rejects.toMatchObject({ code: 'gcloud_required' });
    await expect(
      preflightGcloud({
        cwd: process.cwd(),
        runCommand: async () => {
          throw new Error('spawn ENOENT');
        },
      }),
    ).rejects.toThrow(/cloud\.google\.com\/sdk\/docs\/install/u);
  });

  it('creates one labeled project, enables only required APIs, and reconciles one owner-only key', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'secrets', 'gchat.json');
    const state: FakeGcpState = {
      project: false,
      lifecycle: 'ACTIVE',
      labels: {},
      api: false,
      serviceAccount: false,
      keys: new Set(),
      mutations: [],
    };
    const runCommand = fakeRunner(state, credentialFile);
    const input = {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      account: 'operator@example.com',
      serviceAccountEmail: SERVICE_ACCOUNT,
      credentialFile,
      cwd: root,
    };

    await reconcileGcpProject(input, { runCommand });
    expect(await verifyGcpProject(input, { runCommand })).toBe(true);
    const firstMutations = [...state.mutations];
    await reconcileGcpProject(input, { runCommand });
    expect(state.mutations).toEqual(firstMutations);
    expect(firstMutations).toHaveLength(4);
    expect(firstMutations.every((args) => args.includes('--account=operator@example.com'))).toBe(true);
    expect(
      firstMutations.filter((args) => !args.startsWith('projects create ')).every((args) => args.includes(PROJECT_ID)),
    ).toBe(true);
  });

  it('stops instead of minting a second key when remote private material is unavailable locally', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'secrets', 'gchat.json');
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' },
      api: true,
      serviceAccount: true,
      keys: new Set(['remote-key']),
      mutations: [],
    };

    await expect(
      reconcileGcpProject(
        {
          instanceId: INSTANCE_ID,
          projectId: PROJECT_ID,
          account: 'operator@example.com',
          serviceAccountEmail: SERVICE_ACCOUNT,
          credentialFile,
          cwd: root,
        },
        { runCommand: fakeRunner(state, credentialFile) },
      ),
    ).rejects.toMatchObject({ code: 'gcp_key_recovery_required' });
    expect(state.mutations).toEqual([]);
  });

  it('refuses to adopt a project whose GWS-EA ownership label differs', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'gchat.json');
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': allocateInstanceId(), 'gws-ea-managed': 'true' },
      api: false,
      serviceAccount: false,
      keys: new Set(),
      mutations: [],
    };

    await expect(
      reconcileGcpProject(
        {
          instanceId: INSTANCE_ID,
          projectId: PROJECT_ID,
          account: 'operator@example.com',
          serviceAccountEmail: SERVICE_ACCOUNT,
          credentialFile,
          cwd: root,
        },
        { runCommand: fakeRunner(state, credentialFile) },
      ),
    ).rejects.toMatchObject({ code: 'gcp_project_owner_mismatch' });
    expect(state.mutations).toEqual([]);
  });

  it('requests deletion only after ownership verification and treats a repeated delete as complete', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'gchat.json');
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' },
      api: true,
      serviceAccount: true,
      keys: new Set(),
      mutations: [],
    };
    const input = {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      account: 'operator@example.com',
      cwd: root,
    };
    const runCommand = fakeRunner(state, credentialFile);

    await deleteOwnedGcpProject(input, { runCommand });
    await deleteOwnedGcpProject(input, { runCommand });
    expect(state.lifecycle).toBe('DELETE_REQUESTED');
    expect(state.mutations.filter((args) => args.startsWith('projects delete '))).toHaveLength(1);
  });

  it('refuses project deletion when the instance ownership label differs', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'gchat.json');
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': allocateInstanceId(), 'gws-ea-managed': 'true' },
      api: true,
      serviceAccount: true,
      keys: new Set(),
      mutations: [],
    };

    await expect(
      deleteOwnedGcpProject(
        { instanceId: INSTANCE_ID, projectId: PROJECT_ID, account: 'operator@example.com', cwd: root },
        { runCommand: fakeRunner(state, credentialFile) },
      ),
    ).rejects.toMatchObject({ code: 'gcp_project_owner_mismatch' });
    expect(state.mutations).toEqual([]);
  });

  it('does not complete removal when Google Cloud leaves the project active after delete', async () => {
    const root = await tempRoot();
    const credentialFile = path.join(root, 'gchat.json');
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' },
      api: true,
      serviceAccount: true,
      keys: new Set(),
      mutations: [],
    };
    const fallback = fakeRunner(state, credentialFile);
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args[0] === 'projects' && command.args[1] === 'delete') {
        state.mutations.push(command.args.join(' '));
        return { stdout: '{}', stderr: '', exitCode: 0 };
      }
      return fallback(command);
    };

    await expect(
      deleteOwnedGcpProject(
        { instanceId: INSTANCE_ID, projectId: PROJECT_ID, account: 'operator@example.com', cwd: root },
        { runCommand },
      ),
    ).rejects.toMatchObject({ code: 'gcp_delete_unconfirmed' });
    expect(state.lifecycle).toBe('ACTIVE');
  });
});
