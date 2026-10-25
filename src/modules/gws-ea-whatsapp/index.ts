/** Always compiled; a durable link record, including needs-relink, enables the adapter. */
import fs from 'node:fs';

import { getChannelAdapterExact, registerChannelAdapter } from '../../channels/channel-registry.js';
import { registerPostDeliveryHook } from '../../delivery.js';
import type { WhatsAppAdapter } from './adapter.js';
import { WHATSAPP_DEFAULTS } from './defaults.js';
import { readWhatsAppLink, whatsappDirectory } from './paths.js';
import { whatsAppLinking } from './link.js';

/** Undefined before channel startup or without a link record. */
export function activeWhatsAppAdapter(): WhatsAppAdapter | undefined {
  return getChannelAdapterExact('whatsapp') as WhatsAppAdapter | undefined;
}
registerChannelAdapter('whatsapp', {
  defaults: WHATSAPP_DEFAULTS,
  factory: async () => {
    const directory = whatsappDirectory();
    if (!directory || !fs.existsSync(directory)) return null;
    await whatsAppLinking().reconcile();
    if (!(await readWhatsAppLink(directory))) return null;
    const { createWhatsAppAdapter } = await import('./adapter.js');
    return createWhatsAppAdapter({ directory });
  },
});
registerPostDeliveryHook((message) => {
  if (message.channelType === 'whatsapp') activeWhatsAppAdapter()?.completeDelivery(message.id);
});

export { WHATSAPP_DEFAULTS } from './defaults.js';
export type { WhatsAppAdapter, WhatsAppAdapterOptions, WhatsAppSocket } from './adapter.js';
export {
  readWhatsAppLink,
  writeWhatsAppLink,
  whatsappDirectory,
  WHATSAPP_DIRECTORY_ENV,
  type WhatsAppLink,
  type WhatsAppPerson,
} from './paths.js';
export {
  registerWhatsAppObserver,
  type WhatsAppObserver,
  type WhatsAppLinkNotice,
  type WhatsAppReceived,
  type WhatsAppGroupEvent,
} from './observers.js';
export type { WhatsAppContent } from './inbound.js';

export type { WhatsAppOutreachRequest } from './contacts.js';
export type { WhatsAppGroup, WhatsAppGroupMember, WhatsAppMembershipEvent } from './events.js';
export type { WhatsAppGroupOutreach } from './outreach.js';

export { linkWhatsApp, whatsAppLinking, type WhatsAppLinkCaller, type WhatsAppLinkStatus } from './link.js';
