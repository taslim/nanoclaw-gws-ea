/**
 * Google Cloud through gcloud. `provision_gcp` observes its resources
 * with reads whose failures are classified, never guessed: an expired sign-in
 * signs in again, and anything a read cannot decide is unknown and changes
 * nothing, except creating the project under the instance's own random ID.
 * The Chat key converges by replacement, and a key-creation policy lifted to
 * create it is recorded in the journal first and restored before the step can
 * complete. Every command is logged in a form an operator can rerun.
 */
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
import { readProvisionJournal, recordKeyPolicyLifted, type InstanceOperation } from './journal.js';
import { CONTROL_PLANE_ROOT, preparePrivateDirectory } from './paths.js';
import {
  ABSENT,
  OBSERVATION_WAITS_SECONDS,
  PRESENT,
  type Observation,
  type ProvisionHumanPause,
  type StepResource,
} from './phases.js';
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
import { assertInstanceId } from './registry.js';
import { readOwnerOnlyFile, removePrivateFile, writePrivateTextFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson, requireString, stringField } from './validation.js';

export const GCLOUD_INSTALL_URL = 'https://cloud.google.com/sdk/docs/install';
const INVALID_OUTPUT = 'invalid_gcloud_output';
const INVALID_CREDENTIAL = 'invalid_gchat_credential';
const PROJECT_LABEL_INSTANCE = 'gws-ea-instance';
const PROJECT_LABEL_MANAGED = 'gws-ea-managed';
const REQUIRED_APIS = ['chat.googleapis.com', 'iam.googleapis.com', 'orgpolicy.googleapis.com'] as const;
/** The legacy and managed constraints that can block service-account key creation. */
const KEY_CREATION_CONSTRAINTS = [
  'iam.disableServiceAccountKeyCreation',
  'iam.managed.disableServiceAccountKeyCreation',
] as const;
const POLICY_ADMIN_ROLE = 'roles/orgpolicy.policyAdmin';
const SERVICE_ACCOUNT_DISPLAY_NAME = 'GWS-EA Google Chat';
const ACCOUNT_PATTERN = /^[^\s@]+@[^\s@]+$/u;
const CONSUMER_GOOGLE_DOMAINS = new Set(['gmail.com', 'googlemail.com']);

/**
 * What a failed gcloud command means. Only messages Google documents
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

/** A create refused because the resource already exists (HTTP 409), in gcloud's wordings. */
const ALREADY_EXISTS = [/\bALREADY_EXISTS\b/u, /already in use by another project/u, /is the subject of a conflict/u];

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

export interface GcloudDependencies {
  readonly runCommand?: GcloudCommandRunner;
  /** Waits between key-creation attempts while Google applies a lifted policy. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Reports such a wait. */
  readonly onWait?: (reason: string) => void;
}

/** One assistant's reserved Google Cloud project. */
export interface GcpProjectCoordinates {
  readonly instanceId: string;
  readonly projectId: string;
  readonly account: string;
  readonly cwd: string;
}

export interface GcpProjectInput extends GcpProjectCoordinates {
  readonly serviceAccountEmail: string;
  readonly credentialFile: string;
}

/** What `provision_gcp`'s resources read from the step context. */
export interface GcpStepContext {
  readonly operation: InstanceOperation;
  readonly input: { readonly gcp: GcpProjectInput };
}

type Pause = ProvisionHumanPause | undefined;

interface Ran {
  readonly command: SanitizedCommand;
  readonly outcome: SanitizedCommandOutcome;
}

/** A read that answered, or the failed command that did not. */
type Read<Value> = { readonly value: Value } | { readonly failed: Ran };

/** gcloud as the reserved account against one project. */
type Gcloud = (args: readonly string[]) => Promise<Ran>;

interface Project {
  readonly projectId: string;
  readonly projectNumber: string | undefined;
  readonly lifecycleState: string;
  readonly labels: Readonly<Record<string, unknown>>;
}

