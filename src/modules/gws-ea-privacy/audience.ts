/**
 * Who a send reaches: the principal, or anyone else.
 *
 * The audience comes from the final recipients. A channel that addresses
 * mail registers a resolver that returns the exact addresses a send goes to,
 * the same list it sends with; the send is the principal's only when every
 * one of them is one of the principal's addresses, by the one recognizer
 * every comparison with them uses (`loadPrincipalRecognizer`). Any other
 * send is the principal's only when it goes to a direct message mapped to a
 * verified principal. Everything else, an unknown or empty recipient list
 * included, is "others".
 */
import { getDb } from '../../db/connection.js';
import type { OutboundSend } from '../../delivery.js';
import { loadPrincipalRecognizer } from '../gws-ea-profile/db.js';

export type Audience = 'principal' | 'others';

/** The bare email addresses a send on this channel goes to, exactly as the channel will send it. */
export type RecipientResolver = (send: OutboundSend) => readonly string[] | Promise<readonly string[]>;

const recipientResolvers = new Map<string, RecipientResolver>();

export function registerRecipientResolver(channelType: string, resolver: RecipientResolver): void {
  if (recipientResolvers.has(channelType)) {
    throw new Error(`A recipient resolver is already registered for ${channelType}`);
  }
  recipientResolvers.set(channelType, resolver);
}

export async function audienceForAddresses(addresses: readonly string[]): Promise<Audience> {
  if (addresses.length === 0) return 'others';
  const principal = await loadPrincipalRecognizer();
  return addresses.every((address) => principal.has(address)) ? 'principal' : 'others';
}

async function isPrincipalDirectMessage(channelType: string, platformId: string, instance: string): Promise<boolean> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_principal_users'))) return false;
  const row = await db.get<{ present: number }>(
    `SELECT 1 AS present
       FROM messaging_groups mg
       JOIN user_dms dm ON dm.messaging_group_id = mg.id
       JOIN gws_ea_principal_users principal ON principal.user_id = dm.user_id
      WHERE mg.channel_type = ? AND mg.platform_id = ? AND mg.instance = ? AND mg.is_group = 0
      LIMIT 1`,
    channelType,
    platformId,
    instance,
  );
  return row !== undefined;
}

export async function resolveAudience(send: OutboundSend): Promise<Audience> {
  const resolver = recipientResolvers.get(send.channelType);
  if (resolver) return audienceForAddresses(await resolver(send));
  return (await isPrincipalDirectMessage(send.channelType, send.platformId, send.instance ?? send.channelType))
    ? 'principal'
    : 'others';
}
