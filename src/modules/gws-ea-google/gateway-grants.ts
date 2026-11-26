/**
 * Capability-exact OneCLI grants for agents' Google credentials.
 *
 * Each published secret in `AGENT_GOOGLE_CREDENTIALS` is granted to a non-sealed
 * group strictly when that group holds an eligible Google capability (matching
 * the same `MAIN_ONLY_KEYS` rule as `gog`'s env vars in `index.ts`), and
 * detached when it no longer does. Model credentials and operator-attached
 * grants are never touched here, and host-owned sealed groups are skipped so
 * `gws-ea-sealed-gateway` remains their sole fail-closed authority.
 */
import { getGroupCapabilities } from '../../capabilities.js';
import { protectedGroupReason } from '../../cli/guard.js';
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { createOnecliAdmin, type OnecliAdmin, type OnecliAgent } from '../../gws-ea/onecli-admin.js';
import { knownMainAgentGroupId } from '../gws-ea-profile/db.js';
import {
  AGENT_GOOGLE_CREDENTIALS,
  AGENT_GOOGLE_SERVICES,
  EXPOSED_GOOGLE_SERVICES,
  type GoogleCapability,
} from './grant.js';

/**
 * Keys whose Google access only the profile's `main` is given, since a new
 * group stores `all` and so holds every default-on key. Shared by both the
 * container `gog` env vars and OneCLI gateway grant reconciliation.
 */
export const MAIN_ONLY_KEYS: ReadonlySet<GoogleCapability> = new Set(['google-workspace']);

/** Exact `AGENT_GOOGLE_CREDENTIALS` secret names a group with `capabilities` is entitled to hold. */
export function entitledGoogleSecretNames(capabilities: ReadonlySet<string>, isMain: boolean): ReadonlySet<string> {
  const names = new Set<string>();
  for (const credential of AGENT_GOOGLE_CREDENTIALS) {
    const entitled = credential.services.some((serviceId) => {
      if (!EXPOSED_GOOGLE_SERVICES.includes(serviceId)) return false;
      const capability = AGENT_GOOGLE_SERVICES[serviceId].capability;
      return capabilities.has(capability) && (isMain || !MAIN_ONLY_KEYS.has(capability));
    });
    if (entitled) names.add(credential.secretName);
  }
  return names;
}

/**
 * Map of `secretName -> secretId` for every `AGENT_GOOGLE_CREDENTIALS` entry
 * currently published unambiguously on its exact host in OneCLI.
 */
export function publishedGoogleSecretIds(secrets: readonly Record<string, unknown>[]): ReadonlyMap<string, string> {
  const result = new Map<string, string>();
  for (const credential of AGENT_GOOGLE_CREDENTIALS) {
    const matches = secrets.filter(
      (secret) =>
        typeof secret.id === 'string' &&
        secret.id.length > 0 &&
        secret.name === credential.secretName &&
        secret.hostPattern === credential.host,
    );
    if (matches.length === 1) result.set(credential.secretName, matches[0]!.id as string);
  }
  return result;
}

/** Host-side OneCLI admin client when `ONECLI_URL` and `ONECLI_API_KEY` are configured. */
export function hostOnecliAdmin(): OnecliAdmin | undefined {
  const stored = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  const url = process.env.ONECLI_URL || stored.ONECLI_URL;
  const key = process.env.ONECLI_API_KEY || stored.ONECLI_API_KEY;
  if (!url || !key) return undefined;
  return createOnecliAdmin(url, key);
}

export interface ReconcileGroupGoogleGrantsOptions {
  readonly admin: OnecliAdmin;
  readonly capabilities: ReadonlySet<string>;
  readonly isMain: boolean;
  /** Required when `createMissingAgent` is true and the group has no OneCLI agent yet. */
  readonly groupName?: string;
  /** Create the OneCLI agent if absent and the group holds at least one Google capability. */
  readonly createMissingAgent?: boolean;
  /** Pre-fetched vault secret list when batch-reconciling multiple groups. */
  readonly secrets?: readonly Record<string, unknown>[];
  /** Pre-fetched agent list when batch-reconciling multiple groups. */
  readonly agents?: readonly OnecliAgent[];
}

