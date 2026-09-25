import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { prepareReleaseCommandEnvironments, type ReleaseCommandEnvironments } from './checkout.js';
import { runSanitizedCommand, type SanitizedCommandRunner } from './process.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';
import type { ProviderCredentialMetadata } from '../provider-credential.js';
import { providerProvisioningCapabilityDigest } from '../provider-provisioning-capability.js';
import { ONECLI_CLI_VERSION, ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './onecli-compose.js';
import { assertInstalledOnecliSdkVersion } from './onecli.js';
import { CLOUDFLARED_IMAGE, validateCloudflaredImagePin } from './cloudflare-connector.js';

const PROVIDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface SetupCommand {
  command: 'pnpm';
  args: readonly string[];
  cwd: string;
  env: Readonly<Record<string, string>>;
}

export interface ReleasePreflightInput {
  checkoutRoot: string;
  provider: string;
  providerCapabilityDigest: string;
  providerCredential: ProviderCredentialMetadata;
  onecliCliPath: string;
}

export interface ReleasePreflightRuntime {
  runCommand?: SanitizedCommandRunner;
  runSetupCommand?: (command: SetupCommand) => Promise<void>;
}

export interface ReleasePreflightResult {
  provider: string;
  providerCapabilityDigest: string;
  providerCredential: ProviderCredentialMetadata;
  packageManager: string;
  onecli: {
    gateway: string;
    cli: string;
    sdk: string;
  };
}

type JsonRecord = Record<string, unknown>;

function requireRecord(value: unknown, label: string, code = 'incomplete_release'): JsonRecord {
  if (!isRecord(value)) throw new GwsEaError(code, `${label} must be an object`);
  return value;
}

async function readJson(file: string, label: string): Promise<JsonRecord> {
  try {
    return requireRecord(JSON.parse(await readFile(file, 'utf8')) as unknown, label);
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('incomplete_release', `${label} is missing or invalid`);
  }
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

async function assertCommittedRegularFiles(
  checkoutRoot: string,
  relativePaths: readonly string[],
  run: SanitizedCommandRunner,
  environments: ReleaseCommandEnvironments,
): Promise<void> {
  const [trackedResult, fileInfo] = await Promise.all([
    run({
      command: 'git',
      args: ['ls-files', '-z', '--', ...relativePaths],
      cwd: checkoutRoot,
      env: environments.git,
    }),
    Promise.all(
      relativePaths.map(async (relativePath) => {
        try {
          return await lstat(path.join(checkoutRoot, relativePath));
          /* eslint-disable-next-line no-catch-all/no-catch-all -- Every lstat failure means the required release file is unusable. */
        } catch {
          return undefined;
        }
      }),
    ),
  ]);
  const tracked = new Set(trackedResult.stdout.split('\0').filter(Boolean));
  for (const [index, relativePath] of relativePaths.entries()) {
    const info = fileInfo[index];
    if (!info || !tracked.has(relativePath)) {
      throw new GwsEaError('incomplete_release', `Required committed release file is missing: ${relativePath}`);
    }
    if (info.isSymbolicLink() || !info.isFile()) {
      throw new GwsEaError('incomplete_release', `Required release file must be a regular file: ${relativePath}`);
    }
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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface BarrelImportExpectation {
  readonly barrel: string;
  readonly moduleName: string;
  readonly code: string;
}

async function assertBarrelImports(
  checkoutRoot: string,
  expectations: readonly BarrelImportExpectation[],
): Promise<void> {
  const sources = await Promise.all(
    expectations.map(({ barrel }) => readFile(path.join(checkoutRoot, barrel), 'utf8')),
  );
  for (const [index, expectation] of expectations.entries()) {
    const importPattern = new RegExp(
      `^\\s*import\\s+['"]\\./${escapeRegExp(expectation.moduleName)}\\.js['"]\\s*;?\\s*$`,
      'm',
    );
    if (!importPattern.test(sources[index]!)) {
      throw new GwsEaError(expectation.code, `${expectation.moduleName} is not composed in ${expectation.barrel}`);
    }
  }
}

function exactVersion(value: unknown, label: string): string {
  if (typeof value !== 'string' || !EXACT_VERSION_PATTERN.test(value)) {
    throw new GwsEaError('invalid_release_pin', `${label} must be pinned to one exact version`);
  }
  return value;
}

function dependencyMap(manifest: JsonRecord, section: string): Record<string, string> {
  const value = manifest[section];
  if (value === undefined) return {};
  const record = requireRecord(value, `package.json ${section}`);
  const result: Record<string, string> = {};
  for (const [name, specifier] of Object.entries(record)) {
    if (typeof specifier !== 'string') {
      throw new GwsEaError('inconsistent_lockfile', `package.json ${section}.${name} is invalid`);
    }
    result[name] = specifier;
  }
  return result;
}

function lockSpecifier(section: unknown, dependency: string): string | undefined {
  if (!isRecord(section)) return undefined;
  const entry = section[dependency];
  if (typeof entry === 'string') return entry;
  if (!isRecord(entry)) return undefined;
  return typeof entry.specifier === 'string' ? entry.specifier : undefined;
}

async function validatePackageAndPins(
  checkoutRoot: string,
): Promise<{ packageManager: string; gateway: string; cli: string; sdk: string; cloudflaredImage: string }> {
  const manifest = await readJson(path.join(checkoutRoot, 'package.json'), 'package.json');
  const packageManager = typeof manifest.packageManager === 'string' ? manifest.packageManager : '';
  const packageManagerMatch = /^pnpm@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)$/.exec(packageManager);
  if (!packageManagerMatch) {
    throw new GwsEaError('invalid_package_manager', 'package.json must declare one exact pnpm version');
  }
  const scripts = requireRecord(manifest.scripts, 'package.json scripts');
  if (typeof scripts.build !== 'string' || scripts.build.length === 0) {
    throw new GwsEaError('incomplete_release', 'package.json must declare a build script');
  }
  const sdk = exactVersion(dependencyMap(manifest, 'dependencies')['@onecli-sh/sdk'], 'OneCLI SDK');

  let lockfile: JsonRecord;
  try {
    lockfile = requireRecord(
      parseYaml(await readFile(path.join(checkoutRoot, 'pnpm-lock.yaml'), 'utf8')),
      'pnpm lockfile',
    );
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError('inconsistent_lockfile', 'pnpm lockfile is missing or invalid');
  }
  const importers = requireRecord(lockfile.importers, 'pnpm lockfile importers', 'inconsistent_lockfile');
  const rootImporter = requireRecord(importers['.'], 'pnpm root importer', 'inconsistent_lockfile');
  for (const section of ['dependencies', 'devDependencies', 'optionalDependencies'] as const) {
    for (const [dependency, specifier] of Object.entries(dependencyMap(manifest, section))) {
      if (lockSpecifier(rootImporter[section], dependency) !== specifier) {
        throw new GwsEaError(
          'inconsistent_lockfile',
          `pnpm lockfile does not match package.json for ${section}.${dependency}`,
        );
      }
    }
  }

  const versions = await readJson(path.join(checkoutRoot, 'versions.json'), 'versions.json');
  const gateway = exactVersion(versions['onecli-gateway'], 'OneCLI gateway');
  const cli = exactVersion(versions['onecli-cli'], 'OneCLI CLI');
  const cloudflaredImage = validateCloudflaredImagePin(versions.cloudflared);
  if (lockSpecifier(rootImporter.dependencies, '@onecli-sh/sdk') !== sdk) {
    throw new GwsEaError('inconsistent_lockfile', 'pnpm lockfile does not match the pinned OneCLI SDK');
  }
  return { packageManager, gateway, cli, sdk, cloudflaredImage };
}

async function validateComposition(
  checkoutRoot: string,
  provider: string,
  run: SanitizedCommandRunner,
  environments: ReleaseCommandEnvironments,
): Promise<void> {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new GwsEaError('provider_not_composed', 'Selected provider name is invalid');
  }
  const commonFiles = [
    'package.json',
    'pnpm-lock.yaml',
    'versions.json',
    'bin/gws-ea',
    'bin/ncl',
    'setup/gws-ea.ts',
    'setup/gws-ea-input.ts',
    'src/provider-credential.ts',
    'templates/gws-ea/main/plugin.json',
    'src/channels/gchat.ts',
    'src/channels/index.ts',
    'src/gws-ea/process.ts',
    'src/gws-ea/cloudflare-connector.ts',
    'scripts/init-first-agent.ts',
    'src/modules/gws-ea-profile/index.ts',
    'src/modules/gws-ea-profile/migration.ts',
    'src/modules/index.ts',
  ];
  const gatewayFiles = [
    'src/gateway-providers/index.ts',
    'src/gateway-providers/installed.ts',
    'src/gateway-providers/onecli.ts',
    'src/gateway-providers/onecli-files.ts',
    'container/skills/onecli-gateway/SKILL.md',
    'container/skills/onecli-gateway/instructions.md',
  ];
  const providerFiles = [
    `src/provider-contracts/${provider}.ts`,
    'src/provider-contracts/index.ts',
    `setup/providers/${provider}.ts`,
    'setup/providers/index.ts',
    `container/agent-runner/src/providers/${provider}.ts`,
    'container/agent-runner/src/providers/index.ts',
    `container/agent-runner/src/provider-contracts/${provider}.ts`,
    'container/agent-runner/src/provider-contracts/index.ts',
    `container/agent-runner/src/providers/${provider}.conformance.test.ts`,
  ];
  try {
    await assertCommittedRegularFiles(
      checkoutRoot,
      [...commonFiles, ...gatewayFiles, ...providerFiles],
      run,
      environments,
    );
    await assertBarrelImports(checkoutRoot, [
      { barrel: 'src/channels/index.ts', moduleName: 'gchat', code: 'incomplete_release' },
      { barrel: 'src/modules/index.ts', moduleName: 'gws-ea-profile/index', code: 'incomplete_release' },
      { barrel: 'src/gateway-providers/index.ts', moduleName: 'installed', code: 'gateway_not_composed' },
      { barrel: 'src/gateway-providers/installed.ts', moduleName: 'onecli', code: 'gateway_not_composed' },
      ...[
        'src/provider-contracts/index.ts',
        'setup/providers/index.ts',
        'container/agent-runner/src/providers/index.ts',
        'container/agent-runner/src/provider-contracts/index.ts',
      ].map((barrel) => ({ barrel, moduleName: provider, code: 'provider_not_composed' })),
    ]);
  } catch (error) {
    if (
      error instanceof GwsEaError &&
      error.code === 'incomplete_release' &&
      gatewayFiles.some((file) => error.message.includes(file))
    ) {
      throw new GwsEaError('gateway_not_composed', 'The selected release is missing its OneCLI gateway');
    }
    if (
      error instanceof GwsEaError &&
      error.code === 'incomplete_release' &&
      providerFiles.some((file) => error.message.includes(file))
    ) {
      throw new GwsEaError('provider_not_composed', `Selected provider is not fully composed: ${provider}`);
    }
    throw error;
  }

  const template = await readJson(path.join(checkoutRoot, 'templates/gws-ea/main/plugin.json'), 'gws-ea/main template');
  const extensions = requireRecord(template.extensions, 'gws-ea/main extensions');
  const nanoclaw = requireRecord(extensions['ai.nanoco.nanoclaw'], 'gws-ea/main NanoClaw extension');
  if (template.name !== 'gws-ea-main' || nanoclaw.agentName !== 'main') {
    throw new GwsEaError('incomplete_release', 'Committed gws-ea/main template is not the canonical main assistant');
  }
}

function assertLauncherOnecliCohort(pins: { gateway: string; cli: string; sdk: string }): void {
  if (pins.gateway !== ONECLI_GATEWAY_VERSION || pins.cli !== ONECLI_CLI_VERSION || pins.sdk !== ONECLI_SDK_VERSION) {
    throw new GwsEaError(
      'onecli_release_mismatch',
      'The selected release requires a different OneCLI cohort; update the GWS-EA launcher before provisioning it',
    );
  }
}

function assertLauncherCloudflaredPin(image: string): void {
  if (image !== CLOUDFLARED_IMAGE) {
    throw new GwsEaError(
      'cloudflared_release_mismatch',
      'The selected release requires a different cloudflared image; update the GWS-EA launcher before provisioning it',
    );
  }
}

/** The OneCLI CLI at `executable` reports exactly `expectedVersion`. */
export async function assertInstalledOnecliCli(
  executable: string,
  expectedVersion: string,
  checkoutRoot: string,
  environment: Readonly<Record<string, string>>,
  run: SanitizedCommandRunner,
): Promise<void> {
  if (!path.isAbsolute(executable) || path.resolve(executable) !== executable) {
    throw new GwsEaError('incompatible_onecli', 'OneCLI CLI path must be absolute and normalized');
  }
  const result = await run({ command: executable, args: ['version'], cwd: checkoutRoot, env: environment });
  let version: unknown;
  try {
    const parsed: unknown = JSON.parse(result.stdout);
    version = isRecord(parsed) ? parsed.version : undefined;
  } catch {
    throw new GwsEaError('incompatible_onecli', 'Installed OneCLI CLI returned invalid version information');
  }
  if (version !== expectedVersion) {
    throw new GwsEaError(
      'incompatible_onecli',
      `Installed OneCLI CLI ${typeof version === 'string' ? version : '(unknown version)'} does not match the pinned ${expectedVersion}; install OneCLI CLI ${expectedVersion}, then retry`,
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
  const providerCapabilityDigest = await providerProvisioningCapabilityDigest(checkoutRoot);
  if (providerCapabilityDigest !== input.providerCapabilityDigest) {
    throw new GwsEaError(
      'provider_capability_mismatch',
      'The selected release has a different provider setup capability; update the GWS-EA launcher before provisioning it',
    );
  }
  await validateComposition(checkoutRoot, input.provider, runCommand, environments);
  const pins = await validatePackageAndPins(checkoutRoot);
  assertLauncherOnecliCohort(pins);
  assertLauncherCloudflaredPin(pins.cloudflaredImage);
  await Promise.all([
    assertInstalledOnecliCli(input.onecliCliPath, pins.cli, checkoutRoot, environments.common, runCommand),
    assertInstalledOnecliSdkVersion(pins.sdk),
  ]);
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

  return {
    provider: input.provider,
    providerCapabilityDigest,
    providerCredential: input.providerCredential,
    packageManager: pins.packageManager,
    onecli: { gateway: pins.gateway, cli: pins.cli, sdk: pins.sdk },
  };
}
