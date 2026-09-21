import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  deleteOwnedGcpProject,
  deriveGcpProjectId,
  preflightGcloud,
  probeGcpProjectForCreate,
  reconcileGcpProject,
  verifyGcpProject,
  type GcloudCommandRunner,
  type GcloudProgressEvent,
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
  blockedPolicies?: Set<string>;
  mutations: string[];
}

function fakeRunner(state: FakeGcpState): GcloudCommandRunner {
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
    if (signature.startsWith('resource-manager org-policies describe ')) {
      const constraint = command.args[3]!;
      return ok(
        JSON.stringify({
          booleanPolicy: state.blockedPolicies?.has(constraint) ? { enforced: true } : {},
          constraint: `constraints/${constraint}`,
        }),
      );
    }
    if (signature.startsWith('resource-manager org-policies disable-enforce ')) {
      const constraint = command.args[3]!;
      state.blockedPolicies?.delete(constraint);
      state.mutations.push(signature);
      return ok('{}');
    }
    if (signature.startsWith('resource-manager org-policies enable-enforce ')) {
      const constraint = command.args[3]!;
      (state.blockedPolicies ??= new Set()).add(constraint);
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
      const outputFile = command.args[4]!;
      await mkdir(path.dirname(outputFile), { recursive: true, mode: 0o700 });
      if (state.blockedPolicies && state.blockedPolicies.size > 0) {
        await writeFile(outputFile, '', { mode: 0o600 });
        return {
          stdout: '',
          stderr: 'FAILED_PRECONDITION: Key creation is not allowed on this service account.',
          exitCode: 1,
        };
      }
      const keyId = 'key-1';
      state.keys.add(keyId);
      await writeFile(outputFile, credentialContents(keyId), { mode: 0o600 });
      state.mutations.push(signature);
      return ok('{}');
    }
    throw new Error(`Unexpected gcloud command: ${signature}`);
  };
}

const INSTANCE_ID = '12345678-1234-4234-8234-123456789abc';
const PROJECT_ID = deriveGcpProjectId(INSTANCE_ID);
const SERVICE_ACCOUNT = `gws-ea-chat@${PROJECT_ID}.iam.gserviceaccount.com`;

function credentialContents(keyId = 'key-1'): string {
  return JSON.stringify({
    type: 'service_account',
    project_id: PROJECT_ID,
    private_key_id: keyId,
    private_key: '-----BEGIN PRIVATE KEY-----\ntest\n-----END PRIVATE KEY-----\n',
    client_email: SERVICE_ACCOUNT,
    client_id: '123',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/gws-ea-chat',
    universe_domain: 'googleapis.com',
  });
}