/**
 * Reconcile one non-sealed group's Google secret grants against its resolved
 * capabilities. Only secrets belonging to `AGENT_GOOGLE_CREDENTIALS` are ever
 * attached or detached; model and operator grants are preserved untouched.
 */
export async function reconcileGroupGoogleGrants(
  agentGroupId: string,
  options: ReconcileGroupGoogleGrantsOptions,
): Promise<void> {
  const secrets = options.secrets ?? (await options.admin.listSecrets());
  const published = publishedGoogleSecretIds(secrets);
  if (published.size === 0) return;

  const entitledNames = entitledGoogleSecretNames(options.capabilities, options.isMain);
  const wantedIds = new Set<string>();
  for (const name of entitledNames) {
    const id = published.get(name);
    if (id !== undefined) wantedIds.add(id);
  }
  const allGoogleIds = new Set(published.values());

  const agents = options.agents ?? (await options.admin.listAgents());
  const matches = agents.filter((agent) => agent.identifier === agentGroupId);
  if (matches.length > 1) {
    throw new Error(`Multiple OneCLI agents claim group ${agentGroupId}`);
  }
  let agent = matches[0];
  if (!agent) {
    if (wantedIds.size === 0 || !options.createMissingAgent || !options.groupName) return;
    await options.admin.createAgent({ identifier: agentGroupId, name: options.groupName });
    const refreshed = (await options.admin.listAgents()).filter((entry) => entry.identifier === agentGroupId);
    if (refreshed.length !== 1) throw new Error(`OneCLI agent for group ${agentGroupId} could not be resolved`);
    agent = refreshed[0]!;
  }
  if (agent.secretMode === 'all') return;

  const granted = new Set(await options.admin.listAgentSecretGrants(agent.id));
  for (const id of wantedIds) {
    if (!granted.has(id)) await options.admin.attachAgentSecretGrant(agent.id, id);
  }
  for (const id of allGoogleIds) {
    if (!wantedIds.has(id) && granted.has(id)) await options.admin.detachAgentSecretGrant(agent.id, id);
  }
}

export interface ReconcileAllGoogleGrantsDependencies {
  readonly listGroups?: () => Promise<readonly { readonly id: string; readonly name: string }[]>;
  readonly getCapabilities?: (agentGroupId: string) => Promise<ReadonlySet<string>>;
  readonly mainGroupId?: () => string | null;
  readonly isProtected?: (agentGroupId: string) => Promise<boolean>;
}

/**
 * Reconcile Google secret grants across every non-protected agent group that
 * already has a OneCLI identity. Sealed groups are skipped so their admission
 * drift checks stay authoritative.
 */
export async function reconcileAllGoogleGrants(
  admin: OnecliAdmin,
  dependencies: ReconcileAllGoogleGrantsDependencies = {},
): Promise<void> {
  const secrets = await admin.listSecrets();
  if (publishedGoogleSecretIds(secrets).size === 0) return;

  const [groups, agents] = await Promise.all([(dependencies.listGroups ?? getAllAgentGroups)(), admin.listAgents()]);
  const mainId = (dependencies.mainGroupId ?? knownMainAgentGroupId)();
  const getCapabilities = dependencies.getCapabilities ?? getGroupCapabilities;
  const isProtected =
    dependencies.isProtected ?? (async (groupId: string) => (await protectedGroupReason(groupId)) !== undefined);

  for (const group of groups) {
    if (await isProtected(group.id)) continue;
    const capabilities = await getCapabilities(group.id);
    await reconcileGroupGoogleGrants(group.id, {
      admin,
      capabilities,
      isMain: group.id === mainId,
      groupName: group.name,
      createMissingAgent: false,
      secrets,
      agents,
    });
  }
}
