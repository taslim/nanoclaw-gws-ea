import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SignInRequired, type RunEvent } from './events.js';
import { RECORDED_GCLOUD_REAUTHENTICATION_FAILED } from './fixtures/recordings.js';
import {
  activeGcloudAccount,
  assertGcloudInstalled,
  assertGcloudSignedIn,
  classifyGcloudFailure,
  deleteOwnedGcpProject,
  deriveGchatServiceAccountEmail,
  deriveGcpProjectId,
  googleCloudResources,
  isConsumerGoogleAccount,
  parseGchatServiceAccountCredential,
  restoreKeyCreationPolicyForRemoval,
  type GcloudCommandRunner,
  type GcloudFailureClass,
  type GcpProjectCoordinates,
  type GcpProjectInput,
  type GcpStepContext,
} from './gcloud.js';
import { readProvisionJournal, withInstanceOperation, type ProvisionJournal } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import {
  OBSERVATION_WAITS_SECONDS,
  PRESENT,
  runProvisionSteps,
  type ProvisionResult,
  type ProvisionStep,
  type ProvisionSteps,
} from './phases.js';
import type { SanitizedCommandOutcome } from './process.js';
import { allocateInstanceId, reserveInstance } from './registry.js';
import { GwsEaError, PROVISION_STEPS } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-gcloud-'));
  roots.push(root);
  return root;
}

const ACCOUNT = 'operator@example.com';
const FULL_WAIT = OBSERVATION_WAITS_SECONDS.map((seconds) => seconds * 1_000);
const KEY_CONSTRAINTS = ['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation'];

