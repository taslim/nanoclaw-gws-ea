import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { prepareReleaseCommandEnvironments, type ReleaseCommandEnvironments } from './checkout.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
import { isRecord, parseJson, requireRecord } from './validation.js';
import { sameCredentialMetadata, type ProviderCredentialMetadata } from '../provider-credential.js';
import { exactVersion, isSupportedOnecliGatewayUpgrade, parsePins, PIN_NAMES } from './pins.js';

const INCOMPLETE = 'incomplete_release';
const RELEASE_PINS_FILE = 'src/gws-ea/versions.json';

export interface SetupCommand {
  command: 'pnpm';
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ReleasePreflightInput {
  checkoutRoot: string;
  provider: string;
  providerCredential: ProviderCredentialMetadata;
}

export interface ReleasePreflightRuntime {
  runCommand?: SanitizedCommandRunner;
  runSetupCommand?: (command: SetupCommand) => Promise<void>;
}

export interface ReleasePreflightResult {
  provider: string;
  providerCredential: ProviderCredentialMetadata;
  packageManager: string;
  onecli: {
    gateway: string;
    sdk: string;
  };
}

type JsonRecord = Record<string, unknown>;

async function readJson(file: string, label: string): Promise<JsonRecord> {
  let source: string;
  try {
    source = await readFile(file, 'utf8');
  } catch {
    throw new GwsEaError(INCOMPLETE, `${label} is missing`);
  }
  return requireRecord(parseJson(source, label, INCOMPLETE), label, INCOMPLETE);
}

async function assertPhysicalCheckout(checkoutRoot: string): Promise<string> {
  const resolved = path.resolve(checkoutRoot);
  let info;
  try {
    info = await lstat(resolved);
  } catch {
    throw new GwsEaError('incomplete_release', 'Release checkout does not exist');
  }
  if (info.isSymbolicLink() || !info.isDirectory() || (await realpath(resolved)) !== resolved) {
    throw new GwsEaError('unsafe_checkout', 'Release checkout must be a physical directory at its claimed path');
  }
  return resolved;
}

async function git(
  checkoutRoot: string,
  args: readonly string[],
  run: SanitizedCommandRunner,
  environments: ReleaseCommandEnvironments,
): Promise<string> {
  return (await run({ command: 'git', args, cwd: checkoutRoot, env: environments.git })).stdout.trim();
}

async function assertClean(
  checkoutRoot: string,
  phase: string,
  run: SanitizedCommandRunner,
  environments: ReleaseCommandEnvironments,
): Promise<void> {
  const status = await git(checkoutRoot, ['status', '--porcelain=v1', '--untracked-files=all'], run, environments);
  if (status) throw new GwsEaError('checkout_drift', `Release checkout changed during ${phase}:\n${status}`);
}

async function assertDetachedCommit(
  checkoutRoot: string,
  run: SanitizedCommandRunner,
  environments: ReleaseCommandEnvironments,
): Promise<void> {
  const head = await git(checkoutRoot, ['rev-parse', '--verify', 'HEAD^{commit}'], run, environments);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new GwsEaError('incomplete_release', 'Release checkout HEAD is not a full commit');
  }
  if ((await git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'], run, environments)) !== 'HEAD') {
    throw new GwsEaError('checkout_not_detached', 'Release checkout HEAD must be detached');
  }
}

async function assertRuntimeArtifacts(checkoutRoot: string): Promise<void> {
  for (const relativePath of ['dist/gws-ea/process.js', 'dist/index.js']) {
    let info;
    try {
      info = await lstat(path.join(checkoutRoot, relativePath));
    } catch {
      throw new GwsEaError('incomplete_release', `Required build artifact is missing: ${relativePath}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new GwsEaError('incomplete_release', `Required build artifact must be a regular file: ${relativePath}`);
    }
  }
  const launcher = await lstat(path.join(checkoutRoot, 'bin', 'ncl'));
  if ((launcher.mode & 0o111) === 0) {
    throw new GwsEaError('incomplete_release', 'Required ncl launcher is not executable');
  }
}

/**
 * The cohort a release records in its receipt. A release is the tool's own
 * clean commit, so these are the launcher's own pins by construction, and a
 * frozen install refuses a lockfile that disagrees with package.json.
 */
async function readReleaseCohort(
  checkoutRoot: string,
): Promise<Pick<ReleasePreflightResult, 'packageManager' | 'onecli'>> {
  const manifest = await readJson(path.join(checkoutRoot, 'package.json'), 'package.json');
  const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
  if (!/^pnpm@\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(packageManager)) {
    throw new GwsEaError('invalid_package_manager', 'package.json must declare one exact pnpm version');
  }
  const dependencies = isRecord(manifest.dependencies) ? manifest.dependencies : {};
  const pins = parsePins(
    await readJson(path.join(checkoutRoot, RELEASE_PINS_FILE), RELEASE_PINS_FILE),
    RELEASE_PINS_FILE,
  );
  return {
    packageManager,
    onecli: { gateway: pins.onecliGateway, sdk: exactVersion(dependencies['@onecli-sh/sdk'], 'OneCLI SDK') },
  };
}

export interface DeployedSetup {
  readonly onecli: ReleasePreflightResult['onecli'];
  readonly postgresImage: string;
  readonly provider: string;
  readonly providerCredential: ProviderCredentialMetadata;
}

export interface ReleaseSetup {
  readonly onecli: ReleasePreflightResult['onecli'];
  readonly postgresImage: string;
  /** Undefined when the release does not compose the assistant's provider. */
  readonly providerCredential: ProviderCredentialMetadata | undefined;
}

/**
 * An update keeps the assistant's Postgres version and provider setup, and
 * moves its OneCLI gateway only along a verified upgrade path (never downgrades
 * or unverified major jumps, and never changes OneCLI SDK unexpectedly).
 */
export function assertUpdateKeepsSetup(deployed: DeployedSetup, release: ReleaseSetup): void {
  const retry = 'so run the update from a GWS-EA release that';
  if (!isSupportedOnecliGatewayUpgrade(deployed.onecli.gateway, release.onecli.gateway)) {
    throw new GwsEaError(
      'onecli_version_changed',
      `This release pins ${PIN_NAMES.onecliGateway} ${release.onecli.gateway}, but the assistant runs ${deployed.onecli.gateway}; an update cannot move OneCLI gateway from ${deployed.onecli.gateway} to ${release.onecli.gateway}, ${retry} pins ${PIN_NAMES.onecliGateway} ${deployed.onecli.gateway}`,
      { details: { pin: PIN_NAMES.onecliGateway, release: release.onecli.gateway, deployed: deployed.onecli.gateway } },
    );
  }
  if (release.onecli.sdk !== deployed.onecli.sdk) {
    throw new GwsEaError(
      'onecli_version_changed',
      `This release pins OneCLI SDK ${release.onecli.sdk}, but the assistant runs ${deployed.onecli.sdk}; an update cannot change OneCLI versions, ${retry} pins OneCLI SDK ${deployed.onecli.sdk}`,
      { details: { pin: 'OneCLI SDK', release: release.onecli.sdk, deployed: deployed.onecli.sdk } },
    );
  }
  if (release.postgresImage !== deployed.postgresImage) {
    throw new GwsEaError(
      'postgres_version_changed',
      `This release runs OneCLI on the Postgres image ${release.postgresImage}, but the assistant runs ${deployed.postgresImage}; an update cannot change Postgres versions, ${retry} runs ${deployed.postgresImage}`,
      { details: { release: release.postgresImage, deployed: deployed.postgresImage } },
    );
  }
  if (!release.providerCredential) {
    throw new GwsEaError(
      'provider_not_composed',
      `This release does not compose the assistant's provider ${deployed.provider}, and an update cannot change provider setup, ${retry} composes it`,
      { details: { provider: deployed.provider } },
    );
  }
  if (!sameCredentialMetadata(release.providerCredential, deployed.providerCredential)) {
    throw new GwsEaError(
      'provider_setup_changed',
      `This release declares a different provider credential for ${deployed.provider} than the assistant was set up with; an update cannot change provider setup, ${retry} keeps it`,
      { details: { provider: deployed.provider } },
    );
  }
}

async function defaultSetupCommand(command: SetupCommand): Promise<void> {
  await runSanitizedCommand({ ...command, timeoutMs: 20 * 60 * 1000, stream: true });
}

/**
 * Fail closed on an incomplete release before any credential or remote-resource
 * phase. This function only installs the exact lockfile and builds the checkout.
 */
export async function runReleasePreflight(
  input: ReleasePreflightInput,
  runtime: ReleasePreflightRuntime = {},
): Promise<ReleasePreflightResult> {
  const checkoutRoot = await assertPhysicalCheckout(input.checkoutRoot);
  const environments = await prepareReleaseCommandEnvironments(path.dirname(checkoutRoot));
  const runCommand = runtime.runCommand ?? runSanitizedCommand;
  await assertDetachedCommit(checkoutRoot, runCommand, environments);
  await assertClean(checkoutRoot, 'initial preflight', runCommand, environments);
  const cohort = await readReleaseCohort(checkoutRoot);
  const runSetupCommand = runtime.runSetupCommand ?? defaultSetupCommand;

  await runSetupCommand({
    command: 'pnpm',
    args: ['install', '--frozen-lockfile'],
    cwd: checkoutRoot,
    env: environments.common,
  });
  await assertClean(checkoutRoot, 'frozen dependency installation', runCommand, environments);
  await runSetupCommand({ command: 'pnpm', args: ['run', 'build'], cwd: checkoutRoot, env: environments.common });
  await assertClean(checkoutRoot, 'release build', runCommand, environments);
  await assertRuntimeArtifacts(checkoutRoot);

  return { provider: input.provider, providerCredential: input.providerCredential, ...cohort };
}
