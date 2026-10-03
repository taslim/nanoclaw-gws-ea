/**
 * The running inbox: its Gmail client and the host's inbound side of the
 * channel, which the thread functions U11 calls need to release held mail.
 * Set when the host sets the channel adapter up; cleared on teardown.
 */
import type { ChannelSetup } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import type { GmailApi } from './gmail-api.js';

/** The channel type of the inbox, and so of every user it names (`email:<address>`). */
export const EMAIL_CHANNEL_TYPE = 'email';
/** The inbox's one messaging group's platform ID. */
export const INBOX_PLATFORM_ID = 'email:inbox';

export interface InboxRuntime {
  readonly gmail: GmailApi;
  /** The host's inbound side of the channel; undefined until the host sets the adapter up. */
  setup(): ChannelSetup | undefined;
  /** The assistant's own Gmail address, as Gmail reports it; asked of Gmail once. */
  gmailAddress(): Promise<string>;
  /** That address when Gmail has already reported it, without asking. */
  knownGmailAddress(): string | undefined;
  now(): Date;
}

let active: InboxRuntime | undefined;

export function setActiveInbox(runtime: InboxRuntime | undefined): void {
  active = runtime;
}

export function activeInbox(): InboxRuntime | undefined {
  return active;
}

/** The assistant's own addresses: never a recipient, and never "someone else" on a message. */
export async function assistantAddresses(): Promise<ReadonlySet<string>> {
  const addresses = new Set<string>();
  if (await getDb().hasTable('gws_ea_profile')) {
    const email = (await getGwsEaProfile()).assistant_workspace_email;
    if (email) addresses.add(email.toLowerCase());
  }
  const known = active?.knownGmailAddress();
  if (known) addresses.add(known.toLowerCase());
  return addresses;
}
