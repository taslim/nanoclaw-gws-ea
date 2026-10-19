import type { proto, WAMessage } from '@whiskeysockets/baileys';

import { extForMime } from '../../attachment-naming.js';
import type { AudioSource, SpeechResult } from '../../channels/inbound-content.js';
import { getDb } from '../../db/index.js';
import { log } from '../../log.js';

import { MAX_WHATSAPP_MEDIA_BYTES, WhatsAppMediaTooLargeError } from './media-limits.js';

export { MAX_WHATSAPP_MEDIA_BYTES } from './media-limits.js';
export interface WhatsAppAttachment {
  readonly type: 'image' | 'audio' | 'video' | 'file';
  readonly name: string;
  readonly mimeType: string;
  readonly size?: number;
  readonly data?: string;
  readonly audioSource?: AudioSource;
  readonly speech?: SpeechResult;
  readonly downloadError?: 'too-large' | 'size-unknown' | 'chat-declined' | 'media-download-failed';
}

/** An unknown chat is eligible: its first voice note must reach voice preparation. */
export async function chatMediaEligible(platformId: string): Promise<boolean> {
  const db = getDb();
  if (!(await db.hasTable('gws_ea_chats'))) return true;
  const chat = await db.get<{ state: string }>(
    `SELECT c.state FROM gws_ea_chats c JOIN messaging_groups m ON m.id=c.messaging_group_id WHERE m.channel_type='whatsapp' AND m.platform_id=?`,
    platformId,
  );
  return chat?.state !== 'declined' && chat?.state !== 'detached';
}

export function messageContext(message: proto.IMessage): proto.IContextInfo | undefined {
  return (
    message.extendedTextMessage?.contextInfo ??
    message.imageMessage?.contextInfo ??
    message.audioMessage?.contextInfo ??
    message.videoMessage?.contextInfo ??
    message.documentMessage?.contextInfo ??
    message.stickerMessage?.contextInfo ??
    undefined
  );
}

export function isForwarded(context: proto.IContextInfo | undefined): boolean {
  return context?.isForwarded === true || Number(context?.forwardingScore ?? 0) > 0;
}

export async function inboundMedia(
  raw: WAMessage,
  message: proto.IMessage,
  eligible: boolean,
  download: (raw: WAMessage) => Promise<Buffer>,
): Promise<WhatsAppAttachment[]> {
  const source =
    message.imageMessage ??
    message.audioMessage ??
    message.videoMessage ??
    message.documentMessage ??
    message.stickerMessage;
  if (!source) return [];
  const type: WhatsAppAttachment['type'] =
    message.imageMessage || message.stickerMessage
      ? 'image'
      : message.audioMessage
        ? 'audio'
        : message.videoMessage
          ? 'video'
          : 'file';
  const mimeType = source.mimetype ?? (type === 'audio' ? 'audio/ogg' : 'application/octet-stream');
  const filename = message.documentMessage?.fileName;
  const name = filename || `${type}.${extForMime(mimeType) || 'bin'}`;
  const size = source.fileLength == null ? undefined : Number(source.fileLength);
  const audioSource: AudioSource | undefined =
    type === 'audio'
      ? {
          kind: message.audioMessage?.ptt ? 'voice-note' : 'audio',
          forwarded: isForwarded(source.contextInfo ?? undefined),
        }
      : undefined;
  const base = {
    type,
    name,
    mimeType,
    ...(Number.isFinite(size) ? { size } : {}),
    ...(audioSource ? { audioSource } : {}),
  };
  function failed(reason: NonNullable<WhatsAppAttachment['downloadError']>): WhatsAppAttachment[] {
    return [
      {
        ...base,
        downloadError: reason,
        ...(type === 'audio' ? { speech: { status: 'failed', reason } as const } : {}),
      },
    ];
  }
  const refused = !eligible
    ? 'chat-declined'
    : size === undefined || !Number.isSafeInteger(size) || size < 0
      ? 'size-unknown'
      : size > MAX_WHATSAPP_MEDIA_BYTES
        ? 'too-large'
        : undefined;
  if (refused) return failed(refused);
  /* eslint-disable no-catch-all/no-catch-all -- media failure is an attachment outcome, never a lost message */
  try {
    const bytes = await download(raw);
    if (bytes.length > MAX_WHATSAPP_MEDIA_BYTES) return failed('too-large');
    return [{ ...base, data: bytes.toString('base64') }];
  } catch (error) {
    if (
      error instanceof WhatsAppMediaTooLargeError ||
      (error instanceof Error && error.cause instanceof WhatsAppMediaTooLargeError)
    )
      return failed('too-large');
    log.warn('Could not download WhatsApp attachment', { messageId: raw.key.id, err: error });
    return failed('media-download-failed');
  }
}

/* eslint-enable no-catch-all/no-catch-all */
