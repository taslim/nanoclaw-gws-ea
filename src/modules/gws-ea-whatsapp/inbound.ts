import { normalizeMessageContent, type WAMessage } from '@whiskeysockets/baileys';

import type { ChannelSetup, InboundMessage } from '../../channels/adapter.js';
import type { Answers } from '../../channels/answers.js';
import { log } from '../../log.js';
import type { WhatsAppSocket } from './adapter.js';
import { normalizedJid, resolvePerson } from './identity.js';
import type { WhatsAppIndex } from './index-store.js';
import { chatMediaEligible, inboundMedia, isForwarded, messageContext, type WhatsAppAttachment } from './media.js';
import { observeWhatsAppMessage } from './observers.js';
import type { WhatsAppPerson } from './paths.js';

export interface WhatsAppContent {
  readonly text: string;
  readonly sender: string;
  readonly senderId: string;
  readonly senderName: string;
  readonly chatJid: string;
  readonly isGroup: boolean;
  readonly fromMe: boolean;
  readonly forwarded: boolean;
  readonly attachments?: readonly WhatsAppAttachment[];
  readonly replyTo?: { readonly id: string; readonly text?: string; readonly sender?: string };
  readonly reaction?: {
    readonly emoji: string;
    readonly target: { readonly self: boolean; readonly sender: string; readonly excerpt: string };
  };
}

export interface WhatsAppInboundOptions {
  readonly socket: () => WhatsAppSocket;
  readonly index: WhatsAppIndex;
  readonly setup: ChannelSetup;
  readonly answers: Answers;
  readonly download: (raw: WAMessage) => Promise<Buffer>;
  readonly now: () => number;
  readonly onDirectMessage: (person: WhatsAppPerson, at: number) => void;
}

