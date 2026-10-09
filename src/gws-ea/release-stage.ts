/**
 * Staging a release and switching to one (KTD1, KTD3). Create and update
 * stage a release the same way, while the assistant, if there is one, serves:
 * the release's checkout in its own folder, installed, built and checked, its
 * agent image, its links to the assistant's state, and what is kept with it
 * in `kept/<release>/`, its receipt last. Staging writes nothing into
 * `state/` and follows no link. A switch then applies the release's kept
 * files to the assistant while it is fenced, before the live link names the
 * release.
 */
import path from 'node:path';

import { provideReleaseImage, readInstallCjkFonts } from './agent-image-release.js';
import type { ImageDocker } from './agent-image.js';
import { committedTree, materializeReleaseCheckout, type CheckoutRuntime } from './checkout.js';
import { keepRelease, loadReleasePreflightReceipt, readKeptHostEnvironment, readKeptRelease } from './kept-release.js';
import { restoreReleaseGateway, type OnecliRuntimeDependencies } from './onecli.js';
import { renderOnecliCompose, type OnecliRuntimeLayout } from './onecli-compose.js';
import { resolveWrapperGatewayImage } from './onecli-gateway-image.js';
import type { ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, runSanitizedCommand } from './process.js';
import { runReleasePreflight, type ReleasePreflightInput, type ReleasePreflightRuntime } from './release-preflight.js';
import {
  discardIncompleteRelease,
  instanceLayout,
  isReleaseComplete,
  linkReleaseState,
  releaseName,
} from './release-layout.js';
import { activeStep } from './run-log.js';
import {
  instanceHostConfiguration,
  renderInstanceServiceDefinition,
  restoreInstanceServiceDefinition,
  type InstanceRuntimeConfig,
  type InstanceRuntimeDependencies,
  type ServiceLayoutOptions,
  type UpsertEnvVars,
} from './service.js';
import type { InstanceReservation } from './types.js';

/** A release to stage for an assistant. */
export interface ReleaseStageRequest {
  readonly paths: ControlPlanePaths;
  /** The assistant's reservation as it reads at the release: its source, track, and commit (KTD17). */
  readonly view: InstanceReservation;
  /** The assistant's runtime, which the release's kept files are rendered for. */
  readonly runtime: InstanceRuntimeConfig;
  readonly onecli: OnecliRuntimeLayout;
  /** The service manager the release's service definition is rendered for. */
  readonly service: ServiceLayoutOptions;
  /** The provider setup the release's receipt records. */
  readonly provider: Pick<ReleasePreflightInput, 'provider' | 'providerCredential'>;
  /**
   * Run on the staged release, given its folder, before its links are made,
   * so whatever it writes there stays out of the assistant's state: an
   * update's migration dry run, which removes what it made.
   */
  readonly beforeLink?: (release: string) => Promise<void>;
}

/** The boundaries staging crosses; each defaults to this process's. */
export interface ReleaseStageSeams extends CheckoutRuntime {
  /** Runs the release's frozen install and its build. */
  readonly runSetupCommand?: ReleasePreflightRuntime['runSetupCommand'];
  /** The operator's environment, which Docker runs with. */
  readonly ambientEnv?: NodeJS.ProcessEnv;
}

/**
 * Stage the release `request.view` names in `<root>/<hex8>/`. A complete one
 * is kept as it is: a release is never edited once its receipt is written
 * (R4). One left incomplete, by a run cut short anywhere, is removed whole and
 * staged again. Then, in order: the checkout, materialized at its final path;
 * its preflight (frozen install, build, clean tree, artifacts), whose result
 * becomes the receipt; its agent image, built hermetically (KTD6);
 * `beforeLink`; its links to the assistant's state and logs; and the files
 * kept with it, the receipt last.
 */
