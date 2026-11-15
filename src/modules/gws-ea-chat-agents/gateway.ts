import { sealedGatewayAdmin, sealedGatewayIdentity } from '../gws-ea-sealed-gateway/gateway.js';

/** Names chat agents in gateway errors. */
export const CHAT_AGENT = 'Chat agent';

/** Retirement keeps no usable secret; an already removed identity is equally safe. */
export async function retiredChatGatewayDrift(group: string): Promise<string[]> {
  const client = sealedGatewayAdmin(CHAT_AGENT);
  const current = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!current) return [];
  if (current.secretMode !== 'selective') return ['its retired gateway secret mode is not selective'];
  return (await client.listAgentSecretIds(current.id)).length === 0
    ? []
    : ['its retired gateway identity still has secret assignments'];
}

export async function retireChatGateway(group: string): Promise<void> {
  const client = sealedGatewayAdmin(CHAT_AGENT);
  const current = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!current) return;
  if (current.secretMode !== 'selective') await client.setSecretMode(current.id, 'selective');
  await client.setAgentSecretIds(current.id, []);
  const verified = await sealedGatewayIdentity(client, group, CHAT_AGENT);
  if (!verified || verified.secretMode !== 'selective' || (await client.listAgentSecretIds(current.id)).length !== 0)
    throw new Error('Retired chat agent still has gateway secret access');
}
