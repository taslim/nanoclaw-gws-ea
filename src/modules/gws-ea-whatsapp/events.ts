import type { BaileysEventMap, GroupMetadata, GroupParticipant } from '@whiskeysockets/baileys';

import type { WhatsAppSocket } from './adapter.js';
import { normalizedJid, resolvePerson } from './identity.js';
import type { WhatsAppIndex } from './index-store.js';
import { observeWhatsAppMembership, type WhatsAppGroupEvent } from './observers.js';
import type { WhatsAppLink, WhatsAppPerson } from './paths.js';

export interface WhatsAppGroupMember {
  readonly key: string;
  readonly person: WhatsAppPerson;
  readonly name?: string;
  readonly isPrincipal: boolean;
}
export interface WhatsAppGroup {
  readonly platformId: string;
  readonly name: string;
  readonly members: readonly WhatsAppGroupMember[];
}
export type WhatsAppMembershipEvent =
  | { readonly kind: 'join' | 'roster'; readonly group: WhatsAppGroup; readonly author?: WhatsAppPerson }
  | {
      readonly kind: 'detach';
      readonly platformId: string;
      readonly reason: 'removed' | 'deleted';
      readonly author?: WhatsAppPerson;
    };

export function createWhatsAppGroupEvents(options: {
  readonly socket: () => WhatsAppSocket;
  readonly index: WhatsAppIndex;
  readonly link: () => WhatsAppLink | undefined;
}) {
  const groups = new Map<string, GroupMetadata>();
  let tail = Promise.resolve();
  async function member(value: GroupParticipant): Promise<WhatsAppGroupMember> {
    const person = await resolvePerson(
      options.socket(),
      options.index,
      value.lid ?? value.id,
      value.phoneNumber ?? value.id,
    );
    if (!person) throw new Error('WhatsApp group member has no resolved LID');
    const name =
      value.name ||
      value.notify ||
      options.index.name(`${person.lid}@lid`) ||
      options.index.name(normalizedJid(value.id));
    if (value.name || value.notify)
      options.index.rememberName(`${person.lid}@lid`, value.name || value.notify || person.lid);
    return {
      key: `whatsapp:${person.lid}`,
      person,
      ...(name ? { name } : {}),
      isPrincipal: person.lid === options.link()?.principal?.lid,
    };
  }
  async function snapshot(metadata: GroupMetadata): Promise<WhatsAppGroup> {
    const members = await Promise.all(metadata.participants.map(member));
    const self = options.link()?.account?.lid;
    return {
      platformId: metadata.id,
      name: metadata.subject,
      members: members.filter(({ person }) => person.lid !== self),
    };
  }
  async function author(jid?: string, phone?: string): Promise<WhatsAppPerson | undefined> {
    return jid ? resolvePerson(options.socket(), options.index, jid, phone) : undefined;
  }
  async function fetchGroupMembers(platformId: string): Promise<WhatsAppGroup> {
    if (!platformId.endsWith('@g.us')) throw new Error('WhatsApp member fetch requires a group');
    const metadata = await options.socket().groupMetadata(platformId);
    groups.set(platformId, metadata);
    return snapshot(metadata);
  }
  async function handle(event: WhatsAppGroupEvent): Promise<void> {
    if (event.type === 'group-participants.update') {
      const value = event.value;
      const by = await author(value.author, value.authorPn);
      const changed = await Promise.all(value.participants.map(member));
      const self = options.link()?.account?.lid;
      if (value.action === 'remove' && changed.some(({ person }) => person.lid === self)) {
        groups.delete(value.id);
        await observeWhatsAppMembership({
          kind: 'detach',
          platformId: value.id,
          reason: 'removed',
          ...(by ? { author: by } : {}),
        });
        return;
      }
      let metadata = groups.get(value.id);
      if (!metadata) metadata = await options.socket().groupMetadata(value.id);
      const changedKeys = new Set(changed.map(({ person }) => person.lid));
      const retained: GroupParticipant[] = [];
      for (const participant of metadata.participants) {
        const resolved = await member(participant);
        if (!changedKeys.has(resolved.person.lid)) retained.push(participant);
      }
      const updated = {
        ...metadata,
        participants: value.action === 'remove' ? retained : [...retained, ...value.participants],
      };
      groups.set(value.id, updated);
      await observeWhatsAppMembership({
        kind: changed.some(({ person }) => person.lid === self) && value.action === 'add' ? 'join' : 'roster',
        group: await snapshot(updated),
        ...(by ? { author: by } : {}),
      });
      return;
    }
    for (const value of event.value) {
      if (!value.id?.endsWith('@g.us')) continue;
      const previous = groups.get(value.id);
      const complete =
        value.participants && typeof value.subject === 'string'
          ? { ...value, id: value.id, owner: value.owner, subject: value.subject, participants: value.participants }
          : { ...(previous ?? (await options.socket().groupMetadata(value.id))), ...value };
      groups.set(value.id, complete);
      const by = await author(value.author, value.authorPn);
      await observeWhatsAppMembership({
        kind: event.type === 'groups.upsert' ? 'join' : 'roster',
        group: await snapshot(complete),
        ...(by ? { author: by } : {}),
      });
    }
  }
  return {
    reset: () => groups.clear(),
    fetchGroupMembers,
    event(event: WhatsAppGroupEvent): Promise<void> {
      const run = tail.then(() => handle(event));
      tail = run.catch(() => undefined);
      return run;
    },
    deleted(platformIds: BaileysEventMap['chats.delete']): Promise<void> {
      const run = tail.then(async () => {
        for (const platformId of platformIds)
          if (platformId.endsWith('@g.us')) {
            groups.delete(platformId);
            await observeWhatsAppMembership({ kind: 'detach', platformId, reason: 'deleted' });
          }
      });
      tail = run.catch(() => undefined);
      return run;
    },
  };
}