// Recorded live (fixtures/README.md): an expired sign-in, behind the Python warning that gcloud prints first.
const REAUTHENTICATION_FAILED = RECORDED_GCLOUD_REAUTHENTICATION_FAILED.stderr;
const PYTHON_WARNING = REAUTHENTICATION_FAILED.slice(0, REAUTHENTICATION_FAILED.indexOf('ERROR:'));
// gcloud stderr in the Cloud SDK's wordings, not recorded live.
const TOKEN_REFRESH_FAILED = [
  `ERROR: (gcloud.projects.describe) There was a problem refreshing auth tokens for account ${ACCOUNT}: ('invalid_grant: Bad Request', {'error': 'invalid_grant', 'error_description': 'Bad Request'})`,
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
const GCLOUD_CRASHED = [
  'ERROR: gcloud crashed (TypeError): unsupported operand type(s) for +: NoneType and str',
  '',
  'If you would like to report this issue, please run the following command:',
  '  gcloud feedback',
].join('\n');

function projectNotVisible(projectId: string): string {
  return `ERROR: (gcloud.projects.describe) [${ACCOUNT}] does not have permission to access projects instance [${projectId}] (or it may not exist): The caller does not have permission. This command is authenticated as ${ACCOUNT} which is the active account specified by the [core/account] property.`;
}

function keyCreationRefused(projectId: string, email: string, constraint: string): string {
  return [
    'ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account.',
    "- '@type': type.googleapis.com/google.rpc.PreconditionFailure",
    '  violations:',
    '  - description: Key creation is not allowed on this service account.',
    `    subject: projects/${projectId}?configvalue=${email}`,
    `    type: constraints/${constraint}`,
  ].join('\n');
}

function ok(stdout = '', stderr = ''): SanitizedCommandOutcome {
  return { stdout, stderr, exitCode: 0 };
}

function failed(stderr: string): SanitizedCommandOutcome {
  return { stdout: '', stderr, exitCode: 1 };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** A service-account key file as `gcloud iam service-accounts keys create` writes it. */
function keyFile(projectId: string, email: string, keyId: string, extra: Record<string, unknown> = {}): string {
  return json({
    type: 'service_account',
    project_id: projectId,
    private_key_id: keyId,
    private_key:
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n',
    client_email: email,
    client_id: '104285714592231180044',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`,
    universe_domain: 'googleapis.com',
    ...extra,
  });
}

/**
 * One Google Cloud organization as gcloud reports it. It answers only the
 * exact commands an operator could rerun from the log, run as the reserved
 * account and non-interactively, and holds the state those commands change.
 */
class FakeGoogleCloud {
  project: { labels: Record<string, string>; lifecycleState: string } | undefined;
  /** Describes that still answer 403 for a project that exists, while access propagates. */
  hiddenProjectReads = 0;
  readonly enabled = new Set([
    'bigquery.googleapis.com',
    'cloudapis.googleapis.com',
    'logging.googleapis.com',
    'monitoring.googleapis.com',
    'serviceusage.googleapis.com',
    'storage.googleapis.com',
  ]);
  serviceAccount: { displayName: string; description: string } | undefined;
  /** Lists that still omit the Chat service account after it was created. */
  unlistedServiceAccountReads = 0;
  readonly userKeys = new Set<string>();
  readonly systemKeys = new Set(['e2c7a91f06b4d358ac19f0e7b6d2c4a8f1e3b5d7']);
  /** Key-creation constraints the organization enforces. */
  readonly orgEnforced = new Set<string>();
  readonly projectPolicies = new Map<string, boolean>();
  /** Key creations Google still refuses after a lift, while the change propagates. */
  policyLag = 0;
  canSetPolicy = true;
  readonly commands: string[] = [];
  readonly mutations: string[] = [];
  #keys = 0;

  constructor(readonly gcp: GcpProjectInput) {}

  readonly run: GcloudCommandRunner = async (command) => {
    expect(command.command).toBe('gcloud');
    expect(command.args.slice(-2)).toEqual([`--account=${ACCOUNT}`, '--quiet']);
    const words = command.args.slice(0, -2);
    const line = words.join(' ');
    this.commands.push(line);
    const { projectId: project, serviceAccountEmail: email } = this.gcp;
    const scoped = `--project=${project}`;

    if (line === `projects describe ${project} --format=json`) return this.#describeProject();
    if (line.startsWith(`projects create ${project} `)) return this.#createProject(words);
    if (line === `projects delete ${project}`) return this.#deleteProject();
    if (!this.project) {
      return failed(
        `ERROR: (gcloud.${words.slice(0, 3).join('.')}) PERMISSION_DENIED: Permission denied on resource project ${project}.`,
      );
    }
    if (line === `services list --enabled ${scoped} --format=value(config.name)`) {
      return ok([...this.enabled].sort().join('\n') + '\n');
    }
    if (line.startsWith('services enable ') && words.at(-1) === scoped) {
      for (const api of words.slice(2, -1)) this.enabled.add(api);
      this.mutations.push(line);
      return ok(
        '',
        'Operation "operations/acf.p2-441811502258-2c1f3f6e-9a5d-4bde-8a57-0c1d5e6f7a8b" finished successfully.\n',
      );
    }
    if (line === `iam service-accounts list ${scoped} --format=json`) return this.#listServiceAccounts();
    if (line.startsWith('iam service-accounts create gws-ea-chat ') && words.includes(scoped)) {
      return this.#createServiceAccount(words);
    }
    if (line === `iam service-accounts keys list --iam-account=${email} ${scoped} --managed-by=user --format=json`) {
      return this.#listKeys();
    }
    if (line.startsWith('iam service-accounts keys delete ') && line.endsWith(` --iam-account=${email} ${scoped}`)) {
      return this.#deleteKey(words[4]!);
    }
    if (
      line.startsWith('iam service-accounts keys create ') &&
      line.endsWith(` --iam-account=${email} --key-file-type=json ${scoped}`)
    ) {
      return this.#createKey(words[4]!);
    }
    if (line.startsWith('org-policies set-policy ') && words.at(-1) === scoped) return this.#setPolicy(words[2]!);
    throw new Error(`Unexpected gcloud command: ${line}`);
  };

  get projectDescription(): Record<string, unknown> {
    return {
      createTime: '2026-09-20T17:02:11.442Z',
      labels: this.project?.labels,
      lifecycleState: this.project?.lifecycleState,
      name: 'GWS-EA assistant',
      parent: { id: '281734958812', type: 'organization' },
      projectId: this.gcp.projectId,
      projectNumber: '441811502258',
    };
  }

  #describeProject(): SanitizedCommandOutcome {
    if (!this.project || this.hiddenProjectReads > 0) {
      if (this.project) this.hiddenProjectReads -= 1;
      return failed(projectNotVisible(this.gcp.projectId));
    }
    return ok(json(this.projectDescription));
  }

  #createProject(words: readonly string[]): SanitizedCommandOutcome {
    if (this.project) {
      return failed(
        'ERROR: (gcloud.projects.create) Project creation failed. The project ID you specified is already in use by another project. Please try an alternative ID.',
      );
    }
    const labels = words.find((word) => word.startsWith('--labels='))!.slice('--labels='.length);
    this.project = {
      labels: Object.fromEntries(labels.split(',').map((pair) => pair.split('=') as [string, string])),
      lifecycleState: 'ACTIVE',
    };
    this.mutations.push(words.join(' '));
    return ok(
      '',
      `Create in progress for [https://cloudresourcemanager.googleapis.com/v1/projects/${this.gcp.projectId}].\nWaiting for [operations/cp.5821036364185440018] to finish...done.\n`,
    );
  }

  #deleteProject(): SanitizedCommandOutcome {
    this.project!.lifecycleState = 'DELETE_REQUESTED';
    this.mutations.push(`projects delete ${this.gcp.projectId}`);
    return ok('', `Deleted [https://cloudresourcemanager.googleapis.com/v1/projects/${this.gcp.projectId}].\n`);
  }

  get serviceAccountDescription(): Record<string, unknown> {
    const { projectId, serviceAccountEmail } = this.gcp;
    return {
      description: this.serviceAccount?.description,
      displayName: this.serviceAccount?.displayName,
      email: serviceAccountEmail,
      etag: 'MDEwMjE5MjA=',
      name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`,
      oauth2ClientId: '104285714592231180044',
      projectId,
      uniqueId: '104285714592231180044',
    };
  }

  #listServiceAccounts(): SanitizedCommandOutcome {
    if (!this.serviceAccount || this.unlistedServiceAccountReads > 0) {
      if (this.serviceAccount) this.unlistedServiceAccountReads -= 1;
      return ok('[]\n');
    }
    return ok(json([this.serviceAccountDescription]));
  }

  #createServiceAccount(words: readonly string[]): SanitizedCommandOutcome {
    if (this.serviceAccount) {
      return failed(
        `ERROR: (gcloud.iam.service-accounts.create) Resource in projects [${this.gcp.projectId}] is the subject of a conflict: Service account gws-ea-chat already exists within project projects/${this.gcp.projectId}.`,
      );
    }
    const flag = (name: string): string => words.find((word) => word.startsWith(`--${name}=`))!.split('=')[1]!;
    this.serviceAccount = { displayName: flag('display-name'), description: flag('description') };
    this.mutations.push(words.join(' '));
    return ok(json(this.serviceAccountDescription), 'Created service account [gws-ea-chat].\n');
  }

  #listKeys(): SanitizedCommandOutcome {
    const { projectId, serviceAccountEmail } = this.gcp;
    if (!this.serviceAccount) {
      return failed(
        `ERROR: (gcloud.iam.service-accounts.keys.list) NOT_FOUND: Service account projects/${projectId}/serviceAccounts/${serviceAccountEmail} does not exist.`,
      );
    }
    return ok(
      json(
        [...this.userKeys].map((id) => ({
          keyAlgorithm: 'KEY_ALG_RSA_2048',
          keyOrigin: 'GOOGLE_PROVIDED',
          keyType: 'USER_MANAGED',
          name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}/keys/${id}`,
          validAfterTime: '2026-09-20T17:04:00Z',
          validBeforeTime: '9999-12-31T23:59:59Z',
        })),
      ),
    );
  }

  #deleteKey(id: string): SanitizedCommandOutcome {
    if (!this.userKeys.delete(id)) {
      return failed(
        `ERROR: (gcloud.iam.service-accounts.keys.delete) NOT_FOUND: Service account key ${id} does not exist.`,
      );
    }
    this.mutations.push(`keys delete ${id}`);
    return ok('', `deleted key [${id}] for service account [${this.gcp.serviceAccountEmail}]\n`);
  }

  async #createKey(file: string): Promise<SanitizedCommandOutcome> {
    const { projectId, serviceAccountEmail } = this.gcp;
    const enforced = KEY_CONSTRAINTS.find(
      (constraint) => this.projectPolicies.get(constraint) ?? this.orgEnforced.has(constraint),
    );
    const refusing = enforced ?? (this.policyLag > 0 ? KEY_CONSTRAINTS[0] : undefined);
    if (refusing) {
      if (!enforced) this.policyLag -= 1;
      // gcloud opens the output file before Google refuses the request.
      await writeFile(file, '', { mode: 0o600 });
      return failed(keyCreationRefused(projectId, serviceAccountEmail, refusing));
    }
    this.#keys += 1;
    const id = `${String(this.#keys).padStart(2, '0')}${'5f0c3e1a9b7d2468ace0'.repeat(2)}`.slice(0, 40);
    this.userKeys.add(id);
    await writeFile(file, keyFile(projectId, serviceAccountEmail, id), { mode: 0o600 });
    this.mutations.push(`keys create ${id}`);
    return ok('', `created key [${id}] of type [json] as [${file}] for [${serviceAccountEmail}]\n`);
  }

  async #setPolicy(file: string): Promise<SanitizedCommandOutcome> {
    const policy = JSON.parse(await readFile(file, 'utf8')) as {
      name: string;
      spec: { rules: { enforce: boolean }[] };
    };
    const [, project, , constraint] = policy.name.split('/');
    expect(project).toBe(this.gcp.projectId);
    expect(KEY_CONSTRAINTS).toContain(constraint);
    if (!this.canSetPolicy) {
      return failed(
        `ERROR: (gcloud.org-policies.set-policy) PERMISSION_DENIED: Permission 'orgpolicy.policies.create' denied on resource '//cloudresourcemanager.googleapis.com/projects/${this.gcp.projectId}' (or it may not exist).`,
      );
    }
    const enforce = policy.spec.rules[0]!.enforce;
    this.projectPolicies.set(constraint!, enforce);
    this.mutations.push(`set-policy ${constraint} enforce=${enforce}`);
    return ok('', `Updated policy [${policy.name}].\n`);
  }

  /** Everything provisioning creates, as the owner left it. */
  ready(): this {
    this.project = {
      labels: { 'gws-ea-instance': this.gcp.instanceId, 'gws-ea-managed': 'true' },
      lifecycleState: 'ACTIVE',
    };
    for (const api of ['chat.googleapis.com', 'iam.googleapis.com', 'orgpolicy.googleapis.com']) this.enabled.add(api);
    this.serviceAccount = {
      displayName: 'GWS-EA Google Chat',
      description: `Owned by GWS-EA instance ${this.gcp.instanceId}`,
    };
    return this;
  }
}