function readyState(overrides: Partial<FakeGcpState> = {}): FakeGcpState {
  return {
    project: true,
    lifecycle: 'ACTIVE',
    labels: { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' },
    api: true,
    serviceAccount: true,
    keys: new Set(),
    mutations: [],
    ...overrides,
  };
}

function projectInput(root: string, credentialFile = path.join(root, 'secrets', 'gchat.json')) {
  return {
    instanceId: INSTANCE_ID,
    projectId: PROJECT_ID,
    account: 'operator@example.com',
    serviceAccountEmail: SERVICE_ACCOUNT,
    credentialFile,
    cwd: root,
  };
}

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
    const runCommand = fakeRunner(state);
    const input = {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      account: 'operator@example.com',
      serviceAccountEmail: SERVICE_ACCOUNT,
      credentialFile,
      cwd: root,
    };

    await expect(probeGcpProjectForCreate(input, { runCommand })).resolves.toBe(false);
    await reconcileGcpProject(input, { runCommand });
    expect(await verifyGcpProject(input, { runCommand })).toBe(true);
    const firstMutations = [...state.mutations];
    await reconcileGcpProject(input, { runCommand });
    expect(state.mutations).toEqual(firstMutations);
    expect(firstMutations).toHaveLength(6);
    expect(firstMutations.every((args) => args.includes('--account=operator@example.com'))).toBe(true);
    expect(
      firstMutations.filter((args) => !args.startsWith('projects create ')).every((args) => args.includes(PROJECT_ID)),
    ).toBe(true);
  });

  it('overrides only enforced key-creation policies on the dedicated project', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const state = readyState({
      blockedPolicies: new Set([
        'iam.disableServiceAccountKeyCreation',
        'iam.managed.disableServiceAccountKeyCreation',
      ]),
    });
    const progress: string[] = [];

    await reconcileGcpProject(input, {
      runCommand: fakeRunner(state),
      onProgress: (event) => void progress.push(event.resource),
    });

    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
    expect(
      state.mutations.filter((entry) => entry.startsWith('resource-manager org-policies disable-enforce ')),
    ).toEqual([
      expect.stringContaining('iam.disableServiceAccountKeyCreation'),
      expect.stringContaining('iam.managed.disableServiceAccountKeyCreation'),
    ]);
    expect(
      state.mutations.filter((entry) => entry.startsWith('resource-manager org-policies enable-enforce ')),
    ).toEqual([
      expect.stringContaining('iam.disableServiceAccountKeyCreation'),
      expect.stringContaining('iam.managed.disableServiceAccountKeyCreation'),
    ]);
    expect(progress).toContain('credential-policy');
    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
  });

  it('recovers a zero-byte credential left by a failed gcloud key request', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    await mkdir(path.dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(input.credentialFile, '', { mode: 0o600 });
    const state = readyState();

    await reconcileGcpProject(input, { runCommand: fakeRunner(state) });

    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
  });

  it('cleans failed staged key output without publishing it as the credential', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const stagingFile = `${input.credentialFile}.staging`;
    const state = readyState();
    const fallback = fakeRunner(state);
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 4).join(' ') === 'iam service-accounts keys create') {
        const outputFile = command.args[4]!;
        await writeFile(outputFile, '', { mode: 0o600 });
        return {
          stdout: '',
          stderr: 'FAILED_PRECONDITION: Key creation is not allowed on this service account.',
          exitCode: 1,
        };
      }
      return fallback(command);
    };

    await expect(reconcileGcpProject(input, { runCommand })).rejects.toMatchObject({ code: 'gcloud_failed' });

    await expect(stat(input.credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(stagingFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('publishes a valid staged credential after an interrupted successful key request', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    await mkdir(path.dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(`${input.credentialFile}.staging`, credentialContents('staged-key'), { mode: 0o600 });
    const state = readyState({ keys: new Set(['staged-key']) });

    await reconcileGcpProject(input, { runCommand: fakeRunner(state) });

    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
    await expect(stat(`${input.credentialFile}.staging`)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.mutations).toEqual([
      expect.stringContaining('resource-manager org-policies enable-enforce iam.disableServiceAccountKeyCreation'),
      expect.stringContaining(
        'resource-manager org-policies enable-enforce iam.managed.disableServiceAccountKeyCreation',
      ),
    ]);
  });

  it('preserves a valid staged credential while its remote key remains hidden', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const stagingFile = `${input.credentialFile}.staging`;
    await mkdir(path.dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(stagingFile, credentialContents('staged-key'), { mode: 0o600 });
    const state = readyState();

    await expect(
      reconcileGcpProject(input, { runCommand: fakeRunner(state), sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: 'gcp_key_pending' });

    await expect(stat(stagingFile)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(input.credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.mutations.some((entry) => entry.startsWith('iam service-accounts keys create '))).toBe(false);

    state.keys.add('staged-key');
    await reconcileGcpProject(input, { runCommand: fakeRunner(state) });
    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
    await expect(stat(stagingFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('recovers a valid staged credential after an ambiguous key-create failure', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const stagingFile = `${input.credentialFile}.staging`;
    const state = readyState();
    const fallback = fakeRunner(state);
    let creates = 0;
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 4).join(' ') === 'iam service-accounts keys create') {
        creates += 1;
        await mkdir(path.dirname(stagingFile), { recursive: true, mode: 0o700 });
        await writeFile(stagingFile, credentialContents('ambiguous-key'), { mode: 0o600 });
        state.keys.add('ambiguous-key');
        return { stdout: '', stderr: 'connection closed after remote commit', exitCode: 1 };
      }
      return fallback(command);
    };

    await expect(reconcileGcpProject(input, { runCommand })).rejects.toMatchObject({ code: 'gcloud_failed' });
    await reconcileGcpProject(input, { runCommand });

    expect(creates).toBe(1);
    expect(await verifyGcpProject(input, { runCommand })).toBe(true);
    await expect(stat(stagingFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('distinguishes policy permission failures from other update failures', async () => {
    const runCase = async (stderr: string, expectedCode: string) => {
      const root = await tempRoot();
      const input = projectInput(root);
      const state = readyState({ blockedPolicies: new Set(['iam.disableServiceAccountKeyCreation']) });
      const fallback = fakeRunner(state);
      const runCommand: GcloudCommandRunner = async (command) =>
        command.args.slice(0, 3).join(' ') === 'resource-manager org-policies disable-enforce'
          ? { stdout: '', stderr, exitCode: 1 }
          : fallback(command);

      await expect(reconcileGcpProject(input, { runCommand })).rejects.toMatchObject({ code: expectedCode });
      expect(state.mutations.some((entry) => entry.startsWith('iam service-accounts keys create '))).toBe(false);
    };

    await runCase('PERMISSION_DENIED: denied', 'gcp_policy_permission_required');
    await runCase('UNAVAILABLE: service unavailable', 'gcloud_failed');
  });

  it('does not create a key before a policy change becomes effective', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const state = readyState({ blockedPolicies: new Set(['iam.disableServiceAccountKeyCreation']) });
    const fallback = fakeRunner(state);
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 3).join(' ') === 'resource-manager org-policies disable-enforce') {
        state.mutations.push(command.args.join(' '));
        return { stdout: '{}', stderr: '', exitCode: 0 };
      }
      return fallback(command);
    };

    await expect(reconcileGcpProject(input, { runCommand, sleep: async () => undefined })).rejects.toMatchObject({
      code: 'gcp_policy_pending',
    });
    expect(state.mutations.some((entry) => entry.startsWith('iam service-accounts keys create '))).toBe(false);
  });

  it('resumes policy restoration after the credential is published', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const stagingFile = `${input.credentialFile}.staging`;
    await mkdir(path.dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(stagingFile, credentialContents('staged-key'), { mode: 0o600 });
    const state = readyState({ keys: new Set(['staged-key']) });
    const fallback = fakeRunner(state);
    const stalePolicyRunner: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 3).join(' ') === 'resource-manager org-policies enable-enforce') {
        state.mutations.push(command.args.join(' '));
        return { stdout: '{}', stderr: '', exitCode: 0 };
      }
      return fallback(command);
    };

    await expect(
      reconcileGcpProject(input, { runCommand: stalePolicyRunner, sleep: async () => undefined }),
    ).rejects.toMatchObject({ code: 'gcp_policy_pending' });

    await expect(stat(input.credentialFile)).resolves.toMatchObject({ mode: expect.any(Number) });
    await expect(stat(stagingFile)).resolves.toMatchObject({ mode: expect.any(Number) });

    await reconcileGcpProject(input, { runCommand: fakeRunner(state) });
    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
    await expect(stat(stagingFile)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
  });

  it('waits for every created GCP resource to become readable without replaying mutations', async () => {
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
    const fallback = fakeRunner(state);
    const sleeps: number[] = [];
    const progress: string[] = [];
    const staleReads = { project: 1, apis: 1, serviceAccount: 2, serviceAccountKeys: 1, createdKey: 1 };
    let projectCreated = false;
    let apisEnabled = false;
    let serviceAccountCreated = false;
    let keyCreated = false;
    const runCommand: GcloudCommandRunner = async (command) => {
      const signature = command.args.join(' ');
      if (projectCreated && signature.startsWith('projects describe ') && staleReads.project > 0) {
        staleReads.project -= 1;
        return { stdout: '', stderr: 'NOT_FOUND: resource was not found', exitCode: 1 };
      }
      if (apisEnabled && signature.startsWith('services list ') && staleReads.apis > 0) {
        staleReads.apis -= 1;
        return { stdout: '', stderr: '', exitCode: 0 };
      }
      if (
        serviceAccountCreated &&
        signature.startsWith('iam service-accounts describe ') &&
        staleReads.serviceAccount > 0
      ) {
        staleReads.serviceAccount -= 1;
        return { stdout: '', stderr: 'NOT_FOUND: resource was not found', exitCode: 1 };
      }
      if (
        serviceAccountCreated &&
        !keyCreated &&
        signature.startsWith('iam service-accounts keys list ') &&
        staleReads.serviceAccountKeys > 0
      ) {
        staleReads.serviceAccountKeys -= 1;
        return { stdout: '', stderr: 'NOT_FOUND: resource was not found', exitCode: 1 };
      }
      if (keyCreated && signature.startsWith('iam service-accounts keys list ') && staleReads.createdKey > 0) {
        staleReads.createdKey -= 1;
        return { stdout: '[]', stderr: '', exitCode: 0 };
      }
      const result = await fallback(command);
      if (signature.startsWith('projects create ')) projectCreated = true;
      if (signature.startsWith('services enable ')) apisEnabled = true;
      if (signature.startsWith('iam service-accounts create ')) serviceAccountCreated = true;
      if (signature.startsWith('iam service-accounts keys create ')) keyCreated = true;
      return result;
    };
    const input = {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      account: 'operator@example.com',
      serviceAccountEmail: SERVICE_ACCOUNT,
      credentialFile,
      cwd: root,
    };
    const dependencies = {
      runCommand,
      sleep: async (delayMs: number) => void sleeps.push(delayMs),
      onProgress: (event: GcloudProgressEvent) => void progress.push(event.resource),
    };

    await reconcileGcpProject(input, dependencies);

    expect(sleeps).toEqual([1_000, 1_000, 1_000, 2_000, 1_000, 1_000]);
    expect(progress).toEqual([
      'project',
      'apis',
      'service-account',
      'service-account-keys',
      'credential-key',
      'credential-policy',
    ]);
    expect(state.mutations).toHaveLength(6);
    expect(await verifyGcpProject(input, { runCommand })).toBe(true);
    const firstMutations = [...state.mutations];
    const firstSleeps = [...sleeps];

    await reconcileGcpProject(input, dependencies);

    expect(state.mutations).toEqual(firstMutations);
    expect(sleeps).toEqual(firstSleeps);
    expect(progress).toHaveLength(6);
  });

  it('uses project creation to resolve an access-denied missing-project probe', async () => {
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
    const fallback = fakeRunner(state);
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args[0] === 'projects' && command.args[1] === 'describe' && !state.project) {
        return {
          stdout: '',
          stderr: 'The caller does not have permission to access this project (or it may not exist).',
          exitCode: 1,
        };
      }
      return fallback(command);
    };
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
    expect(state.mutations.some((args) => args.startsWith('projects create '))).toBe(true);
  });

  it('does not treat access denial as absence during project removal', async () => {
    const root = await tempRoot();
    const input = {
      instanceId: INSTANCE_ID,
      projectId: PROJECT_ID,
      account: 'operator@example.com',
      serviceAccountEmail: SERVICE_ACCOUNT,
      credentialFile: path.join(root, 'secrets', 'gchat.json'),
      cwd: root,
    };
    const runCommand: GcloudCommandRunner = async () => ({
      stdout: '',
      stderr: 'The caller does not have permission to access this project (or it may not exist).',
      exitCode: 1,
    });

    await expect(verifyGcpProject(input, { runCommand })).rejects.toMatchObject({ code: 'gcloud_failed' });
    await expect(
      deleteOwnedGcpProject(
        { instanceId: INSTANCE_ID, projectId: PROJECT_ID, account: 'operator@example.com', cwd: root },
        { runCommand },
      ),
    ).rejects.toMatchObject({ code: 'gcloud_failed' });
  });

  it('fails closed when an access-denied project probe collides during creation', async () => {
    const root = await tempRoot();
    const commands: string[] = [];
    const runCommand: GcloudCommandRunner = async (command) => {
      const signature = command.args.join(' ');
      commands.push(signature);
      if (signature.startsWith('projects describe ')) {
        return {
          stdout: '',
          stderr: 'The caller does not have permission to access this project (or it may not exist).',
          exitCode: 1,
        };
      }
      if (signature.startsWith('projects create ')) {
        return { stdout: '', stderr: 'ALREADY_EXISTS: Requested entity already exists', exitCode: 1 };
      }
      throw new Error(`Unexpected gcloud command: ${signature}`);
    };

    await expect(
      reconcileGcpProject(
        {
          instanceId: INSTANCE_ID,
          projectId: PROJECT_ID,
          account: 'operator@example.com',
          serviceAccountEmail: SERVICE_ACCOUNT,
          credentialFile: path.join(root, 'secrets', 'gchat.json'),
          cwd: root,
        },
        { runCommand },
      ),
    ).rejects.toMatchObject({ code: 'gcloud_failed' });

    expect(commands).toHaveLength(2);
    expect(commands[1]).toMatch(/^projects create /u);
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
        { runCommand: fakeRunner(state) },
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
        { runCommand: fakeRunner(state) },
      ),
    ).rejects.toMatchObject({ code: 'gcp_project_owner_mismatch' });
    expect(state.mutations).toEqual([]);
  });

  it('requests deletion only after ownership verification and treats a repeated delete as complete', async () => {
    const root = await tempRoot();
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
    const runCommand = fakeRunner(state);

    await deleteOwnedGcpProject(input, { runCommand });
    await deleteOwnedGcpProject(input, { runCommand });
    expect(state.lifecycle).toBe('DELETE_REQUESTED');
    expect(state.mutations.filter((args) => args.startsWith('projects delete '))).toHaveLength(1);
  });

  it('refuses project deletion when the instance ownership label differs', async () => {
    const root = await tempRoot();
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
        { runCommand: fakeRunner(state) },
      ),
    ).rejects.toMatchObject({ code: 'gcp_project_owner_mismatch' });
    expect(state.mutations).toEqual([]);
  });

  it('does not complete removal when Google Cloud leaves the project active after delete', async () => {
    const root = await tempRoot();
    const state: FakeGcpState = {
      project: true,
      lifecycle: 'ACTIVE',
      labels: { 'gws-ea-instance': INSTANCE_ID, 'gws-ea-managed': 'true' },
      api: true,
      serviceAccount: true,
      keys: new Set(),
      mutations: [],
    };
    const fallback = fakeRunner(state);
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
