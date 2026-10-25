/** Host modules' hooks into WhatsApp transport events; message observers run before ordinary routing. */
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
export interface WhatsAppLinkNotice {
  readonly id: string;
  readonly kind: 'needs-relink' | 'principal-number-changed';
  readonly text: string;
  readonly link: WhatsAppLink;
}
export interface WhatsAppObserver {
  readonly onLinkNotice?: (notice: WhatsAppLinkNotice) => Promise<boolean>;
  readonly onMembership?: (event: WhatsAppMembershipEvent) => Promise<void>;
  /** Return `consume` only once the effect is complete: a consumed message is marked routed and never replayed. */
  readonly onMessage?: (received: WhatsAppReceived) => Promise<'consume' | 'hold' | 'route'>;
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
export async function observeWhatsAppMessage(received: WhatsAppReceived): Promise<'consume' | 'hold' | 'route'> {
  for (const observer of observers) {
    const result = await observer.onMessage?.(received);
    if (result === 'consume' || result === 'hold') return result;
  }
  return 'route';
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

/** True when any observer accepted the notice, so the caller may mark it delivered. */
export async function observeWhatsAppLinkNotice(notice: WhatsAppLinkNotice): Promise<boolean> {
  let accepted = false;
  for (const observer of observers) if (observer.onLinkNotice && (await observer.onLinkNotice(notice))) accepted = true;
  return accepted;
}
