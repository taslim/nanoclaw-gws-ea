/** Always compiled; a durable link record, including needs-relink, enables the adapter. */
import fs from 'node:fs';
import path from 'node:path';

import { getChannelAdapterExact, registerChannelAdapter } from '../../channels/channel-registry.js';
import { registerPostDeliveryHook } from '../../delivery.js';
import { createWhatsAppAdapter, WHATSAPP_DEFAULTS, type WhatsAppAdapter } from './adapter.js';
import { readWhatsAppLink, whatsappDirectory } from './paths.js';
import { whatsAppLinking } from './link.js';

/** The real active transport, for the link owner; absent before channel startup or without a link. */
export function activeWhatsAppAdapter(): WhatsAppAdapter | undefined {
  return getChannelAdapterExact('whatsapp') as WhatsAppAdapter | undefined;
}
registerChannelAdapter('whatsapp', {
  defaults: WHATSAPP_DEFAULTS,
  factory: () => {
    const directory = whatsappDirectory();
    if (!directory || !fs.existsSync(path.join(directory, 'link.json'))) return null;
    return readWhatsAppLink(directory).then(async (record) => {
      if (!record) throw new Error('WhatsApp link disappeared during channel startup');
      if (record.number) await whatsAppLinking().reconcile();
      if (!(await readWhatsAppLink(directory))) throw new Error('WhatsApp pairing expired before channel startup');
      return createWhatsAppAdapter({ directory });
    });
  },
});
registerPostDeliveryHook((message) => {
  if (message.channelType === 'whatsapp') activeWhatsAppAdapter()?.completeDelivery(message.id);
});

export {
  createWhatsAppAdapter,
  WHATSAPP_DEFAULTS,
  resolveWaWebVersion,
  type WhatsAppAdapter,
  type WhatsAppAdapterOptions,
  type WhatsAppSocket,
} from './adapter.js';
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
