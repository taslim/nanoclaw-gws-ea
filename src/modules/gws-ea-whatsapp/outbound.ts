import { createHash, randomUUID } from 'node:crypto';

import type { AnyMessageContent } from '@whiskeysockets/baileys';

import { ChannelNotConnectedError, type OutboundMessage } from '../../channels/adapter.js';
import { approveRejectRequest, normalizeOptions, type RawOption } from '../../channels/ask-question.js';
import { indexPostedRequest } from '../../channels/answers.js';
import { OutboundRefusedError } from '../../delivery.js';
import { isRecord } from '../../gws-ea/validation.js';
import { whatsappStatusCode, type WhatsAppContacts, type WhatsAppOutreachRequest } from './contacts.js';
import type { WhatsAppPerson } from './paths.js';
import type { SqliteStateAdapter } from '../../state-sqlite.js';
import type { WhatsAppSocket } from './adapter.js';
import { formatWhatsApp } from './format.js';
import type { WhatsAppIndex } from './index-store.js';

const HELD_SEND_LIMIT_MS = 4 * 60 * 60 * 1000;
/** Baileys rc14 messages-send.js spreads caller options after generateMessageIDV2 and relays fullMsg.key.id. */
export function whatsappMessageId(rowId: string, part = 0): string {
  return `3EB0${createHash('sha256').update(rowId).update(`:${part}`).digest('hex').slice(0, 28).toUpperCase()}`;
}

function rawOptions(value: unknown): RawOption[] {
  if (!Array.isArray(value)) throw new Error('WhatsApp request has no options');
  return value.map((item: unknown): RawOption => {
    if (typeof item === 'string') return item;
    if (!isRecord(item) || typeof item.label !== 'string') throw new Error('WhatsApp request has an invalid option');
    return {
      label: item.label,
      ...(typeof item.value === 'string' ? { value: item.value } : {}),
      ...(typeof item.selectedLabel === 'string' ? { selectedLabel: item.selectedLabel } : {}),
    };
  });
}

function words(content: Record<string, unknown>): string {
  if (content.type === 'ask_question') {
    if (typeof content.title !== 'string' || typeof content.questionId !== 'string')
      throw new Error('WhatsApp request has no title or question id');
    if (content.requirePresentation === true)
      throw new Error('WhatsApp cannot present a request requiring a custom card');
    const options = normalizeOptions(rawOptions(content.options));
    const approval = approveRejectRequest(options);
    const how = approval
      ? 'Quote this message with yes or no, or react 👍 or 👎.' +
        (approval.takesReason ? ' To say why, quote it with no and your reason.' : '')
      : options.map((option, i) => `${i + 1}. ${option.label}`).join('\n') +
        '\n\nQuote this message with the number or name of your choice.';
    return [`**${content.title}**`, typeof content.question === 'string' ? content.question : '', how]
      .filter(Boolean)
      .join('\n\n');
  }
  const text =
    typeof content.markdown === 'string' ? content.markdown : typeof content.text === 'string' ? content.text : '';
  if (text) return text;
  if (isRecord(content.terminalCard) && typeof content.terminalCard.resolution === 'string')
    return content.terminalCard.resolution;
  return '';
}

export interface WhatsAppOutboundOptions {
  readonly index: WhatsAppIndex;
  readonly contacts: WhatsAppContacts;
  readonly resolvePerson: (jid: string) => Promise<WhatsAppPerson | undefined>;
  readonly directSendAllowed: (person: WhatsAppPerson) => Promise<boolean>;
  readonly state: SqliteStateAdapter;
  readonly socket: () => WhatsAppSocket | undefined;
  readonly connected: () => boolean;
  readonly sender: () => string;
  readonly now: () => number;
}

