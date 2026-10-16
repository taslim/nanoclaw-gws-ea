/**
 * Removal from any partial state. A resource is observed only when
 * the provisioning step that owns it ever started: no journal means
 * nothing started, and a journal this launcher cannot read means every
 * resource is observed. An absent resource is done; an owned one is deleted
 * and observed again; a foreign one is refused by name; one that cannot be
 * observed pauses with evidence until the operator abandons it. Everything a
 * resource needs — Docker, NanoClaw's service helpers, the operator's and the
 * assistant's Google sign-ins — is checked before the first change, and
 * removal locks only its own instance, so one stuck removal
 * never blocks another assistant. NanoClaw's helpers stop the host; removal
 * then cleans up what they leave. The assistant's Google Chat subscription
 * goes after the host, which would only create it again, and before the
 * project, which takes its topic, its Pub/Sub subscription, and its
 * subscriber account with it (KTD13). The assistant's 1Password resources
 * go after the host too, once nothing can use them: their IDs are copied into
 * the receipt before anything changes, and the receipt outlives the instance
 * while a service account remains for the operator to revoke (KTD9).
 * An unfinished update or rollback never stops it: its releases, what is
 * kept with them, its snapshots, and its quarantined state all sit under the
 * instance root, and go with it. So does every image the assistant's
 * releases tagged or its rebuilds displaced, while the images assistants
 * share stay (KTD6). Nor does the phase the assistant is in (R9): fenced, it
 * is removed from its physical state.
 */
