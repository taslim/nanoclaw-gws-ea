/**
 * What an assistant keeps with each release besides its checkout, in
 * `kept/<release>/` (KTD1): the files the release runs with, rendered when it
 * was staged by the tool that is its own code, and its receipt, written last,
 * so a release is complete only once everything kept with it is there
 * (`release-layout.ts`). A switch to a release applies these files
 * (`release-stage.ts`); nothing here changes once the receipt is written.
 */
import path from 'node:path';

import type { ProviderCredentialMetadata } from '../provider-credential.js';
import { sameCredentialMetadata } from '../provider-credential.js';
import { preparePrivateDirectory } from './paths.js';
import type { ReleasePreflightResult } from './release-preflight.js';
import { readOwnerOnlyFile, readOwnerOnlyJson, writePrivateTextFile } from './secrets.js';
import { INSTANCE_HOST_ENV_KEYS } from './service.js';
import { GwsEaError } from './types.js';
import { isRecord, requireRecord, requireString } from './validation.js';

/** Where `kept/<release>/` keeps each file; the receipt's name is the one `release-layout.ts` checks for. */
export interface KeptReleaseFiles {
  readonly receipt: string;
  readonly compose: string;
  readonly serviceDefinition: string;
  readonly hostEnvironment: string;
}

/** The files kept in `root`, a release's `kept/<release>/`. */
export function keptReleaseFiles(root: string): KeptReleaseFiles {
  return {
    receipt: path.join(root, 'release-preflight.json'),
    compose: path.join(root, 'onecli-compose.yaml'),
    serviceDefinition: path.join(root, 'service-definition'),
    hostEnvironment: path.join(root, 'host-environment.json'),
  };
}

/**
 * What a release runs with besides its checkout: its OneCLI Compose file, its
 * service definition, and gws-ea's `.env` keys, as the tool that staged it
 * rendered them for the assistant.
 */
export interface KeptRelease {
  readonly compose: string;
  readonly serviceDefinition: string;
  readonly hostEnvironment: Readonly<Record<string, string>>;
}

/** What a release's preflight established, kept as its receipt. */
export interface ReleasePreflightReceipt extends ReleasePreflightResult {
  readonly schema_version: 1;
  readonly instance_id: string;
  readonly deployed_commit: string;
}

/** The receipt a release stages with: whose it is, its commit, and what its preflight established. */
export interface ReleaseReceiptInput {
  readonly instanceId: string;
  readonly commit: string;
  readonly preflight: ReleasePreflightResult;
}

/**
 * Keep `files` with a staged release in `root`, its `kept/<release>/`, then
 * its receipt, last: until the receipt is there the release is incomplete, and
 * the next staging discards it whole.
 */
export async function keepRelease(root: string, files: KeptRelease, receipt: ReleaseReceiptInput): Promise<void> {
  await preparePrivateDirectory(root);
  const kept = keptReleaseFiles(root);
  await writePrivateTextFile(kept.compose, files.compose);
  await writePrivateTextFile(kept.serviceDefinition, files.serviceDefinition);
  await writePrivateTextFile(kept.hostEnvironment, `${JSON.stringify(files.hostEnvironment, null, 2)}\n`);
  await writeReleasePreflightReceipt(kept.receipt, receipt.instanceId, receipt.commit, receipt.preflight);
}

/** gws-ea's `.env` keys kept with the release in `root`; a key gws-ea does not own is refused. */
export async function readKeptHostEnvironment(root: string): Promise<Record<string, string>> {
  const file = keptReleaseFiles(root).hostEnvironment;
  const value = await readOwnerOnlyJson(file, 'Kept host environment', 'invalid_kept_release');
  if (!isRecord(value)) throw new GwsEaError('invalid_kept_release', `${file} holds no environment`);
  const owned: readonly string[] = INSTANCE_HOST_ENV_KEYS;
  const environment: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!owned.includes(key) || typeof entry !== 'string') {
      throw new GwsEaError('invalid_kept_release', `${file} holds a key gws-ea does not own: ${key}`);
    }
    environment[key] = entry;
  }
  return environment;
}

/** The files kept with the release in `root`. */
export async function readKeptRelease(root: string): Promise<KeptRelease> {
  const kept = keptReleaseFiles(root);
  const [compose, serviceDefinition, hostEnvironment] = await Promise.all([
    readOwnerOnlyFile(kept.compose),
    readOwnerOnlyFile(kept.serviceDefinition),
    readKeptHostEnvironment(root),
  ]);
  return { compose, serviceDefinition, hostEnvironment };
}

