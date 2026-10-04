/**
 * The running inbox: its Gmail client and the host's inbound side of the
 * channel. Set when the host sets the channel adapter up; cleared on
 * teardown.
 */
import type { ChannelSetup } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import type { GmailApi } from './gmail-api.js';

/** The channel type of the inbox, and so of every user it names (`email:<address>`). */
export const EMAIL_CHANNEL_TYPE = 'email';
/** The platform ID of the inbox's messaging group: every thread anyone but the principal can read. */
export const INBOX_PLATFORM_ID = 'email:inbox';
/** The platform ID of the principal's own email conversation with `main`. */
export const PRINCIPAL_PLATFORM_ID = 'email:principal';

export interface InboxRuntime {
  readonly gmail: GmailApi;
  /** The host's inbound side of the channel; undefined until the host sets the adapter up. */
  setup(): ChannelSetup | undefined;
  /** The assistant's own Gmail address, as Gmail reports it; asked of Gmail once. */
  gmailAddress(): Promise<string>;
  /** That address when Gmail has already reported it, without asking. */
  knownGmailAddress(): string | undefined;
  now(): Date;
  /** Wait between retries of a Gmail call. */
  sleep(ms: number): Promise<void>;
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