import { access, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { isErrno } from '../community-portal/errors.js';
import { getInstallScopedNames } from '../install-slug.js';
import { createWorkspaceEventsApi, type WorkspaceEventsApi } from '../modules/gws-ea-chat/subscription.js';
import { GOOGLE_GRANT_FILE_NAME, type GoogleGrant } from '../modules/gws-ea-google/grant.js';
import { readGoogleGrantFile } from '../modules/gws-ea-google/grant-file.js';
import {
  GoogleGrantRevokedError,
  GoogleScopeNotGrantedError,
  GoogleTokenError,
  mintServiceToken,
} from '../modules/gws-ea-google/tokens.js';
import { GoogleApiError } from '../modules/gws-ea-inbox/gmail-api.js';
import { reclaimImage } from './agent-image-release.js';
import { PauseRequired, runStep, withGoogleSignIn, type StepIdentity, type StepReporter } from './events.js';
import {
  assertGcloudInstalled,
  assertGcloudSignedIn,
  deleteOwnedGcpProject,
  restoreKeyCreationPolicyForRemoval,
  restoreMemberDomainPolicyForRemoval,
  type GcloudCommandRunner,
  type GcpProjectCoordinates,
} from './gcloud.js';
import { readProvisionJournal } from './journal.js';
import type { OnePasswordCliSeams } from './onepassword.js';
import {
  captureOnePasswordCleanup,
  onePasswordDeletionBlock,
  onePasswordEvidence,
  onePasswordRemovalOutcome,
  parseOnePasswordCleanup,
  previewOnePasswordCleanup,
  settleOnePasswordCleanup,
  withSelection,
  type OnePasswordBlock,
  type OnePasswordCapture,
  type OnePasswordCleanup,
  type OnePasswordRemovalOutcome,
  type OnePasswordRemovalPreview,
} from './onepassword-removal.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { removeOnecliRuntime } from './onecli.js';
import { readOperationRecord, type OperationRecord } from './operation.js';
import { CONTROL_PLANE_ROOT, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { pollUntil } from './poll.js';
import { probeRecordedDockerEndpoint, resolveDockerEndpoint } from './prerequisites.js';
import { redact } from './redact.js';
import {
  buildToolEnvironment,
  checkedRunner,
  commandExitError,
  runSanitizedCommandOutcome,
  type SanitizedCommand,
  type SanitizedCommandOutcomeRunner,
} from './process.js';
import {
  assertInstanceId,
  assertStateConsistent,
  getInstanceReservation,
  readRegistry,
  releaseInstanceReservation,
  validateReservation,
} from './registry.js';
import { activeStep } from './run-log.js';
import { readOwnerOnlyJson, removePrivateFile } from './secrets.js';
import { serviceManagerEnvironment } from './service.js';
import { createServiceControl, type NanoclawServiceHelpers, type ServiceControlTarget } from './service-control.js';
import {
  createInstanceServiceCoordinates,
  instanceServicePlatform,
  type InstanceServiceCoordinates,
  type InstanceServicePlatform,
} from './service-coordinates.js';
import { GwsEaError, type InstanceReservation, type ProvisionStepId } from './types.js';
import { canonicalTimestamp, isRecord, requireDockerEndpoint, requirePath } from './validation.js';

/** Resources in teardown order; the registry entry is released after all of them. */
export const REMOVAL_RESOURCES = [
  'nanoclaw',
  'chat-subscription',
  'onepassword',
  'gcp-project',
  'onecli',
  'instance-files',
] as const;
export type RemovalResource = (typeof REMOVAL_RESOURCES)[number];

/**
 * What an operator may leave behind when removal cannot observe it (`--abandon`):
 * the Google Cloud project, the assistant's Google Chat subscription when
 * Google refuses its sign-in, or its 1Password resources: a vault removal
 * cannot settle, and the service accounts only the operator can revoke.
 */
export const ABANDONABLE_RESOURCES = ['gcp-project', 'chat-subscription', 'onepassword'] as const;
export type AbandonableResource = (typeof ABANDONABLE_RESOURCES)[number];

/** What leaving each resource behind means, as a pause tells the operator. */
const LEAVING_BEHIND: Readonly<Record<AbandonableResource, string>> = {
  'gcp-project':
    "Leave it behind only if it is already gone or is not this assistant's; removal records this evidence.",
  'chat-subscription':
    'Leaving it behind is safe: once the project is deleted it delivers nowhere, and Google deletes it within 7 days; removal records this evidence.',
  onepassword:
    'Leaving it behind keeps the vault and its items in 1Password and stops tracking its service accounts; removal records their IDs as evidence, so you can delete or revoke them yourself on 1Password.com.',
};

function isAbandonable(resource: RemovalResource): resource is RemovalResource & AbandonableResource {
  return ABANDONABLE_RESOURCES.some((candidate) => candidate === resource);
}

const RECEIPT_SCHEMA_VERSION = 3 as const;
const INVALID_RECORD = 'invalid_runtime_config';
/** A receipt whose 1Password IDs cannot be read is never set aside: that would lose them. */
const UNREADABLE_CLEANUP = 'removal_receipt_unreadable';

const RESOURCE_STEPS: Readonly<Record<RemovalResource, StepIdentity>> = {
  nanoclaw: { id: 'remove_nanoclaw', label: 'Stopping NanoClaw…' },
  'chat-subscription': { id: 'remove_chat_subscription', label: 'Deleting the Google Chat subscription…' },
  onepassword: { id: 'remove_onepassword', label: "Cleaning up the assistant's 1Password vault and token…" },
  'gcp-project': { id: 'remove_gcp_project', label: 'Deleting the Google Cloud project…' },
  onecli: { id: 'remove_onecli', label: 'Removing OneCLI…' },
  'instance-files': { id: 'remove_instance_files', label: 'Removing local files…' },
};

interface Evidence {
  readonly at: string;
  readonly evidence: string;
}

/** The durable record of a removal under way: its reservation snapshot and what each resource came to. */
interface RemovalReceipt {
  readonly schema_version: typeof RECEIPT_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly reservation: InstanceReservation;
  readonly started_at: string;
  readonly completed: Readonly<Partial<Record<RemovalResource, string>>>;
  readonly abandoned: Readonly<Partial<Record<AbandonableResource, Evidence>>>;
  /** A key-creation policy `provision_gcp` lifted that Google refused to restore. */
  readonly key_policy_unrestored?: Evidence;
  /** A member-domain policy `provision_gcp` relaxed that Google refused to restore. */
  readonly member_policy_unrestored?: Evidence;
  /** The assistant's 1Password IDs and what became of them; kept here, outside the instance, until the operator closes it. */
  readonly onepassword?: OnePasswordCleanup;
}

/** What local teardown uses, as the instance recorded it. */
export interface LocalRuntime {
  readonly homeDirectory: string;
  readonly dockerEndpoint: string;
}

/** The human input removal may need, through the driver's `Interaction` port. */
export interface RemovalInteraction {
  signInToGoogleCloud(account: string): Promise<void>;
}

/** What the driver supplies to one removal. */
export interface RemovalOptions {
  readonly interaction: RemovalInteraction;
  /** Resources the operator accepts leaving behind if removal cannot observe them. */
  readonly abandon?: ReadonlySet<AbandonableResource>;
  readonly reporter?: StepReporter;
  /** NanoClaw's service helpers (`scripts/update/service.ts`), which stop the host; the driver supplies them. */
  readonly serviceHelpers?: NanoclawServiceHelpers;
  /** The operator's choice, confirmed with the removal, to delete an app-created vault that still holds items. */
  readonly deleteVault?: boolean;
  /** How the 1Password CLI the host recorded is run. */
  readonly onePassword?: OnePasswordCliSeams;
}

/** Boundary seams; each defaults to the real one. */
export interface RemovalDependencies extends RemovalOptions {
  readonly platform?: InstanceServicePlatform;
  /** Reaches Google as the assistant: its Chat token and its Workspace Events subscription. */
  readonly fetch?: typeof globalThis.fetch;
  /** Runs local teardown: the service manager fallback, the stray-host kill, and Docker. */
  readonly runCommand?: SanitizedCommandOutcomeRunner;
  readonly runGcloud?: GcloudCommandRunner;
  /** Probe the recorded Docker endpoint, else resolve the active local one. */
  readonly resolveDocker?: (recorded: string | undefined) => Promise<string>;
  readonly uninstallNanoclaw?: (reservation: InstanceReservation, runtime: LocalRuntime) => Promise<void>;
  readonly removeOnecli?: (reservation: InstanceReservation, runtime: LocalRuntime) => Promise<void>;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

export interface AbandonedResource {
  readonly resource: AbandonableResource;
  readonly evidence: string;
}

export interface RemovalOutcome {
  /** Resources removal observed and removed, or found already gone. */
  readonly removed: readonly RemovalResource[];
  readonly abandoned: readonly AbandonedResource[];
  /** Why a lifted key-creation policy could not be restored. */
  readonly keyPolicyUnrestored?: string;
  /** Why a relaxed member-domain policy could not be restored. */
  readonly memberPolicyUnrestored?: string;
  /** What became of the assistant's 1Password resources, and what only the operator can still do. */
  readonly onepassword?: OnePasswordRemovalOutcome;
}

/**
 * Removal cannot observe a resource. It pauses with the evidence; the operator
 * fixes access and retries, or leaves the resource behind with `--abandon`.
 */
export class RemovalPause extends PauseRequired {
  readonly resource: AbandonableResource;

  constructor(resource: AbandonableResource, reason: string, evidence: string) {
    super(`${resource.replaceAll('-', '_')}_unobservable`, reason, [
      'Evidence:',
      ...evidence.split('\n').map((line) => `  ${line}`),
      LEAVING_BEHIND[resource],
    ]);
    this.name = 'RemovalPause';
    this.resource = resource;
  }
}

export interface RemovalPreview {
  readonly instanceId: string;
  readonly checkout: string;
  readonly gcpProject: string;
  readonly gcpAccount: string;
  readonly onecliProject: string;
  /** Null when the assistant has no 1Password record removal can read. */
  readonly onepassword: OnePasswordRemovalPreview | null;
}

function evidenceOf(value: unknown): Evidence | undefined {
  if (!isRecord(value) || typeof value.evidence !== 'string') return undefined;
  const at = canonicalTimestamp(value.at);
  return at ? { at, evidence: value.evidence } : undefined;
}

function entries<K extends string, V>(keys: readonly K[], value: unknown, parse: (entry: unknown) => V | undefined) {
  const parsed: Partial<Record<K, V>> = {};
  if (!isRecord(value)) return parsed;
  for (const key of keys) {
    const entry = parse(value[key]);
    if (entry !== undefined) parsed[key] = entry;
  }
  return parsed;
}

/**
 * The receipt of a removal already under way. Unknown fields are ignored. A
 * receipt that cannot be read safely, or that another schema wrote, is set
 * aside: everything it could say is re-observed.
 */
async function readReceipt(paths: ControlPlanePaths, instanceId: string): Promise<RemovalReceipt | undefined> {
  try {
    const raw = await readOwnerOnlyJson(paths.removalFile(instanceId), 'Removal receipt', 'invalid_removal');
    if (!isRecord(raw) || raw.instance_id !== instanceId) {
      throw new GwsEaError('invalid_removal', 'Removal receipt does not match this instance');
    }
    if (raw.schema_version !== RECEIPT_SCHEMA_VERSION) {
      throw new GwsEaError(
        'invalid_removal',
        `Removal receipt schema ${String(raw.schema_version)} is not this launcher's`,
      );
    }
    const reservation = validateReservation(raw.reservation);
    if (reservation.instance_id !== instanceId) {
      throw new GwsEaError('invalid_removal', 'Removal receipt reservation does not match this instance');
    }
    const keyPolicyUnrestored = evidenceOf(raw.key_policy_unrestored);
    const memberPolicyUnrestored = evidenceOf(raw.member_policy_unrestored);
    const onepassword = raw.onepassword === undefined ? undefined : parseOnePasswordCleanup(raw.onepassword);
    if (raw.onepassword !== undefined && !onepassword)
      throw new GwsEaError(
        UNREADABLE_CLEANUP,
        `The removal receipt ${paths.removalFile(instanceId)} names 1Password resources it cannot read safely; removal stops so their IDs are not lost. Inspect it before retrying.`,
      );
    return {
      schema_version: RECEIPT_SCHEMA_VERSION,
      instance_id: instanceId,
      reservation,
      started_at: canonicalTimestamp(raw.started_at) ?? new Date().toISOString(),
      completed: entries(REMOVAL_RESOURCES, raw.completed, canonicalTimestamp),
      abandoned: entries(ABANDONABLE_RESOURCES, raw.abandoned, evidenceOf),
      ...(keyPolicyUnrestored ? { key_policy_unrestored: keyPolicyUnrestored } : {}),
      ...(memberPolicyUnrestored ? { member_policy_unrestored: memberPolicyUnrestored } : {}),
      ...(onepassword ? { onepassword } : {}),
    };
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    if (!(error instanceof GwsEaError) || error.code === UNREADABLE_CLEANUP) throw error;
    activeStep()?.write(`${error.message}; its resources are observed again\n`);
    return undefined;
  }
}

/** Which provisioning steps ever started, and whether `provision_gcp` left the key policy lifted. */
interface ProvisioningRecord {
  readonly started: (step: ProvisionStepId) => boolean;
  readonly keyPolicyLifted: boolean;
}

async function readProvisioningRecord(paths: ControlPlanePaths, instanceId: string): Promise<ProvisioningRecord> {
  try {
    const journal = await readProvisionJournal(paths, instanceId);
    return { started: (step) => journal.steps[step] !== undefined, keyPolicyLifted: journal.key_policy_lifted };
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    if (error.code === 'journal_missing') return { started: () => false, keyPolicyLifted: false };
    activeStep()?.write(`${error.message}; every resource is observed\n`);
    return { started: () => true, keyPolicyLifted: false };
  }
}

async function readRecord(file: string): Promise<Record<string, unknown> | undefined> {
  try {
    const value = await readOwnerOnlyJson(file, 'Instance record', INVALID_RECORD);
    return isRecord(value) ? value : undefined;
  } catch (error) {
    if (isErrno(error, 'ENOENT') || isErrno(error, 'ENOTDIR')) return undefined;
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(`${error.message}; not used for removal\n`);
    return undefined;
  }
}

/**
 * The record of an unfinished update or rollback: undefined when there is
 * none, null when it cannot be read. Removal goes on without what an
 * unreadable one would say.
 */
async function readUnfinishedOperation(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<OperationRecord | undefined | null> {
  try {
    return await readOperationRecord(paths, instanceId);
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    activeStep()?.write(
      `${error.message}; the live checkout is checked by its instance identity alone, and only the images its repository still tags are deleted\n`,
    );
    return null;
  }
}

/**
 * The agent images an update's or rollback's rebuilds displaced, by ID: an
 * agent group's image a rebuild displaced keeps no tag to be found by, and the
 * record is the only place that names it until its follow-up reclaims it.
 */
function recordedAgentImages(record: OperationRecord | undefined | null): readonly string[] {
  if (!record) return [];
  return record.follow_ups.flatMap((followUp) => (followUp.kind === 'reclaim_image' ? [followUp.image_id] : []));
}

/**
 * The home directory and Docker endpoint the instance recorded:
 * `runtime.json` in its `state/` once create wrote it, else the bootstrap
 * manifest create wrote first. Only these fields are read, so files an
 * earlier launcher wrote still remove cleanly.
 */
async function readRecordedRuntime(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<{ readonly homeDirectory?: string; readonly dockerEndpoint?: string }> {
  const records = await Promise.all([
    readRecord(paths.runtimeFile(reservation.instance_id)),
    readRecord(paths.bootstrapFile(reservation.instance_id)),
  ]);
  const field = (key: string, parse: (value: unknown, label: string, code: string) => string): string | undefined => {
    for (const record of records) {
      if (record?.[key] === undefined) continue;
      try {
        return parse(record[key], key, INVALID_RECORD);
      } catch (error) {
        if (!(error instanceof GwsEaError)) throw error;
      }
    }
    return undefined;
  };
  const homeDirectory = field('home_directory', requirePath);
  const dockerEndpoint = field('docker_endpoint', requireDockerEndpoint);
  return {
    ...(homeDirectory ? { homeDirectory } : {}),
    ...(dockerEndpoint ? { dockerEndpoint } : {}),
  };
}

/** Evaluate once, on first use. */
function once<T>(evaluate: () => Promise<T>): () => Promise<T> {
  let value: Promise<T> | undefined;
  return () => (value ??= evaluate());
}

/** The assistant's Google sign-in, where every runtime keeps it: in the instance's secrets (`googleGrantFile`). */
function grantFileOf(paths: ControlPlanePaths, instanceId: string): string {
  return path.join(paths.instanceRoot(instanceId), 'secrets', GOOGLE_GRANT_FILE_NAME);
}

/**
 * Google's answer to the assistant's sign-in is final: the grant is revoked
 * or short of Chat's scopes, or Google refuses its token or the call. Only an
 * unreachable or overloaded Google is worth asking again.
 */
function googleRefuses(error: unknown): boolean {
  if (error instanceof GoogleApiError) return !error.retryable;
  if (error instanceof GoogleTokenError) return error.refused;
  return error instanceof GoogleGrantRevokedError || error instanceof GoogleScopeNotGrantedError;
}

/** What Google, or reading the sign-in, answered: its message, which names no secret, redacted all the same. */
function answerOf(error: unknown): string {
  return redact(error instanceof Error ? error.message : String(error));
}

/** Why removal cannot see the assistant's Chat subscription. */
interface ChatSubscriptionRefusal {
  readonly reason: string;
  readonly evidence: string;
}

/** How removal reaches the assistant's Chat subscription, which only the assistant's own sign-in can see. */
type ChatSubscriptionAccess =
  /** The assistant never signed in, so its host never subscribed. */
  | { readonly state: 'unsigned' }
  | { readonly state: 'signed-in'; readonly account: string; readonly api: WorkspaceEventsApi }
  /** Google refuses the sign-in, or the sign-in cannot be read. */
  | ({ readonly state: 'refused' } & ChatSubscriptionRefusal);

function signInRefusal(account: string, error: unknown): ChatSubscriptionRefusal {
  return {
    reason: "Google refuses the assistant's sign-in, so removal cannot see or delete its Google Chat subscription.",
    evidence: [`Assistant account: ${account}`, `Google answered: ${answerOf(error)}`].join('\n'),
  };
}

/**
 * Workspace Events as the assistant, proven by listing its Chat
 * subscriptions, which changes nothing: from the grant the instance keeps,
 * with a Chat token minted for each call as the host mints its own.
 */
async function chatSubscriptionAccess(
  grantFile: string,
  fetch: typeof globalThis.fetch | undefined,
): Promise<ChatSubscriptionAccess> {
  let grant: GoogleGrant | undefined;
  try {
    grant = await readGoogleGrantFile(grantFile);
    // eslint-disable-next-line no-catch-all/no-catch-all -- A sign-in that cannot be read cannot see the subscription; removal pauses with why.
  } catch (error) {
    return {
      state: 'refused',
      reason:
        "The assistant's Google sign-in cannot be read, so removal cannot see or delete its Google Chat subscription.",
      evidence: [`Sign-in file: ${grantFile}`, `Reading it failed: ${answerOf(error)}`].join('\n'),
    };
  }
  if (grant === undefined) return { state: 'unsigned' };
  const signedIn = grant;
  const options = fetch === undefined ? {} : { fetch };
  const api = createWorkspaceEventsApi({
    token: async () => (await mintServiceToken(signedIn, 'chat', options)).accessToken,
    ...options,
  });
  try {
    await api.list();
  } catch (error) {
    if (!googleRefuses(error)) throw error;
    return { state: 'refused', ...signInRefusal(signedIn.account, error) };
  }
  return { state: 'signed-in', account: signedIn.account, api };
}

/** Delete every subscription the assistant holds on its Chat target, then observe that none is left. */
async function deleteChatSubscriptions(api: WorkspaceEventsApi): Promise<void> {
  for (const subscription of await api.list()) await api.remove(subscription.name);
  const left = (await api.list()).filter((subscription) => subscription.state !== 'DELETED');
  if (left.length > 0) {
    throw new GwsEaError(
      'chat_subscription_removal_incomplete',
      `Google still shows the Chat subscription ${left.map((subscription) => subscription.name).join(', ')} after its deletion`,
    );
  }
}

/** How often, and how many times, removal checks that a stray host it stopped is gone. */
const STOPPED_POLL_MS = 500;
const STOPPED_CHECKS = 10;

/** The tags in `repository` that `docker image ls --format {{.Repository}}:{{.Tag}} <repository>` lists. */
export function repositoryTags(listing: string, repository: string): string[] {
  return listing
    .split(/\r?\n/u)
    .map((reference) => reference.trim())
    .filter((reference) => reference.startsWith(`${repository}:`) && reference !== `${repository}:<none>`);
}

/** The NanoClaw install a teardown removes: an assistant's, or a stray one in the gws-ea tool checkout. */
export type NanoclawInstall = Omit<ServiceControlTarget, 'instanceId'>;

/** What removing the host uses besides the install itself. */
export interface NanoclawTeardown {
  readonly platform: InstanceServicePlatform;
  readonly run: SanitizedCommandOutcomeRunner;
  readonly sleep: (milliseconds: number) => Promise<void>;
  readonly serviceHelpers: NanoclawServiceHelpers;
  /** The agent image IDs an unfinished update or rollback recorded. */
  readonly recordedImages: readonly string[];
  /**
   * The assistant's root: its host runs from whichever release folder directly
   * under it was live when it started, so it is found by the root. Without it,
   * the host is the one the install's own checkout runs.
   */
  readonly instanceRoot?: string;
}

/** `text` as a POSIX extended regular expression that matches only itself. */
function literalPattern(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

/**
 * The command line `pkill -f` and `pgrep -f` find a host by: `dist/index.js`
 * in any release folder directly under the assistant's root, or in the
 * install's own checkout.
 */
function hostProcessPattern(install: NanoclawInstall, teardown: Pick<NanoclawTeardown, 'instanceRoot'>): string {
  const folder =
    teardown.instanceRoot === undefined
      ? literalPattern(install.checkoutRoot)
      : `${literalPattern(teardown.instanceRoot)}/[^/]+`;
  return `${folder}/dist/index\\.js`;
}

/**
 * Stop the instance's host through NanoClaw's own service helpers, then clean
 * up whatever that stop leaves: the service definition (a launchd job whose
 * plist is gone, which NanoClaw cannot find, is stopped by its label, and a
 * systemd unit is disabled too, so neither login nor boot starts it again),
 * a host running outside the service, the agent containers (drained, then
 * removed with any that had already stopped), and the agent images.
 */
export async function uninstallNanoclaw(install: NanoclawInstall, teardown: NanoclawTeardown): Promise<void> {
  const { platform, run, sleep } = teardown;
  const { installId, homeDirectory, dockerEndpoint } = install;
  const recorded = { home_directory: homeDirectory, docker_endpoint: dockerEndpoint };
  const incomplete = (message: string): GwsEaError => new GwsEaError('nanoclaw_removal_incomplete', message);
  const commandFor = (
    program: string,
    args: readonly string[],
    env: Readonly<Record<string, string>>,
  ): SanitizedCommand => ({ command: program, args, cwd: CONTROL_PLANE_ROOT, env, timeoutMs: 120_000 });
  /** Runs a command and returns its raw outcome, for callers that read the exit code themselves. */
  const execute = (program: string, args: readonly string[], env: Readonly<Record<string, string>>) => {
    const command = commandFor(program, args, env);
    return run(command).then((outcome) => ({ command, outcome }));
  };
  const runChecked = checkedRunner(run);
  const checked = async (program: string, args: readonly string[], env: Readonly<Record<string, string>>) =>
    (await runChecked(commandFor(program, args, env))).stdout;
  /** Whether `present` still holds once what removal stopped has had a moment to go. */
  const stillPresent = (present: () => Promise<boolean>): Promise<boolean> =>
    pollUntil(present, (still) => !still, {
      intervalMs: STOPPED_POLL_MS,
      limitMs: (STOPPED_CHECKS - 1) * STOPPED_POLL_MS,
      sleep,
    });
  const coordinates = (runningAsRoot: boolean) =>
    createInstanceServiceCoordinates({ installId, homeDirectory, platform, runningAsRoot });

  const units: InstanceServiceCoordinates[] = [];
  if (platform === 'linux') {
    for (const runningAsRoot of [false, true]) {
      const service = coordinates(runningAsRoot);
      const defined = await access(service.serviceDefinitionPath).then(
        () => true,
        (error: unknown) => {
          if (isErrno(error, 'ENOENT')) return false;
          throw error;
        },
      );
      if (defined) units.push(service);
    }
  }
  // A system unit is root's to remove, so removal without root refuses before anything stops.
  const systemUnit = units.find((service) => service.manager === 'systemd-system');
  if (systemUnit && process.getuid?.() !== 0) {
    throw new GwsEaError(
      'root_required',
      `Re-run removal with root privileges to remove ${systemUnit.serviceDefinitionPath}`,
    );
  }

  // Removal only detects, stops, and drains; the instance ID names nothing but a start's refusal.
  const control = createServiceControl(
    teardown.serviceHelpers,
    { ...install, instanceId: installId },
    { platform: platform === 'macos' ? 'darwin' : 'linux', sleep },
  );
  const detected = control.detect();
  // A host running outside its service is not NanoClaw's to stop; the stray-host kill below takes it.
  if (detected.mode !== 'unmanaged') await control.stop();

  if (platform === 'macos') {
    const service = coordinates(false);
    // NanoClaw finds a launchd job by its plist, so a job still loaded after its plist was deleted is stopped
    // by its label, before the stray-host kill below: launchd would only start that host again.
    if (detected.mode !== 'launchd') await control.stopByLabel(service.serviceIdentity, service.serviceDefinitionPath);
    await rm(service.serviceDefinitionPath, { force: true });
  }
  for (const service of units) {
    const env = serviceManagerEnvironment(recorded, service.manager, {});
    const scope = service.manager === 'systemd-user' ? ['--user'] : [];
    const unit = `${service.serviceIdentity}.service`;
    await execute('systemctl', [...scope, 'disable', '--now', unit], env);
    if ((await execute('systemctl', [...scope, 'is-active', unit], env)).outcome.exitCode === 0) {
      throw incomplete(`The NanoClaw service ${unit} is still active`);
    }
    await rm(service.serviceDefinitionPath, { force: true });
    await checked('systemctl', [...scope, 'daemon-reload'], env);
  }

  const tools = buildToolEnvironment(process.env, { DOCKER_HOST: dockerEndpoint });
  const host = hostProcessPattern(install, teardown);
  const killed = await execute('pkill', ['-f', host], tools);
  if (killed.outcome.exitCode !== 0 && killed.outcome.exitCode !== 1)
    throw commandExitError(killed.command, killed.outcome);
  // pkill only sends SIGTERM, so a stopping host gets a moment to exit before it counts as still running.
  const hostRunning = await stillPresent(async () => {
    const remaining = await execute('pgrep', ['-f', host], tools);
    if (remaining.outcome.exitCode === 1) return false;
    if (remaining.outcome.exitCode !== 0) throw commandExitError(remaining.command, remaining.outcome);
    return true;
  });
  if (hostRunning) throw incomplete('The NanoClaw host process is still running');

  // Nothing is left that could start another agent, so the drain is race-free.
  await control.drain();
  const { installLabel } = coordinates(false);
  const containers = async (): Promise<string[]> =>
    (await checked('docker', ['ps', '-aq', '--filter', `label=${installLabel}`], tools))
      .split(/\r?\n/u)
      .map((id) => id.trim())
      .filter(Boolean);
  const ids = await containers();
  if (ids.length > 0) {
    await checked('docker', ['rm', '--force', ...ids], tools);
    if ((await containers()).length > 0) throw incomplete('NanoClaw containers remain after removal');
  }

  // Every tag in the assistant's own image repository goes: each kept release's `:r-<release>`, the `:building` tag
  // of an image a build had not yet labeled, and each agent group's own image. Removing a tag deletes its image only
  // with the last tag naming it, so an agent image another assistant shares by content stays with that assistant's
  // tags. Nothing outside the repository is named, so the OneCLI and gateway images assistants share stay
  // too (KTD6).
  const repository = getInstallScopedNames(installId).containerImageBase;
  const tagged = async (): Promise<string[]> =>
    repositoryTags(
      await checked('docker', ['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}', repository], tools),
      repository,
    );
  const references = await tagged();
  if (references.length > 0) {
    await checked('docker', ['image', 'rm', ...references], tools);
    const remaining = await tagged();
    if (remaining.length > 0) throw incomplete(`NanoClaw images remain after removal: ${remaining.join(', ')}`);
  }
  // An image a rebuild displaced has no tag left to find it by, so it is removed by the ID its record holds, and
  // stays while another repository still tags it: assistants share agent images by content.
  const images = { run: runChecked, cwd: CONTROL_PLANE_ROOT, env: tools };
  for (const imageId of teardown.recordedImages) await reclaimImage(images, imageId);
}

/** OneCLI's Compose project, through the recorded Docker endpoint. */
async function removeOnecli(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: LocalRuntime,
  run: SanitizedCommandOutcomeRunner,
): Promise<void> {
  await removeOnecliRuntime(
    createOnecliRuntimeLayout({
      instanceId: reservation.instance_id,
      instanceRoot: paths.instanceRoot(reservation.instance_id),
      project: reservation.exclusive_resource_claims.onecli_project,
      appPort: reservation.allocated_ports.onecli_app,
      gatewayPort: reservation.allocated_ports.onecli_gateway,
      dockerEndpoint: runtime.dockerEndpoint,
    }),
    { dockerCommandRunner: checkedRunner(run) },
  );
}

/**
 * The assistant's 1Password resources as removal will handle them: the
 * receipt's record once a removal began, else the instance's own, under this
 * run's choice for a vault that holds items.
 */
async function onePasswordCapture(
  paths: ControlPlanePaths,
  instanceId: string,
  receipt: RemovalReceipt | undefined,
  deleteVault: boolean | undefined,
): Promise<OnePasswordCapture> {
  const selection = deleteVault ? 'delete' : 'retain';
  return receipt?.onepassword
    ? { status: 'captured', cleanup: withSelection(receipt.onepassword, selection) }
    : captureOnePasswordCleanup(paths, instanceId, selection);
}

/** The terminal confirmation: a vault deletion is named in the same question that confirms the removal. */
export function removalQuestion(preview: RemovalPreview): string {
  const vault = preview.onepassword;
  const project = `request deletion of GCP project ${preview.gcpProject}`;
  if (vault?.vault !== 'delete') return `Permanently remove assistant ${preview.instanceId} and ${project}?`;
  const count = vault.item_count;
  const contents =
    count === 0
      ? `its empty 1Password vault ${vault.vault_id}`
      : `1Password vault ${vault.vault_id} with ${count === null ? 'whatever it holds' : `its ${count} item${count === 1 ? '' : 's'}`}`;
  return `Permanently remove assistant ${preview.instanceId}, ${project}, and delete ${contents}?`;
}

/** What removal will do, read before the operator confirms; it counts the vault's items, and changes nothing. */
export async function describeRemoval(
  paths: ControlPlanePaths,
  instanceId: string,
  options: Pick<RemovalOptions, 'deleteVault' | 'onePassword'> = {},
): Promise<RemovalPreview> {
  assertInstanceId(instanceId);
  const registry = await readRegistry(paths);
  const receipt = await readReceipt(paths, instanceId);
  const reservation =
    registry.instances[instanceId] ?? receipt?.reservation ?? (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  const captured = await onePasswordCapture(paths, instanceId, receipt, options.deleteVault);
  return {
    instanceId,
    checkout: paths.checkoutRoot(instanceId),
    gcpProject: claims.gcp_project_id,
    gcpAccount: claims.gcp_account,
    onecliProject: claims.onecli_project,
    onepassword:
      captured.status === 'captured'
        ? await previewOnePasswordCleanup(paths, captured.cleanup, options.onePassword)
        : null,
  };
}

/** Remove one assistant from whatever state it is in, holding only its own lock. */
export async function removeAssistant(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies,
): Promise<RemovalOutcome> {
  assertInstanceId(instanceId);
  await preparePrivateDirectory(path.dirname(paths.instanceLock(instanceId)));
  const release = await processLock(paths.instanceLock(instanceId));
  if (!release) throw new GwsEaError('instance_busy', 'Instance operation is already in progress');
  try {
    return await removeLocked(paths, instanceId, dependencies);
  } finally {
    release();
  }
}

async function removeLocked(
  paths: ControlPlanePaths,
  instanceId: string,
  dependencies: RemovalDependencies,
): Promise<RemovalOutcome> {
  const { interaction } = dependencies;
  const reporter = dependencies.reporter ?? {};
  const abandon = dependencies.abandon ?? new Set();
  const platform = dependencies.platform ?? instanceServicePlatform();
  const runGcloud = dependencies.runGcloud ?? runSanitizedCommandOutcome;
  const registry = await readRegistry(paths);
  const existing = await readReceipt(paths, instanceId);
  const reservation =
    registry.instances[instanceId] ?? existing?.reservation ?? (await getInstanceReservation(paths, instanceId));
  const claims = reservation.exclusive_resource_claims;
  let receipt: RemovalReceipt = existing ?? {
    schema_version: RECEIPT_SCHEMA_VERSION,
    instance_id: instanceId,
    reservation,
    started_at: new Date().toISOString(),
    completed: {},
    abandoned: {},
  };

  // Everything below reads; nothing changes until the receipt is written.
  const operation = await readUnfinishedOperation(paths, instanceId);
  await assertStateConsistent(paths, reservation);
  const provisioning = await readProvisioningRecord(paths, instanceId);
  const recorded = await readRecordedRuntime(paths, reservation);
  const onePassword = await onePasswordCapture(paths, instanceId, existing, dependencies.deleteVault);
  if (onePassword.status === 'captured') receipt = { ...receipt, onepassword: onePassword.cleanup };
  // Released last, so a released reservation left only local files and the receipt behind.
  const released = registry.instances[instanceId] === undefined;
  const started = (step: ProvisionStepId): boolean => !released && provisioning.started(step);
  const owned: Readonly<Record<RemovalResource, boolean>> = {
    nanoclaw: started('start_nanoclaw'),
    // The host keeps the subscription from its start, with the assistant's sign-in.
    'chat-subscription': started('start_nanoclaw'),
    'gcp-project': started('provision_gcp'),
    // Whatever its provisioning reached, a recorded vault or account is the operator's to settle.
    onepassword: onePassword.status !== 'none',
    onecli: started('start_onecli'),
    'instance-files': true,
  };
  const pending = new Set(
    REMOVAL_RESOURCES.filter(
      (resource) =>
        owned[resource] && !receipt.completed[resource] && !(isAbandonable(resource) && receipt.abandoned[resource]),
    ),
  );

  const docker = once(() =>
    (
      dependencies.resolveDocker ??
      ((endpoint) => (endpoint ? probeRecordedDockerEndpoint(endpoint) : resolveDockerEndpoint()))
    )(recorded.dockerEndpoint),
  );
  const localRuntime = async (): Promise<LocalRuntime> => ({
    homeDirectory: recorded.homeDirectory ?? os.homedir(),
    dockerEndpoint: await docker(),
  });
  const run = dependencies.runCommand ?? runSanitizedCommandOutcome;
  const serviceHelpers = dependencies.serviceHelpers;
  const uninstall =
    dependencies.uninstallNanoclaw ??
    (serviceHelpers
      ? (removed: InstanceReservation, runtime: LocalRuntime) =>
          uninstallNanoclaw(
            {
              checkoutRoot: paths.checkoutRoot(removed.instance_id),
              installId: removed.instance_id.replaceAll('-', ''),
              homeDirectory: runtime.homeDirectory,
              dockerEndpoint: runtime.dockerEndpoint,
            },
            {
              platform,
              run,
              sleep: dependencies.sleep ?? delay,
              serviceHelpers,
              recordedImages: recordedAgentImages(operation),
              instanceRoot: paths.instanceRoot(instanceId),
            },
          )
      : undefined);
  /** Only the launcher supplies NanoClaw's service helpers, so removal refuses before any change without them. */
  const requireUninstall = (): NonNullable<typeof uninstall> => {
    if (uninstall) return uninstall;
    throw new GwsEaError('interactive_setup_unavailable', 'Run this command through the gws-ea launcher');
  };
  const account = claims.gcp_account;
  const withSignIn = <T>(body: () => Promise<T>): Promise<T> =>
    withGoogleSignIn(
      body,
      () => interaction.signInToGoogleCloud(account),
      (refusal) => activeStep()?.write(`${refusal.message}; signing in, then trying again\n`),
    );
  const chatSubscription = once(() => chatSubscriptionAccess(grantFileOf(paths, instanceId), dependencies.fetch));
  /** Leave the resource behind when the operator accepts it, else pause with why removal cannot settle it. */
  const leaveBehind = (
    resource: AbandonableResource,
    refusal: { readonly reason: string; readonly evidence: string },
  ): Evidence => {
    if (!abandon.has(resource)) {
      throw new RemovalPause(resource, refusal.reason, refusal.evidence);
    }
    activeStep()?.write(`${refusal.reason}\n${refusal.evidence}\n`);
    return { at: new Date().toISOString(), evidence: refusal.evidence };
  };
  const leaveChatSubscription = (refusal: ChatSubscriptionRefusal): Evidence =>
    leaveBehind('chat-subscription', refusal);
  const onePasswordSeams = dependencies.onePassword;

  await runStep(reporter, { id: 'prerequisites' }, async () => {
    if (pending.has('nanoclaw')) requireUninstall();
    if (pending.has('nanoclaw') || pending.has('onecli')) await docker();
    if (pending.has('gcp-project')) {
      await withSignIn(async () => {
        await assertGcloudInstalled(runGcloud);
        await assertGcloudSignedIn(account, runGcloud);
      });
    }
    if (pending.has('chat-subscription')) {
      const access = await chatSubscription();
      if (access.state === 'refused' && !abandon.has('chat-subscription')) {
        throw new RemovalPause('chat-subscription', access.reason, access.evidence);
      }
    }
    if (pending.has('onepassword') && !abandon.has('onepassword')) {
      const blocked: OnePasswordBlock | undefined =
        onePassword.status === 'unreadable'
          ? onePassword
          : onePassword.status === 'captured'
            ? await onePasswordDeletionBlock(paths, onePassword.cleanup, onePasswordSeams)
            : undefined;
      if (blocked) throw new RemovalPause('onepassword', blocked.reason, blocked.evidence);
    }
  });

  const file = paths.removalFile(instanceId);
  const record = async (change: (current: RemovalReceipt) => RemovalReceipt): Promise<void> => {
    receipt = change(receipt);
    reporter.emit?.({ type: 'domain-effect', step: 'remove', changed: null });
    await writePrivate(file, receipt);
    reporter.emit?.({ type: 'domain-effect', step: 'remove', changed: true });
  };
  await preparePrivateDirectory(paths.removalRoot);
  await record((current) => current);

  const removals: Readonly<Record<RemovalResource, () => Promise<Evidence | undefined>>> = {
    nanoclaw: async () => {
      await requireUninstall()(reservation, await localRuntime());
      return undefined;
    },
    'chat-subscription': async () => {
      const access = await chatSubscription();
      switch (access.state) {
        case 'unsigned':
          return undefined;
        case 'refused':
          return leaveChatSubscription(access);
        case 'signed-in':
          try {
            await deleteChatSubscriptions(access.api);
            return undefined;
          } catch (error) {
            if (!googleRefuses(error)) throw error;
            return leaveChatSubscription(signInRefusal(access.account, error));
          }
      }
    },
    onepassword: async () => {
      if (onePassword.status === 'unreadable') return leaveBehind('onepassword', onePassword);
      const cleanup = receipt.onepassword;
      if (!cleanup) return undefined;
      const blocked = await settleOnePasswordCleanup(paths, instanceId, cleanup, {
        seams: onePasswordSeams,
        record: (next) => record((current) => ({ ...current, onepassword: next })),
      });
      return blocked ? leaveBehind('onepassword', blocked) : undefined;
    },
    'gcp-project': async () => {
      const coordinates: GcpProjectCoordinates = {
        instanceId,
        projectId: claims.gcp_project_id,
        account,
        cwd: CONTROL_PLANE_ROOT,
      };
      const gcloud = { runCommand: runGcloud };
      const unrestored = (
        policy: 'key_policy_unrestored' | 'member_policy_unrestored',
        evidence: string | undefined,
      ) =>
        evidence
          ? record((current) => ({
              ...current,
              [policy]: { at: new Date().toISOString(), evidence } satisfies Evidence,
            }))
          : undefined;
      const seen = await withSignIn(() =>
        deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: provisioning.keyPolicyLifted }, gcloud),
      );
      if (seen.status === 'deleted') {
        await unrestored('key_policy_unrestored', seen.keyPolicyUnrestored);
        await unrestored('member_policy_unrestored', seen.memberPolicyUnrestored);
        return undefined;
      }
      activeStep()?.write(`${seen.reason}\n${seen.evidence}\n`);
      if (!abandon.has('gcp-project')) throw new RemovalPause('gcp-project', seen.reason, seen.evidence);
      if (provisioning.keyPolicyLifted) {
        await unrestored(
          'key_policy_unrestored',
          await withSignIn(() => restoreKeyCreationPolicyForRemoval(coordinates, gcloud)),
        );
      }
      // Policies Google will not show belong to the project left behind; only a refused delete is news.
      const member = await withSignIn(() => restoreMemberDomainPolicyForRemoval(coordinates, gcloud));
      if (member?.refused === 'delete') await unrestored('member_policy_unrestored', member.evidence);
      return { at: new Date().toISOString(), evidence: seen.evidence };
    },
    onecli: async () => {
      const runtime = await localRuntime();
      await (dependencies.removeOnecli
        ? dependencies.removeOnecli(reservation, runtime)
        : removeOnecli(paths, reservation, runtime, run));
      return undefined;
    },
    'instance-files': async () => {
      // Includes browser/profile and host-only browser/staging.
      // This runs only after the native NanoClaw stop/drain resource has completed.
      await rm(paths.instanceRoot(instanceId), { recursive: true, force: true });
      return undefined;
    },
  };

  for (const resource of REMOVAL_RESOURCES) {
    if (!pending.has(resource)) continue;
    const abandoned = await runStep(reporter, RESOURCE_STEPS[resource], removals[resource]);
    await record((current) =>
      abandoned && isAbandonable(resource)
        ? { ...current, abandoned: { ...current.abandoned, [resource]: abandoned } }
        : { ...current, completed: { ...current.completed, [resource]: new Date().toISOString() } },
    );
  }
  await releaseInstanceReservation(paths, reservation);
  // Local removal is complete. A service account left to revoke keeps the receipt, and its IDs, until the operator closes it.
  const cleanup = receipt.onepassword;
  if (cleanup?.runtime_service_account_ids.length && !receipt.abandoned.onepassword && abandon.has('onepassword'))
    await record((current) => ({
      ...current,
      abandoned: {
        ...current.abandoned,
        onepassword: {
          at: new Date().toISOString(),
          evidence: onePasswordEvidence(
            cleanup,
            'The operator closed this record: revoking these service accounts on 1Password.com is theirs.',
          ),
        },
      },
    }));
  const retained = Boolean(cleanup?.runtime_service_account_ids.length) && !receipt.abandoned.onepassword;
  if (!retained) await removePrivateFile(file);

  return {
    // What became of 1Password is its own account below: a kept vault is not a removed resource.
    removed: REMOVAL_RESOURCES.filter(
      (resource) => resource !== 'onepassword' && receipt.completed[resource] !== undefined,
    ),
    abandoned: ABANDONABLE_RESOURCES.flatMap((resource) => {
      const entry = receipt.abandoned[resource];
      return entry ? [{ resource, evidence: entry.evidence }] : [];
    }),
    ...(receipt.key_policy_unrestored ? { keyPolicyUnrestored: receipt.key_policy_unrestored.evidence } : {}),
    ...(receipt.member_policy_unrestored ? { memberPolicyUnrestored: receipt.member_policy_unrestored.evidence } : {}),
    ...(cleanup
      ? {
          onepassword: onePasswordRemovalOutcome(
            cleanup,
            receipt.abandoned.onepassword?.evidence,
            retained ? file : null,
          ),
        }
      : {}),
  };
}
