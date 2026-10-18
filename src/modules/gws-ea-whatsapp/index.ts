/** Always compiled; a durable link record, including needs-relink, enables the adapter. */
import fs from 'node:fs';
import path from 'node:path';

import { registerChannelAdapter } from '../../channels/channel-registry.js';
import { registerPostDeliveryHook } from '../../delivery.js';
import { createWhatsAppAdapter, WHATSAPP_DEFAULTS, type WhatsAppAdapter } from './adapter.js';
import { readWhatsAppLink, whatsappDirectory } from './paths.js';

let active: WhatsAppAdapter | undefined;
/** The real active transport, for the link owner; absent before channel startup or without a link. */
export function activeWhatsAppAdapter(): WhatsAppAdapter | undefined {
  return active;
}
registerChannelAdapter('whatsapp', {
  defaults: WHATSAPP_DEFAULTS,
  factory: () => {
    const directory = whatsappDirectory();
    if (!directory || !fs.existsSync(path.join(directory, 'link.json'))) return null;
    return readWhatsAppLink(directory).then((record) => {
      if (!record) throw new Error('WhatsApp link disappeared during channel startup');
      active = createWhatsAppAdapter({ directory });
      return active;
    });
  },
});
registerPostDeliveryHook((message) => {
  if (message.channelType === 'whatsapp') active?.completeDelivery(message.id);
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
  type WhatsAppReceived,
  type WhatsAppGroupEvent,
} from './observers.js';
export type { WhatsAppContent } from './inbound.js';

export type { WhatsAppOutreachRequest } from './contacts.js';
export type { WhatsAppGroup, WhatsAppGroupMember, WhatsAppMembershipEvent } from './events.js';
export type { WhatsAppGroupOutreach } from './outreach.js';