interface ServiceAccountCredential {
  readonly projectId: string;
  readonly privateKeyId: string;
  readonly clientEmail: string;
}

type KeyFile =
  | { readonly status: 'missing' }
  | { readonly status: 'unusable'; readonly problem: string }
  | { readonly status: 'valid'; readonly contents: string; readonly keyId: string };

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
async function run(runner: GcloudCommandRunner, cwd: string, args: readonly string[]): Promise<Ran> {
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
  return { command, outcome };
}

/** Run gcloud where any failure stops the caller, reported as the failed command. */
async function runChecked(runner: GcloudCommandRunner, args: readonly string[]): Promise<string> {
  const { command, outcome } = await run(runner, CONTROL_PLANE_ROOT, args);
  if (outcome.exitCode !== 0) throw commandExitError(command, outcome);
  return outcome.stdout;
}

function isNormalizedAbsolute(value: string): boolean {
  return path.isAbsolute(value) && path.resolve(value) === value;
}

function validateCoordinates(input: GcpProjectCoordinates | GcpProjectInput): void {
  assertInstanceId(input.instanceId);
  if (!GCP_PROJECT_PATTERN.test(input.projectId)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
  if (!ACCOUNT_PATTERN.test(input.account)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  if (!isNormalizedAbsolute(input.cwd)) throw new GwsEaError('unsafe_path', 'GCP command directory is invalid');
  if ('credentialFile' in input) {
    if (!isNormalizedAbsolute(input.credentialFile)) {
      throw new GwsEaError('unsafe_path', 'Google Chat credential path is invalid');
    }
    if (input.serviceAccountEmail !== deriveGchatServiceAccountEmail(input.projectId)) {
      throw new GwsEaError('invalid_claim', 'Chat service-account identity does not match the project');
    }
  }
}

/** gcloud as the reserved account, non-interactively: each logged command can be rerun by hand. */
function gcloudFor(coordinates: GcpProjectCoordinates, dependencies: GcloudDependencies): Gcloud {
  validateCoordinates(coordinates);
  const runner = dependencies.runCommand ?? runSanitizedCommandOutcome;
  return (args) => run(runner, coordinates.cwd, [...args, `--account=${coordinates.account}`, '--quiet']);
}

function succeeded({ outcome }: Ran): boolean {
  return outcome.exitCode === 0;
}

function alreadyExists({ outcome }: Ran): boolean {
  return ALREADY_EXISTS.some((pattern) => pattern.test(outcome.stderr));
}

/** A command Google Cloud refused: the step stops with the failed command as evidence. */
function gcloudFailed(message: string, { command, outcome }: Ran): GwsEaError {
  const failure = commandExitError(command, outcome);
  return new GwsEaError('gcloud_failed', message, {
    cause: failure,
    ...(failure.details ? { details: failure.details } : {}),
  });
}

/** The failed command and its redacted stderr tail. */
function evidence({ command, outcome }: Ran): string {
  const failure = commandExitError(command, outcome);
  const tail = failure.details?.stderrTail;
  return typeof tail === 'string' && tail ? `${failure.message}\n${tail}` : failure.message;
}

/** A read that did not decide: unknown, with the failed command as evidence. */
function unknownRead(what: string, failed: Ran): Observation {
  return {
    status: 'unknown',
    reason:
      classifyGcloudFailure(failed.outcome) === 'permission-or-missing'
        ? `Google Cloud denied access to ${what}, which may not exist yet`
        : `Google Cloud could not read ${what}`,
    evidence: evidence(failed),
  };
}

function parseJsonList(stdout: string, label: string): unknown[] {
  const value = parseJson(stdout, label, INVALID_OUTPUT);
  if (!Array.isArray(value)) throw new GwsEaError(INVALID_OUTPUT, `${label} is not a list`);
  const list: unknown[] = value;
  return list;
}

export function deriveGcpProjectId(instanceId: string): string {
  assertInstanceId(instanceId);
  return `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
}

export { deriveGchatServiceAccountEmail } from './gcp-identity.js';

/** gcloud is on PATH and runs. */
export async function assertGcloudInstalled(runner: GcloudCommandRunner = runSanitizedCommandOutcome): Promise<void> {
  await runChecked(runner, ['version', '--format=json']).catch((error: unknown) =>
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
  const stdout = await runChecked(runner, ['auth', 'list', '--filter=status:ACTIVE', '--format=value(account)']);
  const active = stdout
    .split('\n')
    .map((value) => value.trim())
    .filter(Boolean);
  if (active.length > 1 || (active.length === 1 && !ACCOUNT_PATTERN.test(active[0]!))) {
    throw new GwsEaError(INVALID_OUTPUT, 'gcloud reported an invalid active account');
  }
  return active[0];
}

/** `account` holds Google Cloud credentials that still refresh; `SignInRequired` when it must sign in again. */
export async function assertGcloudSignedIn(
  account: string,
  runner: GcloudCommandRunner = runSanitizedCommandOutcome,
): Promise<void> {
  if (!ACCOUNT_PATTERN.test(account)) throw new GwsEaError('invalid_claim', 'GCP account is invalid');
  const token = (await runChecked(runner, ['auth', 'print-access-token', `--account=${account}`, '--quiet'])).trim();
  if (!token) throw new SignInRequired(`Google Cloud returned no credentials for ${account}`);
  registerSecret(token);
}

async function readProject(gcloud: Gcloud, projectId: string): Promise<Read<Project>> {
  const described = await gcloud(['projects', 'describe', projectId, '--format=json']);
  if (!succeeded(described)) return { failed: described };
  const value = parseJson(described.outcome.stdout, 'Google Cloud project', INVALID_OUTPUT);
  if (!isRecord(value)) throw new GwsEaError(INVALID_OUTPUT, 'Google Cloud project must be an object');
  return {
    value: {
      projectId: stringField(value, 'projectId', 'Google Cloud project', INVALID_OUTPUT),
      projectNumber: parseGcpProjectNumber(value.projectNumber),
      lifecycleState: stringField(value, 'lifecycleState', 'Google Cloud project', INVALID_OUTPUT),
      // gcloud omits an empty label map.
      labels: isRecord(value.labels) ? value.labels : {},
    },
  };
}

/** Only a project labeled for this assistant is used or changed; any other is refused by name. */
function assertOwnedProject(coordinates: GcpProjectCoordinates, project: Project): void {
  if (
    project.projectId !== coordinates.projectId ||
    project.labels[PROJECT_LABEL_INSTANCE] !== coordinates.instanceId ||
    project.labels[PROJECT_LABEL_MANAGED] !== 'true'
  ) {
    throw new GwsEaError(
      'gcp_project_owner_mismatch',
      `Google Cloud project ${coordinates.projectId} is not labeled as this assistant's; refusing to use or change it.`,
    );
  }
}