/** What a receipt must say to be this assistant's. */
export interface ReleasePreflightExpectation {
  readonly instanceId: string;
  /** The commits the receipt may name: the reservation's, and mid-update the one an operation placed live. */
  readonly deployedCommits: readonly string[];
  readonly provider: string;
  readonly providerCredential?: ProviderCredentialMetadata;
}

const INVALID_RECEIPT = 'invalid_release_preflight';

const OPTIONAL_CREDENTIAL_FIELDS = ['pathPattern', 'headerName', 'valueFormat', 'paramName', 'paramFormat'] as const;

function credentialMetadataRecord(value: unknown): ProviderCredentialMetadata {
  const metadata = requireRecord(value, 'Release provider credential metadata', INVALID_RECEIPT);
  const field = (key: string): string =>
    requireString(metadata[key], `Release provider credential ${key}`, INVALID_RECEIPT);
  const optional: { [Key in (typeof OPTIONAL_CREDENTIAL_FIELDS)[number]]?: string } = {};
  for (const key of OPTIONAL_CREDENTIAL_FIELDS) if (metadata[key] !== undefined) optional[key] = field(key);
  return { name: field('name'), type: field('type'), hostPattern: field('hostPattern'), ...optional };
}

/**
 * The receipt records what a release's preflight established, including the
 * OneCLI cohort the release pinned. The instance's OneCLI runtime runs that
 * cohort; resume never compares it with this launcher's pins, so a launcher
 * upgrade neither blocks nor upgrades an instance it did not create.
 */
function validateReleasePreflightReceipt(
  value: unknown,
  expectation: ReleasePreflightExpectation,
): ReleasePreflightReceipt {
  const receipt = requireRecord(value, 'Release preflight receipt', INVALID_RECEIPT);
  const onecli = requireRecord(receipt.onecli, 'Release preflight OneCLI cohort', INVALID_RECEIPT);
  const validated: ReleasePreflightReceipt = {
    schema_version: 1,
    instance_id: requireString(receipt.instance_id, 'Release preflight instance_id', INVALID_RECEIPT),
    deployed_commit: requireString(receipt.deployed_commit, 'Release preflight deployed_commit', INVALID_RECEIPT),
    provider: requireString(receipt.provider, 'Release preflight provider', INVALID_RECEIPT),
    providerCredential: credentialMetadataRecord(receipt.providerCredential),
    packageManager: requireString(receipt.packageManager, 'Release preflight packageManager', INVALID_RECEIPT),
    onecli: {
      gateway: requireString(onecli.gateway, 'Release preflight OneCLI gateway', INVALID_RECEIPT),
      sdk: requireString(onecli.sdk, 'Release preflight OneCLI SDK', INVALID_RECEIPT),
    },
  };
  if (
    receipt.schema_version !== 1 ||
    validated.instance_id !== expectation.instanceId ||
    !expectation.deployedCommits.includes(validated.deployed_commit) ||
    validated.provider !== expectation.provider ||
    (expectation.providerCredential !== undefined &&
      !sameCredentialMetadata(validated.providerCredential, expectation.providerCredential))
  ) {
    throw new GwsEaError('release_preflight_mismatch', 'Release preflight receipt does not match this instance');
  }
  return validated;
}

/** The receipt at `file`, checked against the assistant it must belong to. */
export async function loadReleasePreflightReceipt(
  file: string,
  expectation: ReleasePreflightExpectation,
): Promise<ReleasePreflightReceipt> {
  return validateReleasePreflightReceipt(
    await readOwnerOnlyJson(file, 'Release preflight receipt', INVALID_RECEIPT),
    expectation,
  );
}

/** Record what a release preflight established for `instanceId` at `deployedCommit`, owner-only, at `file`. */
async function writeReleasePreflightReceipt(
  file: string,
  instanceId: string,
  deployedCommit: string,
  result: ReleasePreflightResult,
): Promise<void> {
  const receipt: ReleasePreflightReceipt = {
    schema_version: 1,
    instance_id: instanceId,
    deployed_commit: deployedCommit,
    ...result,
  };
  await preparePrivateDirectory(path.dirname(file));
  await writePrivateTextFile(file, `${JSON.stringify(receipt, null, 2)}\n`);
}
