import { chmod } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { deriveGchatServiceAccountEmail, GCHAT_SERVICE_ACCOUNT_ID, GCP_PROJECT_PATTERN } from './gcp-identity.js';
import { preparePrivateLocalDirectory } from './paths.js';
import {
  buildAllowlistedEnvironment,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import { readOwnerOnlyFile } from './secrets.js';
import { assertInstanceId } from './registry.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

const INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const PROJECT_LABEL_INSTANCE = 'gws-ea-instance';
const PROJECT_LABEL_MANAGED = 'gws-ea-managed';
const REQUIRED_APIS = ['chat.googleapis.com', 'iam.googleapis.com'] as const;
const SERVICE_ACCOUNT_DISPLAY_NAME = 'GWS-EA Google Chat';
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

export type GcloudCommandRunner = SanitizedCommandOutcomeRunner;

export interface GcloudDependencies {
  readonly runCommand?: GcloudCommandRunner;
}

export interface GcloudPreflightInput extends GcloudDependencies {
  readonly cwd: string;
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
  readonly lifecycleState: string;
  readonly labels: Readonly<Record<string, string>>;
}

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

function gcloudCommand(cwd: string, args: readonly string[]): SanitizedCommand {
  return {
    command: 'gcloud',
    args,
    cwd: path.resolve(cwd),
    env: buildAllowlistedEnvironment(process.env, {
      HOME: os.homedir(),
      CLOUDSDK_CORE_DISABLE_PROMPTS: '1',
    }),
    timeoutMs: 120_000,
  };
}

async function run(
  cwd: string,
  args: readonly string[],
  runner: GcloudCommandRunner,
): Promise<SanitizedCommandOutcome> {
  return runner(gcloudCommand(cwd, args));
}

function commandFailure(message: string): GwsEaError {
  return new GwsEaError('gcloud_failed', message);
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

export async function preflightGcloud(input: GcloudPreflightInput): Promise<{ readonly account: string }> {
  const runner = input.runCommand ?? runSanitizedCommandOutcome;
  let version: SanitizedCommandOutcome;
  try {
    version = await run(input.cwd, ['version', '--format=json'], runner);
  } catch {
    throw new GwsEaError(
      'gcloud_required',
      `Google Cloud CLI is required. Install it from ${INSTALL_URL}, then retry.`,
    );
  }
  if (version.exitCode !== 0) {
    throw new GwsEaError(
      'gcloud_required',
      `Google Cloud CLI is required. Install it from ${INSTALL_URL}, then retry.`,
    );
  }
  const accounts = await run(input.cwd, ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)'], runner);
  const active = accounts.stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (accounts.exitCode !== 0 || active.length !== 1 || !ACCOUNT_PATTERN.test(active[0]!)) {
    throw new GwsEaError(
      'gcloud_auth_required',
      'Google Cloud CLI is not signed in. Run gcloud auth login, then retry.',
    );
  }
  const account = active[0]!;
  const token = await run(input.cwd, ['auth', 'print-access-token', `--account=${account}`, '--quiet'], runner);
  if (token.exitCode !== 0 || !token.stdout.trim()) {
    throw new GwsEaError(
      'gcloud_auth_required',
      `Google Cloud credentials for ${account} are unavailable. Run gcloud auth login ${account}, then retry.`,
    );
  }
  return { account };
}

async function describeProject(
  input: GcpDeletionInput,
  runner: GcloudCommandRunner,
): Promise<ProjectDescription | undefined> {
  validateCoordinates(input);
  const result = await run(
    input.cwd,
    ['projects', 'describe', input.projectId, `--account=${input.account}`, '--format=json', '--quiet'],
    runner,
  );
  if (result.exitCode !== 0) {
    if (isNotFound(result)) return undefined;
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
    lifecycleState: stringField(value, 'lifecycleState', 'Google Cloud project'),
    labels,
  };
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

async function ensureProject(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<void> {
  const observed = await describeProject(input, runner);
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
  const created = await describeProject(input, runner);
  if (!created) throw commandFailure('Google Cloud did not return the newly created assistant project.');
  assertOwnedProject(input, created);
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

async function ensureApis(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<void> {
  const observed = await enabledApis(input, runner);
  const missing = REQUIRED_APIS.filter((api) => !observed.has(api));
  if (missing.length === 0) return;
  const result = await run(
    input.cwd,
    ['services', 'enable', ...missing, `--project=${input.projectId}`, `--account=${input.account}`, '--quiet'],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not enable the Google Chat APIs.');
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

async function ensureServiceAccount(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<void> {
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
  const created = await describeServiceAccount(input, runner);
  if (!created) throw commandFailure('Google Cloud did not return the newly created Chat service account.');
  assertOwnedServiceAccount(input, created);
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

async function listUserManagedKeys(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<readonly string[]> {
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
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not inspect the Chat credential keys.');
  const value = parseJson(result.stdout, 'Google Cloud service-account keys');
  if (!Array.isArray(value) || !value.every(isRecord)) {
    throw new GwsEaError('invalid_gcloud_output', 'Google Cloud returned invalid service-account keys');
  }
  return value
    .map((key) => stringField(key, 'name', 'Google Cloud service-account key').split('/').at(-1)!)
    .filter(Boolean);
}

async function credentialFromFile(input: GcpProjectInput): Promise<ServiceAccountCredential | undefined> {
  try {
    return parseGchatServiceAccountCredential(await readOwnerOnlyFile(input.credentialFile), {
      projectId: input.projectId,
      serviceAccountEmail: input.serviceAccountEmail,
    });
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function ensureCredential(input: GcpProjectInput, runner: GcloudCommandRunner): Promise<void> {
  const local = await credentialFromFile(input);
  const remote = await listUserManagedKeys(input, runner);
  if (local) {
    if (!remote.includes(local.privateKeyId)) {
      throw new GwsEaError('gcp_key_drift', 'The local Chat credential key is no longer active in Google Cloud');
    }
    return;
  }
  if (remote.length > 0) {
    throw new GwsEaError(
      'gcp_key_recovery_required',
      'Google Cloud has a Chat key whose private material is unavailable locally; remove that key, then resume.',
    );
  }
  await preparePrivateLocalDirectory(path.dirname(input.credentialFile));
  const result = await run(
    input.cwd,
    [
      'iam',
      'service-accounts',
      'keys',
      'create',
      input.credentialFile,
      `--iam-account=${input.serviceAccountEmail}`,
      '--key-file-type=json',
      `--project=${input.projectId}`,
      `--account=${input.account}`,
      '--quiet',
    ],
    runner,
  );
  if (result.exitCode !== 0) throw commandFailure('Google Cloud could not create the Chat credential key.');
  await chmod(input.credentialFile, 0o600);
  const created = await credentialFromFile(input);
  if (!created) throw commandFailure('Google Cloud did not write the Chat credential key.');
  const keys = await listUserManagedKeys(input, runner);
  if (!keys.includes(created.privateKeyId)) {
    throw new GwsEaError('gcp_key_drift', 'The new Chat credential key was not visible in Google Cloud');
  }
}

export async function verifyGcpProject(
  input: GcpProjectInput,
  dependencies: GcloudDependencies = {},
): Promise<boolean> {
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  validateCoordinates(input);
  if (input.serviceAccountEmail !== deriveGchatServiceAccountEmail(input.projectId)) {
    throw new GwsEaError('invalid_claim', 'Chat service-account identity does not match the project');
  }
  const project = await describeProject(input, runner);
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
  return (await listUserManagedKeys(input, runner)).includes(local.privateKeyId);
}

export async function reconcileGcpProject(
  input: GcpProjectInput,
  dependencies: GcloudDependencies = {},
): Promise<void> {
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  validateCoordinates(input);
  if (input.serviceAccountEmail !== deriveGchatServiceAccountEmail(input.projectId)) {
    throw new GwsEaError('invalid_claim', 'Chat service-account identity does not match the project');
  }
  await ensureProject(input, runner);
  await ensureApis(input, runner);
  await ensureServiceAccount(input, runner);
  await ensureCredential(input, runner);
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