export async function stageRelease(request: ReleaseStageRequest, seams: ReleaseStageSeams = {}): Promise<void> {
  const { paths, view, runtime } = request;
  const layout = paths.instanceLayout(view.instance_id);
  const name = releaseName(view.deployed_commit);
  if (await isReleaseComplete(layout, name)) return;
  await discardIncompleteRelease(layout, name);
  const release = layout.release(name);
  const run = seams.runCommand ?? runSanitizedCommand;

  await materializeReleaseCheckout(paths, view, seams);
  const preflight = await runReleasePreflight(
    { ...request.provider, checkoutRoot: release },
    { runCommand: run, runSetupCommand: seams.runSetupCommand },
  );
  const docker: ImageDocker = {
    run,
    cwd: layout.root,
    env: buildToolEnvironment(seams.ambientEnv ?? process.env, {
      HOME: runtime.home_directory,
      DOCKER_HOST: runtime.docker_endpoint,
    }),
  };
  await provideReleaseImage(docker, {
    layout,
    release: name,
    installId: runtime.install_id,
    inputs: {
      contextTree: await committedTree(release, view.deployed_commit, 'container', seams),
      installCjkFonts: readInstallCjkFonts(layout.state),
    },
  });
  await request.beforeLink?.(release);
  await linkReleaseState(layout, name);

  const pins = { gateway: preflight.onecli.gateway };
  const { image: gateway } = await resolveWrapperGatewayImage(pins);
  await keepRelease(
    layout.kept(name),
    {
      compose: renderOnecliCompose(request.onecli, pins, gateway),
      serviceDefinition: renderInstanceServiceDefinition(runtime, request.service),
      hostEnvironment: instanceHostConfiguration(runtime),
    },
    { instanceId: view.instance_id, commit: view.deployed_commit, preflight },
  );
}

/** Write `environment`, gws-ea's `.env` keys, into the physical `state/.env`, keeping every other writer's keys. */
function writeStateEnvironment(
  state: string,
  environment: Readonly<Record<string, string>>,
  upsertEnvVars: UpsertEnvVars,
): void {
  upsertEnvVars({ ...environment }, state);
  activeStep()?.envFile(
    path.join(state, '.env'),
    Object.entries(environment)
      .map(([key, value]) => `${key}=${value}\n`)
      .join(''),
  );
}

/**
 * Write gws-ea's `.env` keys kept with release `release` into the assistant's
 * physical `state/.env`, keeping every other writer's keys (upstream
 * `upsertEnvVars`). Never written through a link.
 */
export async function applyReleaseEnvironment(
  runtime: InstanceRuntimeConfig,
  release: string,
  upsertEnvVars: UpsertEnvVars,
): Promise<void> {
  const layout = instanceLayout(runtime.instance_root);
  writeStateEnvironment(layout.state, await readKeptHostEnvironment(layout.kept(release)), upsertEnvVars);
}

/** The complete release a switch applies, for the assistant it belongs to. */
export interface ReleaseFilesTarget {
  readonly runtime: InstanceRuntimeConfig;
  readonly onecli: OnecliRuntimeLayout;
  /** The release's commit. */
  readonly commit: string;
}

/**
 * Apply the files kept with the release `target` names to the assistant,
 * while it is fenced and before the live link names the release: gws-ea's
 * `.env` keys into `state/.env`; its OneCLI Compose file, put back and
 * brought up (`restoreReleaseGateway`), which recreates the gateway only when
 * its configuration differs and probes isolation when it did, so a failed
 * probe refuses the release before its host starts (KTD15); and its service
 * definition, installed when it differs. Each part converges, so a rerun
 * after an apply cut short finishes it; the gateway is brought up even when
 * its file already matches, since a run cut short after writing it may not
 * have. Returns whether the service definition changed, which a start needs.
 */
export async function applyReleaseFiles(
  target: ReleaseFilesTarget,
  dependencies: InstanceRuntimeDependencies,
  onecliDependencies: Pick<OnecliRuntimeDependencies, 'dockerCommandRunner' | 'ambientEnv'> = {},
): Promise<{ readonly definitionChanged: boolean }> {
  const { runtime, onecli, commit } = target;
  const layout = instanceLayout(runtime.instance_root);
  const name = releaseName(commit);
  const receipt = await loadReleasePreflightReceipt(layout.receipt(name), {
    instanceId: runtime.instance_id,
    deployedCommits: [commit],
    provider: runtime.selected_provider,
  });
  const kept = await readKeptRelease(layout.kept(name));
  writeStateEnvironment(layout.state, kept.hostEnvironment, dependencies.upsertEnvVars);
  await restoreReleaseGateway(onecli, { gateway: receipt.onecli.gateway }, kept.compose, onecliDependencies);
  return { definitionChanged: await restoreInstanceServiceDefinition(runtime, kept.serviceDefinition, dependencies) };
}
