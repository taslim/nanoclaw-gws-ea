import { sealedGatewayAdmin, sealedGatewayIdentity } from '../gws-ea-sealed-gateway/gateway.js';

/** Names chat agents in gateway errors. */
export const CHAT_AGENT = 'Chat agent';

/** Retirement keeps no usable secret; an already removed identity is equally safe. */
export async function retiredChatGatewayDrift(group: string): Promise<string[]> {
  const client = sealedGatewayAdmin(CHAT_AGENT);
  const current = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!current) return [];
  if (current.secretMode === 'all') return ['its retired gateway secret mode is all'];
  return (await client.listAgentSecretGrants(current.id)).length === 0
    ? []
    : ['its retired gateway identity still has secret grants'];
}

export async function retireChatGateway(group: string): Promise<void> {
  const client = sealedGatewayAdmin(CHAT_AGENT);
  const current = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!current) return;
  if (current.secretMode === 'all') {
    throw new Error('Retired chat agent is in legacy all-secrets mode; upgrade or reconvert OneCLI');
  }
  for (const secretId of await client.listAgentSecretGrants(current.id)) {
    await client.detachAgentSecretGrant(current.id, secretId);
  }
  const verified = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!verified || verified.secretMode === 'all' || (await client.listAgentSecretGrants(current.id)).length !== 0) {
    throw new Error('Retired chat agent still has gateway secret access');
  }
}
