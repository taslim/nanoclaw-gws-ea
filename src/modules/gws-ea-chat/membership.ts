import type { ChannelAdapter } from '../../channels/adapter.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import type { ChatHydrator } from './hydrate.js';
import type { WorkspaceEvent } from './pubsub-pull.js';
import { CHAT_MEMBERSHIP_CREATED, CHAT_MEMBERSHIP_DELETED, CHAT_MEMBERSHIP_UPDATED } from './subscription.js';

export interface ChatSpaceMember {
  readonly userId: string;
  readonly name: string;
}
export interface ChatMembership {
  readonly platformId: string;
  readonly name: string;
  readonly isGroup: boolean;
  readonly members: readonly ChatSpaceMember[];
}
export type ChatMembershipEvent =
  | { readonly kind: 'join' | 'roster'; readonly group: ChatMembership }
  | { readonly kind: 'detach'; readonly platformId: string };
export interface AssistantChatChannel extends ChannelAdapter {
  fetchChatMembers(platformId: string): Promise<ChatMembership>;
  isOwnMessage(platformId: string, messageId: string): Promise<boolean>;
}
const observers = new Set<(event: ChatMembershipEvent) => Promise<void>>();
export function registerChatMembershipObserver(observer: (event: ChatMembershipEvent) => Promise<void>): void {
  observers.add(observer);
}
export async function observeChatMembership(event: ChatMembershipEvent): Promise<void> {
  for (const observer of observers) await observer(event);
}
export function chatSpaceName(platformId: string): string {
  const space = platformId.replace(/^gchat:/u, '');
  if (!/^spaces\/[^/:]+$/u.test(space)) throw new Error('Google Chat membership needs a space address.');
  return space;
}
/** Name-only events require a fresh membership read; removals may already be unreadable. */
export function createChatMembershipReader(options: {
  readonly client: GoogleClientOptions;
  readonly hydrator: ChatHydrator;
  readonly assistantUserId: string;
}) {
  async function fetchChatMembers(platformId: string): Promise<ChatMembership> {
    const space = chatSpaceName(platformId);
    const resource = await googleJson(options.client, `https://chat.googleapis.com/v1/${space}`);
    if (!isRecord(resource)) throw new Error('Google Chat returned an unreadable space.');
    const members: ChatSpaceMember[] = [];
    let token: string | undefined;
    do {
      const query = new URLSearchParams({ pageSize: '100' });
      if (token) query.set('pageToken', token);
      const page = await googleJson(
        options.client,
        `https://chat.googleapis.com/v1/${space}/members?${query.toString()}`,
      );
      if (!isRecord(page)) throw new Error('Google Chat returned unreadable memberships.');
      for (const entry of Array.isArray(page.memberships) ? page.memberships : []) {
        const member = isRecord(entry) && isRecord(entry.member) ? entry.member : undefined;
        if (
          !isRecord(entry) ||
          entry.state !== 'JOINED' ||
          member?.type !== 'HUMAN' ||
          typeof member.name !== 'string' ||
          !/^users\/\d+$/u.test(member.name) ||
          member.name === options.assistantUserId
        )
          continue;
        members.push({ userId: member.name, name: await options.hydrator.displayName(member.name) });
      }
      token = typeof page.nextPageToken === 'string' && page.nextPageToken ? page.nextPageToken : undefined;
    } while (token);
    return {
      platformId: `gchat:${space}`,
      name: typeof resource.displayName === 'string' ? resource.displayName : space,
      isGroup: resource.spaceType !== 'DIRECT_MESSAGE',
      members,
    };
  }
  return {
    fetchChatMembers,
    async isOwnMessage(platformId: string, messageId: string): Promise<boolean> {
      const space = chatSpaceName(platformId);
      if (!messageId.startsWith(`${space}/messages/`)) return false;
      return (await options.hydrator.message(messageId))?.sender.name === options.assistantUserId;
    },
    async handle(event: WorkspaceEvent): Promise<boolean> {
      const singles = [CHAT_MEMBERSHIP_CREATED, CHAT_MEMBERSHIP_UPDATED, CHAT_MEMBERSHIP_DELETED];
      const batches = singles.map((type) =>
        type.replace(/(created|updated|deleted)$/u, (suffix) => `batch${suffix[0].toUpperCase()}${suffix.slice(1)}`),
      );
      if (!singles.includes(event.type) && !batches.includes(event.type)) return false;
      const entries =
        batches.includes(event.type) && Array.isArray(event.data.memberships) ? event.data.memberships : [event.data];
      const spaces = new Map<string, boolean>();
      for (const entry of entries) {
        const membership = isRecord(entry) && isRecord(entry.membership) ? entry.membership : undefined;
        const name =
          typeof membership?.name === 'string'
            ? membership.name
            : event.subject.replace(/^\/\/chat.googleapis.com\//u, '');
        const space = /^(spaces\/[^/]+)\/members\/[^/]+$/u.exec(name)?.[1];
        if (!space) throw new Error('Google Chat membership event has no member resource.');
        const own = name === `${space}/members/${options.assistantUserId.replace(/^users\//u, '')}`;
        spaces.set(space, spaces.get(space) === true || (own && /(?:deleted|batchDeleted)$/u.test(event.type)));
      }
      for (const [space, detached] of spaces) {
        const platformId = `gchat:${space}`;
        if (detached) {
          await observeChatMembership({ kind: 'detach', platformId });
          continue;
        }
        try {
          // The all-spaces user subscription reports this assistant's own membership changes.
          const kind = /(?:created|batchCreated)$/u.test(event.type) ? 'join' : 'roster';
          await observeChatMembership({ kind, group: await fetchChatMembers(platformId) });
        } catch (error) {
          if (!(error instanceof GoogleApiError) || (error.status !== 403 && error.status !== 404)) throw error;
          await observeChatMembership({ kind: 'detach', platformId });
        }
      }
      return true;
    },
  };
}
