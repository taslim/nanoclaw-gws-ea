/**
 * The principal's DM, opened by the assistant at create: the assistant writes
 * first, so only the person Google resolves for the one address create named
 * can become the principal.
 *
 * Chat's `spaces.setup` returns the assistant's DM with that address,
 * opening it when there is none. Google must answer with a direct message
 * between the assistant and exactly one person, who is then known by the
 * numeric ID Chat names them with (`gchat:users/{id}`): the address alias
 * never becomes a user ID. Google lists that person as invited until the DM
 * holds a message, as observed live on 2026-10-12 for a person in the
 * assistant's own organization, and someone outside it stays invited until
 * they accept the DM as a message request. Neither can happen before the
 * assistant writes, so an invited person is the principal like a joined one:
 * the assistant's welcome is what makes the DM appear to them.
 *
 * The DM's conversation is the one the adapter routes that person's
 * messages to (adapter.ts): `gchat:{space}`, on the `gchat` instance. It is
 * kept strict: only the principal is ever in it.
 *
 * Google being briefly unavailable (unreachable, 429, 5xx) is retried, then
 * reported; any other refusal fails, naming the address. Another address is
 * never tried in its place.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { createMessagingGroupIfAbsent, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { GCHAT_CHANNEL_TYPE } from '../../gws-ea/types.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import { DIRECT_MESSAGE } from './hydrate.js';

const CHAT = 'https://chat.googleapis.com/v1';
/** How long one call to Chat may take before it counts as unavailable. */
const REQUEST_TIMEOUT_MS = 15_000;
const RETRY_WAITS_MS = [2_000, 5_000] as const;

export type PrincipalDmResult =
  | {
      readonly status: 'opened';
      readonly user_id: string;
      readonly platform_id: string;
      readonly messaging_group_id: string;
    }
  /** Google stayed unavailable through every attempt. */
  | { readonly status: 'unavailable'; readonly reason: string };

export interface OpenPrincipalDmOptions {
  readonly chatToken: () => Promise<string>;
  /** `users/{sub}`: how Chat names the assistant. */
  readonly assistantUserId: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly sleep?: (milliseconds: number) => Promise<void>;
}

/** `userId` is the person in the DM with the assistant, as `gchat:users/{id}`. */
interface DirectMessage {
  readonly space: string;
  readonly userId: string;
}

/** The conversation the adapter routes a DM in `space` to: `channelIdFromThreadId` of its DM thread. */
function directMessagePlatformId(space: string): string {
  return `${GCHAT_CHANNEL_TYPE}:${space}`;
}

function notOneToOne(email: string, space: string): Error {
  return new Error(
    `Google Chat answered ${email} with ${space}, which is not a direct message between the assistant and one person`,
  );
}

async function readDirectMessage(email: string, options: OpenPrincipalDmOptions): Promise<DirectMessage> {
  const client: GoogleClientOptions = {
    token: options.chatToken,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  };
  const space = await googleJson(client, `${CHAT}/spaces:setup`, {
    method: 'POST',
    body: {
      space: { spaceType: DIRECT_MESSAGE, singleUserBotDm: false },
      memberships: [{ member: { name: `users/${email}`, type: 'HUMAN' } }],
    },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!isRecord(space) || typeof space.name !== 'string' || !/^spaces\/[^/]+$/u.test(space.name)) {
    throw new Error(`Google Chat answered ${email} without a conversation`);
  }
  const name = space.name;
  if (space.spaceType !== DIRECT_MESSAGE || space.singleUserBotDm === true) throw notOneToOne(email, name);
  // Invited members are listed only when asked for, and the person is one until the DM holds a message.
  const listed = await googleJson(client, `${CHAT}/${name}/members?showInvited=true&pageSize=100`, {
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  const memberships: unknown[] = isRecord(listed) && Array.isArray(listed.memberships) ? listed.memberships : [];
  const members = memberships.flatMap((membership) => {
    const member = isRecord(membership) && isRecord(membership.member) ? membership.member : undefined;
    return isRecord(membership) && typeof member?.name === 'string'
      ? [{ name: member.name, type: member.type, state: membership.state }]
      : [];
  });
  const others = members.filter((member) => member.name !== options.assistantUserId);
  const [other] = others;
  if (
    members.length !== 2 ||
    others.length !== 1 ||
    other === undefined ||
    other.type !== 'HUMAN' ||
    !/^users\/\d+$/u.test(other.name) ||
    (other.state !== 'JOINED' && other.state !== 'INVITED')
  ) {
    throw notOneToOne(email, name);
  }
  return { space: name, userId: `${GCHAT_CHANNEL_TYPE}:${other.name}` };
}

/**
 * Inserted as the router inserts a first message's conversation, so a message
 * arriving meanwhile shares the row.
 */
async function directMessageConversation(email: string, space: string): Promise<string> {
  const platformId = directMessagePlatformId(space);
  await createMessagingGroupIfAbsent({
    id: `mg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    channel_type: GCHAT_CHANNEL_TYPE,
    platform_id: platformId,
    instance: GCHAT_CHANNEL_TYPE,
    name: null,
    is_group: 0,
    unknown_sender_policy: 'strict',
    denied_at: null,
    created_at: new Date().toISOString(),
  });
  const conversation = await getMessagingGroupByPlatform(GCHAT_CHANNEL_TYPE, platformId, GCHAT_CHANNEL_TYPE);
  if (!conversation) throw new Error(`The conversation of the direct message with ${email} was not kept`);
  if (conversation.is_group !== 0) throw notOneToOne(email, space);
  return conversation.id;
}

export async function openPrincipalDm(email: string, options: OpenPrincipalDmOptions): Promise<PrincipalDmResult> {
  const sleep = options.sleep ?? ((milliseconds: number) => delay(milliseconds));
  let dm: DirectMessage | undefined;
  for (let attempt = 0; dm === undefined; attempt += 1) {
    try {
      dm = await readDirectMessage(email, options);
    } catch (error) {
      if (!(error instanceof GoogleApiError)) throw error;
      if (!error.retryable) {
        throw new Error(`Google Chat cannot open a direct message with ${email}: ${error.message}`, { cause: error });
      }
      const wait = RETRY_WAITS_MS[attempt];
      if (wait === undefined) return { status: 'unavailable', reason: error.message };
      await sleep(wait);
    }
  }
  return {
    status: 'opened',
    user_id: dm.userId,
    platform_id: directMessagePlatformId(dm.space),
    messaging_group_id: await directMessageConversation(email, dm.space),
  };
}