function assertActiveProject(coordinates: GcpProjectCoordinates, project: Project): void {
  if (project.lifecycleState === 'ACTIVE') return;
  const recovery =
    project.lifecycleState === 'DELETE_REQUESTED'
      ? ` Restore it with \`gcloud projects undelete ${coordinates.projectId}\`, or remove this assistant.`
      : '';
  throw new GwsEaError(
    'gcp_project_unavailable',
    `Google Cloud project ${coordinates.projectId} is ${project.lifecycleState}, not ACTIVE.${recovery}`,
  );
}

/** The add-on signing identity's project number, read only from the owned, active project. */
export async function getOwnedGcpProjectNumber(
  coordinates: GcpProjectCoordinates,
  dependencies: GcloudDependencies = {},
): Promise<string> {
  const read = await readProject(gcloudFor(coordinates, dependencies), coordinates.projectId);
  if ('failed' in read) {
    throw gcloudFailed(`Google Cloud could not describe project ${coordinates.projectId}`, read.failed);
  }
  assertOwnedProject(coordinates, read.value);
  assertActiveProject(coordinates, read.value);
  if (!read.value.projectNumber) {
    throw new GwsEaError(INVALID_OUTPUT, 'Google Cloud returned an invalid project number');
  }
  return read.value.projectNumber;
}

