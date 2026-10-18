/** Native transport facts used by the link and chat owners, before ordinary routing. */
import type { BaileysEventMap, WAMessage } from '@whiskeysockets/baileys';

import type { InboundMessage } from '../../channels/adapter.js';
import type { WhatsAppContent } from './inbound.js';
import type { WhatsAppMembershipEvent } from './events.js';
import type { WhatsAppLink, WhatsAppPerson } from './paths.js';

export interface WhatsAppReceived {
  readonly raw: WAMessage;
  readonly platformId: string;
  readonly isGroup: boolean;
  readonly person?: WhatsAppPerson;
  readonly content: WhatsAppContent;
  readonly inbound: InboundMessage;
}
export type WhatsAppGroupEvent =
  | { readonly type: 'groups.upsert'; readonly value: BaileysEventMap['groups.upsert'] }
  | { readonly type: 'groups.update'; readonly value: BaileysEventMap['groups.update'] }
  | { readonly type: 'group-participants.update'; readonly value: BaileysEventMap['group-participants.update'] };
export interface WhatsAppObserver {
  readonly onMembership?: (event: WhatsAppMembershipEvent) => Promise<void>;
  /** A binding message may be consumed; only a completed effect may return consume. */
  readonly onMessage?: (received: WhatsAppReceived) => Promise<'consume' | 'route'>;
  readonly onConnectionUpdate?: (event: {
    readonly update: BaileysEventMap['connection.update'];
    readonly link: WhatsAppLink | undefined;
  }) => Promise<void>;
  readonly onGroupEvent?: (event: WhatsAppGroupEvent) => Promise<void>;
}
const observers = new Set<WhatsAppObserver>();
export function registerWhatsAppObserver(observer: WhatsAppObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
export async function observeWhatsAppMessage(received: WhatsAppReceived): Promise<boolean> {
  for (const observer of observers) if ((await observer.onMessage?.(received)) === 'consume') return true;
  return false;
}
export async function observeWhatsAppGroup(event: WhatsAppGroupEvent): Promise<void> {
  for (const observer of observers) await observer.onGroupEvent?.(event);
}

export async function observeWhatsAppConnection(
  update: BaileysEventMap['connection.update'],
  link: WhatsAppLink | undefined,
): Promise<void> {
  for (const observer of observers) await observer.onConnectionUpdate?.({ update, link });
}

export async function observeWhatsAppMembership(event: WhatsAppMembershipEvent): Promise<void> {
  for (const observer of observers) await observer.onMembership?.(event);
}
