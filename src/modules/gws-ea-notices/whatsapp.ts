/** WhatsApp trouble is durably owed to the principal on Google Chat, regardless of the current DM. */
import { createHash } from 'node:crypto';

import { getDeliveryAdapter } from '../../delivery.js';
import { onHostStart } from '../../host-lifecycle.js';
import { log } from '../../log.js';
import { principalContact } from '../gws-ea-profile/db.js';
import { registerWhatsAppObserver, type WhatsAppLinkNotice } from '../gws-ea-whatsapp/observers.js';
import { whatsappDirectory } from '../gws-ea-whatsapp/paths.js';
import { WhatsAppNoticeStore } from './whatsapp-store.js';

function inStore<T>(directory: string, operation: (store: WhatsAppNoticeStore) => T): T {
  const store = new WhatsAppNoticeStore(directory);
  try {
    return operation(store);
  } finally {
    store.close();
  }
}

const WORDS: Readonly<Record<WhatsAppLinkNotice['kind'], string>> = {
  'needs-relink':
    'My WhatsApp connection has disconnected. Reply here when you’re ready and I’ll help you link it again.',
  'principal-number-changed':
    'Your WhatsApp number has changed, so I can’t use that conversation. Reply here and I’ll help you connect the new number.',
};

let delivering: Promise<void> | undefined;

function deliverPending(): Promise<void> {
  delivering ??= (async () => {
    const directory = whatsappDirectory();
    if (!directory) return;
    const adapter = getDeliveryAdapter();
    if (!adapter) return;
    const contact = await principalContact('gchat');
    if (!contact || contact.directMessage.detached_at) return;
    const dm = contact.directMessage;
    const pending = inStore(directory, (store) => store.pending());
    for (const notice of pending) {
      /* eslint-disable no-catch-all/no-catch-all -- this durable notice stays owed until the channel accepts it */
      try {
        await adapter.deliver(
          dm.channel_type,
          dm.platform_id,
          null,
          'chat',
          JSON.stringify({ text: WORDS[notice.kind] }),
          undefined,
          dm.instance,
          notice.notice_id,
          notice.created_at,
        );
        inStore(directory, (store) => {
          store.delivered(notice.notice_id);
        });
      } catch (error) {
        log.warn('WhatsApp notice remains pending on Google Chat', { id: notice.notice_id, err: error });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  })().finally(() => {
    delivering = undefined;
  });
  return delivering;
}

async function retryPending(): Promise<void> {
  /* eslint-disable no-catch-all/no-catch-all -- a queue pass never withdraws a durable accepted notice */
  try {
    await deliverPending();
  } catch (error) {
    log.warn('Could not deliver pending WhatsApp notices', { err: error });
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

registerWhatsAppObserver({
  async onLinkNotice(notice) {
    const directory = whatsappDirectory();
    if (!directory) return false;
    // The link owner supplies outage ids. A number-change belongs to the
    // particular binding, so a later binding of the same LID can report anew.
    const key =
      notice.kind === 'principal-number-changed'
        ? `${notice.id}:${createHash('sha256')
            .update(notice.link.principalVerifiedAt ?? notice.link.principal?.phoneJid ?? '')
            .digest('hex')
            .slice(0, 16)}`
        : notice.id;
    inStore(directory, (store) => {
      store.accept(key, notice);
    });
    await retryPending();
    return true;
  },
});

onHostStart(async ({ signal }) => {
  await retryPending();
  if (signal.aborted) return;
  const timer = setInterval(() => {
    void retryPending();
  }, 60_000);
  timer.unref();
  signal.addEventListener(
    'abort',
    () => {
      clearInterval(timer);
    },
    { once: true },
  );
});
