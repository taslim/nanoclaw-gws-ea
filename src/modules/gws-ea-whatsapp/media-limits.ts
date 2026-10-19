export const MAX_WHATSAPP_MEDIA_BYTES = 25 * 1024 * 1024;
export const WHATSAPP_MEDIA_DOWNLOAD_TIMEOUT_MS = 30_000;

export class WhatsAppMediaTooLargeError extends Error {
  constructor() {
    super('WhatsApp attachment exceeds 25 MB');
  }
}
