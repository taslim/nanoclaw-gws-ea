/**
 * The one-time move of an assistant from the layout before releases, where it
 * lived at `<state root>/instances/<id>/` with one checkout holding its state,
 * to its short root (KTD10-KTD12). Temporary (KTD13): this module, with the
 * legacy locator and the hooks `update.ts` and the read-only commands keep
 * for it, is deleted once both dogfood assistants are converted.
 *
 * A registry entry is unconverted exactly while it still carries the
 * `checkout_realpath` the layout before releases recorded; nothing writes that
 * field any more, and the conversion's registry rewrite drops it.
 *
 * The conversion is the assistant's first update, one way, with no backup and
 * no rollback target. While its old release serves, everything that can fail
 * is proven before anything moves: no update or rollback an earlier gws-ea
 * left open; for an assistant set up under step contract 1, a Google
 * connection, and then its journal rewritten to contract 2; a free short root
 * and a launchd service; the new release staged at its final path, its
 * migrations tried on a copy of the live database and its image built, its
 * OneCLI Compose file rendered for the short root (`update.ts`); OneCLI
 * administered over REST against the running gateway; and Docker resolving a
 * bind mount through a relative link in the short root.
 *
 * Then each step, recorded in `<short root>/conversion.json` as it completes:
 * the old host stopped, its agents drained, and both roots proven quiet; its
 * state moved by rename, `data` first, so from the first rename the old
 * launcher finds no runtime record and starts nothing; the registry entry,
 * runtime record, and service definition rewritten for the short root, the
 * definition naming the live link, absent until the switch; and the OneCLI
 * project recreated from the short root's Compose file, its named volumes
 * kept, and probed. The update then switches, starts, verifies, and commits
 * (`update.ts`). Every resume stops, drains, and proves quiet again before any
 * further rename: a reboot may have started the old host since.
 *
 * A failure before the first rename serves the old release again and drops
 * the update; after it, `update --id` resumes from the record. Once a release
 * on the short root is verified, what the old layout left goes: its rollback
 * point, its checkout once it holds no state, its root, and its old agent
 * image tags. The shared Cloudflare connector is never touched: nothing in it
 * names an instance root.
 */
