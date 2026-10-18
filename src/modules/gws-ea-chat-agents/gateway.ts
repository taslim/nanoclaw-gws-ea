import { getContainerConfig } from '../../db/container-configs.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { readEnvFile } from '../../env.js';
import { createOnecliAdmin, type OnecliAdmin, type OnecliAgent } from '../../gws-ea/onecli-admin.js';
import { getProviderHostContract } from '../../provider-contracts/index.js';
import { resolveProviderName } from '../../providers/provider-name.js';

function admin(): OnecliAdmin {
  const stored = readEnvFile(['ONECLI_URL', 'ONECLI_API_KEY']);
  const url = process.env.ONECLI_URL || stored.ONECLI_URL;
  const key = process.env.ONECLI_API_KEY || stored.ONECLI_API_KEY;
  if (!url || !key) throw new Error('Chat-agent gateway administration is not configured');
  return createOnecliAdmin(url, key);
}

async function identity(client: OnecliAdmin, group: string): Promise<OnecliAgent | undefined> {
  const found = (await client.listAgents()).filter((agent) => agent.identifier === group);
  if (found.length > 1) throw new Error('Chat agent has colliding gateway identities');
  return found[0];
}

async function modelSecret(client: OnecliAdmin, group: string): Promise<string> {
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
  if (candidates.length !== 1) throw new Error('Chat agent needs one unambiguous model credential');
  const id = candidates[0]?.id;
  if (typeof id !== 'string' || !id) throw new Error('Chat agent model credential has no ID');
  return id;
}

/** Repair only a host-owned group's gateway identity, then read back both restrictions. */
export async function reconcileChatGateway(group: string): Promise<void> {
  const client = admin();
  const secret = await modelSecret(client, group);
  let current = await identity(client, group);
  if (!current) {
    const stored = await getAgentGroup(group);
    if (!stored) throw new Error('Chat agent no longer exists');
    await client.createAgent({ identifier: group, name: stored.name });
    current = await identity(client, group);
  }
  if (!current) throw new Error('Chat agent gateway identity was not created');
  if (current.secretMode !== 'selective') await client.setSecretMode(current.id, 'selective');
  const assigned = await client.listAgentSecretIds(current.id);
  if (assigned.length !== 1 || assigned[0] !== secret) await client.setAgentSecretIds(current.id, [secret]);
  const problems = await chatGatewayDrift(group);
  if (problems.length > 0) throw new Error(`Chat-agent gateway reconciliation failed: ${problems.join('; ')}`);
}

/** Admission reads the gateway; a cached successful create is not authority to start. */
export async function chatGatewayDrift(group: string): Promise<string[]> {
  const client = admin();
  const current = await identity(client, group);
  if (!current) return ['its gateway identity is missing'];
  if (current.secretMode !== 'selective') return ['its gateway secret mode is not selective'];
  const [secret, assigned] = await Promise.all([modelSecret(client, group), client.listAgentSecretIds(current.id)]);
  return assigned.length === 1 && assigned[0] === secret ? [] : ['its gateway secret assignments are not model-only'];
}

/** A retired group keeps its gateway identity with no usable secret. */
export async function retireChatGateway(group: string): Promise<void> {
  const client = admin();
  const current = await identity(client, group);
  if (!current) return;
  if (current.secretMode !== 'selective') await client.setSecretMode(current.id, 'selective');
  await client.setAgentSecretIds(current.id, []);
  const verified = await identity(client, group);
  if (!verified || verified.secretMode !== 'selective' || (await client.listAgentSecretIds(current.id)).length !== 0)
    throw new Error('Retired chat agent still has gateway secret access');
}
