import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SignInRequired } from './events.js';
import {
  activeGcloudAccount,
  assertGcloudInstalled,
  assertGcloudSignedIn,
  classifyGcloudFailure,
  deleteOwnedGcpProject,
  deriveGcpProjectId,
  isConsumerGoogleAccount,
  probeGcpProjectForCreate,
  reconcileGcpProject,
  verifyGcpProject,
  type GcloudCommandRunner,
  type GcloudFailureClass,
  type GcloudProgressEvent,
} from './gcloud.js';
import { allocateInstanceId } from './registry.js';
import { GwsEaError } from './types.js';

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
  projectPolicies?: Map<string, boolean>;
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
    if (signature.startsWith('services list ')) {
      return ok(state.api ? 'chat.googleapis.com\niam.googleapis.com\norgpolicy.googleapis.com\n' : '');
    }
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
    if (signature.startsWith('org-policies describe ')) {
      const constraint = command.args[2]!;
      const effective = command.args.includes('--effective');
      const enforced = effective ? state.blockedPolicies?.has(constraint) : state.projectPolicies?.get(constraint);
      if (enforced === undefined) return missing();
      return ok(
        JSON.stringify({
          name: `projects/${PROJECT_ID}/policies/${constraint}`,
          spec: {
            ...(effective ? {} : { etag: 'test-etag' }),
            rules: [{ enforce: enforced }],
          },
        }),
      );
    }
    if (signature.startsWith('org-policies set-policy ')) {
      const policy = JSON.parse(await readFile(command.args[2]!, 'utf8')) as {
        name: string;
        spec: { etag?: string; rules: [{ enforce: boolean }] };
      };
      const constraint = policy.name.split('/').at(-1)!;
      const expectedEtag = state.projectPolicies?.has(constraint) ? 'test-etag' : undefined;
      if (policy.spec.etag !== expectedEtag) throw new Error('Incorrect V2 policy etag');
      (state.projectPolicies ??= new Map()).set(constraint, policy.spec.rules[0].enforce);
      if (policy.spec.rules[0].enforce) (state.blockedPolicies ??= new Set()).add(constraint);
      else state.blockedPolicies?.delete(constraint);
      state.mutations.push(`${signature} name=${policy.name} enforced=${policy.spec.rules[0].enforce}`);
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

// Recorded gcloud stderr, as Google Cloud SDK prints it.
const REAUTHENTICATION_FAILED = [
  'ERROR: (gcloud.auth.print-access-token) There was a problem refreshing your current auth tokens: Reauthentication failed. cannot prompt during non-interactive execution.',
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');
const TOKEN_REFRESH_FAILED = [
  "ERROR: (gcloud.projects.describe) There was a problem refreshing auth tokens for account operator@example.com: ('invalid_grant: Bad Request', {'error': 'invalid_grant', 'error_description': 'Bad Request'})",
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');
const NO_ACTIVE_ACCOUNT = [
  'ERROR: (gcloud.projects.list) You do not currently have an active account selected.',
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');
const CONNECTION_FAILED =
  'ERROR: (gcloud.auth.print-access-token) There was a problem connecting: [Errno 8] nodename nor servname provided, or not known';

describe('gcloud failure classification', () => {
  it.each<[string, string, GcloudFailureClass]>([
    ['a failed reauthentication', REAUTHENTICATION_FAILED, 'auth-required'],
    ['a token that no longer refreshes', TOKEN_REFRESH_FAILED, 'auth-required'],
    ['no active account', NO_ACTIVE_ACCOUNT, 'auth-required'],
    [
      'an account without credentials',
      'ERROR: (gcloud.auth.print-access-token) Your current active account [operator@example.com] does not have any valid credentials',
      'auth-required',
    ],
    ['a reauthentication demand', 'ERROR: (gcloud.projects.describe) Reauthentication required.', 'auth-required'],
    [
      'rejected credentials',
      'ERROR: (gcloud.projects.describe) UNAUTHENTICATED: Request had invalid authentication credentials.',
      'auth-required',
    ],
    [
      'a project Google will not confirm exists',
      'ERROR: (gcloud.projects.describe) [operator@example.com] does not have permission to access projects instance [gws-ea-12345678123442348234] (or it may not exist): The caller does not have permission. This command is authenticated as operator@example.com which is the active account specified by the [core/account] property.',
      'permission-or-missing',
    ],
    [
      'a denied permission on a resource that may not exist',
      "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED: Permission 'iam.serviceAccounts.get' denied on resource (or it may not exist).",
      'permission-or-missing',
    ],
    [
      'a missing resource',
      'ERROR: (gcloud.iam.service-accounts.describe) NOT_FOUND: Unknown service account',
      'permission-or-missing',
    ],
    [
      'blocked key creation',
      [
        'ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account.',
        "- '@type': type.googleapis.com/google.rpc.PreconditionFailure",
        '  violations:',
        '  - description: Key creation is not allowed on this service account.',
        '    type: constraints/iam.disableServiceAccountKeyCreation',
      ].join('\n'),
      'precondition',
    ],
    ['a connection failure', CONNECTION_FAILED, 'anything-else'],
    ['exhausted quota', 'ERROR: (gcloud.projects.create) RESOURCE_EXHAUSTED: Quota exceeded.', 'anything-else'],
    ['a crash', 'ERROR: gcloud crashed (TypeError): unsupported operand', 'anything-else'],
    ['silence', '', 'anything-else'],
  ])('classifies %s', (_case, stderr, expected) => {
    expect(classifyGcloudFailure({ stdout: '', stderr, exitCode: 1 })).toBe(expected);
  });
});

describe('Google account kind', () => {
  it.each([
    ['operator@gmail.com', true],
    ['Operator@GoogleMail.com', true],
    ['operator@example.com', false],
    ['gmail.com@example.com', false],
  ])('%s is a consumer account: %s', (email, consumer) => {
    expect(isConsumerGoogleAccount(email)).toBe(consumer);
  });
});

describe('Google Cloud provisioning', () => {
  it('checks the reserved account on resume even when another account is active', async () => {
    const commands: string[][] = [];
    const account = 'reserved@example.com';

    await assertGcloudSignedIn(account, async (command) => {
      commands.push([...command.args]);
      return { stdout: 'discard-me', stderr: '', exitCode: 0 };
    });

    expect(commands).toEqual([['auth', 'print-access-token', `--account=${account}`, '--quiet']]);
  });

  it('asks for sign-in when the reserved account cannot refresh its token', async () => {
    const failure = await assertGcloudSignedIn('reserved@example.com', async () => ({
      stdout: '',
      stderr: REAUTHENTICATION_FAILED,
      exitCode: 1,
    })).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({
      code: 'gcloud_auth_required',
      message: expect.stringContaining('reserved@example.com'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('Reauthentication failed') },
    });
  });

  it('reports any other token failure as the failed command, not as a sign-in', async () => {
    const failure = await assertGcloudSignedIn('reserved@example.com', async () => ({
      stdout: '',
      stderr: CONNECTION_FAILED,
      exitCode: 1,
    })).catch((error: unknown) => error);

    expect(failure).not.toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({
      code: 'command_failed',
      message: expect.stringContaining('gcloud auth print-access-token --account=reserved@example.com'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('There was a problem connecting') },
    });
  });

  it('names the signed-in account, or none', async () => {
    const commands: string[][] = [];
    const answer =
      (stdout: string): GcloudCommandRunner =>
      async (command) => {
        commands.push([...command.args]);
        return { stdout, stderr: '', exitCode: 0 };
      };

    await expect(activeGcloudAccount(answer('operator@example.com\n'))).resolves.toBe('operator@example.com');
    await expect(activeGcloudAccount(answer(''))).resolves.toBeUndefined();
    expect(commands[0]).toEqual(['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  });

  it('fails with one actionable install message when gcloud is unavailable', async () => {
    const missing = assertGcloudInstalled(async () => {
      throw new GwsEaError('executable_not_found', 'gcloud was not found on PATH', {
        details: { program: 'gcloud', searched: ['/usr/bin'] },
      });
    });

    await expect(missing).rejects.toMatchObject({
      code: 'gcloud_required',
      message: expect.stringContaining('https://cloud.google.com/sdk/docs/install'),
      details: { searched: ['/usr/bin'] },
    });
    await expect(
      assertGcloudInstalled(async () => ({ stdout: '{}', stderr: '', exitCode: 0 })),
    ).resolves.toBeUndefined();
  });

  it('asks for sign-in when a step finds the sign-in expired, instead of a generic project error', async () => {
    const root = await tempRoot();
    const state = readyState();
    const fallback = fakeRunner(state);

    const failure = await reconcileGcpProject(projectInput(root), {
      runCommand: async (command) =>
        command.args[0] === 'projects' && command.args[1] === 'describe'
          ? { stdout: '', stderr: TOKEN_REFRESH_FAILED, exitCode: 1 }
          : fallback(command),
      sleep: async () => undefined,
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({ message: expect.stringContaining('operator@example.com') });
    expect(state.mutations).toEqual([]);
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
    expect(firstMutations.find((entry) => entry.startsWith('services enable '))).toContain('orgpolicy.googleapis.com');
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
      state.mutations.filter(
        (entry) => entry.startsWith('org-policies set-policy ') && entry.endsWith('enforced=false'),
      ),
    ).toEqual([
      expect.stringContaining('iam.disableServiceAccountKeyCreation'),
      expect.stringContaining('iam.managed.disableServiceAccountKeyCreation'),
    ]);
    expect(
      state.mutations.filter(
        (entry) => entry.startsWith('org-policies set-policy ') && entry.endsWith('enforced=true'),
      ),
    ).toEqual([
      expect.stringContaining('iam.disableServiceAccountKeyCreation'),
      expect.stringContaining('iam.managed.disableServiceAccountKeyCreation'),
    ]);
    expect(progress).toContain('credential-policy');
    expect(await verifyGcpProject(input, { runCommand: fakeRunner(state) })).toBe(true);
  });

  it('restores a managed key-creation policy through V2 after publishing the Chat credential', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    await mkdir(path.dirname(input.credentialFile), { recursive: true, mode: 0o700 });
    await writeFile(input.credentialFile, credentialContents('existing-key'), { mode: 0o600 });
    const state = readyState({
      keys: new Set(['existing-key']),
      blockedPolicies: new Set(['iam.disableServiceAccountKeyCreation']),
      projectPolicies: new Map([['iam.managed.disableServiceAccountKeyCreation', false]]),
    });
    await expect(probeGcpProjectForCreate(input, { runCommand: fakeRunner(state) })).resolves.toBe(false);
    await reconcileGcpProject(input, { runCommand: fakeRunner(state) });

    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
    expect(state.projectPolicies?.get('iam.managed.disableServiceAccountKeyCreation')).toBe(true);
    expect(state.mutations).toEqual([
      expect.stringContaining('policies/iam.managed.disableServiceAccountKeyCreation enforced=true'),
    ]);
    expect(state.mutations.some((entry) => entry.startsWith('iam service-accounts keys create '))).toBe(false);
  });

  it('restores key-creation restrictions after key creation fails', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const state = readyState({ blockedPolicies: new Set(['iam.disableServiceAccountKeyCreation']) });
    const fallback = fakeRunner(state);
    const failedKeyRunner: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 4).join(' ') === 'iam service-accounts keys create') {
        return { stdout: '', stderr: 'PERMISSION_DENIED', exitCode: 1 };
      }
      return fallback(command);
    };

    await expect(reconcileGcpProject(input, { runCommand: failedKeyRunner })).rejects.toMatchObject({
      code: 'gcloud_failed',
    });
    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
    expect(state.keys.size).toBe(0);
  });

  it('restores a restriction when disabling the next one fails', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const state = readyState({
      blockedPolicies: new Set([
        'iam.disableServiceAccountKeyCreation',
        'iam.managed.disableServiceAccountKeyCreation',
      ]),
    });
    const fallback = fakeRunner(state);
    const partialFailureRunner: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 2).join(' ') === 'org-policies set-policy') {
        const policy = JSON.parse(await readFile(command.args[2]!, 'utf8')) as {
          name: string;
          spec: { rules: [{ enforce: boolean }] };
        };
        if (policy.name.endsWith('/iam.managed.disableServiceAccountKeyCreation') && !policy.spec.rules[0].enforce) {
          return { stdout: '', stderr: 'PERMISSION_DENIED', exitCode: 1 };
        }
      }
      return fallback(command);
    };

    await expect(reconcileGcpProject(input, { runCommand: partialFailureRunner })).rejects.toMatchObject({
      code: 'gcp_policy_permission_required',
    });
    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
    expect(state.keys.size).toBe(0);
  });

  it('restores restrictions before reporting a remote key without local private material', async () => {
    const root = await tempRoot();
    const input = projectInput(root);
    const state = readyState({ keys: new Set(['orphan-key']), blockedPolicies: new Set() });

    await expect(reconcileGcpProject(input, { runCommand: fakeRunner(state) })).rejects.toMatchObject({
      code: 'gcp_key_recovery_required',
    });
    expect(state.blockedPolicies).toEqual(
      new Set(['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation']),
    );
    expect(state.mutations.some((entry) => entry.startsWith('iam service-accounts keys create '))).toBe(false);
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
      expect.stringContaining('policies/iam.disableServiceAccountKeyCreation enforced=true'),
      expect.stringContaining('policies/iam.managed.disableServiceAccountKeyCreation enforced=true'),
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
        command.args.slice(0, 2).join(' ') === 'org-policies set-policy'
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
      if (command.args.slice(0, 2).join(' ') === 'org-policies set-policy') {
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
      if (command.args.slice(0, 2).join(' ') === 'org-policies set-policy') {
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
    expect(state.mutations.every((mutation) => mutation.includes('enforced=true'))).toBe(true);
    expect(state.mutations.some((mutation) => mutation.startsWith('iam service-accounts keys create '))).toBe(false);
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
