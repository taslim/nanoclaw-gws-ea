/**
 * Operator setup for the catalog apps that need this host: Link's pinned CLI, installed per version from the
 * committed lockfile, and the operator's registered Shop client. One owner-only policy records both; every
 * assistant reads it on use, so the operator never touches an assistant to enable or retire an entry.
 */
import { copyFile, lstat, mkdtemp, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { processLock } from '../community-portal/process-lock.js';
import { hostOf } from '../modules/gws-ea-connections/admit.js';
import {
  CATALOG_POLICY_SCHEMA_VERSION,
  catalogEntry,
  isClientId,
  readCatalogPolicy,
  type CatalogPolicy,
} from '../modules/gws-ea-connections/catalog.js';
import {
  catalogRetireArgs,
  parseCatalogRetireReply,
  type RetirableCatalogEntry,
} from '../modules/gws-ea-connections/catalog-retire.js';
import { CATALOG_POLICY_FILE_NAME } from '../modules/gws-ea-connections/config.js';
import {
  recordHostCliReceipt,
  verifyHostCliReceipt,
  type HostCliTransport,
} from '../modules/gws-ea-connections/host-cli-receipt.js';
import { appRedirectUri } from '../modules/gws-ea-connections/oauth.js';
import type { ConnectorInspection, ConnectorObservation, ConnectorReadiness } from './connector-inspection.js';
import { CONNECTOR_ACTIONS, connectorDefinition } from './connectors.js';
import type { InstanceOperation } from './journal.js';
import { withManagedInstances } from './local-voice.js';
import { runInstanceNclJson } from './ncl.js';
import { assertOwnedDirectory, preparePrivateDirectory, type ControlPlanePaths } from './paths.js';
import { buildToolEnvironment, runSanitizedCommand } from './process.js';
import { registerSecret, safeErrorCode, safeErrorMessage } from './redact.js';
import { getInstanceReservation, readRegistry } from './registry.js';
import type { NextAction } from './result.js';
import { readOperatorFile, writePrivateTextFile } from './secrets.js';
import { bindInstanceHostPolicies, type InstanceRuntimeConfig, type UpsertEnvVars } from './service.js';
import { createServiceControl, runtimeServiceTarget, type NanoclawServiceHelpers } from './service-control.js';
import { GwsEaError } from './types.js';

export type CatalogConnectorName = RetirableCatalogEntry;

const NAMES: Readonly<Record<CatalogConnectorName, string>> = { link: 'Link', shop: 'Shop' };
const LINK_PACKAGE_FILES = ['package.json', 'pnpm-lock.yaml'] as const;
const LINK_PACKAGE_DIRECTORY = path.join(path.dirname(fileURLToPath(import.meta.url)), 'connector-packages', 'link');
const LINK_INSTALL_TIMEOUT_MS = 10 * 60_000;

export interface CatalogConnectorDependencies {
  readonly environment?: NodeJS.ProcessEnv;
  readonly upsertEnvVars?: UpsertEnvVars;
  readonly serviceHelpers?: NanoclawServiceHelpers;
  readonly progress?: (line: string) => void;
  readonly recordEffect?: (changed: true | null) => void;
}

export interface LinkInstallData {
  readonly name: 'link';
  readonly scope: 'host';
  readonly enabled: true;
  readonly version: string;
  readonly installation_dir: string;
}

/** What one assistant answered when asked to disconnect an entry the operator retired. */
export interface CatalogRetirement {
  readonly instance_id: string;
  /** `stopped`: not running, so it disconnects the entry when it next starts. */
  readonly outcome: 'retired' | 'stopped' | 'unconfirmed';
  readonly retired: number | null;
  readonly remaining: number | null;
  readonly message: string;
}

interface CatalogUninstallFacts {
  readonly scope: 'host';
  readonly outcome: 'removed' | 'pending';
  readonly reason: string | null;
  readonly assistants: readonly CatalogRetirement[];
}
export interface LinkUninstallData extends CatalogUninstallFacts {
  readonly name: 'link';
  readonly enabled: false;
}
export interface ShopUninstallData extends CatalogUninstallFacts {
  readonly name: 'shop';
  readonly registered: false;
}

export interface ShopRedirect {
  readonly instance_id: string;
  /** Null until web serves the assistant: the address is on its web hostname. */
  readonly redirect_uri: string | null;
}

export interface ShopInstallData {
  readonly name: 'shop';
  readonly scope: 'host';
  readonly registered: true;
  readonly client_id: string;
  readonly client_secret: boolean;
  readonly assistants: readonly (ShopRedirect & { readonly message: string })[];
  readonly operator_actions: readonly string[];
}

export interface ShopInstallRequest {
  readonly clientId?: string;
  readonly clientSecretFile?: string;
}

export interface LinkConnectorDetails {
  readonly name: 'link';
  readonly policy_file: string;
  readonly pinned_version: string;
  readonly enabled: boolean | null;
  readonly versions: readonly {
    readonly version: string;
    readonly installation_dir: string;
    readonly pinned: boolean;
    readonly receipt: 'verified' | 'invalid' | 'not_checked';
    readonly reason: string | null;
  }[];
}

export interface ShopConnectorDetails {
  readonly name: 'shop';
  readonly policy_file: string;
  readonly client_id: string | null;
  readonly client_secret: boolean;
  readonly assistants: readonly ShopRedirect[];
}

export function catalogPolicyFile(paths: Pick<ControlPlanePaths, 'configRoot'>): string {
  return path.join(paths.configRoot, CATALOG_POLICY_FILE_NAME);
}

function connectorRoot(paths: Pick<ControlPlanePaths, 'configRoot'>, name: CatalogConnectorName): string {
  return path.join(paths.configRoot, 'connectors', name);
}

export function linkInstallationDirectory(paths: Pick<ControlPlanePaths, 'configRoot'>, version: string): string {
  return path.join(connectorRoot(paths, 'link'), version);
}

function shopSecretFile(paths: Pick<ControlPlanePaths, 'configRoot'>): string {
  return path.join(connectorRoot(paths, 'shop'), 'client-secret');
}

/** The version this checkout's catalog pins; assistants on this release spawn exactly it. */
export function pinnedLinkTransport(): HostCliTransport {
  const transport = catalogEntry('link')?.transport;
  if (transport?.kind !== 'host_cli') throw new Error('The catalog has no host-run Link entry');
  return transport;
}

function shopHost(): string {
  const transport = catalogEntry('shop')?.transport;
  const host = transport?.kind === 'remote' ? hostOf(transport.url) : undefined;
  if (!host) throw new Error('The catalog has no remote Shop entry');
  return host;
}

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}