function serviceAccountDescription(instanceId: string): string {
  return `Owned by GWS-EA instance ${instanceId}`;
}

/** The Chat service account as listed, or undefined when the conclusive list lacks it. */
async function readServiceAccount(
  gcloud: Gcloud,
  gcp: GcpProjectInput,
): Promise<Read<Readonly<Record<string, unknown>> | undefined>> {
  const listed = await gcloud(['iam', 'service-accounts', 'list', `--project=${gcp.projectId}`, '--format=json']);
  if (!succeeded(listed)) return { failed: listed };
  const accounts = parseJsonList(listed.outcome.stdout, 'Google Cloud service accounts');
  return { value: accounts.filter(isRecord).find((account) => account.email === gcp.serviceAccountEmail) };
}

function assertOwnedServiceAccount(gcp: GcpProjectInput, account: Readonly<Record<string, unknown>>): void {
  if (
    account.displayName !== SERVICE_ACCOUNT_DISPLAY_NAME ||
    account.description !== serviceAccountDescription(gcp.instanceId)
  ) {
    throw new GwsEaError(
      'gcp_service_account_owner_mismatch',
      `Service account ${gcp.serviceAccountEmail} is not marked as this assistant's; refusing to use or change it.`,
    );
  }
}

/** The IDs of the Chat account's user-managed keys; an empty list is conclusive. */
async function readUserManagedKeys(gcloud: Gcloud, gcp: GcpProjectInput): Promise<Read<readonly string[]>> {
  const listed = await gcloud([
    'iam',
    'service-accounts',
    'keys',
    'list',
    `--iam-account=${gcp.serviceAccountEmail}`,
    `--project=${gcp.projectId}`,
    '--managed-by=user',
    '--format=json',
  ]);
  if (!succeeded(listed)) return { failed: listed };
  return {
    value: parseJsonList(listed.outcome.stdout, 'Google Cloud service-account keys').map(
      (key) =>
        requireString(isRecord(key) ? key.name : undefined, 'Google Cloud service-account key name', INVALID_OUTPUT)
          .split('/')
          .at(-1)!,
    ),
  };
}

/**
 * A service-account key for the reserved project and account. Only the fields
 * gws-ea uses are read; any other field is ignored.
 */
export function parseGchatServiceAccountCredential(
  contents: string,
  expected: { readonly projectId: string; readonly serviceAccountEmail: string },
): ServiceAccountCredential {
  const value = parseJson(contents, 'Google Chat credential', INVALID_CREDENTIAL);
  if (!isRecord(value) || value.type !== 'service_account') {
    throw new GwsEaError(INVALID_CREDENTIAL, 'Google Chat credential is not a service-account key');
  }
  const field = (key: string): string => stringField(value, key, 'Google Chat credential', INVALID_CREDENTIAL);
  const projectId = field('project_id');
  const privateKeyId = field('private_key_id');
  const clientEmail = field('client_email');
  const privateKey = value.private_key;
  if (
    typeof privateKey !== 'string' ||
    !privateKey.startsWith('-----BEGIN PRIVATE KEY-----\n') ||
    !privateKey.trimEnd().endsWith('\n-----END PRIVATE KEY-----')
  ) {
    throw new GwsEaError(INVALID_CREDENTIAL, 'Google Chat credential contains an invalid private key');
  }
  if (projectId !== expected.projectId || clientEmail !== expected.serviceAccountEmail) {
    throw new GwsEaError('gchat_credential_mismatch', 'Google Chat credential does not match the reserved project');
  }
  return { projectId, privateKeyId, clientEmail };
}