interface Harness {
  readonly cloud: FakeGoogleCloud;
  readonly gcp: GcpProjectInput;
  readonly staging: string;
  readonly sleeps: number[];
  readonly events: RunEvent[];
  readonly signIns: string[];
  /** Run `provision_gcp` through the step engine, as `create` and `resume` do. */
  run(runCommand?: GcloudCommandRunner): Promise<ProvisionResult>;
  journal(): Promise<ProvisionJournal>;
}

async function harness(): Promise<Harness> {
  const root = await tempRoot();
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = allocateInstanceId();
  const projectId = deriveGcpProjectId(instanceId);
  const serviceAccountEmail = deriveGchatServiceAccountEmail(projectId);
  await reserveInstance(paths, {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 32_001, onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://gcloud.example.test/webhook/gchat' },
      gcp_project_id: projectId,
      gcp_account: ACCOUNT,
      gchat_service_account: serviceAccountEmail,
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const gcp: GcpProjectInput = {
    instanceId,
    projectId,
    account: ACCOUNT,
    serviceAccountEmail,
    credentialFile: path.join(root, 'secrets', 'gchat.json'),
    cwd: root,
  };
  const cloud = new FakeGoogleCloud(gcp);
  const sleeps: number[] = [];
  const events: RunEvent[] = [];
  const signIns: string[] = [];
  const sleep = async (milliseconds: number): Promise<void> => void sleeps.push(milliseconds);
  const emit = (event: RunEvent): void => void events.push(event);
  const satisfied: ProvisionStep<GcpStepContext> = {
    label: 'Already satisfied…',
    resources: [{ name: 'nothing', observe: async () => PRESENT, apply: async () => undefined }],
  };
  return {
    cloud,
    gcp,
    staging: `${gcp.credentialFile}.staging`,
    sleeps,
    events,
    signIns,
    run: async (runCommand = cloud.run) => {
      const steps = {
        ...Object.fromEntries(PROVISION_STEPS.map((id) => [id, satisfied])),
        provision_gcp: {
          label: 'Configuring Google Cloud…',
          resources: googleCloudResources({
            runCommand,
            sleep,
            onWait: (reason) => emit({ type: 'step-waiting', step: 'provision_gcp', reason }),
          }),
        },
      } as ProvisionSteps<GcpStepContext>;
      const result = await withInstanceOperation(paths, instanceId, (operation) =>
        runProvisionSteps(operation, { operation, input: { gcp } }, steps, {
          sleep,
          emit,
          signIn: async () => void signIns.push(ACCOUNT),
        }),
      );
      if (!result) throw new Error('The instance operation was busy');
      return result;
    },
    journal: () => readProvisionJournal(paths, instanceId),
  };
}

async function writeCredential(file: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
}

async function publishedKeyId(gcp: GcpProjectInput): Promise<string> {
  const credential = await readFile(gcp.credentialFile, 'utf8');
  expect((await stat(gcp.credentialFile)).mode & 0o777).toBe(0o600);
  return parseGchatServiceAccountCredential(credential, gcp).privateKeyId;
}

describe('gcloud failure classification', () => {
  const cases: ReadonlyArray<readonly [string, string, GcloudFailureClass]> = [
    ['a failed reauthentication, as recorded', REAUTHENTICATION_FAILED, 'auth-required'],
    ['a token that no longer refreshes', TOKEN_REFRESH_FAILED, 'auth-required'],
    ['no active account', NO_ACTIVE_ACCOUNT, 'auth-required'],
    [
      'an account without credentials',
      `ERROR: (gcloud.auth.print-access-token) Your current active account [${ACCOUNT}] does not have any valid credentials`,
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
      projectNotVisible('gws-ea-12345678123442348234'),
      'permission-or-missing',
    ],
    [
      'a denied permission on a resource that may not exist',
      "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED: Permission 'iam.serviceAccounts.get' denied on resource (or it may not exist).",
      'permission-or-missing',
    ],
    [
      'a missing resource',
      'ERROR: (gcloud.iam.service-accounts.keys.list) NOT_FOUND: Service account projects/p/serviceAccounts/a@p.iam.gserviceaccount.com does not exist.',
      'permission-or-missing',
    ],
    [
      'blocked key creation',
      keyCreationRefused('p', 'a@p.iam.gserviceaccount.com', 'iam.disableServiceAccountKeyCreation'),
      'precondition',
    ],
    ['a connection failure', CONNECTION_FAILED, 'anything-else'],
    ['exhausted quota', 'ERROR: (gcloud.projects.create) RESOURCE_EXHAUSTED: Quota exceeded.', 'anything-else'],
    ['a crash', GCLOUD_CRASHED, 'anything-else'],
    ['silence', '', 'anything-else'],
  ];

  it.each(cases)('classifies %s', (_case, stderr, expected) => {
    expect(classifyGcloudFailure({ stdout: '', stderr, exitCode: 1 })).toBe(expected);
  });

  it('keeps the recorded Python warning ahead of the error', () => {
    expect(PYTHON_WARNING).toMatch(/^WARNING: {2}Python 3\.9\.x is no longer officially supported/u);
  });

  it.each(cases)('classifies %s behind the recorded Python warning', (_case, stderr, expected) => {
    expect(classifyGcloudFailure({ stdout: '', stderr: `${PYTHON_WARNING}${stderr}`, exitCode: 1 })).toBe(expected);
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

describe('gcloud sign-in and installation', () => {
  it('checks the reserved account on resume even when another account is active', async () => {
    const commands: string[][] = [];
    const account = 'reserved@example.com';

    await assertGcloudSignedIn(account, async (command) => {
      commands.push([...command.args]);
      return ok('discard-me');
    });

    expect(commands).toEqual([['auth', 'print-access-token', `--account=${account}`, '--quiet']]);
  });

  it('asks for sign-in when the reserved account cannot refresh its token', async () => {
    const failure = await assertGcloudSignedIn(
      'reserved@example.com',
      async () => RECORDED_GCLOUD_REAUTHENTICATION_FAILED,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({
      code: 'gcloud_auth_required',
      message: expect.stringContaining('reserved@example.com'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('Reauthentication failed') },
    });
  });

  it('reports any other token failure as the failed command, not as a sign-in', async () => {
    const failure = await assertGcloudSignedIn('reserved@example.com', async () => failed(CONNECTION_FAILED)).catch(
      (error: unknown) => error,
    );

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
        return ok(stdout);
      };

    await expect(activeGcloudAccount(answer(`${ACCOUNT}\n`))).resolves.toBe(ACCOUNT);
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
    await expect(assertGcloudInstalled(async () => ok('{}'))).resolves.toBeUndefined();
  });
});

describe('Google Chat service-account key', () => {
  const projectId = 'gws-ea-12345678123442348234';
  const email = deriveGchatServiceAccountEmail(projectId);
  const expected = { projectId, serviceAccountEmail: email };

  it('reads the fields it uses and tolerates fields it does not', () => {
    const minimal = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'key-1',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
      client_email: email,
    });

    expect(
      parseGchatServiceAccountCredential(keyFile(projectId, email, 'key-1', { future_field: { a: 1 } }), expected),
    ).toEqual({ projectId, privateKeyId: 'key-1', clientEmail: email });
    expect(parseGchatServiceAccountCredential(minimal, expected)).toMatchObject({ privateKeyId: 'key-1' });
  });

  it.each([
    ['not JSON', '{', 'invalid_gchat_credential'],
    [
      'another credential type',
      keyFile(projectId, email, 'key-1', { type: 'authorized_user' }),
      'invalid_gchat_credential',
    ],
    [
      'a malformed private key',
      keyFile(projectId, email, 'key-1', { private_key: 'MIIE' }),
      'invalid_gchat_credential',
    ],
    ['a missing key ID', keyFile(projectId, email, 'key-1', { private_key_id: '' }), 'invalid_gchat_credential'],
    ['another project', keyFile('gws-ea-other0000000000000000', email, 'key-1'), 'gchat_credential_mismatch'],
    [
      'another service account',
      keyFile(projectId, `other@${projectId}.iam.gserviceaccount.com`, 'key-1'),
      'gchat_credential_mismatch',
    ],
  ])('refuses %s', (_case, contents, code) => {
    expect(() => parseGchatServiceAccountCredential(contents, expected)).toThrow(
      expect.objectContaining({ code }) as Error,
    );
  });
});

describe('Google Cloud setup through the step engine', () => {
  it('creates a never-created project Google will not confirm, then its APIs, account, and one published key', async () => {
    const setup = await harness();

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const { projectId, instanceId, serviceAccountEmail } = setup.gcp;
    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations).toEqual([
      `projects create ${projectId} --name=GWS-EA assistant --labels=gws-ea-instance=${instanceId},gws-ea-managed=true --format=json`,
      `services enable chat.googleapis.com iam.googleapis.com orgpolicy.googleapis.com --project=${projectId}`,
      `iam service-accounts create gws-ea-chat --display-name=GWS-EA Google Chat --description=Owned by GWS-EA instance ${instanceId} --project=${projectId} --format=json`,
      `keys create ${keyId}`,
    ]);
    expect(setup.cloud.commands[0]).toBe(`projects describe ${projectId} --format=json`);
    expect(setup.cloud.userKeys).toEqual(new Set([keyId]));
    expect(serviceAccountEmail).toBe(`gws-ea-chat@${projectId}.iam.gserviceaccount.com`);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
    const journal = await setup.journal();
    expect(journal.steps.provision_gcp?.completed_at).toBeDefined();
    expect(journal.key_policy_lifted).toBe(false);
    expect(setup.sleeps).toEqual([]);
  });

  it('adopts a project whose creation reports it already exists when its labels name this assistant', async () => {
    const setup = await harness();
    setup.cloud.ready().hiddenProjectReads = 1;
    await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));
    setup.cloud.userKeys.add('k1');

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.commands.slice(0, 3)).toEqual([
      `projects describe ${setup.gcp.projectId} --format=json`,
      expect.stringMatching(/^projects create /u),
      `projects describe ${setup.gcp.projectId} --format=json`,
    ]);
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('refuses, by name, a project whose creation reports it already exists under other labels', async () => {
    const setup = await harness();
    setup.cloud.ready().hiddenProjectReads = 1;
    setup.cloud.project!.labels = { 'gws-ea-instance': allocateInstanceId(), 'gws-ea-managed': 'true' };

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'gcp_project_owner_mismatch',
      message: expect.stringContaining(setup.gcp.projectId),
    });
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.commands.some((command) => !command.startsWith('projects '))).toBe(false);
  });

  it('waits for a created service account to be listed, then continues', async () => {
    const setup = await harness();
    setup.cloud.ready().serviceAccount = undefined;
    setup.cloud.unlistedServiceAccountReads = 2;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations.filter((entry) => entry.startsWith('iam service-accounts create '))).toHaveLength(1);
    expect(setup.sleeps).toEqual([1_000, 2_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for the Google Chat service account…',
    });
    await publishedKeyId(setup.gcp);
  });

  it('keeps a valid local credential whose key is listed, changing nothing', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('k1');
    await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([]);
    expect(await publishedKeyId(setup.gcp)).toBe('k1');
  });

  it('replaces an orphan key when there is no local credential, leaving Google-managed keys alone', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('orphan');

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations).toEqual(['keys delete orphan', `keys create ${keyId}`]);
    expect(setup.cloud.userKeys).toEqual(new Set([keyId]));
    expect(setup.cloud.systemKeys.size).toBe(1);
  });

  it('replaces a valid local credential whose key Google no longer lists', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('other');
    await writeCredential(
      setup.gcp.credentialFile,
      keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'gone'),
    );

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(keyId).not.toBe('gone');
    expect(setup.cloud.mutations).toEqual(['keys delete other', `keys create ${keyId}`]);
  });

  it('publishes a valid staged key left by a crash without creating another', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('staged');
    await writeCredential(setup.staging, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'staged'));

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(await publishedKeyId(setup.gcp)).toBe('staged');
    expect(setup.cloud.mutations).toEqual([]);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const unusableKeyFiles: ReadonlyArray<readonly [string, number, string]> = [
    ['at the wrong mode', 0o644, 'readable only by its owner'],
    ['not a key', 0o600, 'Google Chat credential'],
    // The owner can read any file when running as root.
    ...(process.getuid?.() === 0 ? [] : [['unreadable', 0o200, 'EACCES'] as const]),
  ];

  it.each(unusableKeyFiles)('stops, deleting nothing, when the local key file is %s', async (_case, mode, evidence) => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('k1');
    const contents =
      evidence === 'Google Chat credential'
        ? '{"type":"authorized_user"}'
        : keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1');
    await writeCredential(setup.gcp.credentialFile, contents, mode);

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'observation_unknown',
      message: expect.stringContaining(setup.gcp.credentialFile),
      details: { evidence: expect.stringContaining(evidence) },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.userKeys).toEqual(new Set(['k1']));
    await expect(stat(setup.gcp.credentialFile)).resolves.toMatchObject({ size: Buffer.byteLength(contents) });
  });

  it('lifts a blocking key policy only after recording the lift, and restores it before completing', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    setup.cloud.policyLag = 1;
    const liftedWhenLifting: boolean[] = [];
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args[1] === 'set-policy') liftedWhenLifting.push((await setup.journal()).key_policy_lifted);
      return setup.cloud.run(command);
    };

    await expect(setup.run(runCommand)).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`),
      `keys create ${keyId}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect(liftedWhenLifting).toEqual([true, true, true, true]);
    expect(setup.sleeps).toEqual([1_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for Google Cloud to allow Google Chat key creation…',
    });
    const journal = await setup.journal();
    expect(journal.key_policy_lifted).toBe(false);
    expect(journal.steps.provision_gcp?.completed_at).toBeDefined();
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores the policy and stops when Google keeps refusing the key after the lift', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    setup.cloud.policyLag = 99;

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining('resume to retry'),
      details: { stderrTail: expect.stringContaining('FAILED_PRECONDITION') },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`),
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('stops on a project pending deletion, naming how to restore it', async () => {
    const setup = await harness();
    setup.cloud.ready().project!.lifecycleState = 'DELETE_REQUESTED';

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcp_project_unavailable',
      message: expect.stringContaining(`gcloud projects undelete ${setup.gcp.projectId}`),
    });
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('restores a policy lifted before a crash before anything else on the next run', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.managed.disableServiceAccountKeyCreation');
    let lifted = 0;
    const dying: GcloudCommandRunner = async (command) => {
      if (lifted === KEY_CONSTRAINTS.length) throw new Error('The process died');
      const outcome = await setup.cloud.run(command);
      if (command.args[1] === 'set-policy') lifted += 1;
      return outcome;
    };

    await expect(setup.run(dying)).rejects.toThrow('The process died');
    expect((await setup.journal()).key_policy_lifted).toBe(true);
    expect([...setup.cloud.projectPolicies.values()]).toEqual([false, false]);

    const before = setup.cloud.mutations.length;
    const commandsBefore = setup.cloud.commands.length;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    // The first commands of the next run restore the policy.
    expect(setup.cloud.commands.slice(commandsBefore, commandsBefore + 2)).toEqual([
      expect.stringMatching(/^org-policies set-policy /u),
      expect.stringMatching(/^org-policies set-policy /u),
    ]);
    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations.slice(before)).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`),
      `keys create ${keyId}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('pauses, naming the policy role and the project, when the policy cannot be changed', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    setup.cloud.canSetPolicy = false;

    const result = await setup.run();

    expect(result).toMatchObject({
      status: 'paused',
      pause: {
        phase: 'provision_gcp',
        code: 'gcp_policy_permission_required',
        message: expect.stringContaining(setup.gcp.projectId),
        details: [expect.stringContaining('roles/orgpolicy.policyAdmin')],
      },
    });
    expect(setup.cloud.mutations).toEqual([]);
    await expect(stat(setup.gcp.credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });

    setup.cloud.canSetPolicy = true;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });
    expect(setup.cloud.mutations[0]).toBe('set-policy iam.disableServiceAccountKeyCreation enforce=true');
    expect((await setup.journal()).key_policy_lifted).toBe(false);
    await publishedKeyId(setup.gcp);
  });

  it('stops with evidence and changes nothing when a read fails in an unrecognized way', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('orphan');
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 3).join(' ') === 'iam service-accounts list'
        ? failed(GCLOUD_CRASHED)
        : setup.cloud.run(command);

    const failure = await setup.run(runCommand).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'observation_unknown',
      message: expect.stringContaining('the Google Chat service account'),
      details: { evidence: expect.stringContaining('gcloud crashed (TypeError)') },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.userKeys).toEqual(new Set(['orphan']));
  });

  it('signs in when the sign-in expired mid-step, then continues without repeating a change', async () => {
    const setup = await harness();
    let expired = true;
    const runCommand: GcloudCommandRunner = async (command) => {
      if (expired && command.args[0] === 'services') {
        expired = false;
        return failed(TOKEN_REFRESH_FAILED);
      }
      return setup.cloud.run(command);
    };

    await expect(setup.run(runCommand)).resolves.toEqual({ status: 'ready' });

    expect(setup.signIns).toEqual([ACCOUNT]);
    expect(setup.cloud.mutations.filter((entry) => entry.startsWith('projects create '))).toHaveLength(1);
  });
});

describe('Google Cloud project removal', () => {
  async function removal(): Promise<{ cloud: FakeGoogleCloud; coordinates: GcpProjectCoordinates }> {
    const root = await tempRoot();
    const instanceId = allocateInstanceId();
    const projectId = deriveGcpProjectId(instanceId);
    const coordinates = { instanceId, projectId, account: ACCOUNT, cwd: root };
    const cloud = new FakeGoogleCloud({
      ...coordinates,
      serviceAccountEmail: deriveGchatServiceAccountEmail(projectId),
      credentialFile: path.join(root, 'gchat.json'),
    });
    return { cloud, coordinates };
  }

  it('requests deletion only after ownership verification and treats a repeated delete as complete', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();

    const options = { restoreKeyPolicy: false };
    await expect(deleteOwnedGcpProject(coordinates, options, { runCommand: cloud.run })).resolves.toEqual({
      status: 'deleted',
    });
    await expect(deleteOwnedGcpProject(coordinates, options, { runCommand: cloud.run })).resolves.toEqual({
      status: 'deleted',
    });

    expect(cloud.project?.lifecycleState).toBe('DELETE_REQUESTED');
    expect(cloud.mutations).toEqual([`projects delete ${coordinates.projectId}`]);
  });

  it('reports a project Google will not show as unknown, with evidence, and changes nothing', async () => {
    const { cloud, coordinates } = await removal();

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({
      status: 'unknown',
      reason: expect.stringContaining(coordinates.projectId),
      evidence: expect.stringContaining('(or it may not exist)'),
    });
    expect(cloud.mutations).toEqual([]);
  });

  it('restores a lifted key-creation policy before it requests deletion', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();
    for (const constraint of KEY_CONSTRAINTS) cloud.projectPolicies.set(constraint, false);

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({ status: 'deleted' });

    expect(cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
      `projects delete ${coordinates.projectId}`,
    ]);
  });

  it('still deletes the project, reporting the lift unrestored, when Google refuses the restore', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready().canSetPolicy = false;

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({ status: 'deleted', keyPolicyUnrestored: expect.stringContaining('PERMISSION_DENIED') });
    expect(cloud.mutations).toEqual([`projects delete ${coordinates.projectId}`]);
  });

  it('reports a restore Google refuses as evidence rather than a pause', async () => {
    const { cloud, coordinates } = await removal();

    await expect(restoreKeyCreationPolicyForRemoval(coordinates, { runCommand: cloud.run })).resolves.toEqual(
      expect.stringContaining('PERMISSION_DENIED'),
    );
    cloud.ready();
    await expect(restoreKeyCreationPolicyForRemoval(coordinates, { runCommand: cloud.run })).resolves.toBeUndefined();
    expect(cloud.mutations).toEqual(KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`));
  });

  it('refuses project deletion when the instance ownership label differs', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready().project!.labels['gws-ea-instance'] = allocateInstanceId();

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).rejects.toMatchObject({
      code: 'gcp_project_owner_mismatch',
      message: expect.stringContaining(coordinates.projectId),
    });
    expect(cloud.mutations).toEqual([]);
  });

  it('does not complete removal when Google Cloud leaves the project active after delete', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args[1] === 'delete' ? ok() : cloud.run(command);

    await expect(deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: false }, { runCommand })).rejects.toMatchObject(
      {
        code: 'gcp_delete_unconfirmed',
      },
    );
    expect(cloud.project?.lifecycleState).toBe('ACTIVE');
  });
});