/** One serial durable inbox: a duplicate concurrent event cannot pass a still-running route. */
export function createWhatsAppInbound(options: WhatsAppInboundOptions) {
  let tail = Promise.resolve();
  async function route(raw: WAMessage): Promise<void> {
    const rawChat = raw.key.remoteJid;
    const id = raw.key.id;
    if (!id || !rawChat || rawChat === 'status@broadcast' || rawChat.endsWith('@broadcast') || raw.key.fromMe) return;
    const message = normalizeMessageContent(raw.message);
    if (!message) {
      options.index.finishIntake(rawChat, id);
      return;
    }
    const isGroup = rawChat.endsWith('@g.us');
    const socket = options.socket();
    const rawSender = raw.key.participant || rawChat;
    const alternate = isGroup ? raw.key.participantAlt : raw.key.remoteJidAlt;
    let person;
    /* eslint-disable no-catch-all/no-catch-all -- an unresolvable group sender is retained without identity authority */
    try {
      person = await resolvePerson(socket, options.index, rawSender, alternate);
    } catch (error) {
      log.warn('WhatsApp sender could not be resolved', { sender: rawSender, err: error });
    }
    /* eslint-enable no-catch-all/no-catch-all */
    if (!person) {
      log.warn('WhatsApp sender has no resolved LID', { sender: rawSender, isGroup });
      if (!isGroup) {
        options.index.finishIntake(rawChat, id);
        return;
      }
    }
    const platformId = isGroup ? rawChat : `${person?.lid}@lid`;
    if (options.index.message(platformId, id)?.routed) {
      options.index.finishIntake(rawChat, id);
      return;
    }
    const sender = person ? `whatsapp:${person.lid}` : `whatsapp:${normalizedJid(rawSender)}`;
    const context = messageContext(message);
    const forwarded = isForwarded(context);
    let text =
      message.conversation ??
      message.extendedTextMessage?.text ??
      message.imageMessage?.caption ??
      message.videoMessage?.caption ??
      message.documentMessage?.caption ??
      '';
    const at = Number(raw.messageTimestamp ?? 0) * 1000 || options.now();
    const senderName = raw.pushName || options.index.name(normalizedJid(rawSender)) || person?.lid || rawSender;
    if (raw.pushName) {
      options.index.rememberName(normalizedJid(rawSender), raw.pushName);
      if (person) options.index.rememberName(`${person.lid}@lid`, raw.pushName);
    }
    // Save before media/host routing: WhatsApp has already acknowledged this message.
    options.index.receive({ chat: platformId, id, sender, fromMe: false, forwarded, text, at, routed: false }, raw);
    if (!isGroup && person) options.onDirectMessage(person, at);
    for (const mention of context?.mentionedJid ?? []) {
      const jid = normalizedJid(mention);
      const name = options.index.name(jid);
      if (name) text = text.replaceAll(`@${jid.split('@')[0]}`, `@${name}`);
    }
    const quotedId = context?.stanzaId || undefined;
    const quoted = quotedId ? options.index.message(platformId, quotedId) : undefined;
    const reaction = message.reactionMessage;
    const target = reaction?.key?.id ? options.index.message(platformId, reaction.key.id) : undefined;
    const attachments = await inboundMedia(raw, message, await chatMediaEligible(platformId), options.download);
    const content: WhatsAppContent = {
      text: reaction ? '' : text,
      sender: senderName,
      senderId: sender,
      senderName,
      chatJid: platformId,
      isGroup,
      fromMe: false,
      forwarded,
      ...(attachments.length ? { attachments } : {}),
      ...(quotedId
        ? { replyTo: { id: quotedId, ...(quoted ? { text: quoted.text, sender: quoted.sender } : {}) } }
        : {}),
      ...(reaction?.key?.id
        ? {
            reaction: {
              emoji: reaction.text ?? '',
              target: {
                self: target?.fromMe === true,
                sender: target?.sender ?? 'unknown',
                excerpt: target?.text.slice(0, 280) ?? '',
              },
            },
          }
        : {}),
    };
    const self = [socket.user?.id, socket.user?.lid]
      .filter((jid): jid is string => typeof jid === 'string')
      .map(normalizedJid);
    const mentioned = (context?.mentionedJid ?? []).some((jid) => self.includes(normalizedJid(jid)));
    const inbound: InboundMessage = {
      id,
      kind: 'chat',
      content,
      timestamp: new Date(at).toISOString(),
      isGroup,
      deduplicate: true,
      isMention: person !== undefined && (!isGroup || mentioned || quoted?.fromMe === true || target?.fromMe === true),
      ...(person ? { authenticatedSender: { userId: sender, displayName: senderName, kind: 'human' } } : {}),
      ...(reaction ? { reaction: true, quiet: target?.fromMe !== true } : {}),
    };
    const received = { raw, platformId, isGroup, person, content, inbound };
    if (await observeWhatsAppMessage(received)) {
      options.index.routed(platformId, id, rawChat);
      return;
    }
    const answered =
      person &&
      !forwarded &&
      (reaction?.key?.id
        ? await options.answers.takeReaction({
            id,
            platformId,
            userId: sender,
            isMe: false,
            emoji: reaction.text ?? '',
            messageId: reaction.key.id,
          })
        : await options.answers.takeMessage({
            id,
            platformId,
            userId: sender,
            isMe: false,
            isDM: !isGroup,
            at: new Date(at),
            text,
            ...(quotedId ? { quote: { messageId: quotedId } } : {}),
          }));
    if (!answered && (text || attachments.length || reaction)) {
      options.setup.onMetadata(platformId, undefined, isGroup);
      await options.setup.onInbound(platformId, null, inbound);
    }
    options.index.routed(platformId, id, rawChat);
  }
  const enqueue = (messages: readonly WAMessage[]): Promise<void> => {
    for (const message of messages) options.index.intake(message);
    options.index.prune(options.now());
    const run = tail.then(async () => {
      for (const message of messages) {
        /* eslint-disable no-catch-all/no-catch-all -- leave every failed route durably queued for replay */
        try {
          await route(message);
        } catch (error) {
          log.error('WhatsApp message remains unrouted for replay', { messageId: message.key.id, err: error });
        }
        /* eslint-enable no-catch-all/no-catch-all */
      }
    });
    tail = run;
    return run;
  };
  return { receive: enqueue, replay: () => enqueue(options.index.unrouted()), settled: () => tail };
}