/** A key file as found: missing, unusable (unreadable, wrong mode, or invalid), or valid. */
async function readKeyFile(file: string, gcp: GcpProjectInput): Promise<KeyFile> {
  try {
    const contents = await readOwnerOnlyFile(file);
    return { status: 'valid', contents, keyId: parseGchatServiceAccountCredential(contents, gcp).privateKeyId };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return { status: 'missing' };
    // The file's own faults: its type, owner, or mode, its permissions, or its contents.
    const fileFault = error instanceof GwsEaError || isErrno(error, 'EACCES') || isErrno(error, 'EPERM');
    if (fileFault && error instanceof Error) return { status: 'unusable', problem: error.message };
    throw error;
  }
}

function stagingFile(gcp: GcpProjectInput): string {
  return `${gcp.credentialFile}.staging`;
}

function policyPermissionPause(coordinates: GcpProjectCoordinates): ProvisionHumanPause {
  return {
    kind: 'human-action',
    phase: 'provision_gcp',
    code: 'gcp_policy_permission_required',
    message: `Google Cloud refused to change the Google Chat key-creation policy on project ${coordinates.projectId}.`,
    details: [
      `Grant ${coordinates.account} Organization Policy Administrator (${POLICY_ADMIN_ROLE}) on the organization that contains project ${coordinates.projectId}, then resume.`,
    ],
  };
}

/** A key-creation constraint Google refused to set, and the refused command. */
interface PolicyRefusal {
  readonly constraint: string;
  readonly refused: Ran;
}

