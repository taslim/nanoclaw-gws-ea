/** Baileys' event and network boundary; no routing, identity or delivery logic lives here. */
import type {
  AnyMessageContent,
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
  lookupGate?: Promise<void>;
  readonly user = { id: '15550000000:1@s.whatsapp.net', lid: '999000:1@lid', name: 'Assistant' };
  sendError?: Error;
  ended = false;
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
  async groupFetchAllParticipating(): Promise<Record<string, never>> {
    return {};
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
