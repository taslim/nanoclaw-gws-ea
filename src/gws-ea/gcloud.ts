import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { isErrno } from '../community-portal/errors.js';
import { SignInRequired } from './events.js';
import {
  deriveGchatServiceAccountEmail,
  GCHAT_SERVICE_ACCOUNT_ID,
  GCP_PROJECT_PATTERN,
  parseGcpProjectNumber,
} from './gcp-identity.js';
import { CONTROL_PLANE_ROOT, preparePrivateLocalDirectory } from './paths.js';
import {
  buildToolEnvironment,
  commandExitError,
  missingExecutable,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { registerSecret } from './redact.js';
import { readOwnerOnlyFile, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { assertInstanceId } from './registry.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

export const GCLOUD_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const PROJECT_LABEL_INSTANCE = 'gws-ea-instance';
const PROJECT_LABEL_MANAGED = 'gws-ea-managed';
const REQUIRED_APIS = ['chat.googleapis.com', 'iam.googleapis.com', 'orgpolicy.googleapis.com'] as const;
const SERVICE_ACCOUNT_KEY_POLICIES = [
  'iam.disableServiceAccountKeyCreation',
  'iam.managed.disableServiceAccountKeyCreation',
] as const;
const SERVICE_ACCOUNT_DISPLAY_NAME = 'GWS-EA Google Chat';
const READBACK_DELAYS_MS = [1_000, 2_000, 4_000, 8_000, 16_000, 30_000] as const;
const SERVICE_ACCOUNT_KEYS = new Set([
  'type',
  'project_id',
  'private_key_id',
  'private_key',
  'client_email',
  'client_id',
  'auth_uri',
  'token_uri',
  'auth_provider_x509_cert_url',
  'client_x509_cert_url',
  'universe_domain',
]);
const ACCOUNT_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * What a failed gcloud command means (KTD5). Only messages Google documents
 * are recognized; anything unfamiliar is `anything-else`.
 * - `auth-required`: the operator must sign in again.
 * - `permission-or-missing`: Google will not say whether the resource exists.
 * - `precondition`: the request was refused by policy, such as blocked key creation.
 */
export type GcloudFailureClass = 'auth-required' | 'permission-or-missing' | 'precondition' | 'anything-else';

const GCLOUD_FAILURES: ReadonlyArray<readonly [GcloudFailureClass, readonly RegExp[]]> = [
  [
    'auth-required',
    [
      /There was a problem refreshing (?:your current auth tokens|auth tokens for account)/u,
      /There was a problem reauthenticating/u,
      /Reauthentication (?:required|failed|is needed)/u,
      /You do not currently have an active account selected/u,
      /does not have any valid credentials/u,
      /to obtain new credentials/u,
      /\bUNAUTHENTICATED\b/u,
    ],
  ],
  ['precondition', [/\bFAILED_PRECONDITION\b/u]],
  [
    'permission-or-missing',
    [/\bPERMISSION_DENIED\b/u, /\bNOT_FOUND\b/u, /\(or it may not exist\)/u, /does not have permission to access/u],
  ],
];

/** Classify a failed gcloud command by its stderr. */
export function classifyGcloudFailure(outcome: SanitizedCommandOutcome): GcloudFailureClass {
  const match = GCLOUD_FAILURES.find(([, patterns]) => patterns.some((pattern) => pattern.test(outcome.stderr)));
  return match?.[0] ?? 'anything-else';
}

/** A personal Google account, which cannot own a Google Chat app for a Workspace. */
export function isConsumerGoogleAccount(email: string): boolean {
  return CONSUMER_GOOGLE_DOMAINS.has(email.slice(email.lastIndexOf('@') + 1).toLowerCase());
}

export function isGoogleAccountAddress(value: string): boolean {
  return ACCOUNT_PATTERN.test(value);
}

export type GcloudCommandRunner = SanitizedCommandOutcomeRunner;

export type GcloudReadbackResource =
  | 'project'
  | 'apis'
  | 'service-account'
  | 'credential-policy'
  | 'service-account-keys'
  | 'credential-key';

export interface GcloudProgressEvent {
  readonly resource: GcloudReadbackResource;
}

export interface GcloudDependencies {
  readonly runCommand?: GcloudCommandRunner;
  readonly sleep?: (delayMs: number) => Promise<void>;
  readonly onProgress?: (event: GcloudProgressEvent) => void | Promise<void>;
}

export interface GcpProjectInput {
  readonly instanceId: string;
  readonly projectId: string;
  readonly account: string;
  readonly serviceAccountEmail: string;
  readonly credentialFile: string;
  readonly cwd: string;
}

export interface GcpDeletionInput {
  readonly instanceId: string;
  readonly projectId: string;
  readonly account: string;
  readonly cwd: string;
}

interface ProjectDescription {
  readonly projectId: string;
  readonly projectNumber: string | undefined;
  readonly lifecycleState: string;
  readonly labels: Readonly<Record<string, string>>;
}

type ProjectLookupMode = 'strict' | 'creation-probe';

interface ServiceAccountDescription {
  readonly email: string;
  readonly displayName: string;
  readonly description: string;
}

interface ServiceAccountCredential {
  readonly projectId: string;
  readonly privateKeyId: string;
  readonly clientEmail: string;
}

type CredentialArtifact =
  | { readonly status: 'missing' | 'empty' }
  | { readonly status: 'invalid'; readonly error: GwsEaError }
  | { readonly status: 'valid'; readonly contents: string; readonly credential: ServiceAccountCredential };

function gcloudCommand(cwd: string, args: readonly string[]): SanitizedCommand {
  return {
    command: 'gcloud',
    args,
    cwd: path.resolve(cwd),
    env: buildToolEnvironment(process.env, {
      HOME: os.homedir(),
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    }),
    timeoutMs: 120_000,
  };
}

/** Run gcloud. An expired sign-in throws `SignInRequired`; any other failure is the caller's to judge. */
async function run(
  cwd: string,
  args: readonly string[],
  runner: GcloudCommandRunner,
): Promise<SanitizedCommandOutcome> {
  const command = gcloudCommand(cwd, args);
  const outcome = await runner(command);
  if (outcome.exitCode !== 0 && classifyGcloudFailure(outcome) === 'auth-required') {
    const failure = commandExitError(command, outcome);
    const account = args.find((arg) => arg.startsWith('--account='))?.slice('--account='.length);
    throw new SignInRequired(`Google Cloud sign-in${account ? ` for ${account}` : ''} has expired`, {
      cause: failure,
      ...(failure.details ? { details: failure.details } : {}),
    });
  }
  return outcome;
}

/** Run gcloud where any failure stops the caller, reported as the failed command. */
async function runChecked(
  cwd: string,
  args: readonly string[],
  runner: GcloudCommandRunner,
): Promise<SanitizedCommandOutcome> {
  const outcome = await run(cwd, args, runner);
  if (outcome.exitCode !== 0) throw commandExitError(gcloudCommand(cwd, args), outcome);
  return outcome;
}

function commandFailure(message: string): GwsEaError {
  return new GwsEaError('gcloud_failed', message);
}

async function waitForReadback<Value>(
  observe: () => Promise<Value | undefined>,
  sleep: (delayMs: number) => Promise<void>,
  onWait: () => void | Promise<void>,
): Promise<Value | undefined> {
  const immediate = await observe();
  if (immediate !== undefined) return immediate;
  await onWait();
  for (const delayMs of READBACK_DELAYS_MS) {
    await sleep(delayMs);
    const observed = await observe();
    if (observed !== undefined) return observed;
  }
  return undefined;
}

function parseJson(source: string, label: string): unknown {
  try {
    return JSON.parse(source) as unknown;
  } catch {
    throw new GwsEaError('invalid_gcloud_output', `${label} returned invalid JSON`);
  }
}

function stringField(value: Record<string, unknown>, key: string, label: string): string {
  const field = value[key];
  if (typeof field !== 'string' || field.length === 0) {
    throw new GwsEaError('invalid_gcloud_output', `${label} returned an invalid ${key}`);
  }
  return field;
}

function isNotFound(outcome: SanitizedCommandOutcome): boolean {
  return /\bNOT_FOUND\b|\bnot found\b|does not exist/iu.test(outcome.stderr);
}

function isPermissionDenied(outcome: SanitizedCommandOutcome): boolean {
  return /\bPERMISSION_DENIED\b|\bdoes not have permission\b/iu.test(outcome.stderr);
}

function validateCoordinates(input: GcpDeletionInput): void {
  assertInstanceId(input.instanceId);
  if (!GCP_PROJECT_PATTERN.test(input.projectId)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
  if (!ACCOUNT_PATTERN.test(input.account)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  if (!path.isAbsolute(input.cwd) || path.resolve(input.cwd) !== input.cwd) {
    throw new GwsEaError('unsafe_path', 'GCP command directory is invalid');
  }
  if ('credentialFile' in input) {
    const credentialFile = input.credentialFile;
    if (
      typeof credentialFile !== 'string' ||
      !path.isAbsolute(credentialFile) ||
      path.resolve(credentialFile) !== credentialFile
    ) {
      throw new GwsEaError('unsafe_path', 'Google Chat credential path is invalid');
    }
  }
}

export function deriveGcpProjectId(instanceId: string): string {
  assertInstanceId(instanceId);
  return `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
}

export { deriveGchatServiceAccountEmail } from './gcp-identity.js';

/** gcloud is on PATH and runs. */
export async function assertGcloudInstalled(runner: GcloudCommandRunner = runSanitizedCommandOutcome): Promise<void> {
  await runChecked(CONTROL_PLANE_ROOT, ['version', '--format=json'], runner).catch((error: unknown) =>
    missingExecutable(
      error,
      'gcloud_required',
      `Google Cloud CLI is required. Install it from ${GCLOUD_INSTALL_URL}, then retry.`,
    ),
  );
}

/** The account gcloud is signed in as, or undefined when nobody is. */
export async function activeGcloudAccount(
  runner: GcloudCommandRunner = runSanitizedCommandOutcome,
): Promise<string | undefined> {
  const { stdout } = await runChecked(
    CONTROL_PLANE_ROOT,
    ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'],
    runner,
  );
  const active = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (active.length > 1 || (active.length === 1 && !ACCOUNT_PATTERN.test(active[0]!))) {
    throw new GwsEaError('invalid_gcloud_output', 'gcloud reported an invalid active account');
  }
  return active[0];
}

/** `account` holds Google Cloud credentials that still refresh; `SignInRequired` when it must sign in again. */
export async function assertGcloudSignedIn(
  account: string,
  runner: GcloudCommandRunner = runSanitizedCommandOutcome,
): Promise<void> {
  if (!ACCOUNT_PATTERN.test(account)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  const { stdout } = await runChecked(
    CONTROL_PLANE_ROOT,
    ['auth', 'print-access-token', `--account=${account}`, '--quiet'],
    runner,
  );
  const token = stdout.trim();
  if (!token) throw new SignInRequired(`Google Cloud returned no credentials for ${account}`);
  registerSecret(token);
}

async function describeProject(
  input: GcpDeletionInput,
  runner: GcloudCommandRunner,
  mode: ProjectLookupMode = 'strict',
): Promise<ProjectDescription | undefined> {
  validateCoordinates(input);
  const result = await run(
    input.cwd,
    ['projects', 'describe', input.projectId, `--account=${input.account}`, '--format=json', '--quiet'],
    runner,
  );
  if (result.exitCode !== 0) {
    if (isNotFound(result) || (mode === 'creation-probe' && isPermissionDenied(result))) return undefined;
    throw commandFailure('Google Cloud could not verify the dedicated project; no action was taken.');
  }
  const value = parseJson(result.stdout, 'Google Cloud project');
  if (!isRecord(value) || !isRecord(value.labels)) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid project description');
  }
  const labels: Record<string, string> = {};
  for (const [key, label] of Object.entries(value.labels)) {
    if (typeof label !== 'string') {
      throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned invalid project labels');
    }
    labels[key] = label;
  }
  return {
    projectId: stringField(value, 'projectId', 'Google Cloud project'),
    projectNumber: parseGcpProjectNumber(value.projectNumber),
    lifecycleState: stringField(value, 'lifecycleState', 'Google Cloud project'),
    labels,
  };
}

export async function getOwnedGcpProjectNumber(
  input: GcpDeletionInput,
  dependencies: GcloudDependencies = {},
): Promise<string> {
  const project = await describeProject(input, dependencies.runCommand ?? runSanitizedCommandOutcome);
  if (!project) throw commandFailure('The dedicated Google Cloud project is unavailable.');
  assertOwnedProject(input, project);
  if (project.lifecycleState !== 'ACTIVE') {
    throw new GwsEaError('gcp_project_unavailable', 'The dedicated Google Cloud project is not active');
  }
  if (!project.projectNumber) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid project number');
  }
  return project.projectNumber;
}

function assertOwnedProject(input: GcpDeletionInput, project: ProjectDescription): void {
  if (
    project.projectId !== input.projectId ||
    project.labels[PROJECT_LABEL_INSTANCE] !== input.instanceId ||
    project.labels[PROJECT_LABEL_MANAGED] !== 'true'
  ) {
    throw new GwsEaError(
      'gcp_project_owner_mismatch',
      'The Google Cloud project is not marked as owned by this assistant; refusing mutation.',
    );
  }
}

async function ensureProject(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<void> {
  // Resource Manager deliberately makes a missing project indistinguishable
  // from an inaccessible one. Creation is the safe discriminator: it either
  // creates our random ID or fails without adopting an existing project.
  const observed = await describeProject(input, runner, 'creation-probe');
  if (observed) {
    assertOwnedProject(input, observed);
    if (observed.lifecycleState !== 'ACTIVE') {
      throw new GwsEaError('gcp_project_unavailable', 'The dedicated Google Cloud project is not active');
    }
    return;
  }
  const result = await run(
    input.cwd,
    [
      'projects',
      'create',
      input.projectId,
      '--name=GWS-EA assistant',
      `--labels=${PROJECT_LABEL_INSTANCE}=${input.instanceId},${PROJECT_LABEL_MANAGED}=true`,
      `--account=${input.account}`,
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) {
    throw commandFailure('Google Cloud could not create the dedicated assistant project.');
  }
  const created = await waitForReadback(
    async () => {
      const project = await describeProject(input, runner, 'creation-probe');
      if (!project) return undefined;
      assertOwnedProject(input, project);
      if (project.lifecycleState !== 'ACTIVE') {
        throw new GwsEaError('gcp_project_unavailable', 'The dedicated Google Cloud project is not active');
      }
      return project;
    },
    sleep,
    () => onProgress({ resource: 'project' }),
  );
  if (!created) throw commandFailure('Google Cloud did not return the newly created assistant project.');
}

async function enabledApis(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<Set<string>> {
  const result = await run(
    input.cwd,
    [
      'services',
      'list',
      '--enabled',
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--format=value(config.name)',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not inspect enabled APIs.');
  return new Set(
    result.stdout
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean),
  );
}

async function ensureApis(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<void> {
  const observed = await enabledApis(input, runner);
  const missing = REQUIRED_APIS.filter((api) => !observed.has(api));
  if (missing.length === 0) return;
  const result = await run(
    input.cwd,
    ['services', 'enable', ...missing, `--project=${input.projectId}`, `--account=${input.account}`, '--quiet'],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not enable the assistant setup APIs.');
  const enabled = await waitForReadback(
    async () => {
      const apis = await enabledApis(input, runner);
      return REQUIRED_APIS.every((api) => apis.has(api)) ? apis : undefined;
    },
    sleep,
    () => onProgress({ resource: 'apis' }),
  );
  if (!enabled) throw commandFailure('Google Cloud did not return the newly enabled assistant setup APIs.');
}

async function keyCreationPolicyEnforced(
  input: GcpProjectInput,
  constraint: (typeof SERVICE_ACCOUNT_KEY_POLICIES)[number],
  runner: GcloudCommandRunner,
): Promise<boolean> {
  const result = await run(
    input.cwd,
    [
      'org-policies',
      'describe',
      constraint,
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--effective',
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return false;
    throw commandFailure('Google Cloud could not inspect the Chat credential policy.');
  }
  const value = parseJson(result.stdout, 'Google Cloud credential policy');
  if (!isRecord(value) || !isRecord(value.spec) || !Array.isArray(value.spec.rules)) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid credential policy');
  }
  const rules: unknown[] = value.spec.rules;
  if (rules.length !== 1 || !isRecord(rules[0]) || typeof rules[0].enforce !== 'boolean' || rules[0].condition) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid credential policy');
  }
  return rules[0].enforce;
}

async function setKeyCreationPolicy(
  input: GcpProjectInput,
  constraint: (typeof SERVICE_ACCOUNT_KEY_POLICIES)[number],
  enforced: boolean,
  runner: GcloudCommandRunner,
): Promise<void> {
  const current = await run(
    input.cwd,
    [
      'org-policies',
      'describe',
      constraint,
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (current.exitCode !== 0 && !isNotFound(current)) {
    throw commandFailure('Google Cloud could not inspect the Chat credential policy.');
  }
  let etag: string | undefined;
  if (current.exitCode === 0) {
    const value = parseJson(current.stdout, 'Google Cloud credential policy');
    if (!isRecord(value) || !isRecord(value.spec) || typeof value.spec.etag !== 'string' || !value.spec.etag) {
      throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid credential policy');
    }
    etag = value.spec.etag;
  }

  const temporary = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-org-policy-'));
  try {
    const policyFile = path.join(temporary, 'policy.json');
    await writeFile(
      policyFile,
      JSON.stringify({
        name: `projects/${input.projectId}/policies/${constraint}`,
        spec: { ...(etag === undefined ? {} : { etag }), rules: [{ enforce: enforced }] },
      }),
      { encoding: 'utf8', flag: 'wx', mode: 0o600 },
    );
    const result = await run(
      input.cwd,
      [
        'org-policies',
        'set-policy',
        policyFile,
        `--project=${input.projectId}`,
        `--account=${input.account}`,
        '--quiet',
      ],
      runner,
    );
    if (result.exitCode !== 0) {
      if (isPermissionDenied(result)) {
        throw new GwsEaError(
          'gcp_policy_permission_required',
          'Google Cloud could not update the Chat credential policy. Grant Organization Policy Administrator access, then resume.',
        );
      }
      throw commandFailure('Google Cloud could not update the Chat credential policy.');
    }
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

async function reconcileKeyCreationPolicies(
  input: GcpProjectInput,
  enforced: boolean,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<void> {
  const policyStates = await Promise.all(
    SERVICE_ACCOUNT_KEY_POLICIES.map(async (constraint) => ({
      constraint,
      enforced: await keyCreationPolicyEnforced(input, constraint, runner),
    })),
  );
  const pending = policyStates.filter((policy) => policy.enforced !== enforced).map((policy) => policy.constraint);
  if (pending.length === 0) return;

  await onProgress({ resource: 'credential-policy' });
  for (const constraint of pending) {
    await setKeyCreationPolicy(input, constraint, enforced, runner);
  }

  for (const constraint of pending) {
    const applied = await waitForReadback(
      async () => ((await keyCreationPolicyEnforced(input, constraint, runner)) === enforced ? true : undefined),
      sleep,
      () => undefined,
    );
    if (!applied) {
      throw new GwsEaError(
        'gcp_policy_pending',
        'Google Cloud has not applied the Chat credential policy change yet; resume to continue.',
      );
    }
  }
}

async function describeServiceAccount(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
): Promise<ServiceAccountDescription | undefined> {
  const result = await run(
    input.cwd,
    [
      'iam',
      'service-accounts',
      'describe',
      input.serviceAccountEmail,
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return undefined;
    throw commandFailure('Google Cloud could not inspect the Chat service account.');
  }
  const value = parseJson(result.stdout, 'Google Cloud service account');
  if (!isRecord(value))
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned an invalid service account');
  return {
    email: stringField(value, 'email', 'Google Cloud service account'),
    displayName: stringField(value, 'displayName', 'Google Cloud service account'),
    description: stringField(value, 'description', 'Google Cloud service account'),
  };
}

function serviceAccountDescription(instanceId: string): string {
  return `Owned by GWS-EA instance ${instanceId}`;
}

function assertOwnedServiceAccount(input: GcpProjectInput, account: ServiceAccountDescription): void {
  if (
    account.email !== input.serviceAccountEmail ||
    account.displayName !== SERVICE_ACCOUNT_DISPLAY_NAME ||
    account.description !== serviceAccountDescription(input.instanceId)
  ) {
    throw new GwsEaError(
      'gcp_service_account_owner_mismatch',
      'The Chat service account is not marked as owned by this assistant; refusing mutation.',
    );
  }
}

async function ensureServiceAccount(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<void> {
  const observed = await describeServiceAccount(input, runner);
  if (observed) {
    assertOwnedServiceAccount(input, observed);
    return;
  }
  const result = await run(
    input.cwd,
    [
      'iam',
      'service-accounts',
      'create',
      GCHAT_SERVICE_ACCOUNT_ID,
      `--display-name=${SERVICE_ACCOUNT_DISPLAY_NAME}`,
      `--description=${serviceAccountDescription(input.instanceId)}`,
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not create the Chat service account.');
  const created = await waitForReadback(
    async () => {
      const account = await describeServiceAccount(input, runner);
      if (!account) return undefined;
      assertOwnedServiceAccount(input, account);
      return account;
    },
    sleep,
    () => onProgress({ resource: 'service-account' }),
  );
  if (!created) throw commandFailure('Google Cloud did not return the newly created Chat service account.');
}

export function parseGchatServiceAccountCredential(
  contents: string,
  expected: { readonly projectId: string; readonly serviceAccountEmail: string },
): ServiceAccountCredential {
  const value = parseJson(contents, 'Google Chat credential');
  if (
    !isRecord(value) ||
    value.type !== 'service_account' ||
    Object.keys(value).some((key) => !SERVICE_ACCOUNT_KEYS.has(key))
  ) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential is not a service-account key');
  }
  const projectId = stringField(value, 'project_id', 'Google Chat credential');
  const privateKeyId = stringField(value, 'private_key_id', 'Google Chat credential');
  const privateKey = stringField(value, 'private_key', 'Google Chat credential');
  const clientEmail = stringField(value, 'client_email', 'Google Chat credential');
  stringField(value, 'client_id', 'Google Chat credential');
  for (const field of ['auth_uri', 'token_uri', 'auth_provider_x509_cert_url', 'client_x509_cert_url']) {
    let url: URL;
    try {
      url = new URL(stringField(value, field, 'Google Chat credential'));
    } catch {
      throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential contains an invalid HTTPS URL');
    }
    if (url.protocol !== 'https:' || url.username || url.password) {
      throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential contains an invalid HTTPS URL');
    }
  }
  if (
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !privateKey.trimEnd().endsWith('\n-----END PRIVATE KEY-----')
  ) {
    throw new GwsEaError('invalid_gchat_credential', 'Google Chat credential contains an invalid private key');
  }
  if (projectId !== expected.projectId || clientEmail !== expected.serviceAccountEmail) {
    throw new GwsEaError('gchat_credential_mismatch', 'Google Chat credential does not match the reserved project');
  }
  return { projectId, privateKeyId, clientEmail };
}

async function readUserManagedKeys(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
): Promise<readonly string[] | undefined> {
  const result = await run(
    input.cwd,
    [
      'iam',
      'service-accounts',
      'keys',
      'list',
      `--iam-account=${input.serviceAccountEmail}`,
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--filter=keyType:USER_MANAGED',
      '--format=json',
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return undefined;
    throw commandFailure('Google Cloud could not inspect the Chat credential keys.');
  }
  const value = parseJson(result.stdout, 'Google Cloud service-account keys');
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned invalid service-account keys');
  }
  return value
    .map((key) => stringField(key, 'name', 'Google Cloud service-account key').split('/').at(-1)!)
    .filter(Boolean);
}

async function listUserManagedKeys(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<readonly string[]> {
  const keys = await readUserManagedKeys(input, runner);
  if (!keys) throw commandFailure('Google Cloud could not inspect the Chat credential keys.');
  return keys;
}

async function inspectCredentialArtifact(input: GcpProjectInput, file: string): Promise<CredentialArtifact> {
  let contents: string;
  try {
    contents = await readOwnerOnlyFile(file);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'missing' };
    throw error;
  }
  if (contents.trim().length === 0) return { status: 'empty' };
  try {
    return {
      status: 'valid',
      contents,
      credential: parseGchatServiceAccountCredential(contents, {
        projectId: input.projectId,
        serviceAccountEmail: input.serviceAccountEmail,
      }),
    };
  } catch (error) {
    if (error instanceof GwsEaError) return { status: 'invalid', error };
    throw error;
  }
}

async function credentialFromFile(input: GcpProjectInput): Promise<ServiceAccountCredential | undefined> {
  const artifact = await inspectCredentialArtifact(input, input.credentialFile);
  if (artifact.status === 'invalid') throw artifact.error;
  if (artifact.status !== 'valid') return undefined;
  return artifact.credential;
}

function unavailableLocalKey(): GwsEaError {
  return new GwsEaError(
    'gcp_key_recovery_required',
    'Google Cloud has a Chat key whose private material is unavailable locally; remove that key, then resume.',
  );
}

async function credentialKeyVisible(
  input: GcpProjectInput,
  keyId: string,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<boolean> {
  const key = await waitForReadback(
    async () => {
      const keys = await readUserManagedKeys(input, runner);
      return keys?.includes(keyId) ? keyId : undefined;
    },
    sleep,
    () => onProgress({ resource: 'credential-key' }),
  );
  return key !== undefined;
}

async function ensureCredential(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
  sleep: (delayMs: number) => Promise<void>,
  onProgress: (event: GcloudProgressEvent) => void | Promise<void>,
): Promise<void> {
  const stagingFile = `${input.credentialFile}.staging`;
  const failAfterPolicyRestore = async (error: GwsEaError): Promise<never> => {
    await reconcileKeyCreationPolicies(input, true, runner, sleep, onProgress);
    throw error;
  };
  const local = await inspectCredentialArtifact(input, input.credentialFile);
  if (local.status === 'invalid') return failAfterPolicyRestore(local.error);
  const remote = await waitForReadback(
    () => readUserManagedKeys(input, runner),
    sleep,
    () => onProgress({ resource: 'service-account-keys' }),
  );
  if (!remote)
    return failAfterPolicyRestore(commandFailure('Google Cloud could not inspect the Chat credential keys.'));
  if (local.status === 'valid') {
    if (!remote.includes(local.credential.privateKeyId)) {
      return failAfterPolicyRestore(
        new GwsEaError('gcp_key_drift', 'The local Chat credential key is no longer active in Google Cloud'),
      );
    }
    await reconcileKeyCreationPolicies(input, true, runner, sleep, onProgress);
    await removePrivateFile(stagingFile);
    return;
  }

  const staged = await inspectCredentialArtifact(input, stagingFile);
  if (staged.status === 'valid') {
    if (
      remote.includes(staged.credential.privateKeyId) ||
      (await credentialKeyVisible(input, staged.credential.privateKeyId, runner, sleep, onProgress))
    ) {
      await writePrivateTextFile(input.credentialFile, staged.contents);
      await reconcileKeyCreationPolicies(input, true, runner, sleep, onProgress);
      await removePrivateFile(stagingFile);
      return;
    }
    if (remote.length > 0) return failAfterPolicyRestore(unavailableLocalKey());
    return failAfterPolicyRestore(
      new GwsEaError(
        'gcp_key_pending',
        'Google Cloud has not returned the staged Chat credential key yet; resume to continue.',
      ),
    );
  } else if (staged.status !== 'missing') {
    if (remote.length > 0) return failAfterPolicyRestore(unavailableLocalKey());
    await removePrivateFile(stagingFile);
  }
  if (remote.length > 0) return failAfterPolicyRestore(unavailableLocalKey());
  if (local.status === 'empty') await removePrivateFile(input.credentialFile);

  try {
    await reconcileKeyCreationPolicies(input, false, runner, sleep, onProgress);
    await preparePrivateLocalDirectory(path.dirname(input.credentialFile));
    const result = await run(
      input.cwd,
      [
        'iam',
        'service-accounts',
        'keys',
        'create',
        stagingFile,
        `--iam-account=${input.serviceAccountEmail}`,
        '--key-file-type=json',
        `--project=${input.projectId}`,
        `--account=${input.account}`,
        '--quiet',
      ],
      runner,
    );
    if (result.exitCode !== 0) {
      const failed = await inspectCredentialArtifact(input, stagingFile);
      if (failed.status === 'empty') await removePrivateFile(stagingFile);
      throw commandFailure('Google Cloud could not create the Chat credential key.');
    }
    await chmod(stagingFile, 0o600);
    const created = await inspectCredentialArtifact(input, stagingFile);
    if (created.status !== 'valid') {
      if (created.status === 'empty') await removePrivateFile(stagingFile);
      if (created.status === 'invalid') throw created.error;
      throw commandFailure('Google Cloud did not write the Chat credential key.');
    }
    if (!(await credentialKeyVisible(input, created.credential.privateKeyId, runner, sleep, onProgress))) {
      throw new GwsEaError('gcp_key_drift', 'The new Chat credential key was not visible in Google Cloud');
    }
    await writePrivateTextFile(input.credentialFile, created.contents);
  } finally {
    await reconcileKeyCreationPolicies(input, true, runner, sleep, onProgress);
  }
  await removePrivateFile(stagingFile);
}

async function inspectGcpProject(
  input: GcpProjectInput,
  runner: GcloudCommandRunner,
  mode: ProjectLookupMode,
): Promise<boolean> {
  validateCoordinates(input);
  if (input.serviceAccountEmail !== deriveGchatServiceAccountEmail(input.projectId)) {
    throw new GwsEaError('invalid_claim', 'Chat service-account identity does not match the project');
  }
  const project = await describeProject(input, runner, mode);
  if (!project) return false;
  assertOwnedProject(input, project);
  if (project.lifecycleState !== 'ACTIVE') return false;
  const apis = await enabledApis(input, runner);
  if (REQUIRED_APIS.some((api) => !apis.has(api))) return false;
  const account = await describeServiceAccount(input, runner);
  if (!account) return false;
  assertOwnedServiceAccount(input, account);
  const local = await credentialFromFile(input);
  if (!local) return false;
  if (!(await listUserManagedKeys(input, runner)).includes(local.privateKeyId)) return false;
  for (const constraint of SERVICE_ACCOUNT_KEY_POLICIES) {
    if (!(await keyCreationPolicyEnforced(input, constraint, runner))) return false;
  }
  return true;
}

export async function probeGcpProjectForCreate(
  input: GcpProjectInput,
  dependencies: GcloudDependencies = {},
): Promise<boolean> {
  return inspectGcpProject(input, dependencies.runCommand ?? runSanitizedCommandOutcome, 'creation-probe');
}

export async function verifyGcpProject(
  input: GcpProjectInput,
  dependencies: GcloudDependencies = {},
): Promise<boolean> {
  return inspectGcpProject(input, dependencies.runCommand ?? runSanitizedCommandOutcome, 'strict');
}

export async function reconcileGcpProject(
  input: GcpProjectInput,
  dependencies: GcloudDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  const sleep = dependencies.sleep ?? delay;
  const onProgress = dependencies.onProgress ?? (() => undefined);
  validateCoordinates(input);
  if (input.serviceAccountEmail !== deriveGchatServiceAccountEmail(input.projectId)) {
    throw new GwsEaError('invalid_claim', 'Chat service-account identity does not match the project');
  }
  await ensureProject(input, runner, sleep, onProgress);
  await ensureApis(input, runner, sleep, onProgress);
  await ensureServiceAccount(input, runner, sleep, onProgress);
  await ensureCredential(input, runner, sleep, onProgress);
}

export async function deleteOwnedGcpProject(
  input: GcpDeletionInput,
  dependencies: GcloudDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  const project = await describeProject(input, runner);
  if (!project) return;
  assertOwnedProject(input, project);
  if (project.lifecycleState === 'DELETE_REQUESTED') return;
  if (project.lifecycleState !== 'ACTIVE') {
    throw new GwsEaError('gcp_project_unavailable', 'The dedicated Google Cloud project is in an unexpected state');
  }
  const result = await run(
    input.cwd,
    ['projects', 'delete', input.projectId, `--account=${input.account}`, '--quiet'],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not delete the dedicated assistant project.');
  const observed = await describeProject(input, runner);
  if (observed) {
    assertOwnedProject(input, observed);
    if (observed.lifecycleState !== 'DELETE_REQUESTED') {
      throw new GwsEaError('gcp_delete_unconfirmed', 'Google Cloud did not confirm project deletion');
    }
  }
}
