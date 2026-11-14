/**
 * The gateway identity of a host-owned sealed group: selective secret mode, holding exactly its provider's model
 * credential. Every other secret in the gateway, the principal's app credentials included, stays with main, whose
 * identity keeps all secrets.
 */
import { getContainerConfig } from '../../db/container-configs.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { createOnecliAdmin, type OnecliAdmin, type OnecliAgent } from '../../gws-ea/onecli-admin.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';

/** `label` names the group in errors, as an operator reads it. */
export function sealedGatewayAdmin(label: string): OnecliAdmin {
  const stored = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  const url = process.env.ONECLI_URL || stored.ONECLI_URL;
  const key = process.env.ONECLI_API_KEY || stored.ONECLI_API_KEY;
  if (!url || !key) throw new Error(`${label} gateway administration is not configured`);
  return createOnecliAdmin(url, key);
}

export async function sealedGatewayIdentity(
  client: OnecliAdmin,
  group: string,
  label: string,
): Promise<OnecliAgent | undefined> {
  const found = (await client.listAgents()).filter((agent) => agent.identifier === group);
  if (found.length > 1) throw new Error(`${label} has colliding gateway identities`);
  return found[0];
}

async function modelSecret(client: OnecliAdmin, group: string, label: string): Promise<string> {
  const config = await getContainerConfig(group);
  const provider = resolveProviderName(null, config?.provider);
  const endpoints = getProviderHostContract(provider)?.modelEndpoints;
  const hosts = new Set(
    [endpoints?.api, endpoints?.subscription]
      .filter((value): value is string => value !== undefined)
      .map((value) => new URL(value).hostname),
  );
  const candidates = (await client.listSecrets()).filter(
    (secret) =>
      typeof secret.id === 'string' && typeof secret.hostPattern === 'string' && hosts.has(secret.hostPattern),
  );
  if (candidates.length !== 1) throw new Error(`${label} needs one unambiguous model credential`);
  const id = candidates[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error(`${label} model credential has no ID`);
  return id;
}

/**
 * Admission refuses a group without an identity, so the gateway never creates one in its default all-secrets mode;
 * this creates it, repairs it, and reads back both restrictions. Only this group's identity is written.
 */
export async function reconcileSealedGateway(group: string, label: string): Promise<void> {
  if ((await sealedGatewayDrift(group, label)).length === 0) return;
  const client = sealedGatewayAdmin(label);
  const secret = await modelSecret(client, group, label);
  let current = await sealedGatewayIdentity(client, group, label);
  if (!current) {
    const stored = await getAgentGroup(group);
    if (!stored) throw new Error(`${label} no longer exists`);
    await client.createAgent({ identifier: group, name: stored.name });
    current = await sealedGatewayIdentity(client, group, label);
  }
  if (!current) throw new Error(`${label} gateway identity was not created`);
  if (current.secretMode !== 'selective') await client.setSecretMode(current.id, 'selective');
  const assigned = await client.listAgentSecretIds(current.id);
  if (assigned.length !== 1 || assigned[0] !== secret) await client.setAgentSecretIds(current.id, [secret]);
  const problems = await sealedGatewayDrift(group, label);
  if (problems.length > 0) throw new Error(`${label} gateway reconciliation failed: ${problems.join('; ')}`);
}

/** Admission reads the gateway; a cached successful reconcile is not authority to start. */
export async function sealedGatewayDrift(group: string, label: string): Promise<string[]> {
  const client = sealedGatewayAdmin(label);
  const model = modelSecret(client, group, label);
  // The identity's own drift returns before the model credential is awaited; its failure must not go unhandled.
  void model.catch(() => undefined);
  const current = await sealedGatewayIdentity(client, group, label);
  if (!current) return ['its gateway identity is missing'];
  if (current.secretMode !== 'selective') return ['its gateway secret mode is not selective'];
  const [secret, assigned] = await Promise.all([model, client.listAgentSecretIds(current.id)]);
  return assigned.length === 1 && assigned[0] === secret ? [] : ['its gateway secret assignments are not model-only'];
}
