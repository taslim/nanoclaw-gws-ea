/**
 * The assistant's email on the web. Its web alias is its email on every
 * website: for its own accounts, which are in its own name, and for bookings
 * and checkouts made for the principal. The addresses it converses from (its
 * Workspace email, and the one Gmail reports) never go onto a site, and no
 * signup opens an account under one of the principal's addresses: their own
 * accounts come only from their logins in 1Password. Until gws-ea records an
 * alias, whatever would put the assistant's email on a site stops with
 * `alias_unavailable`, which tells the agent the assistant's setup is
 * incomplete.
 */
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { EMAIL_PATTERN, identityMatchKey } from '../../gws-ea/validation.js';
import { assistantAddressesOf } from '../gws-ea-inbox/runtime.js';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';

const WRITTEN_ADDRESS = /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/gu;

/** One mailbox in every spelling that reaches it (`identityMatchKey`): any case, any +tag, Gmail's dots. */
function mailbox(address: string): string {
  return identityMatchKey(`email:${address.trim()}`);
}

interface WebIdentity {
  /** Null until gws-ea records the alias the operator confirmed. */
  readonly alias: string | null;
  /** Whether `address` reaches the assistant's mailbox other than through its alias: an address it converses from. */
  conversesFrom(address: string): boolean;
}

async function webIdentity(): Promise<WebIdentity> {
  const profile = (await getDb().hasTable('gws_ea_profile')) ? await getGwsEaProfile() : undefined;
  const alias = profile?.assistant_alias ?? null;
  const own = new Set([...assistantAddressesOf(profile)].map(mailbox));
  if (alias !== null) own.delete(mailbox(alias));
  return {
    alias,
    conversesFrom: (address) => own.has(mailbox(address)),
  };
}

/**
 * What a browser batch meets when the text it gives a site (what it types or
 * selects, and the addresses it opens with their query decoded) holds an
 * address the assistant converses from: `alias_unavailable` while no alias is
 * recorded, and a refusal naming the alias once one is.
 */
export async function givenAddressStop(texts: readonly string[]): Promise<'alias_unavailable' | undefined> {
  const written = texts.flatMap((text) => text.match(WRITTEN_ADDRESS) ?? []);
  if (written.length === 0) return undefined;
  const identity = await webIdentity();
  if (!written.some((address) => identity.conversesFrom(address))) return undefined;
  if (identity.alias === null) return 'alias_unavailable';
  throw invalidArgs(
    `On websites the assistant's email is ${identity.alias}: give that, never an address it converses from.`,
  );
}

/**
 * An email username names the assistant's account only when it reaches the
 * recorded web alias. Non-email usernames need the site's finalized signup
 * record as well, which the credential-attempt store checks.
 */
export async function isAssistantAccount(username: string): Promise<boolean> {
  const { alias } = await webIdentity();
  return alias !== null && mailbox(username) === mailbox(alias);
}

/**
 * Signups use only the web alias, in any spelling that reaches it, or a
 * non-email username. Email signups wait for the operator to record an alias.
 */
export async function signupAccountStop(username: string): Promise<'alias_unavailable' | undefined> {
  const identity = await webIdentity();
  if (!EMAIL_PATTERN.test(username)) return undefined;
  if (identity.alias === null) return 'alias_unavailable';
  if (mailbox(username) === mailbox(identity.alias)) return undefined;
  throw forbidden(
    `The assistant opens accounts only under its web address, ${identity.alias}, or a non-email username. The principal's own accounts come only from their logins in 1Password.`,
  );
}

/**
 * The email a sign-in by emailed code gives the site: the alias, in the
 * spelling the field already holds when that reaches it (an account opened
 * under a +tag of it), never an address the assistant converses from;
 * undefined while no alias is recorded.
 */
export async function signInAddress(current: string): Promise<string | undefined> {
  const { alias } = await webIdentity();
  if (alias === null) return undefined;
  const held = current.trim().toLowerCase();
  return mailbox(held) === mailbox(alias) ? held : alias;
}

/** Null until gws-ea records the alias the operator confirmed. */
export async function assistantWebAddress(): Promise<string | null> {
  return (await webIdentity()).alias;
}
