import { lstat, readFile, realpath } from 'node:fs/promises';
import path from 'node:path';

import { parse as parseYaml } from 'yaml';

import { runArgumentCommand } from './checkout.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

const PROVIDER_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const EXACT_VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

export interface SetupCommand {
  command: 'pnpm';
  args: readonly string[];
  cwd: string;
}

export interface ReleasePreflightInput {
  checkoutRoot: string;
  provider: string;
}

export interface ReleasePreflightRuntime {
  runSetupCommand?: (command: SetupCommand) => Promise<void>;
}

export interface ReleasePreflightResult {
  provider: string;
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

async function git(checkoutRoot: string, args: readonly string[]): Promise<string> {
  return (await runArgumentCommand({ command: 'git', args, cwd: checkoutRoot })).stdout.trim();
}

async function assertClean(checkoutRoot: string, phase: string): Promise<void> {
  const status = await git(checkoutRoot, ['status', '--porcelain=v1', '--untracked-files=all']);
  if (status) throw new GwsEaError('checkout_drift', `Release checkout changed during ${phase}:\n${status}`);
}

async function assertDetachedCommit(checkoutRoot: string): Promise<void> {
  const head = await git(checkoutRoot, ['rev-parse', '--verify', 'HEAD^{commit}']);
  if (!/^[0-9a-f]{40}$/.test(head)) {
    throw new GwsEaError('incomplete_release', 'Release checkout HEAD is not a full commit');
  }
  if ((await git(checkoutRoot, ['rev-parse', '--abbrev-ref', 'HEAD'])) !== 'HEAD') {
    throw new GwsEaError('checkout_not_detached', 'Release checkout HEAD must be detached');
  }
}

async function assertCommittedRegularFiles(checkoutRoot: string, relativePaths: readonly string[]): Promise<void> {
  const [trackedResult, fileInfo] = await Promise.all([
    runArgumentCommand({ command: 'git', args: ['ls-files', '-z', '--', ...relativePaths], cwd: checkoutRoot }),
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
): Promise<{ packageManager: string; gateway: string; cli: string; sdk: string }> {
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
  if (lockSpecifier(rootImporter.dependencies, '@onecli-sh/sdk') !== sdk) {
    throw new GwsEaError('inconsistent_lockfile', 'pnpm lockfile does not match the pinned OneCLI SDK');
  }
  return { packageManager, gateway, cli, sdk };
}

async function validateComposition(checkoutRoot: string, provider: string): Promise<void> {
  if (!PROVIDER_PATTERN.test(provider)) {
    throw new GwsEaError('provider_not_composed', 'Selected provider name is invalid');
  }
  const commonFiles = [
    'package.json',
    'pnpm-lock.yaml',
    'versions.json',
    'templates/gws-ea/main/plugin.json',
    'src/channels/gchat.ts',
    'src/channels/index.ts',
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
    await assertCommittedRegularFiles(checkoutRoot, [...commonFiles, ...providerFiles]);
    await assertBarrelImports(checkoutRoot, [
      { barrel: 'src/channels/index.ts', moduleName: 'gchat', code: 'incomplete_release' },
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

async function defaultSetupCommand(command: SetupCommand): Promise<void> {
  await runArgumentCommand({ ...command, timeoutMs: 20 * 60 * 1000 });
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
  await assertDetachedCommit(checkoutRoot);
  await assertClean(checkoutRoot, 'initial preflight');
  await validateComposition(checkoutRoot, input.provider);
  const pins = await validatePackageAndPins(checkoutRoot);
  const runSetupCommand = runtime.runSetupCommand ?? defaultSetupCommand;

  await runSetupCommand({ command: 'pnpm', args: ['install', '--frozen-lockfile'], cwd: checkoutRoot });
  await assertClean(checkoutRoot, 'frozen dependency installation');
  await runSetupCommand({ command: 'pnpm', args: ['run', 'build'], cwd: checkoutRoot });
  await assertClean(checkoutRoot, 'release build');

  return {
    provider: input.provider,
    packageManager: pins.packageManager,
    onecli: { gateway: pins.gateway, cli: pins.cli, sdk: pins.sdk },
  };
}
