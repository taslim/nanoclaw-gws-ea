/**
 * The running inbox: its Gmail client and the host's inbound side of the
 * channel. Set when the host sets the channel adapter up; cleared on
 * teardown.
 */
import type { ChannelSetup } from '../../channels/adapter.js';
import { getDb } from '../../db/connection.js';
import {
  assistantOwnAddresses,
  getGwsEaProfile,
  loadPrincipalRecognizer,
  type GwsEaProfile,
} from '../gws-ea-profile/db.js';
import type { GmailApi } from './gmail-api.js';
import { threadAddresses } from './thread-map.js';

/** The channel type of the inbox, and so of every user it names (`email:<address>`). */
export const EMAIL_CHANNEL_TYPE = 'email';
/** The inbox's messaging group: every thread anyone but the principal can read. */
export const INBOX_PLATFORM_ID = 'email:inbox';
/** The principal's own email conversation with `main`. */
export const PRINCIPAL_PLATFORM_ID = 'email:principal';

export interface InboxRuntime {
  readonly gmail: GmailApi;
  /** Undefined until the host sets the adapter up. */
  setup(): ChannelSetup | undefined;
  /** The assistant's own, as Gmail reports it, lowercased; asked of Gmail once. */
  gmailAddress(): Promise<string>;
  /** The Gmail address when Gmail has already reported it, without asking. */
  knownGmailAddress(): string | undefined;
  now(): Date;
  sleep(ms: number): Promise<void>;
  /** Wake the existing inbox loop after a sign-in claim changes. */
  wakeSignIn(): void;
}

let active: InboxRuntime | undefined;

export function setActiveInbox(runtime: InboxRuntime | undefined): void {
  active = runtime;
}

export function activeInbox(): InboxRuntime | undefined {
  return active;
}

/**
 * The assistant's own addresses: never a recipient, and never "someone else"
 * on a message. Its web alias is one of them, so mail to it routes as mail to
 * the assistant does, with no route of its own.
 */
export async function assistantAddresses(): Promise<ReadonlySet<string>> {
  return assistantAddressesOf((await getDb().hasTable('gws_ea_profile')) ? await getGwsEaProfile() : undefined);
}

/** From a profile already read: the addresses it names, and the one Gmail reported, if it has. */
export function assistantAddressesOf(profile: GwsEaProfile | undefined): ReadonlySet<string> {
  const addresses = new Set(assistantOwnAddresses(profile).map((address) => address.toLowerCase()));
  const known = active?.knownGmailAddress();
  if (known) addresses.add(known.toLowerCase());
  return addresses;
}

/** Never the principal, the assistant, or someone only written about in the thread. */
export async function conversationPeople(threadKey: string): Promise<string[]> {
  const principal = await loadPrincipalRecognizer();
  const assistant = await assistantAddresses();
  const people = (await threadAddresses(threadKey)).flatMap((entry) =>
    entry.source === 'written' ? [] : [entry.address],
  );
  return [...new Set(people)].filter((address) => !principal.has(address) && !assistant.has(address));
}