/** Set both key-creation constraints on the dedicated project only (org-policies v2). */
async function setKeyCreationPolicy(
  coordinates: GcpProjectCoordinates,
  enforce: boolean,
  dependencies: GcloudDependencies,
): Promise<PolicyRefusal | undefined> {
  const gcloud = gcloudFor(coordinates, dependencies);
  const { projectId } = coordinates;
  const directory = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-org-policy-'));
  try {
    for (const constraint of KEY_CREATION_CONSTRAINTS) {
      const file = path.join(directory, `${constraint}.json`);
      const policy = { name: `projects/${projectId}/policies/${constraint}`, spec: { rules: [{ enforce }] } };
      await writeFile(file, JSON.stringify(policy), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      const set = await gcloud(['org-policies', 'set-policy', file, `--project=${projectId}`]);
      if (!succeeded(set)) return { constraint, refused: set };
    }
    return undefined;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

/** For `provision_gcp`: a missing policy permission pauses for the operator; any other refusal stops. */
async function changeKeyCreationPolicy(
  coordinates: GcpProjectCoordinates,
  enforce: boolean,
  dependencies: GcloudDependencies,
): Promise<Pause> {
  const refusal = await setKeyCreationPolicy(coordinates, enforce, dependencies);
  if (!refusal) return undefined;
  if (classifyGcloudFailure(refusal.refused.outcome) === 'permission-or-missing') {
    return policyPermissionPause(coordinates);
  }
  const change = enforce ? 'restore' : 'lift';
  throw gcloudFailed(
    `Google Cloud could not ${change} ${refusal.constraint} on project ${coordinates.projectId}`,
    refusal.refused,
  );
}

/** Restore the dedicated project's key-creation policy, then clear the journal's lift. */
async function restoreKeyCreationPolicy(context: GcpStepContext, dependencies: GcloudDependencies): Promise<Pause> {
  const pause = await changeKeyCreationPolicy(context.input.gcp, true, dependencies);
  if (!pause) await recordKeyPolicyLifted(context.operation, false);
  return pause;
}

/**
 * Create a key into the staging file. When policy blocks creation, record the
 * lift in the journal, lift the policy on the dedicated project, retry while
 * Google applies the change, and restore the policy before returning.
 */
async function createKey(context: GcpStepContext, dependencies: GcloudDependencies): Promise<Pause> {
  const gcp = context.input.gcp;
  const gcloud = gcloudFor(gcp, dependencies);
  const staging = stagingFile(gcp);
  const create = async (): Promise<Ran> => {
    const created = await gcloud([
      'iam',
      'service-accounts',
      'keys',
      'create',
      staging,
      `--iam-account=${gcp.serviceAccountEmail}`,
      '--key-file-type=json',
      `--project=${gcp.projectId}`,
    ]);
    // gcloud opens the output file before Google answers, so a refusal leaves it empty.
    if (!succeeded(created)) await rm(staging, { force: true });
    return created;
  };
  const blocked = (attempt: Ran): boolean =>
    !succeeded(attempt) && classifyGcloudFailure(attempt.outcome) === 'precondition';

  let created = await create();
  if (blocked(created)) {
    await recordKeyPolicyLifted(context.operation, true);
    const denied = await changeKeyCreationPolicy(gcp, false, dependencies);
    if (denied) return denied;
    const sleep = dependencies.sleep ?? delay;
    let restored: Pause;
    try {
      created = await create();
      for (const seconds of OBSERVATION_WAITS_SECONDS) {
        if (!blocked(created)) break;
        dependencies.onWait?.('Waiting for Google Cloud to allow Google Chat key creation…');
        await sleep(seconds * 1_000);
        created = await create();
      }
    } finally {
      restored = await restoreKeyCreationPolicy(context, dependencies);
    }
    if (restored) return restored;
  }
  if (!succeeded(created)) {
    const message = blocked(created)
      ? `Google Cloud still refused key creation on project ${gcp.projectId} after its policy was lifted; resume to retry`
      : `Google Cloud could not create a key for ${gcp.serviceAccountEmail}`;
    throw gcloudFailed(message, created);
  }
  return undefined;
}

/** Delete every user-managed key of the Chat account, once it is confirmed to be this assistant's. */
async function deleteUserManagedKeys(gcloud: Gcloud, gcp: GcpProjectInput): Promise<void> {
  const account = await readServiceAccount(gcloud, gcp);
  if ('failed' in account) {
    throw gcloudFailed(`Google Cloud could not list service account ${gcp.serviceAccountEmail}`, account.failed);
  }
  if (!account.value) {
    throw new GwsEaError('gcp_service_account_missing', `Service account ${gcp.serviceAccountEmail} is not listed`);
  }
  assertOwnedServiceAccount(gcp, account.value);
  const keys = await readUserManagedKeys(gcloud, gcp);
  if ('failed' in keys) {
    throw gcloudFailed(`Google Cloud could not list the keys of ${gcp.serviceAccountEmail}`, keys.failed);
  }
  for (const key of keys.value) {
    const deleted = await gcloud([
      'iam',
      'service-accounts',
      'keys',
      'delete',
      key,
      `--iam-account=${gcp.serviceAccountEmail}`,
      `--project=${gcp.projectId}`,
    ]);
    if (!succeeded(deleted)) {
      throw gcloudFailed(`Google Cloud could not delete key ${key} of ${gcp.serviceAccountEmail}`, deleted);
    }
  }
}

/**
 * Keys converge by replacement. A key staged before an interruption is
 * published without creating another; otherwise this assistant's keys are
 * deleted and a new one is created to the staging file, validated, and
 * published atomically.
 */
async function replaceKey(context: GcpStepContext, dependencies: GcloudDependencies): Promise<Pause> {
  const gcp = context.input.gcp;
  const staging = stagingFile(gcp);
  let staged = await readKeyFile(staging, gcp);
  if (staged.status !== 'valid') {
    await rm(staging, { force: true });
    await deleteUserManagedKeys(gcloudFor(gcp, dependencies), gcp);
    await preparePrivateDirectory(path.dirname(gcp.credentialFile));
    const pause = await createKey(context, dependencies);
    if (pause) return pause;
    await chmod(staging, 0o600);
    staged = await readKeyFile(staging, gcp);
    if (staged.status !== 'valid') {
      const problem = staged.status === 'unusable' ? staged.problem : 'no key file was written';
      throw new GwsEaError(INVALID_CREDENTIAL, `Google Cloud created an unusable Google Chat key: ${problem}`);
    }
  }
  await writePrivateTextFile(gcp.credentialFile, staged.contents);
  await removePrivateFile(staging);
  return undefined;
}

/**
 * `provision_gcp`'s resources, in order. A policy lift left by an
 * interrupted run is restored before anything else; the project is the one
 * resource created on an unknown observation, under the instance's own ID.
 */
export function googleCloudResources(dependencies: GcloudDependencies = {}): readonly StepResource<GcpStepContext>[] {
  const gcloud = (context: GcpStepContext): Gcloud => gcloudFor(context.input.gcp, dependencies);
  return [
    {
      name: 'the Google Chat key-creation policy',
      observe: async ({ operation }) =>
        (await readProvisionJournal(operation.paths, operation.instanceId)).key_policy_lifted ? ABSENT : PRESENT,
      apply: (context) => restoreKeyCreationPolicy(context, dependencies),
    },
    {
      name: 'the Google Cloud project',
      unknown: 'create-by-unique-id',
      observe: async (context) => {
        const gcp = context.input.gcp;
        const read = await readProject(gcloud(context), gcp.projectId);
        if ('failed' in read) return unknownRead(`project ${gcp.projectId}`, read.failed);
        assertOwnedProject(gcp, read.value);
        assertActiveProject(gcp, read.value);
        return PRESENT;
      },
      apply: async (context) => {
        const gcp = context.input.gcp;
        const created = await gcloud(context)([
          'projects',
          'create',
          gcp.projectId,
          '--name=GWS-EA assistant',
          `--labels=${PROJECT_LABEL_INSTANCE}=${gcp.instanceId},${PROJECT_LABEL_MANAGED}=true`,
          '--format=json',
        ]);
        // An existing project is adopted only if the next observation finds this assistant's labels.
        if (!succeeded(created) && !alreadyExists(created)) {
          throw gcloudFailed(`Google Cloud could not create project ${gcp.projectId}`, created);
        }
        return undefined;
      },
    },
    {
      name: 'the Google Cloud APIs',
      observe: async (context) => {
        const gcp = context.input.gcp;
        const listed = await gcloud(context)([
          'services',
          'list',
          '--enabled',
          `--project=${gcp.projectId}`,
          '--format=value(config.name)',
        ]);
        if (!succeeded(listed)) return unknownRead(`the APIs of project ${gcp.projectId}`, listed);
        const enabled = new Set(listed.outcome.stdout.split('\n').map((line) => line.trim()));
        return REQUIRED_APIS.every((api) => enabled.has(api)) ? PRESENT : ABSENT;
      },
      apply: async (context) => {
        const gcp = context.input.gcp;
        const enabled = await gcloud(context)(['services', 'enable', ...REQUIRED_APIS, `--project=${gcp.projectId}`]);
        if (!succeeded(enabled)) {
          throw gcloudFailed(`Google Cloud could not enable APIs on project ${gcp.projectId}`, enabled);
        }
        return undefined;
      },
    },
    {
      name: 'the Google Chat service account',
      observe: async (context) => {
        const gcp = context.input.gcp;
        const read = await readServiceAccount(gcloud(context), gcp);
        if ('failed' in read) return unknownRead(`the service accounts of project ${gcp.projectId}`, read.failed);
        if (!read.value) return ABSENT;
        assertOwnedServiceAccount(gcp, read.value);
        return PRESENT;
      },
      apply: async (context) => {
        const gcp = context.input.gcp;
        const created = await gcloud(context)([
          'iam',
          'service-accounts',
          'create',
          GCHAT_SERVICE_ACCOUNT_ID,
          `--display-name=${SERVICE_ACCOUNT_DISPLAY_NAME}`,
          `--description=${serviceAccountDescription(gcp.instanceId)}`,
          `--project=${gcp.projectId}`,
          '--format=json',
        ]);
        // Created by an interrupted run but not yet listed: the next observation waits for it.
        if (!succeeded(created) && !alreadyExists(created)) {
          throw gcloudFailed(`Google Cloud could not create service account ${gcp.serviceAccountEmail}`, created);
        }
        return undefined;
      },
    },
    {
      name: 'the Google Chat credential',
      observe: async (context) => {
        const gcp = context.input.gcp;
        const local = await readKeyFile(gcp.credentialFile, gcp);
        if (local.status === 'unusable') {
          return {
            status: 'unknown',
            reason: `${gcp.credentialFile} is unusable; fix it, or remove it to replace the key, then resume`,
            evidence: local.problem,
          };
        }
        if (local.status === 'missing') return ABSENT;
        const keys = await readUserManagedKeys(gcloud(context), gcp);
        if ('failed' in keys) return unknownRead(`the keys of ${gcp.serviceAccountEmail}`, keys.failed);
        return keys.value.includes(local.keyId) ? PRESENT : ABSENT;
      },
      apply: (context) => replaceKey(context, dependencies),
    },
  ];
}

/**
 * Removal's restore of a key-creation policy `provision_gcp` lifted.
 * Returns what Google refused as evidence, for the receipt to record as an
 * unrestored lift, rather than pausing the way `provision_gcp` does.
 */
export async function restoreKeyCreationPolicyForRemoval(
  coordinates: GcpProjectCoordinates,
  dependencies: GcloudDependencies = {},
): Promise<string | undefined> {
  const refusal = await setKeyCreationPolicy(coordinates, true, dependencies);
  return refusal && `${refusal.constraint}: ${evidence(refusal.refused)}`;
}

export interface GcpProjectRemovalOptions {
  /** `provision_gcp` lifted the key-creation policy: restore it before deleting the project. */
  readonly restoreKeyPolicy: boolean;
}

/** Removal's side of the reserved project: deleted (now or earlier), or unknown with evidence. */
export type GcpProjectRemoval =
  | { readonly status: 'deleted'; readonly keyPolicyUnrestored?: string }
  | { readonly status: 'unknown'; readonly reason: string; readonly evidence: string };

/**
 * Delete the owned project. It is deleted only once it is described
 * with this assistant's labels, after any lifted key-creation policy is
 * restored; a restore Google refuses is reported, not a reason to keep the
 * project. A project Google will not describe is unknown, with evidence:
 * whether that may be skipped or abandoned is removal's decision.
 */
export async function deleteOwnedGcpProject(
  coordinates: GcpProjectCoordinates,
  options: GcpProjectRemovalOptions,
  dependencies: GcloudDependencies = {},
): Promise<GcpProjectRemoval> {
  const gcloud = gcloudFor(coordinates, dependencies);
  const read = await readProject(gcloud, coordinates.projectId);
  if ('failed' in read) {
    return {
      status: 'unknown',
      reason: `Google Cloud will not show project ${coordinates.projectId} to ${coordinates.account}, so removal cannot tell whether it still exists`,
      evidence: evidence(read.failed),
    };
  }
  assertOwnedProject(coordinates, read.value);
  if (read.value.lifecycleState === 'DELETE_REQUESTED') return { status: 'deleted' };
  assertActiveProject(coordinates, read.value);
  const keyPolicyUnrestored = options.restoreKeyPolicy
    ? await restoreKeyCreationPolicyForRemoval(coordinates, dependencies)
    : undefined;
  const deleted = await gcloud(['projects', 'delete', coordinates.projectId]);
  if (!succeeded(deleted)) {
    throw gcloudFailed(`Google Cloud could not delete project ${coordinates.projectId}`, deleted);
  }
  const after = await readProject(gcloud, coordinates.projectId);
  if ('value' in after && after.value.lifecycleState !== 'DELETE_REQUESTED') {
    throw new GwsEaError(
      'gcp_delete_unconfirmed',
      `Google Cloud did not confirm deletion of project ${coordinates.projectId}`,
    );
  }
  return keyPolicyUnrestored ? { status: 'deleted', keyPolicyUnrestored } : { status: 'deleted' };
}