async function readPolicy(paths: ControlPlanePaths): Promise<CatalogPolicy> {
  const file = catalogPolicyFile(paths);
  const state = await readCatalogPolicy(file);
  if (state.status === 'read') return state.policy;
  if (state.status === 'absent') return { schemaVersion: CATALOG_POLICY_SCHEMA_VERSION, link: null, shop: null };
  throw new GwsEaError(
    'catalog_policy_invalid',
    `The catalog policy cannot be read. Inspect ${file}: it must be a valid owner-only (0600) file. Restore or remove it before retrying the connector command.`,
  );
}

async function writePolicy(paths: ControlPlanePaths, policy: CatalogPolicy): Promise<void> {
  await writePrivate(catalogPolicyFile(paths), policy);
}

async function underCatalogLock<T>(paths: ControlPlanePaths, work: () => Promise<T>): Promise<T> {
  await preparePrivateDirectory(paths.configRoot);
  const release = await processLock(path.join(paths.configRoot, 'catalog.lock'));
  if (!release)
    throw new GwsEaError('catalog_busy', 'Another catalog connector operation is running; retry this command.');
  try {
    return await work();
  } finally {
    release();
  }
}

async function removeOwned(target: string): Promise<void> {
  try {
    await assertOwnedDirectory(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return;
    throw error;
  }
  await rm(target, { recursive: true });
}

/**
 * Reuses a version whose receipt still verifies; otherwise installs it afresh from the committed lockfile in a
 * staging directory, so a partial install never sits under the version's name.
 */
async function ensureLinkVersion(
  paths: ControlPlanePaths,
  transport: HostCliTransport,
  dependencies: CatalogConnectorDependencies,
): Promise<string> {
  const root = connectorRoot(paths, 'link');
  const destination = linkInstallationDirectory(paths, transport.version);
  try {
    await verifyHostCliReceipt(destination, transport);
    return destination;
    // eslint-disable-next-line no-catch-all/no-catch-all -- An unverifiable installation is replaced; spawns already refuse it.
  } catch (_error) {
    // Installed afresh below.
  }
  await preparePrivateDirectory(path.dirname(root));
  await preparePrivateDirectory(root);
  dependencies.recordEffect?.(null);
  const work = await mkdtemp(path.join(root, '.install-'));
  // pnpm keeps its settings, store and caches under HOME: a throwaway one keeps the operator's configuration out, and
  // the copied install needs nothing from it afterwards.
  const home = await mkdtemp(path.join(root, '.home-'));
  try {
    for (const file of LINK_PACKAGE_FILES)
      await copyFile(path.join(LINK_PACKAGE_DIRECTORY, file), path.join(work, file));
    dependencies.progress?.(`Installing Link ${transport.version} from its pinned lockfile…`);
    await runSanitizedCommand({
      command: 'pnpm',
      args: [
        'install',
        '--frozen-lockfile',
        '--ignore-scripts',
        '--prod',
        // Copied files keep the receipt's bytes independent of pnpm's store.
        '--package-import-method=copy',
        // The lockfile alone decides what is installed; the package's packageManager field must not fetch a pnpm.
        '--config.manage-package-manager-versions=false',
      ],
      cwd: work,
      env: buildToolEnvironment(dependencies.environment ?? process.env, { HOME: home }),
      timeoutMs: LINK_INSTALL_TIMEOUT_MS,
      stream: true,
    });
    await removeOwned(destination);
    await rename(work, destination);
  } finally {
    await rm(work, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
  try {
    await recordHostCliReceipt(destination, transport);
  } catch (cause) {
    await rm(destination, { recursive: true, force: true });
    throw new GwsEaError(
      'link_install_unverified',
      `The installed Link ${transport.version} could not be verified: ${cause instanceof Error ? cause.message : 'verification failed'}. Rerun gws-ea connectors install link.`,
      { cause },
    );
  }
  dependencies.recordEffect?.(true);
  return destination;
}

function withLinkVersion(policy: CatalogPolicy, version: string, installationDir: string): CatalogPolicy {
  return {
    ...policy,
    link: { enabled: true, versions: { ...policy.link?.versions, [version]: { installationDir } } },
  };
}

/** Every assistant reads the policy through its `.env` locator; one that is busy gets it from its next operation. */
async function bindAssistants(paths: ControlPlanePaths, dependencies: CatalogConnectorDependencies): Promise<void> {
  await withManagedInstances(
    paths,
    async (runtimes, missing) => {
      const upsert = dependencies.upsertEnvVars;
      if (runtimes.length && !upsert)
        throw new GwsEaError(
          'catalog_binding_unavailable',
          'The gws-ea launcher must supply its native environment writer to install catalog connectors.',
        );
      if (upsert)
        for (const runtime of runtimes)
          if (await bindInstanceHostPolicies(runtime, paths.configRoot, upsert)) dependencies.recordEffect?.(true);
      for (const id of missing)
        dependencies.progress?.(`Assistant ${id}: runtime is not recorded yet; creation binds the catalog policy.`);
    },
    (id) =>
      dependencies.progress?.(
        `Assistant ${id}: another operation is running; its next create, update or rollback binds the catalog policy.`,
      ),
  );
}

export async function installLink(
  paths: ControlPlanePaths,
  dependencies: CatalogConnectorDependencies = {},
): Promise<LinkInstallData> {
  const transport = pinnedLinkTransport();
  return underCatalogLock(paths, async () => {
    const policy = await readPolicy(paths);
    const installationDir = await ensureLinkVersion(paths, transport, dependencies);
    const next = withLinkVersion(policy, transport.version, installationDir);
    if (JSON.stringify(next) !== JSON.stringify(policy)) {
      dependencies.recordEffect?.(null);
      await writePolicy(paths, next);
      dependencies.recordEffect?.(true);
    }
    await bindAssistants(paths, dependencies);
    return {
      name: 'link',
      scope: 'host',
      enabled: true,
      version: transport.version,
      installation_dir: installationDir,
    };
  });
}

/**
 * Called after a committed lifecycle operation: while Link is enabled, the version this release pins is installed
 * beside the others, so a rolled-back assistant keeps its own.
 */
export async function provisionLink(
  paths: ControlPlanePaths,
  transport: HostCliTransport,
  dependencies: CatalogConnectorDependencies = {},
): Promise<void> {
  const recorded = (await readPolicy(paths)).link;
  if (recorded?.enabled !== true) return;
  const installed = recorded.versions[transport.version];
  if (installed) {
    try {
      await verifyHostCliReceipt(installed.installationDir, transport);
      return;
      // eslint-disable-next-line no-catch-all/no-catch-all -- An unverifiable installation is reinstalled under the lock below.
    } catch (_error) {
      // Reinstalled below.
    }
  }
  await underCatalogLock(paths, async () => {
    const policy = await readPolicy(paths);
    if (policy.link?.enabled !== true) return;
    const installationDir = await ensureLinkVersion(paths, transport, dependencies);
    const next = withLinkVersion(policy, transport.version, installationDir);
    if (JSON.stringify(next) === JSON.stringify(policy)) return;
    dependencies.recordEffect?.(null);
    await writePolicy(paths, next);
    dependencies.recordEffect?.(true);
  });
}

async function retireOn(
  runtime: InstanceRuntimeConfig,
  entry: CatalogConnectorName,
  dependencies: CatalogConnectorDependencies,
): Promise<CatalogRetirement> {
  const name = NAMES[entry];
  const id = runtime.instance_id;
  const stopped = (): CatalogRetirement => ({
    instance_id: id,
    outcome: 'stopped',
    retired: null,
    remaining: null,
    message: `Not running; it disconnects ${name} when it next starts.`,
  });
  const unconfirmed = (why: string, remaining: number | null = null): CatalogRetirement => ({
    instance_id: id,
    outcome: 'unconfirmed',
    retired: null,
    remaining,
    message: `${why} Rerun gws-ea connectors uninstall ${entry} once it is serving, or stop it with gws-ea stop --id ${id}: a stopped assistant disconnects ${name} when it next starts.`,
  });
  if (dependencies.serviceHelpers) {
    try {
      const service = createServiceControl(dependencies.serviceHelpers, runtimeServiceTarget(runtime)).detect();
      if (!service.active && !service.transitional && service.mode !== 'unmanaged') return stopped();
      // eslint-disable-next-line no-catch-all/no-catch-all -- An unobservable service is asked directly; only its answer confirms.
    } catch (_error) {
      // Asked below.
    }
  }
  let answer: unknown;
  try {
    answer = await runInstanceNclJson(runtime, catalogRetireArgs(entry));
    // eslint-disable-next-line no-catch-all/no-catch-all -- A failed request is an unconfirmed assistant, reported with its recovery.
  } catch (error) {
    return unconfirmed(`It could not be asked to disconnect ${name}: ${safeErrorMessage(error)}`);
  }
  const reply = parseCatalogRetireReply(answer, entry);
  if (!reply) return unconfirmed(`It gave no readable answer about disconnecting ${name}.`);
  if (reply.remaining > 0)
    return unconfirmed(
      `It still has ${reply.remaining} ${name} connection(s) it could not disconnect.`,
      reply.remaining,
    );
  return {
    instance_id: id,
    outcome: 'retired',
    retired: reply.retired,
    remaining: 0,
    message: reply.retired > 0 ? `Disconnected ${name}.` : `Had no ${name} connection.`,
  };
}

async function retireEverywhere(
  paths: ControlPlanePaths,
  entry: CatalogConnectorName,
  dependencies: CatalogConnectorDependencies,
): Promise<CatalogRetirement[]> {
  const name = NAMES[entry];
  const assistants: CatalogRetirement[] = [];
  await withManagedInstances(
    paths,
    async (runtimes, missing) => {
      // Without a recorded runtime there is no service to run it; it reads the policy when it starts.
      for (const id of missing)
        assistants.push({
          instance_id: id,
          outcome: 'stopped',
          retired: null,
          remaining: null,
          message: `Not running; it disconnects ${name} when it next starts.`,
        });
      for (const runtime of runtimes) assistants.push(await retireOn(runtime, entry, dependencies));
    },
    (id) =>
      assistants.push({
        instance_id: id,
        outcome: 'unconfirmed',
        retired: null,
        remaining: null,
        message: `Another operation is running on it. Rerun gws-ea connectors uninstall ${entry} after it finishes.`,
      }),
  );
  return assistants.sort((left, right) => left.instance_id.localeCompare(right.instance_id));
}

/**
 * Stop new connections first, then retire the entry on every running assistant. The entry's host files go only
 * once every running one confirms none remain; until then they stay, and rerunning continues from here.
 */
async function uninstallEntry(
  paths: ControlPlanePaths,
  entry: CatalogConnectorName,
  dependencies: CatalogConnectorDependencies,
): Promise<CatalogUninstallFacts> {
  return underCatalogLock(paths, async () => {
    const policy = await readPolicy(paths);
    const root = connectorRoot(paths, entry);
    const installed = entry === 'link' ? policy.link !== null : policy.shop !== null;
    if (!installed && !(await exists(root))) return { scope: 'host', outcome: 'removed', reason: null, assistants: [] };
    const disabled: CatalogPolicy =
      entry === 'link'
        ? { ...policy, link: policy.link && { enabled: false, versions: policy.link.versions } }
        : { ...policy, shop: null };
    if (JSON.stringify(disabled) !== JSON.stringify(policy)) {
      dependencies.recordEffect?.(null);
      await writePolicy(paths, disabled);
      dependencies.recordEffect?.(true);
    }
    const assistants = await retireEverywhere(paths, entry, dependencies);
    const unconfirmed = assistants.filter((assistant) => assistant.outcome === 'unconfirmed');
    if (unconfirmed.length)
      return {
        scope: 'host',
        outcome: 'pending',
        reason: `${NAMES[entry]} accepts no new connections, but its host files stay until every running assistant confirms it is disconnected: ${unconfirmed.map((assistant) => assistant.instance_id).join(', ')}.`,
        assistants,
      };
    dependencies.recordEffect?.(null);
    await removeOwned(root);
    if (entry === 'link') await writePolicy(paths, { ...disabled, link: null });
    dependencies.recordEffect?.(true);
    return { scope: 'host', outcome: 'removed', reason: null, assistants };
  });
}

export async function uninstallLink(
  paths: ControlPlanePaths,
  dependencies: CatalogConnectorDependencies = {},
): Promise<LinkUninstallData> {
  return { name: 'link', enabled: false, ...(await uninstallEntry(paths, 'link', dependencies)) };
}

export async function uninstallShop(
  paths: ControlPlanePaths,
  dependencies: CatalogConnectorDependencies = {},
): Promise<ShopUninstallData> {
  return { name: 'shop', registered: false, ...(await uninstallEntry(paths, 'shop', dependencies)) };
}

/** Each assistant's Shop redirect address lives on its claimed web hostname. */
async function shopRedirects(paths: ControlPlanePaths, instanceId?: string): Promise<ShopRedirect[]> {
  const instances = (await readRegistry(paths)).instances;
  const host = shopHost();
  return Object.keys(instances)
    .filter((id) => instanceId === undefined || id === instanceId)
    .sort()
    .map((id) => {
      const hostname = instances[id].exclusive_resource_claims.web?.hostname;
      return { instance_id: id, redirect_uri: hostname ? appRedirectUri(hostname, host) : null };
    });
}

function allowInstruction(redirectUri: string): string {
  return `Allow ${redirectUri} as a redirect URL of your Shopify client in the Shopify Dev Dashboard.`;
}

const NO_WEB_ADDRESS =
  'Shop sign-in needs this assistant’s web address. Once web serves it, run gws-ea connectors show shop for the redirect URL to allow in Shopify.';

export async function installShop(
  paths: ControlPlanePaths,
  request: ShopInstallRequest,
  dependencies: CatalogConnectorDependencies = {},
): Promise<ShopInstallData> {
  const clientId = request.clientId?.trim();
  if (!clientId || !isClientId(clientId))
    throw new GwsEaError(
      'invalid_arguments',
      'Shop needs the client ID of your Shopify Dev Dashboard app. Rerun with --client-id CLIENT_ID.',
    );
  return underCatalogLock(paths, async () => {
    const policy = await readPolicy(paths);
    let secret: string | undefined;
    if (request.clientSecretFile) {
      secret = (
        await readOperatorFile(
          request.clientSecretFile,
          paths.configRoot,
          'Shop client secret',
          'shop_client_secret_invalid',
        )
      ).trim();
      registerSecret(secret);
      if (!secret || /\s/u.test(secret))
        throw new GwsEaError('shop_client_secret_invalid', 'The Shop client secret file must hold only the secret.');
    }
    const root = connectorRoot(paths, 'shop');
    await preparePrivateDirectory(path.dirname(root));
    // The directory marks Shop as installed until an uninstall confirms every running assistant disconnected it.
    await preparePrivateDirectory(root);
    const secretFile = shopSecretFile(paths);
    dependencies.recordEffect?.(null);
    if (secret !== undefined) await writePrivateTextFile(secretFile, secret);
    await writePolicy(paths, {
      ...policy,
      shop: { clientId, clientSecretFile: secret === undefined ? null : secretFile },
    });
    if (secret === undefined) await rm(secretFile, { force: true });
    dependencies.recordEffect?.(true);
    await bindAssistants(paths, dependencies);
    const redirects = await shopRedirects(paths);
    return {
      name: 'shop',
      scope: 'host',
      registered: true,
      client_id: clientId,
      client_secret: secret !== undefined,
      assistants: redirects.map((redirect) => ({
        ...redirect,
        message: redirect.redirect_uri ? `Redirect URL: ${redirect.redirect_uri}` : NO_WEB_ADDRESS,
      })),
      operator_actions: redirects.flatMap((redirect) =>
        redirect.redirect_uri ? [allowInstruction(redirect.redirect_uri)] : [],
      ),
    };
  });
}

export interface CatalogProvisioning {
  readonly name: CatalogConnectorName;
  readonly reason: string;
  readonly message: string;
  readonly next_actions: readonly NextAction[];
}

/**
 * Optional work after a committed lifecycle operation; nothing here can fail it. A new assistant learns the Shop
 * redirect URL the operator must allow, because Shopify refuses a sign-in to any address it does not list.
 */
export async function provisionCatalogConnectors(
  operation: InstanceOperation,
  occasion: { readonly created: boolean },
  dependencies: CatalogConnectorDependencies = {},
): Promise<CatalogProvisioning[]> {
  const results: CatalogProvisioning[] = [];
  const transport = pinnedLinkTransport();
  try {
    operation.assertActive();
    await provisionLink(operation.paths, transport, dependencies);
    // eslint-disable-next-line no-catch-all/no-catch-all -- Optional setup reports any failure as pending; it never fails the committed release.
  } catch (cause) {
    results.push({
      name: 'link',
      reason: safeErrorCode(cause),
      message: `Link ${transport.version}, which this release pins, is not installed: ${safeErrorMessage(cause)}`,
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'link'] }],
    });
  }
  if (!occasion.created) return results;
  try {
    if ((await readPolicy(operation.paths)).shop === null) return results;
    const [redirect] = await shopRedirects(operation.paths, operation.instanceId);
    results.push(
      redirect?.redirect_uri
        ? {
            name: 'shop',
            reason: 'shop_redirect_to_allow',
            message: `Allow ${redirect.redirect_uri} in your Shopify client so this assistant's principal can connect Shop.`,
            next_actions: [{ kind: 'external', instruction: allowInstruction(redirect.redirect_uri) }],
          }
        : {
            name: 'shop',
            reason: 'shop_redirect_unavailable',
            message: NO_WEB_ADDRESS,
            next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'show', 'shop'] }],
          },
    );
    // eslint-disable-next-line no-catch-all/no-catch-all -- Optional setup reports any failure as pending; it never fails the committed release.
  } catch (cause) {
    results.push({
      name: 'shop',
      reason: safeErrorCode(cause),
      message: safeErrorMessage(cause),
      next_actions: [{ kind: 'command', argv: ['gws-ea', 'connectors', 'show', 'shop'] }],
    });
  }
  return results;
}

