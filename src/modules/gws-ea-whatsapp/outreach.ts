/** Admitting the principal's request belongs to `chat_reach_out` (gws-ea-chats/outreach.ts), not these primitives. */
import { getBinaryNodeChild, jidNormalizedUser } from '@whiskeysockets/baileys';

import type { OutboundMessage } from '../../channels/adapter.js';
import { OutboundRefusedError } from '../../delivery.js';
import { checkOutbound, judgeSend, messageStrings } from '../gws-ea-privacy/outbound.js';
import type { WhatsAppSocket } from './adapter.js';
import { whatsappStatusCode, type WhatsAppContacts, type WhatsAppOutreachRequest } from './contacts.js';
import type { WhatsAppPerson } from './paths.js';
import { whatsappMessageId } from './outbound.js';

export interface WhatsAppGroupOutreach {
  readonly platformId: string;
  readonly participants: readonly {
    readonly person: WhatsAppPerson;
    readonly outcome: 'added' | 'invited' | 'refused' | 'unconfirmed';
    readonly reason?: string;
  }[];
}
export function createWhatsAppOutreach(options: {
  readonly socket: () => WhatsAppSocket;
  readonly contacts: WhatsAppContacts;
  readonly principal: () => WhatsAppPerson | undefined;
  readonly resolve: (jid: string) => Promise<WhatsAppPerson | undefined>;
  readonly deliver: (
    platformId: string,
    message: OutboundMessage,
    rowId: string,
    request: WhatsAppOutreachRequest,
  ) => Promise<string>;
  readonly now: () => number;
}) {
  function operation(request: WhatsAppOutreachRequest, action: string): string {
    if (!request.requestId.trim() || !request.principalMessageId.trim())
      throw new Error('WhatsApp outreach requires the admitted principal message');
    return `reach-out:${request.requestId}:${action}`;
  }
  function jid(person: WhatsAppPerson): string {
    if (!/^\d+$/u.test(person.lid)) throw new Error('WhatsApp outreach requires a resolved LID');
    return `${person.lid}@lid`;
  }
  async function assertPublicWire(content: unknown): Promise<void> {
    // These fields reach people not yet in the chat, so no clearance for the chat can authorize them.
    const check = await checkOutbound(messageStrings(JSON.stringify(content)), 'others');
    if (!check.allowed) throw new OutboundRefusedError('gws-ea-privacy:audience', check.reason);
  }
  async function addParticipant(
    platformId: string,
    person: WhatsAppPerson,
    request: WhatsAppOutreachRequest,
  ): Promise<'added' | 'invited'> {
    if (!platformId.endsWith('@g.us')) throw new Error('WhatsApp participant add requires a group');
    const recipient = jid(person);
    const id = operation(request, `add:${platformId}:${person.lid}`);
    const currentGroup = await options.socket().groupMetadata(platformId);
    await assertPublicWire({ subject: currentGroup.subject });
    await options.contacts.reserve([person.lid], id, request);
    const previous = options.contacts.beginOperation(id);
    if (previous === 'added' || previous === 'invited') return previous;
    if (previous !== undefined) throw new Error('Invalid saved WhatsApp add result');
    try {
      const results = await options.socket().groupParticipantsUpdate(platformId, [recipient], 'add');
      const result = results.find((value) => value.jid === recipient || value.jid === person.phoneJid);
      if (result?.status === '200') {
        options.contacts.finishOperation(id, 'added');
        return 'added';
      }
      if (result?.status === '463') {
        await options.contacts.refused(person.lid, id, request.principalMessageId);
        throw new OutboundRefusedError(
          'gws-ea-whatsapp:contact-refused',
          'WhatsApp refused first contact (463). Use email or tell the principal.',
        );
      }
      // The add response's add_request is scoped to this person. Never request or send groupInviteCode.
      const invite = result?.status === '403' ? getBinaryNodeChild(result.content, 'add_request') : undefined;
      const code = invite?.attrs.code;
      const expiration = Number(invite?.attrs.expiration);
      if (!code || !Number.isFinite(expiration) || expiration * 1000 <= options.now())
        throw new OutboundRefusedError(
          'gws-ea-whatsapp:add-refused',
          'WhatsApp did not add this person or offer a per-person invitation.',
        );
      const group = await options.socket().groupMetadata(platformId);
      const invitation = {
        groupInvite: {
          inviteCode: code,
          inviteExpiration: expiration,
          text: 'You are invited to join this group.',
          jid: platformId,
          subject: group.subject,
        },
      };
      await assertPublicWire(invitation);
      await options.contacts.reserve([person.lid], id, request);
      const messageId = whatsappMessageId(`${id}:invite`);
      options.contacts.handoff(messageId, person.lid, id, request);
      const sent = await options.socket().sendMessage(recipient, invitation, { messageId });
      if (sent?.key.id !== messageId) throw new Error('WhatsApp returned a different per-person invite message id');
      options.contacts.finishOperation(id, 'invited');
      return 'invited';
    } catch (error) {
      if (whatsappStatusCode(error) === 463) {
        await options.contacts.refused(person.lid, id, request.principalMessageId);
        throw new OutboundRefusedError(
          'gws-ea-whatsapp:contact-refused',
          'WhatsApp refused first contact (463). Use email or tell the principal.',
        );
      }
      if (error instanceof OutboundRefusedError && error.guardId !== 'gws-ea-whatsapp:add-refused') throw error;
      await options.contacts.stopped(
        id,
        error instanceof OutboundRefusedError ? 'add refused' : 'participant add unconfirmed',
        [person.lid],
      );
      throw error;
    }
  }
  return {
    async prepareReachOutDM(
      person: WhatsAppPerson,
      request: WhatsAppOutreachRequest,
    ): Promise<{ readonly platformId: string }> {
      const platformId = jid(person);
      await options.contacts.reserve([person.lid], operation(request, `dm:${person.lid}`), request);
      options.contacts.admitDM(person.lid, request);
      return { platformId };
    },
    async resolveNumber(number: string): Promise<WhatsAppPerson | undefined> {
      const phone = number.replace(/^\+/u, '');
      if (!/^\d{7,15}$/u.test(phone)) throw new Error('WhatsApp number must include the country code');
      const phoneJid = `${phone}@s.whatsapp.net`;
      const registered = await options.socket().onWhatsApp(phoneJid);
      if (!registered?.some(({ jid: registeredJid, exists }) => exists && registeredJid === phoneJid)) return undefined;
      return options.resolve(phoneJid);
    },
    async reachOutDM(
      person: WhatsAppPerson,
      message: OutboundMessage,
      request: WhatsAppOutreachRequest,
    ): Promise<{ readonly platformId: string; readonly messageId: string }> {
      const platformId = jid(person);
      const decision = await judgeSend({
        channelType: 'whatsapp',
        instance: 'whatsapp',
        platformId,
        threadId: null,
        kind: message.kind,
        content: JSON.stringify(message.content),
        files: message.files,
      });
      if (decision.effect === 'refuse') throw new OutboundRefusedError('gws-ea-privacy:audience', decision.reason);
      const messageId = await options.deliver(platformId, message, operation(request, `dm:${person.lid}`), request);
      return { platformId, messageId };
    },
    addParticipant,
    async createGroup(
      subject: string,
      people: readonly WhatsAppPerson[],
      request: WhatsAppOutreachRequest,
    ): Promise<WhatsAppGroupOutreach> {
      const principal = options.principal();
      if (!principal) throw new Error('WhatsApp principal is not linked');
      if (!subject.trim()) throw new Error('WhatsApp group needs a name');
      await assertPublicWire({ subject });
      const participants = [...new Map([principal, ...people].map((person) => [jid(person), person])).values()];
      const id = operation(request, 'create-group');
      await options.contacts.reserve(
        participants.map(({ lid }) => lid),
        id,
        request,
      );
      let platformId = options.contacts.beginOperation(id);
      if (platformId === undefined) {
        try {
          const group = await options.socket().groupCreate(subject, [jid(principal)]);
          platformId = group.id;
          options.contacts.finishOperation(id, platformId);
        } catch (error) {
          if (whatsappStatusCode(error) === 463) {
            await options.contacts.refused(principal.lid, id, request.principalMessageId);
            throw new OutboundRefusedError(
              'gws-ea-whatsapp:contact-refused',
              'WhatsApp refused group creation (463). Use email or tell the principal.',
            );
          }
          await options.contacts.stopped(
            id,
            'group creation unconfirmed',
            participants.map(({ lid }) => lid),
          );
          throw error;
        }
      }
      const outcomes: WhatsAppGroupOutreach['participants'][number][] = [];
      for (const person of participants) {
        /* eslint-disable no-catch-all/no-catch-all -- return the real created chat and every person's outcome, even when one add failed */
        try {
          // rc14 groupCreate strips participant error nodes. Fetch actual membership before claiming the principal joined.
          if (person.lid === principal.lid) {
            const metadata = await options.socket().groupMetadata(platformId);
            if (
              metadata.participants.some((member) =>
                [member.id, member.lid, member.phoneNumber].some(
                  (value) => value && [jid(principal), principal.phoneJid].includes(jidNormalizedUser(value)),
                ),
              )
            ) {
              outcomes.push({ person, outcome: 'added' });
              continue;
            }
          }
          outcomes.push({ person, outcome: await addParticipant(platformId, person, request) });
        } catch (error) {
          outcomes.push({
            person,
            outcome:
              error instanceof OutboundRefusedError && error.guardId !== 'gws-ea-whatsapp:outreach-unconfirmed'
                ? 'refused'
                : 'unconfirmed',
            reason: error instanceof Error ? error.message : String(error),
          });
        }
        /* eslint-enable no-catch-all/no-catch-all */
      }
      return { platformId, participants: outcomes };
    },
  };
}
