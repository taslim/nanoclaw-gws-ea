/** Baileys' event and network boundary; no routing, identity or delivery logic lives here. */
import type {
  AnyMessageContent,
  GroupMetadata,
  ParticipantAction,
  BaileysEventEmitter,
  BaileysEventMap,
  MiscMessageGenerationOptions,
  WAMessage,
} from '@whiskeysockets/baileys';

import type { WhatsAppSocket } from '../adapter.js';

export class FakeSocket implements WhatsAppSocket {
  private readonly listeners = new Map<string, Set<(event: unknown) => void>>();
  readonly sends: { jid: string; content: AnyMessageContent; options: MiscMessageGenerationOptions }[] = [];
  readonly presence: { status: string; jid?: string }[] = [];
  readonly mappings = new Map<string, string>();
  readonly usync = new Map<string, string>();
  readonly lookups: string[] = [];
  readonly numberQueries: string[] = [];
  readonly groups = new Map<string, GroupMetadata>();
  readonly leftGroups: string[] = [];
  leaveError?: Error;
  readonly createdGroups: { subject: string; participants: string[] }[] = [];
  readonly participantUpdates: { jid: string; participants: string[]; action: ParticipantAction }[] = [];
  readonly addResults = new Map<string, Awaited<ReturnType<WhatsAppSocket['groupParticipantsUpdate']>>[number]>();
  readonly registered = new Map<string, boolean>();
  lookupGate?: Promise<void>;
  readonly user = { id: '15550000000:1@s.whatsapp.net', lid: '999000:1@lid', name: 'Assistant' };
  sendError?: Error;
  ended = false;
  profileName?: string;
  profileAbout?: string;
  loggedOut = false;
  pairingCode = '12345678';

  readonly ev: BaileysEventEmitter = {
    on: <T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void => {
      const listeners = this.listeners.get(event) ?? new Set();
      listeners.add(listener as (arg: unknown) => void);
      this.listeners.set(event, listeners);
    },
    off: <T extends keyof BaileysEventMap>(event: T, listener: (arg: BaileysEventMap[T]) => void): void => {
      this.listeners.get(event)?.delete(listener as (arg: unknown) => void);
    },
    removeAllListeners: (event): void => {
      this.listeners.delete(event);
    },
    emit: (event, arg): boolean => {
      void this.emit(event, arg);
      return true;
    },
  };

  readonly signalRepository = {
    lidMapping: {
      getLIDForPN: async (pn: string): Promise<string | null> => {
        this.lookups.push(pn);
        await this.lookupGate;
        return [...this.mappings].find(([, phone]) => phone === pn)?.[0] ?? this.usync.get(pn) ?? null;
      },
      getPNForLID: async (lid: string): Promise<string | null> => this.mappings.get(lid) ?? null,
      storeLIDPNMappings: async (pairs: { lid: string; pn: string }[]): Promise<void> => {
        for (const pair of pairs) this.mappings.set(pair.lid, pair.pn);
      },
    },
  };

  async emit<T extends keyof BaileysEventMap>(event: T, arg: BaileysEventMap[T]): Promise<void> {
    for (const listener of this.listeners.get(event) ?? []) await Promise.resolve(listener(arg));
  }

  async sendMessage(
    jid: string,
    content: AnyMessageContent,
    options: MiscMessageGenerationOptions = {},
  ): Promise<WAMessage> {
    this.sends.push({ jid, content, options });
    if (this.sendError) throw this.sendError;
    return {
      key: { remoteJid: jid, fromMe: true, id: options.messageId ?? 'fake-generated-id' },
      message: 'text' in content ? { conversation: content.text } : {},
      messageTimestamp: 1792310400,
    };
  }

  async updateMediaMessage(message: WAMessage): Promise<WAMessage> {
    return message;
  }

  async sendPresenceUpdate(status: string, jid?: string): Promise<void> {
    this.presence.push({ status, jid });
  }
  async requestPairingCode(_phone: string): Promise<string> {
    return this.pairingCode;
  }
  async groupFetchAllParticipating(): Promise<Record<string, GroupMetadata>> {
    return Object.fromEntries(this.groups);
  }
  async groupLeave(jid: string): ReturnType<WhatsAppSocket['groupLeave']> {
    this.leftGroups.push(jid);
    if (this.leaveError) throw this.leaveError;
    return undefined;
  }
  async groupMetadata(jid: string): Promise<GroupMetadata> {
    const group = this.groups.get(jid);
    if (!group) throw new Error('Unknown group at fake network boundary');
    return group;
  }
  async onWhatsApp(...numbers: string[]): ReturnType<WhatsAppSocket['onWhatsApp']> {
    this.numberQueries.push(...numbers);
    return numbers.map((number) => ({
      jid: number.replace(/^\+/u, '').split('@')[0] + '@s.whatsapp.net',
      exists: this.registered.get(number) ?? true,
    }));
  }
  async groupCreate(subject: string, participants: string[]): Promise<GroupMetadata> {
    this.createdGroups.push({ subject, participants });
    const id = `created-${this.createdGroups.length}@g.us`;
    const group: GroupMetadata = {
      id,
      owner: this.user.lid,
      subject,
      participants: [{ id: this.user.lid }, ...participants.map((person) => ({ id: person }))],
    };
    this.groups.set(id, group);
    return group;
  }
  async groupParticipantsUpdate(
    jid: string,
    participants: string[],
    action: ParticipantAction,
  ): ReturnType<WhatsAppSocket['groupParticipantsUpdate']> {
    this.participantUpdates.push({ jid, participants, action });
    return participants.map(
      (person) =>
        this.addResults.get(person) ?? {
          jid: person,
          status: '200',
          content: { tag: 'participant', attrs: { jid: person } },
        },
    );
  }
  async updateProfileName(name: string): Promise<void> {
    this.profileName = name;
  }
  async updateProfileStatus(about: string): Promise<void> {
    this.profileAbout = about;
  }
  async logout(): Promise<void> {
    this.loggedOut = true;
    await this.emit('connection.update', {
      connection: 'close',
      lastDisconnect: {
        error: Object.assign(new Error('logged out'), { output: { statusCode: 401 } }),
        date: new Date(),
      },
    });
  }
  async end(_error: Error | undefined): Promise<void> {
    this.ended = true;
  }
}

export function incoming(id: string, text = 'Hello', fields: Partial<WAMessage> = {}): WAMessage {
  return {
    key: { id, remoteJid: 'team@g.us', participant: '12000@lid', participantAlt: '15551112222@s.whatsapp.net' },
    message: { conversation: text },
    messageTimestamp: 1792310400,
    pushName: 'Pat',
    ...fields,
  };
}