import { randomUUID } from 'node:crypto';
import { mkdir, readdir, rename, rm, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { getInstallScopedNames } from '../install-slug.js';
import { removeImage, type ImageDocker } from './agent-image.js';
import { releaseImageTag } from './agent-image-release.js';
import { locateOnTrack, resolveToolCommit, type CheckoutRuntime } from './checkout.js';
import {
  assertInstanceQuiet,
  assistantImageDocker,
  openFileHolders,
  type CutoverHost,
  type QuiescenceSeams,
} from './cutover.js';
import { runStep } from './events.js';
import { observeGoogleConnection } from './google-connection.js';
import { assertInstanceCreated, type InstanceOperation } from './journal.js';
import { loadReleasePreflightReceipt, readKeptRelease } from './kept-release.js';
import { verifyOnecliRuntime } from './onecli.js';
import { createOnecliAdmin, fetchOnecliApiKey } from './onecli-admin.js';
import {
  createOnecliRuntimeLayout,
  ONECLI_POSTGRES_IMAGE,
  ONECLI_WAIT_TIMEOUT_SECONDS,
  parseOnecliComposeImages,
  type OnecliPins,
  type OnecliRuntimeLayout,
} from './onecli-compose.js';
import { advanceOperation, discardOperation, readOperationRecord, type OperationStop } from './operation.js';
import { CONTROL_PLANE_ROOT, instanceRuntimeFile, isRegularFile, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from './pins.js';
import { buildToolEnvironment, runSanitizedCommand } from './process.js';
import { instanceOnecliLayout } from './provision.js';
import { safeErrorMessage } from './redact.js';
import { getInstanceReservation, readRegistry, withMachineLock } from './registry.js';
import {
  createState,
  lstatIfPresent,
  releaseName,
  STATE_ROOTS,
  syncDirectory,
  type InstanceLayout,
} from './release-layout.js';
import { assertUpdateKeepsSetup } from './release-preflight.js';
import type { UpdateReleaseTarget } from './release-target.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import {
  restoreInstanceServiceDefinition,
  validateRuntimeConfig,
  type InstanceRuntimeConfig,
  type PersistedInstanceRuntime,
} from './service.js';
import { createServiceControl, runtimeServiceTarget, type InstanceServiceControl } from './service-control.js';
import { instanceServicePlatform } from './service-coordinates.js';
import { GwsEaError, releaseLine, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import type { CheckedUpdate, StagedUpdate, UpdateDependencies, UpdateIntent } from './update.js';
import { isRecord, requireCanonicalTimestamp } from './validation.js';
import { hostLeaseLive, readSchemaManifest } from './verify.js';

/** Where every assistant on the layout before releases lived, under the state root. */
const LEGACY_INSTANCES = 'instances';
/** Its one checkout, which held its state as well as its code. */
const LEGACY_CHECKOUT = 'nanoclaw';
const CONVERSION_FILE = 'conversion.json';
/** Where the Docker bind-mount probe builds its relative link, in the short root, removed after. */
const PROBE = '.conversion-probe';
/** What a short root may hold before a conversion: what staging the new release made, and the update's record. */
const STAGED_ENTRY = /^(?:[0-9a-f]{8}(?:\.staging)?|kept|\.release-home|operation\.json|\.conversion-probe)$/u;
/** The old layout's own agent image tags: its live, previous, and staged images, and an update's holds. */
const OLD_IMAGE_TAG = /^(?:latest|previous|next|held-.+)$/u;
const DOCKER_TIMEOUT_MS = 60_000;
/** `up --wait` itself waits `ONECLI_WAIT_TIMEOUT_SECONDS`; the margin covers recreating the containers. */
const ONECLI_UP_TIMEOUT_MS = (ONECLI_WAIT_TIMEOUT_SECONDS + 120) * 1_000;

/** The steps the record names as each completes, in order. */
const CONVERSION_STEPS = ['stopped', 'moved', 'rewritten', 'recreated'] as const;
type ConversionStep = (typeof CONVERSION_STEPS)[number];

/** `<short root>/conversion.json`: a conversion from its first rename until its release is verified. */
interface ConversionRecord {
  readonly schema_version: 1;
  readonly instance_id: string;
  readonly legacy_root: string;
  /** The last step completed. */
  readonly step: ConversionStep;
  /** The runtime record the conversion writes for the short root. */
  readonly runtime: PersistedInstanceRuntime;
  /** The old host's stop, which the update records once it goes on from the conversion. */
  readonly stop: OperationStop;
}

/** The conversion's own boundaries; each defaults to the real one. */
export interface ConversionSeams {
  /** Proves the OneCLI project, recreated for the short root, healthy and isolating agents (`verifyOnecliRuntime`). */
  readonly verifyRecreatedOnecli?: (layout: OnecliRuntimeLayout, pins: OnecliPins) => Promise<void>;
}

/** An assistant on the layout before releases. */
interface LegacyAssistant {
  /** `<state root>/instances/<id>`. */
  readonly root: string;
  /** `<root>/nanoclaw`, its one checkout. */
  readonly checkout: string;
  /** Its runtime as the short root records it. */
  readonly runtime: InstanceRuntimeConfig;
  /** The same runtime rooted at the old root: where its checkout, secrets, and OneCLI project are before they move. */
  readonly old: InstanceRuntimeConfig;
}

/** Where an unconverted assistant still lives, or undefined once it is converted. */
export function legacyInstanceRoot(
  paths: Pick<ControlPlanePaths, 'stateRoot'>,
  reservation: InstanceReservation,
): string | undefined {
  if (reservation.checkout_realpath === undefined) return undefined;
  return legacyLocation(paths, reservation.instance_id).root;
}

/** Refuse an unconverted assistant: only `update` converts it, and only `list`, `status`, `logs`, and `remove` read it. */
export function assertConverted(paths: Pick<ControlPlanePaths, 'stateRoot'>, reservation: InstanceReservation): void {
  if (legacyInstanceRoot(paths, reservation) === undefined) return;
  const id = reservation.instance_id;
  throw new GwsEaError(
    'legacy_layout',
    `Assistant ${id} is on the legacy layout: run gws-ea update --id ${id} to convert it.`,
    { details: { instanceId: id } },
  );
}

/**
 * Where the layout before releases kept an assistant, whether or not it is
 * still there: its root, `<state root>/instances/<id>`, and the live checkout
 * under it that held its state and its host's logs. `remove` deletes the root
 * of every assistant, converted or not, while the converter exists.
 */
export function legacyLocation(
  paths: Pick<ControlPlanePaths, 'stateRoot'>,
  instanceId: string,
): { readonly root: string; readonly checkout: string } {
  const root = path.join(paths.stateRoot, LEGACY_INSTANCES, instanceId);
  return { root, checkout: path.join(root, LEGACY_CHECKOUT) };
}

/** Whether the assistant's conversion is under way: its progress record is there, from its first rename until it commits. */
export function isConverting(paths: Pick<ControlPlanePaths, 'instanceRoot'>, instanceId: string): Promise<boolean> {
  return isRegularFile(conversionRecordFile(paths, instanceId));
}

/** The conversion's progress record in the assistant's short root. */
export function conversionRecordFile(paths: Pick<ControlPlanePaths, 'instanceRoot'>, instanceId: string): string {
  return path.join(paths.instanceRoot(instanceId), CONVERSION_FILE);
}

function stepIndex(step: ConversionStep): number {
  return CONVERSION_STEPS.indexOf(step);
}

function invalidRecord(file: string): GwsEaError {
  return new GwsEaError('invalid_conversion', `${file} is not this assistant's conversion record.`);
}

/** The conversion under way, or undefined when none is. */
async function readConversion(paths: ControlPlanePaths, instanceId: string): Promise<ConversionRecord | undefined> {
  const file = conversionRecordFile(paths, instanceId);
  let value: unknown;
  try {
    value = await readOwnerOnlyJson(file, 'Conversion record', 'invalid_conversion');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const step = CONVERSION_STEPS.find((candidate) => isRecord(value) && value.step === candidate);
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.instance_id !== instanceId ||
    value.legacy_root !== path.join(paths.stateRoot, LEGACY_INSTANCES, instanceId) ||
    step === undefined ||
    !isRecord(value.stop) ||
    typeof value.stop.graceful !== 'boolean'
  ) {
    throw invalidRecord(file);
  }
  const runtime = validateRuntimeConfig(value.runtime);
  if (runtime.instance_id !== instanceId || runtime.instance_root !== paths.instanceRoot(instanceId)) {
    throw invalidRecord(file);
  }
  return {
    schema_version: 1,
    instance_id: instanceId,
    legacy_root: value.legacy_root,
    step,
    runtime: persisted(runtime),
    stop: {
      at: requireCanonicalTimestamp(value.stop.at, 'invalid_conversion', `${file} records no stop time`),
      graceful: value.stop.graceful,
    },
  };
}

/** The values a runtime record stores; the rest is derived from them on every read. */
function persisted(runtime: InstanceRuntimeConfig): PersistedInstanceRuntime {
  return {
    schema_version: runtime.schema_version,
    instance_id: runtime.instance_id,
    instance_root: runtime.instance_root,
    node_path: runtime.node_path,
    home_directory: runtime.home_directory,
    allocated_ports: runtime.allocated_ports,
    onecli_project: runtime.onecli_project,
    selected_provider: runtime.selected_provider,
    endpoint_url: runtime.endpoint_url,
    docker_endpoint: runtime.docker_endpoint,
  };
}

/** The assistant at `root`, with its runtime as the short root records it. */
function legacyAssistant(root: string, runtime: InstanceRuntimeConfig): LegacyAssistant {
  return {
    root,
    checkout: path.join(root, LEGACY_CHECKOUT),
    runtime,
    old: validateRuntimeConfig({ ...persisted(runtime), instance_root: root }),
  };
}

/**
 * The assistant at `root` from the runtime record its checkout holds, schema
 * 1 as the layout before releases wrote it, re-rooted at the short root.
 */
async function readLegacyAssistant(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  root: string,
): Promise<LegacyAssistant> {
  const id = reservation.instance_id;
  const checkout = path.join(root, LEGACY_CHECKOUT);
  const file = instanceRuntimeFile(checkout);
  const raw = await readOwnerOnlyJson(file, 'Runtime config', 'invalid_runtime_config');
  if (!isRecord(raw) || raw.schema_version !== 1 || raw.instance_id !== id || raw.checkout_realpath !== checkout) {
    throw new GwsEaError('invalid_runtime_config', `${file} is not the runtime record of assistant ${id}'s checkout.`);
  }
  const runtime = validateRuntimeConfig({
    schema_version: 2,
    instance_id: id,
    instance_root: paths.instanceRoot(id),
    node_path: raw.node_path,
    home_directory: raw.home_directory,
    allocated_ports: raw.allocated_ports,
    onecli_project: raw.onecli_project,
    selected_provider: raw.selected_provider,
    endpoint_url: raw.endpoint_url,
    docker_endpoint: raw.docker_endpoint,
  });
  return legacyAssistant(root, runtime);
}

/** The old host's service: the same launchd job the short root keeps, found from the old checkout. */
function legacyService(legacy: LegacyAssistant, dependencies: UpdateDependencies): InstanceServiceControl {
  return createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(legacy.old), dependencies.service);
}

/**
 * A step contract 1 journal is rewritten to contract 2 once the assistant is
 * proven connected to Google as `status` observes it, its `connect_google`
 * step recorded complete, before anything parses it: this launcher reads no
 * other contract. The journal must then be one of a fully created assistant.
 */
async function settleLegacyJournal(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  legacy: LegacyAssistant,
  dependencies: UpdateDependencies,
): Promise<void> {
  const id = reservation.instance_id;
  const file = path.join(legacy.root, 'provision.json');
  const raw = await readOwnerOnlyJson(file, 'Provision journal', 'invalid_journal');
  if (isRecord(raw) && raw.launcher_contract_version === 1) {
    const google = await observeGoogleConnection(
      legacy.old,
      reservation.exclusive_resource_claims.workspace_email,
      dependencies.fetch ? { fetch: dependencies.fetch } : {},
    );
    if (google.status !== 'connected') {
      throw new GwsEaError(
        'google_not_connected',
        `Assistant ${id} was set up before assistants connected to Google, and is not connected yet: ${google.reason}. ` +
          `Do that with the gws-ea it runs now, then run gws-ea update --id ${id} again. Nothing was moved.`,
      );
    }
    const now = new Date().toISOString();
    await writePrivate(file, {
      ...raw,
      launcher_contract_version: 2,
      steps: { ...(isRecord(raw.steps) ? raw.steps : {}), connect_google: { started_at: now, completed_at: now } },
    });
  }
  await assertInstanceCreated({ ...paths, journalFile: () => file }, id);
}

/** The short root holds nothing yet but what staging the new release made, from this run or one cut short. */
async function assertFreeDestination(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const root = paths.instanceRoot(instanceId);
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  const foreign = entries.filter((entry) => !STAGED_ENTRY.test(entry)).sort();
  if (foreign.length === 0) return;
  throw new GwsEaError(
    'destination_exists',
    `Assistant ${instanceId} moves to ${root}, which already holds ${foreign.join(', ')}, so nothing was moved. ` +
      'Move them away, or remove the assistant they belong to, then run the update again.',
    { details: { destination: root, entries: foreign } },
  );
}

/** Only launchd ran an assistant on the layout before releases; anything else is refused. */
function assertLaunchdService(legacy: LegacyAssistant, dependencies: UpdateDependencies): void {
  const id = legacy.runtime.instance_id;
  if (instanceServicePlatform(dependencies.service?.platform) !== 'macos') {
    throw new GwsEaError(
      'conversion_unsupported',
      `Assistant ${id} is on the layout before releases, which only ran under launchd; remove it with gws-ea remove --id ${id} and create it again.`,
    );
  }
  const handle = legacyService(legacy, dependencies).detect();
  if (handle.mode === 'unmanaged') {
    throw new GwsEaError(
      'service_unmanaged',
      `A NanoClaw host runs from ${legacy.checkout} outside its service (PID ${handle.name ?? 'unknown'}); stop that process, then convert it.`,
    );
  }
  if (handle.mode !== 'launchd') {
    throw new GwsEaError(
      'conversion_unsupported',
      `Assistant ${id} has no launchd job, which is what an assistant on the layout before releases ran under; nothing was moved.`,
    );
  }
}

/** The old OneCLI project, at the old root, as the layout before releases laid it out. */
function legacyOnecli(legacy: LegacyAssistant, reservation: InstanceReservation): OnecliRuntimeLayout {
  return createOnecliRuntimeLayout({
    instanceId: reservation.instance_id,
    instanceRoot: legacy.root,
    project: reservation.exclusive_resource_claims.onecli_project,
    appPort: reservation.allocated_ports.onecli_app,
    gatewayPort: reservation.allocated_ports.onecli_gateway,
    dockerEndpoint: legacy.runtime.docker_endpoint,
  });
}

/**
 * The tool's release as an update resolves it, held to the setup the old
 * release's own receipt and Compose file record: on its track, forward of
 * what the assistant runs, and keeping its OneCLI, Postgres, and provider.
 */
async function legacyTarget(
  reservation: InstanceReservation,
  legacy: LegacyAssistant,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<UpdateReleaseTarget> {
  const id = reservation.instance_id;
  const runtime: CheckoutRuntime = dependencies.runCommand ? { runCommand: dependencies.runCommand } : {};
  const commit = await resolveToolCommit(dependencies.toolRoot ?? CONTROL_PLANE_ROOT, runtime);
  if (commit !== intent.target.deployed_commit) {
    throw new GwsEaError(
      'release_changed',
      `gws-ea moved from ${shortCommit(intent.target.deployed_commit)} to ${shortCommit(commit)} while this update started; retry it.`,
    );
  }
  const receipt = await loadReleasePreflightReceipt(path.join(legacy.root, 'release-preflight.json'), {
    instanceId: id,
    deployedCommits: [reservation.deployed_commit],
    provider: legacy.runtime.selected_provider,
  });
  const { postgres } = parseOnecliComposeImages(await readOwnerOnlyFile(legacyOnecli(legacy, reservation).composeFile));
  assertUpdateKeepsSetup(
    {
      onecli: receipt.onecli,
      postgresImage: postgres,
      provider: receipt.provider,
      providerCredential: receipt.providerCredential,
    },
    {
      onecli: { gateway: LAUNCHER_PINS.onecliGateway, sdk: ONECLI_SDK_VERSION },
      postgresImage: ONECLI_POSTGRES_IMAGE,
      providerCredential: dependencies.providerSetup.credentialMetadata(receipt.provider),
    },
  );
  const position = await locateOnTrack(intent.source, { commit, deployedCommit: reservation.deployed_commit }, runtime);
  if (!position.onTrack) {
    throw new GwsEaError(
      'release_not_on_track',
      `gws-ea is at ${shortCommit(commit)}, which is not on release track ${intent.track}; run gws-ea from a commit on that track.`,
    );
  }
  if (position.deployed !== 'behind') {
    throw new GwsEaError(
      'release_not_newer',
      `Assistant ${id} runs ${shortCommit(reservation.deployed_commit)}, which this tool's release ${shortCommit(commit)} does not move forward from; run the update from a later gws-ea.`,
    );
  }
  return {
    release: intent.target,
    preflight: { provider: receipt.provider, providerCredential: receipt.providerCredential },
  };
}

/** Every refusal the conversion makes before anything is staged, the old release serving. */
async function checkConversion(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  root: string,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
): Promise<{ readonly checked: CheckedUpdate; readonly legacy: LegacyAssistant }> {
  const id = reservation.instance_id;
  if (await lstatIfPresent(path.join(root, 'operation.json'))) {
    throw new GwsEaError(
      'operation_in_progress',
      `An update or rollback an earlier gws-ea started on assistant ${id} is unfinished (${path.join(root, 'operation.json')}). ` +
        `Finish it with that gws-ea, then run gws-ea update --id ${id} to convert the assistant.`,
    );
  }
  const legacy = await readLegacyAssistant(paths, reservation, root);
  await settleLegacyJournal(paths, reservation, legacy, dependencies);
  await assertFreeDestination(paths, id);
  assertLaunchdService(legacy, dependencies);
  return {
    legacy,
    checked: {
      reservation,
      runtime: legacy.runtime,
      target: await legacyTarget(reservation, legacy, intent, dependencies),
      serving: { state: legacy.checkout, release: legacy.checkout, onecli: legacyOnecli(legacy, reservation) },
    },
  };
}

/** The new release's OneCLI administration reaches the old one's running gateway over REST, on its own port. */
async function proveOnecliAdministration(legacy: LegacyAssistant, dependencies: UpdateDependencies): Promise<void> {
  const url = legacy.old.onecli_app_url;
  const options = dependencies.fetch ? { fetch: dependencies.fetch } : {};
  try {
    const admin = createOnecliAdmin(url, await fetchOnecliApiKey(url, options), options);
    await admin.listSecrets();
    await admin.listAgents();
  } catch (error) {
    if (!(error instanceof GwsEaError)) throw error;
    throw new GwsEaError(
      'onecli_admin_unreachable',
      `This gws-ea administers OneCLI over its REST API, and assistant ${legacy.runtime.instance_id}'s gateway at ${url} did not answer it: ${error.message}. Nothing was moved.`,
      { cause: error },
    );
  }
}

/**
 * Docker resolves a bind mount through a relative link in the short root, as
 * NanoClaw's mounts reach the state through a release's links: a marker
 * behind `release/state -> ../state` is read from a throwaway container of
 * `image`. Everything the probe made is removed.
 */
async function probeLinkedMount(root: string, image: string, docker: ImageDocker): Promise<void> {
  const probe = path.join(root, PROBE);
  const marker = randomUUID();
  const source = path.join(probe, 'release', 'state', 'inner');
  await rm(probe, { recursive: true, force: true });
  try {
    await mkdir(path.join(probe, 'state', 'inner'), { recursive: true, mode: 0o755 });
    await writeFile(path.join(probe, 'state', 'inner', 'marker'), marker, { mode: 0o644 });
    await mkdir(path.join(probe, 'release'), { mode: 0o755 });
    await symlink(path.join('..', 'state'), path.join(probe, 'release', 'state'));
    const { stdout } = await docker.run({
      command: 'docker',
      args: [
        'run',
        '--rm',
        '--network',
        'none',
        '--entrypoint',
        'cat',
        '--volume',
        `${source}:/probe:ro`,
        image,
        '/probe/marker',
      ],
      cwd: root,
      env: docker.env,
      timeoutMs: DOCKER_TIMEOUT_MS,
    });
    if (stdout.trim() !== marker) {
      throw new GwsEaError(
        'bind_mount_unresolved',
        `Docker did not read a file mounted through a relative link in ${root}, which is how the new layout reaches its state. Nothing was moved.`,
      );
    }
  } finally {
    await rm(probe, { recursive: true, force: true });
  }
}

/**
 * While the old release serves, after the new one is staged: OneCLI
 * administered over REST against its gateway, Docker's bind mount through a
 * relative link, and the old release's image tagged as the release layout
 * tags every release it keeps (KTD6), which is what an update after a
 * conversion closed for fix-forward measures it by.
 */
async function proveConversion(
  paths: ControlPlanePaths,
  checked: CheckedUpdate,
  legacy: LegacyAssistant,
  dependencies: UpdateDependencies,
): Promise<void> {
  const { reservation, target } = checked;
  await proveOnecliAdministration(legacy, dependencies);
  const docker = assistantImageDocker(legacy.runtime, dependencies);
  const base = getInstallScopedNames(legacy.runtime.install_id).containerImageBase;
  await probeLinkedMount(
    paths.instanceRoot(reservation.instance_id),
    releaseImageTag(base, releaseName(target.release.deployed_commit)),
    docker,
  );
  await docker.run({
    command: 'docker',
    args: ['tag', `${base}:latest`, releaseImageTag(base, releaseName(reservation.deployed_commit))],
    cwd: docker.cwd,
    env: docker.env,
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
}

/**
 * An update of an assistant on the layout before releases converts it: every
 * refusal checked and everything provable proven while its old release
 * serves, with `stage` staging the new release as every update does. Undefined
 * for an assistant the release layout holds. An update to another release
 * than one whose conversion is under way is refused: only continuing it moves
 * the rest of its state.
 */
export async function prepareConversion(
  operation: InstanceOperation,
  intent: UpdateIntent,
  dependencies: UpdateDependencies,
  stage: (checked: CheckedUpdate) => Promise<StagedUpdate>,
): Promise<StagedUpdate | undefined> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const recorded = await readConversion(paths, instanceId);
  if (recorded && recorded.step !== 'recreated') {
    const record = await readOperationRecord(paths, instanceId);
    const to = record ? ` to ${releaseLine(record.to)}` : '';
    throw new GwsEaError(
      'operation_in_progress',
      `Assistant ${instanceId}'s conversion${to} is unfinished (${recorded.step}). ` +
        `Continue it with gws-ea update --id ${instanceId}${record ? ` from the gws-ea at ${shortCommit(record.to.deployed_commit)}` : ''}.`,
      { details: { continueWith: `gws-ea update --id ${instanceId}` } },
    );
  }
  const reservation = await getInstanceReservation(paths, instanceId);
  const root = legacyInstanceRoot(paths, reservation);
  if (root === undefined) return undefined;
  const reporter = dependencies.reporter ?? {};
  const { checked, legacy } = await runStep(reporter, { id: 'check_update', label: 'Checking the assistant…' }, () =>
    checkConversion(paths, reservation, root, intent, dependencies),
  );
  const staged = await stage(checked);
  await runStep(
    reporter,
    { id: 'prove_conversion', label: 'Checking the new release can take over from the old layout…' },
    () => proveConversion(paths, checked, legacy, dependencies),
  );
  return { ...staged, preview: { ...staged.preview, conversion: { from: root, to: paths.instanceRoot(instanceId) } } };
}

/** The checks both roots must pass before anything moves: no process, container, or open file on either. */
async function assertConversionQuiet(
  legacy: LegacyAssistant,
  layout: InstanceLayout,
  dependencies: UpdateDependencies,
): Promise<void> {
  const seams: QuiescenceSeams = {
    ...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
    ...(dependencies.service?.platform ? { platform: dependencies.service.platform } : {}),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
    ...(dependencies.service?.sleep ? { sleep: dependencies.service.sleep } : {}),
  };
  const { runtime } = legacy;
  const instance = {
    installId: runtime.install_id,
    homeDirectory: runtime.home_directory,
    dockerEndpoint: runtime.docker_endpoint,
  };
  await assertInstanceQuiet({ ...instance, instanceRoot: layout.root, state: layout.state }, seams);
  await assertInstanceQuiet(
    { ...instance, instanceRoot: legacy.root, state: path.join(legacy.checkout, 'data') },
    seams,
  );
  for (const root of ['groups', 'store']) {
    const directory = path.join(legacy.checkout, root);
    if (!(await lstatIfPresent(directory))) continue;
    const holders = await openFileHolders(directory, seams);
    if (holders.length === 0) continue;
    throw new GwsEaError(
      'instance_not_quiet',
      `The assistant at ${legacy.root} is not quiet, so nothing more was moved: ${holders
        .map(({ pid, command, file }) => `${command} (PID ${pid}) holds ${file}`)
        .join('; ')}.`,
    );
  }
}

function stopStep(reporter: NonNullable<UpdateDependencies['reporter']>, service: InstanceServiceControl) {
  return runStep(reporter, { id: 'stop_host', label: 'Stopping the assistant to move it…' }, async () => {
    const outcome = await service.stop();
    await service.drain();
    return outcome;
  });
}

/**
 * Stop the old host and drain its agents, prove both roots quiet, and record
 * the conversion at `stopped`, right before its first rename. A failure here
 * moved nothing: the old release is served again when this run stopped it,
 * and the update is dropped, its staged release kept.
 */
async function stopOldRelease(
  operation: InstanceOperation,
  legacy: LegacyAssistant,
  dependencies: UpdateDependencies,
): Promise<ConversionRecord> {
  const { paths, instanceId } = operation;
  const reporter = dependencies.reporter ?? {};
  const layout = paths.instanceLayout(instanceId);
  const service = legacyService(legacy, dependencies);
  const progress = { stopped: false };
  try {
    progress.stopped = (await stopStep(reporter, service)) === 'stopped';
    const at = new Date().toISOString();
    const record = await readOperationRecord(paths, instanceId);
    await runStep(reporter, { id: 'fence', label: 'Checking nothing still uses its state…' }, async () => {
      await assertConversionQuiet(legacy, layout, dependencies);
      const staged = record?.manifest?.central_migrations ?? [];
      const live = readSchemaManifest(legacy.checkout).central_migrations;
      if (live.length !== staged.length || live.some((name, index) => name !== staged[index])) {
        throw new GwsEaError(
          'live_schema_changed',
          `The live database's migrations changed since the update was staged (${staged.join(', ')} became ${live.join(', ')}), so its dry run no longer holds.`,
        );
      }
    });
    const conversion: ConversionRecord = {
      schema_version: 1,
      instance_id: instanceId,
      legacy_root: legacy.root,
      step: 'stopped',
      runtime: persisted(legacy.runtime),
      stop: { at, graceful: !hostLeaseLive(legacy.checkout, at) },
    };
    await writePrivate(conversionRecordFile(paths, instanceId), conversion);
    return conversion;
  } catch (error) {
    await rm(conversionRecordFile(paths, instanceId), { force: true });
    let restarted = '';
    if (progress.stopped) {
      try {
        await service.start();
        restarted = ', and its old release serves again';
        // eslint-disable-next-line no-catch-all/no-catch-all -- A failed restart is reported with the refusal it follows.
      } catch (restart) {
        restarted = `, and starting its old release again failed too: ${safeErrorMessage(restart)}`;
      }
    }
    await discardOperation(operation);
    throw new GwsEaError(
      'conversion_refused',
      `${safeErrorMessage(error)} Nothing was moved${restarted}. The staged release is kept: gws-ea update --id ${instanceId} tries the conversion again.`,
      { cause: error, details: error instanceof GwsEaError ? error.details : {} },
    );
  }
}

/** One move of the old layout into the short root, by rename. */
interface Move {
  readonly from: string;
  readonly to: string;
  /** The assistant has it whenever it was created; anything else may be absent. */
  readonly required: boolean;
}

/**
 * What the old layout moves to the short root, `data` first: from there on
 * the old launcher, which the old service definition still names until the
 * records are rewritten, finds no runtime record and starts no host. The
 * receipt of the release the registry names until the commit moves with
 * them, so an update that fixes a failed conversion forward reads it there.
 */
function stateMoves(
  paths: ControlPlanePaths,
  legacy: LegacyAssistant,
  layout: InstanceLayout,
  from: string,
): readonly Move[] {
  const id = legacy.runtime.instance_id;
  const checkout = (name: string): string => path.join(legacy.checkout, name);
  const old = (name: string): string => path.join(legacy.root, name);
  return [
    { from: checkout('data'), to: path.join(layout.state, 'data'), required: true },
    { from: checkout('.env'), to: path.join(layout.state, '.env'), required: false },
    { from: checkout('groups'), to: path.join(layout.state, 'groups'), required: false },
    { from: checkout('store'), to: path.join(layout.state, 'store'), required: false },
    { from: checkout('logs'), to: layout.logs, required: false },
    { from: old('secrets'), to: path.join(layout.root, 'secrets'), required: true },
    { from: old('onecli'), to: path.join(layout.root, 'onecli'), required: true },
    { from: old('provision.json'), to: paths.journalFile(id), required: true },
    { from: old('bootstrap.json'), to: paths.bootstrapFile(id), required: false },
    { from: old('release-preflight.json'), to: layout.receipt(from), required: true },
  ];
}

/** Rename once: a move already made is done, and nothing is ever moved over something already there. */
async function move({ from, to, required }: Move): Promise<void> {
  const [source, target] = await Promise.all([lstatIfPresent(from), lstatIfPresent(to)]);
  if (source && target) {
    throw new GwsEaError('unsafe_conversion', `Both ${from} and ${to} exist, so neither is moved over the other.`);
  }
  if (source) {
    await mkdir(path.dirname(to), { recursive: true, mode: 0o700 });
    await rename(from, to);
    await syncDirectory(path.dirname(to));
    await syncDirectory(path.dirname(from));
    return;
  }
  if (!target && required) {
    throw new GwsEaError('unsafe_conversion', `${from} is missing, so the assistant cannot be moved whole.`);
  }
}

/** Move the state by rename, then give `state/` each root the old checkout never had, empty. */
async function moveState(paths: ControlPlanePaths, legacy: LegacyAssistant, from: string): Promise<void> {
  const layout = paths.instanceLayout(legacy.runtime.instance_id);
  await mkdir(layout.state, { recursive: true, mode: 0o700 });
  for (const entry of stateMoves(paths, legacy, layout, from)) await move(entry);
  await createState(layout);
}

/** Drop the registry entry's `checkout_realpath`: the assistant's root is now derived from its ID. */
async function dropLegacyCheckout(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  await withMachineLock(paths, async () => {
    const registry = await readRegistry(paths);
    const stored = registry.instances[instanceId];
    if (!stored) throw new GwsEaError('unknown_instance', 'Unknown instance ID');
    if (stored.checkout_realpath === undefined) return;
    const { checkout_realpath: _legacy, ...converted } = stored;
    await writePrivate(paths.registryFile, {
      ...registry,
      instances: { ...registry.instances, [instanceId]: converted },
    });
  });
}

/**
 * Point the assistant's records at the short root: its runtime record, its
 * registry entry, and its service definition, the new release's kept one,
 * which names the live link: until the switch points it, a reboot starts
 * nothing.
 */
async function rewriteRecords(
  paths: ControlPlanePaths,
  runtime: InstanceRuntimeConfig,
  to: string,
  dependencies: UpdateDependencies,
): Promise<void> {
  const id = runtime.instance_id;
  await writePrivate(paths.runtimeFile(id), persisted(runtime));
  await dropLegacyCheckout(paths, id);
  const { serviceDefinition } = await readKeptRelease(paths.instanceLayout(id).kept(to));
  const uid = dependencies.service?.uid ?? process.getuid?.();
  await restoreInstanceServiceDefinition(runtime, serviceDefinition, {
    platform: instanceServicePlatform(dependencies.service?.platform),
    homeDirectory: runtime.home_directory,
    runningAsRoot: uid === 0,
    ...(dependencies.runCommand ? { runCommand: dependencies.runCommand } : {}),
    ...(uid === undefined ? {} : { uid }),
    ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
  });
}

/**
 * Recreate the OneCLI project from the new release's Compose file for the
 * short root: every container its old mounts pinned to the old root is
 * recreated, its named volumes kept (they are named by project, not by
 * path), then the runtime is proven healthy and the isolation probed.
 */
async function recreateOnecli(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
  runtime: InstanceRuntimeConfig,
  to: ReleaseCoordinates,
  dependencies: UpdateDependencies,
): Promise<void> {
  const layout = paths.instanceLayout(runtime.instance_id);
  const name = releaseName(to.deployed_commit);
  const onecli = instanceOnecliLayout(paths, reservation, runtime.docker_endpoint);
  const receipt = await loadReleasePreflightReceipt(layout.receipt(name), {
    instanceId: runtime.instance_id,
    deployedCommits: [to.deployed_commit],
    provider: runtime.selected_provider,
  });
  const { compose } = await readKeptRelease(layout.kept(name));
  if ((await readOwnerOnlyFile(onecli.composeFile)) !== compose)
    await writePrivateTextFile(onecli.composeFile, compose);
  const ambient = dependencies.ambientEnv ?? process.env;
  await (dependencies.runCommand ?? runSanitizedCommand)({
    command: 'docker',
    args: [
      'compose',
      '--project-name',
      onecli.project,
      '--file',
      onecli.composeFile,
      '--project-directory',
      onecli.rootDirectory,
      '--env-file',
      onecli.envFile,
      'up',
      '--detach',
      '--wait',
      '--wait-timeout',
      String(ONECLI_WAIT_TIMEOUT_SECONDS),
      '--pull',
      'never',
      '--force-recreate',
    ],
    cwd: onecli.rootDirectory,
    env: {
      ...buildToolEnvironment(ambient, { DOCKER_HOST: onecli.dockerEndpoint }),
      ...(ambient.HOME === undefined ? {} : { HOME: ambient.HOME }),
    },
    timeoutMs: ONECLI_UP_TIMEOUT_MS,
    stream: true,
  });
  const pins = { gateway: receipt.onecli.gateway };
  await (
    dependencies.verifyRecreatedOnecli ??
    (async (recreated: OnecliRuntimeLayout, verified: OnecliPins) => {
      await verifyOnecliRuntime(recreated, verified, {
        ...(dependencies.runCommand ? { dockerCommandRunner: dependencies.runCommand } : {}),
        ...(dependencies.fetch ? { fetch: dependencies.fetch } : {}),
        ...(dependencies.ambientEnv ? { ambientEnv: dependencies.ambientEnv } : {}),
      });
    })
  )(onecli, pins);
}

/**
 * Carry an unconverted assistant's update through its conversion, up to the
 * switch: from nothing moved yet, or from the step its record names. A resume
 * stops the host, drains its agents, and proves both roots quiet before
 * anything more moves. Once its OneCLI project is recreated, the update is
 * recorded at `snapshotted` with the old host's stop: the conversion keeps no
 * snapshot, and the update switches from there. A no-op for an assistant the
 * release layout holds.
 */
export async function continueConversion(
  operation: InstanceOperation,
  dependencies: UpdateDependencies,
): Promise<void> {
  operation.assertActive();
  const { paths, instanceId } = operation;
  const recorded = await readConversion(paths, instanceId);
  if (recorded?.step === 'recreated') return;
  const reservation = await getInstanceReservation(paths, instanceId);
  const root = recorded?.legacy_root ?? legacyInstanceRoot(paths, reservation);
  if (root === undefined) return;
  const record = await readOperationRecord(paths, instanceId);
  if (!record) throw new GwsEaError('operation_missing', `Assistant ${instanceId} has no update under way.`);
  const reporter = dependencies.reporter ?? {};
  const layout = paths.instanceLayout(instanceId);
  const legacy = recorded
    ? legacyAssistant(root, validateRuntimeConfig(recorded.runtime))
    : await readLegacyAssistant(paths, reservation, root);
  let conversion = recorded ?? (await stopOldRelease(operation, legacy, dependencies));
  const advance = async (step: ConversionStep): Promise<void> => {
    conversion = { ...conversion, step };
    await writePrivate(conversionRecordFile(paths, instanceId), conversion);
  };
  try {
    if (recorded) {
      await stopStep(reporter, legacyService(legacy, dependencies));
      await runStep(reporter, { id: 'fence', label: 'Checking nothing still uses its state…' }, () =>
        assertConversionQuiet(legacy, layout, dependencies),
      );
    }
    if (stepIndex(conversion.step) < stepIndex('moved')) {
      await runStep(reporter, { id: 'move_state', label: `Moving its state to ${layout.root}…` }, () =>
        moveState(paths, legacy, releaseName(record.from.deployed_commit)),
      );
      await advance('moved');
    }
    if (stepIndex(conversion.step) < stepIndex('rewritten')) {
      await runStep(reporter, { id: 'rewrite_records', label: 'Pointing its records at the new layout…' }, () =>
        rewriteRecords(paths, legacy.runtime, releaseName(record.to.deployed_commit), dependencies),
      );
      await advance('rewritten');
    }
    await runStep(
      reporter,
      { id: 'recreate_gateway', label: 'Recreating its credential vault for the new layout…' },
      () => recreateOnecli(paths, reservation, legacy.runtime, record.to, dependencies),
    );
    await advanceOperation(operation, 'snapshotted', {
      stop: conversion.stop,
      manifest: readSchemaManifest(layout.state),
    });
    await advance('recreated');
  } catch (error) {
    throw new GwsEaError(
      'conversion_interrupted',
      `${safeErrorMessage(error)} Assistant ${instanceId}'s conversion stopped after its step ${conversion.step}: ` +
        `continue it with gws-ea update --id ${instanceId}.`,
      {
        cause: error,
        details: {
          ...(error instanceof GwsEaError ? error.details : {}),
          step: conversion.step,
          continueWith: `gws-ea update --id ${instanceId}`,
        },
      },
    );
  }
}

/** Untag the old layout's own agent image tags, in the assistant's own repository only. */
async function removeOldImageTags(docker: ImageDocker, base: string): Promise<void> {
  const { stdout } = await docker.run({
    command: 'docker',
    args: ['image', 'ls', '--format', '{{.Tag}}', base],
    cwd: docker.cwd,
    env: docker.env,
    timeoutMs: DOCKER_TIMEOUT_MS,
  });
  const tags = new Set(
    stdout
      .split(/\r?\n/u)
      .map((tag) => tag.trim())
      .filter((tag) => OLD_IMAGE_TAG.test(tag)),
  );
  for (const tag of tags) await removeImage(docker, `${base}:${tag}`);
}

/**
 * The old rollback point first; the old checkout only once it holds no state
 * root, its code and nothing else; the old image tags; and the old root last,
 * so whatever a run cut short leaves is found again.
 */
async function removeOldLayout(root: string, host: CutoverHost): Promise<void> {
  await rm(path.join(root, 'previous'), { recursive: true, force: true });
  const checkout = path.join(root, LEGACY_CHECKOUT);
  const left: string[] = [];
  for (const name of [...STATE_ROOTS, 'logs']) {
    if (await lstatIfPresent(path.join(checkout, name))) left.push(name);
  }
  if (left.length > 0) {
    throw new GwsEaError(
      'old_layout_holds_state',
      `${checkout} still holds ${left.join(', ')}, so it and ${root} are kept; only the old rollback point was removed.`,
    );
  }
  await rm(checkout, { recursive: true, force: true });
  const base = getInstallScopedNames(host.runtime.install_id).containerImageBase;
  await removeOldImageTags(assistantImageDocker(host.runtime, host.dependencies), base);
  await rm(root, { recursive: true, force: true });
}

/**
 * Once a release on the short root is verified, the conversion is done: its
 * record goes, and with it what the old layout left (`removeOldLayout`). A
 * failure never fails the release it follows, which goes on to its commit:
 * it is returned, for the update to report once committed, and what is left
 * is removed by the next update's verification, or by `remove`.
 */
export async function finishConversion(host: CutoverHost): Promise<GwsEaError | undefined> {
  const { paths, instanceId } = host.operation;
  const root = path.join(paths.stateRoot, LEGACY_INSTANCES, instanceId);
  const file = conversionRecordFile(paths, instanceId);
  if (!(await lstatIfPresent(root)) && !(await lstatIfPresent(file))) return undefined;
  try {
    await runStep(host.reporter, { id: 'remove_old_layout', label: 'Removing what the old layout left…' }, async () => {
      await rm(file, { force: true });
      await removeOldLayout(root, host);
    });
    return undefined;
    // eslint-disable-next-line no-catch-all/no-catch-all -- Reported once the release it follows is committed.
  } catch (error) {
    return new GwsEaError(
      'old_layout_left',
      `Assistant ${instanceId} runs from ${paths.instanceRoot(instanceId)}, but removing what its old layout left at ${root} failed: ${safeErrorMessage(error)} ` +
        `Its next update removes it, and so does gws-ea remove --id ${instanceId}.`,
      { cause: error },
    );
  }
}
