/**
 * The release create and update deploy: the tool's own commit (R6). The
 * tool's checkout must have no tracked changes and its commit must be on the
 * chosen track, so everything the tool writes is correct for the release by
 * construction, and no assistant runs a commit newer than the tool. An update
 * also moves only forward (KTD4) and keeps the assistant's OneCLI, Postgres,
 * and provider setup (R9, KTD20); going back is `rollback`.
 */
import { locateOnTrack, resolveToolCommit, type CheckoutRuntime, type TrackPosition } from './checkout.js';
import { ONECLI_POSTGRES_IMAGE } from './onecli-compose.js';
import { CONTROL_PLANE_ROOT, type ControlPlanePaths } from './paths.js';
import { LAUNCHER_PINS, ONECLI_SDK_VERSION } from './pins.js';
import { readDeployedSetup } from './provision.js';
import { assertUpdateKeepsSetup, type ReleasePreflightInput } from './release-preflight.js';
import type { ReleaseSource } from './release-tracks.js';
import { GwsEaError, shortCommit, type InstanceReservation, type ReleaseCoordinates } from './types.js';
import type { ProviderCredentialMetadata } from '../provider-credential.js';

/** The tool's own provider setup, which the driver reads from `setup/providers`. */
export interface ToolProviderSetup {
  /** `providerProvisioningCapabilityDigest` of the tool's checkout. */
  readonly capabilityDigest: string;
  /** The credential metadata the tool's setup declares for `provider`, or undefined when it does not compose it. */
  readonly credentialMetadata: (provider: string) => ProviderCredentialMetadata | undefined;
}

/** The assistant an update moves, and the tool's provider setup it is held to. */
export interface UpdatedAssistant {
  readonly paths: ControlPlanePaths;
  readonly reservation: InstanceReservation;
  readonly providerSetup: ToolProviderSetup;
}

export interface CreateTargetRequest {
  readonly track: string;
  /** The track's branch, as `resolveReleaseSource` names it. */
  readonly source: ReleaseSource;
}

export interface UpdateTargetRequest extends CreateTargetRequest {
  readonly update: UpdatedAssistant;
}

export interface ReleaseTarget {
  /** The tool's own commit on the track: what create reserves, and an update's target. */
  readonly release: ReleaseCoordinates;
}

export interface UpdateReleaseTarget extends ReleaseTarget {
  /**
   * The staged release preflight's input, less its checkout: the assistant's
   * provider, credential, and OneCLI CLI, with the tool's provider setup
   * digest, which the promoted receipt records and nothing compares (KTD20).
   */
  readonly preflight: Omit<ReleasePreflightInput, 'checkoutRoot'>;
}

export interface ReleaseTargetRuntime extends CheckoutRuntime {
  /** The tool's checkout; the one this control plane runs from by default. */
  readonly toolRoot?: string;
}

/**
 * Hold the tool's release to the setup the assistant runs, before anything
 * is fetched or staged. The tool's own pins are the release's: its checkout
 * is clean at the commit it deploys.
 */
async function keptSetup({
  paths,
  reservation,
  providerSetup,
}: UpdatedAssistant): Promise<UpdateReleaseTarget['preflight']> {
  const deployed = await readDeployedSetup(paths, reservation);
  assertUpdateKeepsSetup(deployed, {
    onecli: { gateway: LAUNCHER_PINS.onecliGateway, cli: LAUNCHER_PINS.onecliCli, sdk: ONECLI_SDK_VERSION },
    postgresImage: ONECLI_POSTGRES_IMAGE,
    providerCredential: providerSetup.credentialMetadata(deployed.provider),
  });
  return {
    provider: deployed.provider,
    providerCapabilityDigest: providerSetup.capabilityDigest,
    providerCredential: deployed.providerCredential,
    onecliCliPath: deployed.onecliCliPath,
  };
}

function assertMovesForward(
  reservation: InstanceReservation,
  commit: string,
  track: string,
  deployed: TrackPosition['deployed'],
): void {
  if (deployed === 'behind') return;
  const id = reservation.instance_id;
  const details = { deployed: reservation.deployed_commit, release: commit };
  if (deployed === 'same') {
    throw new GwsEaError(
      'release_not_newer',
      `Assistant ${id} already runs ${shortCommit(commit)}, this tool's release; there is nothing to update`,
      { details },
    );
  }
  throw new GwsEaError(
    'release_not_newer',
    `Assistant ${id} runs ${shortCommit(reservation.deployed_commit)}, which this tool's release ${shortCommit(commit)} on track ${track} does not descend from, and an update only moves forward. Run gws-ea rollback --id ${id} to return to its previous release, or update this tool to a later release first.`,
    { details },
  );
}

/**
 * Resolve the release create reserves or an update deploys. Both deploy the
 * tool's own commit, never the track's tip: a tool behind the tip deploys
 * its own commit.
 */
export function resolveReleaseTarget(
  request: UpdateTargetRequest,
  runtime?: ReleaseTargetRuntime,
): Promise<UpdateReleaseTarget>;
export function resolveReleaseTarget(
  request: CreateTargetRequest,
  runtime?: ReleaseTargetRuntime,
): Promise<ReleaseTarget>;
export async function resolveReleaseTarget(
  request: CreateTargetRequest & { readonly update?: UpdatedAssistant },
  runtime: ReleaseTargetRuntime = {},
): Promise<ReleaseTarget | UpdateReleaseTarget> {
  const { track, source, update } = request;
  const commit = await resolveToolCommit(runtime.toolRoot ?? CONTROL_PLANE_ROOT, runtime);
  const preflight = update ? await keptSetup(update) : undefined;
  const position = await locateOnTrack(
    source,
    { commit, ...(update ? { deployedCommit: update.reservation.deployed_commit } : {}) },
    runtime,
  );
  if (!position.onTrack) {
    throw new GwsEaError(
      'release_not_on_track',
      `gws-ea is at ${shortCommit(commit)}, which is not on release track ${track}; run gws-ea from a commit on that track, or choose the --track it is on`,
      { details: { track, ref: source.ref, commit } },
    );
  }
  if (update) assertMovesForward(update.reservation, commit, track, position.deployed);
  const release = { source_remote: source.remote, release_track: track, deployed_commit: commit };
  return preflight ? { release, preflight } : { release };
}