export function createWhatsAppOutbound(options: WhatsAppOutboundOptions) {
  const inflight = new Map<string, Promise<string>>();
  async function deliver(
    platformId: string,
    message: OutboundMessage,
    rowId?: string,
    request?: WhatsAppOutreachRequest,
  ): Promise<string> {
    if (!isRecord(message.content)) throw new Error('WhatsApp outbound content must be an object');
    const content = message.content;
    const key = rowId ?? `host-${randomUUID()}`;
    let admittedRequest = request;
    const messageId = whatsappMessageId(key);
    const originalTime = message.timestamp === undefined ? options.now() : Date.parse(message.timestamp);
    if (!Number.isFinite(originalTime)) throw new Error('WhatsApp outbound row has an invalid original timestamp');
    const pending = options.index.prepare(key, platformId, messageId, originalTime);
    if (!pending.accepted && options.now() - pending.createdAt > HELD_SEND_LIMIT_MS) {
      options.index.complete(key);
      throw new OutboundRefusedError(
        'gws-ea-whatsapp:stale',
        'WhatsApp was unavailable for more than four hours. Please check whether the message is still wanted.',
      );
    }
    const canonicalLid = /^(\d+)@lid$/u.exec(platformId)?.[1];
    if (canonicalLid && !pending.accepted)
      admittedRequest ??= options.contacts.claimDM(canonicalLid, key, pending.createdAt);
    const socket = options.socket();
    if (!socket || !options.connected()) throw new ChannelNotConnectedError();
    const text = words(content);
    const formatted = formatWhatsApp(text);
    const parts: AnyMessageContent[] = [];
    if (content.operation === 'reaction') {
      if (typeof content.messageId !== 'string' || typeof content.emoji !== 'string')
        throw new Error('WhatsApp reaction has no message id or emoji');
      const target = options.index.message(platformId, content.messageId);
      const participant = target?.participant;
      if (platformId.endsWith('@g.us') && target?.fromMe !== true && participant === undefined)
        throw new Error('WhatsApp cannot react to a group message whose sender it does not have');
      parts.push({
        react: {
          text: content.emoji,
          key: {
            remoteJid: platformId,
            id: content.messageId,
            fromMe: target?.fromMe ?? false,
            ...(participant === undefined ? {} : { participant }),
          },
        },
      });
    } else if (content.operation === 'edit') {
      const target =
        typeof content.questionId === 'string'
          ? options.index.requestMessage(content.questionId, platformId)
          : typeof content.messageId === 'string'
            ? content.messageId
            : undefined;
      if (!target || !options.index.message(platformId, target)?.fromMe)
        throw new Error('WhatsApp cannot edit a message it did not send in this chat');
      if (typeof content.questionId !== 'string' && options.index.request(target))
        throw new Error('An open WhatsApp request may only be edited by its outcome handler');
      parts.push({
        text: formatted.text,
        mentions: formatted.mentions,
        edit: { remoteJid: platformId, id: target, fromMe: true },
      });
    } else {
      for (const [i, file] of (message.files ?? []).entries()) {
        const mime = file.mimeType ?? 'application/octet-stream';
        const caption = i === 0 ? formatted.text : undefined;
        if (mime.startsWith('image/'))
          parts.push({ image: file.data, mimetype: mime, caption, mentions: formatted.mentions });
        else if (mime.startsWith('video/'))
          parts.push({ video: file.data, mimetype: mime, caption, mentions: formatted.mentions });
        else if (mime.startsWith('audio/')) parts.push({ audio: file.data, mimetype: mime });
        else
          parts.push({
            document: file.data,
            fileName: file.filename,
            mimetype: mime,
            caption,
            mentions: formatted.mentions,
          });
      }
      if (!parts.length || (message.files?.[0]?.mimeType?.startsWith('audio/') && formatted.text))
        parts.push({ text: formatted.text, mentions: formatted.mentions });
    }
    if (!parts.length || (!formatted.text && !message.files?.length && content.operation !== 'reaction'))
      throw new Error('WhatsApp outbound message has no content');
    let firstId = pending.messageId;
    if (!pending.accepted) {
      for (const [i, part] of parts.entries()) {
        const id = whatsappMessageId(key, i);
        if (i === 0) firstId = id;
        if (options.index.message(platformId, id)?.fromMe) continue;
        const person = !platformId.endsWith('@g.us') ? await options.resolvePerson(platformId) : undefined;
        if (!platformId.endsWith('@g.us') && !person)
          throw new Error('WhatsApp first contact requires a resolved recipient');
        if (person) {
          if (!(await options.directSendAllowed(person)))
            throw new OutboundRefusedError(
              'gws-ea-whatsapp:principal-unbound',
              'The principal must send the binding code from their own WhatsApp before the assistant can write to them.',
            );
          admittedRequest ??= options.contacts.claimDM(person.lid, key, pending.createdAt);
          await options.contacts.reserve([person.lid], key, admittedRequest);
          options.contacts.handoff(id, person.lid, key, admittedRequest);
        }
        try {
          const sent = await socket.sendMessage(platformId, part, { messageId: id });
          if (sent?.key.id !== id)
            throw new Error('WhatsApp returned a different message id from the caller-provided id');
          options.index.sent(
            {
              chat: platformId,
              id,
              sender: options.sender(),
              fromMe: true,
              forwarded: false,
              text: formatted.text,
              at: options.now(),
            },
            sent.message,
          );
          if ('edit' in part && part.edit?.id) options.index.edit(platformId, part.edit.id, formatted.text);
        } catch (error) {
          const status = whatsappStatusCode(error);
          if (status === 463 && person) {
            await options.contacts.refused(person.lid, key, admittedRequest?.principalMessageId ?? null);
            options.index.complete(key);
            throw new OutboundRefusedError(
              'gws-ea-whatsapp:contact-refused',
              'WhatsApp refused first contact (463). Use email or tell the principal.',
            );
          }
          if (status === 400 || status === 403 || status === 404) {
            options.index.complete(key);
            throw new OutboundRefusedError('gws-ea-whatsapp:refused', `WhatsApp refused the message (${status}).`);
          }
          throw error;
        }
      }
    }
    if (content.type === 'ask_question' && typeof content.questionId === 'string') {
      const postedAt = new Date(pending.createdAt).toISOString();
      options.index.rememberRequest(firstId, platformId, content.questionId, postedAt);
      const recorded = `whatsapp-request-indexed:${firstId}`;
      if (!(await options.state.get(recorded))) {
        await indexPostedRequest(options.state, 'whatsapp', platformId, firstId, postedAt);
        await options.state.set(recorded, true);
      }
    }
    options.index.accepted(key);
    if (rowId === undefined) options.index.complete(key);
    return firstId;
  }
  return {
    deliver(
      platformId: string,
      message: OutboundMessage,
      rowId?: string,
      request?: WhatsAppOutreachRequest,
    ): Promise<string> {
      if (rowId === undefined) return deliver(platformId, message, undefined, request);
      const running = inflight.get(rowId);
      if (running) return running;
      const run = deliver(platformId, message, rowId, request);
      inflight.set(rowId, run);
      void run
        .finally(() => {
          inflight.delete(rowId);
        })
        .catch(() => undefined);
      return run;
    },
    complete: (rowId: string) => options.index.complete(rowId),
  };
}