const readiness = (checked: boolean, ready: boolean): ConnectorReadiness => ({
  status: checked ? (ready ? 'ready' : 'not_ready') : 'not_checked',
  checked,
});
const command = (action: string, name: CatalogConnectorName): NextAction => ({
  kind: 'command',
  argv: ['gws-ea', 'connectors', action, name],
});

/** `show` reads local records only; `check` also verifies receipts and the stored secret, and never repairs. */
export async function inspectCatalogConnector(
  paths: ControlPlanePaths,
  name: CatalogConnectorName,
  options: ConnectorInspection = {},
): Promise<ConnectorObservation> {
  const definition = connectorDefinition(name);
  const checked = options.check === true;
  if (options.instanceId) await getInstanceReservation(paths, options.instanceId);
  const file = catalogPolicyFile(paths);
  const state = await readCatalogPolicy(file);
  const reasons: string[] = [];
  const actions: NextAction[] = [];
  let setup: ConnectorObservation['setup'];
  let ready = false;
  let assistants: ConnectorObservation['assistants'] = [];
  let details: LinkConnectorDetails | ShopConnectorDetails;
  const invalidPolicy = `The catalog policy at ${file} is unreadable; nothing it records is offered. Restore a valid owner-only policy, or remove it and reinstall.`;
  if (name === 'link') {
    const pinned = pinnedLinkTransport();
    const link = state.status === 'read' ? state.policy.link : null;
    const versions: LinkConnectorDetails['versions'][number][] = [];
    for (const [version, { installationDir }] of Object.entries(link?.versions ?? {}).sort(([a], [b]) =>
      a.localeCompare(b),
    )) {
      let receipt: LinkConnectorDetails['versions'][number]['receipt'] = 'not_checked';
      let reason: string | null = null;
      if (checked)
        try {
          await verifyHostCliReceipt(installationDir, { ...pinned, version });
          receipt = 'verified';
          // eslint-disable-next-line no-catch-all/no-catch-all -- A failed verification is the observed fact, never a failed inspection.
        } catch (error) {
          receipt = 'invalid';
          reason = error instanceof Error ? error.message : 'Verification failed.';
        }
      versions.push({
        version,
        installation_dir: installationDir,
        pinned: version === pinned.version,
        receipt,
        reason,
      });
    }
    details = {
      name: 'link',
      policy_file: file,
      pinned_version: pinned.version,
      enabled: state.status === 'invalid' ? null : link?.enabled === true,
      versions,
    };
    const current = versions.find((version) => version.pinned);
    if (state.status === 'invalid') {
      setup = 'unknown';
      reasons.push(invalidPolicy);
    } else if (!link) {
      setup = 'not_installed';
      reasons.push('link is not installed.');
      actions.push(command('install', name));
    } else if (!link.enabled) {
      setup = 'uninstall_incomplete';
      reasons.push('Link uninstall is incomplete: it accepts no new connections, and its versions stay installed.');
      actions.push(command('uninstall', name));
    } else if (!current) {
      setup = 'pending';
      reasons.push(`This release pins Link ${pinned.version}, which is not installed.`);
      actions.push(command('install', name));
    } else {
      setup = 'installed';
      ready = current.receipt === 'verified';
      if (checked && !ready) {
        reasons.push(`Link ${pinned.version} does not verify: ${current.reason ?? 'verification failed'}`);
        actions.push(command('install', name));
      }
    }
  } else {
    const shop = state.status === 'read' ? state.policy.shop : null;
    const redirects = shop ? await shopRedirects(paths, options.instanceId) : [];
    details = {
      name: 'shop',
      policy_file: file,
      client_id: shop?.clientId ?? null,
      client_secret: shop?.clientSecretFile != null,
      assistants: redirects,
    };
    if (state.status === 'invalid') {
      setup = 'unknown';
      reasons.push(invalidPolicy);
    } else if (!shop) {
      if (await exists(connectorRoot(paths, 'shop'))) {
        setup = 'uninstall_incomplete';
        reasons.push(
          'Shop uninstall is incomplete: it accepts no new connections, and its client secret stays stored.',
        );
        actions.push(command('uninstall', name));
      } else {
        setup = 'not_installed';
        reasons.push('shop is not installed.');
        actions.push(command('install', name));
      }
    } else {
      setup = 'installed';
      let secretReadable = true;
      if (checked && shop.clientSecretFile)
        try {
          await readOperatorFile(
            shop.clientSecretFile,
            paths.configRoot,
            'Shop client secret',
            'shop_client_secret_invalid',
          );
          // eslint-disable-next-line no-catch-all/no-catch-all -- An unreadable secret is the observed fact; its contents never reach output.
        } catch (_error) {
          secretReadable = false;
          reasons.push('The stored Shop client secret is missing or not owner-only.');
          actions.push(command('install', name));
        }
      assistants = redirects.map((redirect) => ({
        instance_id: redirect.instance_id,
        compatibility: 'compatible',
        setup: redirect.redirect_uri ? 'installed' : 'pending',
        readiness: readiness(checked, secretReadable && redirect.redirect_uri !== null),
        reasons: redirect.redirect_uri ? [] : [NO_WEB_ADDRESS],
        next_actions: [],
      }));
      ready = secretReadable && redirects.every((redirect) => redirect.redirect_uri !== null);
    }
  }
  return {
    name,
    summary: definition.summary,
    observed_at: new Date().toISOString(),
    target: options.instanceId ?? null,
    actions: CONNECTOR_ACTIONS,
    scope: definition.scope,
    account: definition.account,
    compatibility: 'compatible',
    prerequisites: definition.prerequisites.map((requirement) => ({
      requirement,
      status: 'not_checked',
      reason: null,
    })),
    setup,
    readiness: readiness(checked, ready && setup === 'installed'),
    assistants,
    reasons,
    next_actions: actions,
    details,
  };
}
