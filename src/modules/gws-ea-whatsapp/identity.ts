import { jidNormalizedUser } from '@whiskeysockets/baileys';

import type { WhatsAppSocket } from './adapter.js';
import type { WhatsAppIndex } from './index-store.js';
import type { WhatsAppPerson } from './paths.js';

export function normalizedJid(jid: string): string {
  return jidNormalizedUser(jid);
}
const isLid = (jid: string): boolean => /^\d+@lid$/u.test(jid);
const isPhone = (jid: string): boolean => /^\d+@s\.whatsapp\.net$/u.test(jid);

/** Baileys' getLIDForPN consults its Signal mapping, then LID-protocol USync (rc14 socket.js). */
export async function resolvePerson(
  socket: WhatsAppSocket,
  index: WhatsAppIndex,
  raw: string,
  alternate?: string | null,
): Promise<WhatsAppPerson | undefined> {
  const jid = normalizedJid(raw);
  const alt = alternate ? normalizedJid(alternate) : undefined;
  let lid = isLid(jid) ? jid : alt && isLid(alt) ? alt : undefined;
  let phone = isPhone(jid) ? jid : alt && isPhone(alt) ? alt : undefined;
  if (!lid && phone)
    lid = index.lid(phone) ?? (await socket.signalRepository.lidMapping.getLIDForPN(phone)) ?? undefined;
  if (!lid || !isLid(lid)) return undefined;
  phone ??= index.phone(lid) ?? (await socket.signalRepository.lidMapping.getPNForLID(lid)) ?? undefined;
  if (phone && isPhone(phone)) {
    index.alias(lid, phone);
    await socket.signalRepository.lidMapping.storeLIDPNMappings([{ lid, pn: phone }]);
  } else phone = undefined;
  return { lid: lid.slice(0, -4), ...(phone ? { phoneJid: phone } : {}) };
}
