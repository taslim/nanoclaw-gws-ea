/** The assistant's Baileys transport. Connection establishment never holds channel startup open. */
import {
  Browsers,
  DisconnectReason,
  downloadMediaMessage,
  fetchLatestWaWebVersion,
  makeWASocket,
  type BaileysEventEmitter,
  type BaileysEventMap,
  type UserFacingSocketConfig,
  type WASocket,
  type WAMessage,
} from '@whiskeysockets/baileys';
import { pino } from 'pino';

import {
  ChannelNotConnectedError,
  type ChannelAdapter,
  type ChannelDefaults,
  type ChannelSetup,
  type OutboundMessage,
} from '../../channels/adapter.js';
import { createAnswers } from '../../channels/answers.js';
import { resolveQuestionRender } from '../../channels/question-render-registry.js';
import { log } from '../../log.js';
import { SqliteStateAdapter } from '../../state-sqlite.js';
import { WhatsAppAuthStore } from './auth-store.js';
import { normalizedJid, resolvePerson } from './identity.js';
import { createWhatsAppInbound } from './inbound.js';
import { WhatsAppIndex } from './index-store.js';
import { observeWhatsAppConnection, observeWhatsAppGroup } from './observers.js';
import { createWhatsAppOutbound } from './outbound.js';
import { readWhatsAppLink, writeWhatsAppLink, type WhatsAppLink, type WhatsAppPerson } from './paths.js';

export type WhatsAppSocket = Pick<
  WASocket,
  | 'user'
  | 'sendMessage'
  | 'sendPresenceUpdate'
  | 'end'
  | 'requestPairingCode'
  | 'groupFetchAllParticipating'
  | 'updateMediaMessage'
> & {
  readonly ev: BaileysEventEmitter;
  readonly signalRepository: {
    readonly lidMapping: Pick<
      WASocket['signalRepository']['lidMapping'],
      'getLIDForPN' | 'getPNForLID' | 'storeLIDPNMappings'
    >;
  };
};
export interface WhatsAppAdapterOptions {
  readonly directory: string;
  readonly makeSocket?: (config: UserFacingSocketConfig) => WhatsAppSocket;
  readonly resolveVersion?: () => Promise<[number, number, number]>;
  readonly downloadMedia?: (message: WAMessage) => Promise<Buffer>;
  readonly now?: () => number;
}
export interface WhatsAppAdapter extends ChannelAdapter {
  /** Wait for this connection attempt's socket construction, never for open. Also used after a new link record is saved. */
  reconnect(): Promise<void>;
  /** U3 owns authorization and lifecycle; this requests the code only for a linking record. */
  requestPairingCode(phoneNumber: string): Promise<string>;
  resolvePerson(jid: string, alternate?: string | null): Promise<WhatsAppPerson | undefined>;
  completeDelivery(rowId: string): void;
}
export const WHATSAPP_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'strict' },
  group: { engageMode: 'mention', threads: false, unknownSenderPolicy: 'strict' },
  mentions: 'platform',
};
const logger = pino({ level: 'silent' });

/** Refuse Baileys' baked-in fallback: it is returned with isLatest=false/error when the lookup fails. */
export async function resolveWaWebVersion(): Promise<[number, number, number]> {
  const failures: unknown[] = [];
  /* eslint-disable no-catch-all/no-catch-all -- both network lookups may fail; never substitute Baileys' built-in version */
  try {
    const response = await fetch('https://wppconnect.io/whatsapp-versions/', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const match = /\b2\.3000\.(\d+)\b/u.exec(await response.text());
      if (match) return [2, 3000, Number(match[1])];
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const result = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) });
    if (result.isLatest && !result.error) return result.version;
    failures.push(result.error);
  } catch (error) {
    failures.push(error);
  }
  /* eslint-enable no-catch-all/no-catch-all */
  throw new Error('Could not resolve the current WhatsApp Web version; no socket was opened', {
    cause: new AggregateError(failures),
  });
}

export function createWhatsAppAdapter(options: WhatsAppAdapterOptions): WhatsAppAdapter {
  const now = options.now ?? Date.now;
  const auth = new WhatsAppAuthStore(options.directory);
  const index = new WhatsAppIndex(options.directory);
  const state = new SqliteStateAdapter('gws-ea-whatsapp');
  let socket: WhatsAppSocket | undefined;
  let connected = false;
  let stopped = false;
  let link: WhatsAppLink | undefined;
  let config: ChannelSetup | undefined;
  let connecting: Promise<void> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let inbound: ReturnType<typeof createWhatsAppInbound> | undefined;
  const events = new Set<Promise<void>>();
  const outbound = createWhatsAppOutbound({
    index,
    state,
    socket: () => socket,
    connected: () => connected,
    now,
    sender: () => `whatsapp:${link?.account?.lid ?? 'assistant'}`,
  });

  async function record(change: Partial<WhatsAppLink>): Promise<void> {
    const current = await readWhatsAppLink(options.directory);
    if (!current) return;
    link = { ...current, ...change };
    await writeWhatsAppLink(options.directory, link);
  }
  async function report(error: unknown): Promise<void> {
    log.warn('WhatsApp transport is unavailable', { err: error });
    await record({
      error: { message: error instanceof Error ? error.message : String(error), at: new Date(now()).toISOString() },
    });
  }
  function scheduleReconnect(): void {
    if (stopped || reconnectTimer || link?.state !== 'connected') return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void reconnect();
    }, delay);
    reconnectTimer.unref();
  }
  function scheduleReplay(): void {
    if (stopped || replayTimer || !connected || index.unrouted().length === 0) return;
    replayTimer = setTimeout(() => {
      replayTimer = undefined;
      void inbound?.replay().then(scheduleReplay).catch(report);
    }, 1000);
    replayTimer.unref();
  }
  function listen<T extends keyof BaileysEventMap>(
    current: WhatsAppSocket,
    event: T,
    handler: (value: BaileysEventMap[T]) => Promise<void>,
  ): void {
    const run = (value: BaileysEventMap[T]): Promise<void> => {
      if (stopped || socket !== current) return Promise.resolve();
      const work = handler(value).catch(report);
      events.add(work);
      void work
        .finally(() => events.delete(work))
        .catch((error: unknown) => log.error('Could not record WhatsApp transport error', { err: error }));
      return work;
    };
    // eslint-disable-next-line @typescript-eslint/no-misused-promises -- Baileys drops return values; caught work is tracked through teardown, and the fake awaits it.
    current.ev.on(event, run);
  }

  async function connect(): Promise<void> {
    link = await readWhatsAppLink(options.directory);
    if (stopped || !config || !link || link.state === 'needs-relink') return;
    const version = await (options.resolveVersion ?? resolveWaWebVersion)();
    if (stopped) return;
    const previous = socket;
    socket = undefined;
    connected = false;
    await previous?.end(undefined);
    // Signal keys can be committed before the first credentials event; their identity must already be durable.
    auth.saveCreds();
    const current = (options.makeSocket ?? makeWASocket)({
      version,
      auth: auth.state,
      logger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      getMessage: (key) =>
        Promise.resolve(key.remoteJid && key.id ? index.wireMessage(key.remoteJid, key.id) : undefined),
    });
    socket = current;
    const answers = createAnswers({
      state,
      adapterName: 'whatsapp',
      postedRequest: (id) => Promise.resolve(index.request(id)),
      render: resolveQuestionRender,
      dispatch: async (answer) => {
        await config?.onAction(
          answer.questionId,
          answer.value,
          answer.userId,
          { platformId: answer.platformId, threadId: null, messageId: answer.messageId, instance: 'whatsapp' },
          { deferResolution: true, ...(answer.reason ? { reason: answer.reason } : {}) },
        );
      },
    });
    inbound = createWhatsAppInbound({
      socket: () => current,
      index,
      setup: config,
      answers,
      download:
        options.downloadMedia ??
        ((message) =>
          downloadMediaMessage(
            message,
            'buffer',
            {},
            {
              logger,
              reuploadRequest: current.updateMediaMessage,
            },
          )),
      now,
    });
    listen(current, 'creds.update', async (update) => {
      auth.saveCreds(update);
    });
    listen(current, 'lid-mapping.update', async ({ lid, pn }) => {
      const resolved = await resolvePerson(current, index, lid, pn);
      if (resolved && pn) index.alias(`${resolved.lid}@lid`, normalizedJid(pn));
    });
    listen(current, 'contacts.upsert', async (contacts) => {
      for (const contact of contacts)
        if (contact.name || contact.notify)
          index.rememberName(normalizedJid(contact.id), contact.name || contact.notify || contact.id);
    });
    listen(current, 'contacts.update', async (contacts) => {
      for (const contact of contacts)
        if (contact.id && (contact.name || contact.notify))
          index.rememberName(normalizedJid(contact.id), contact.name || contact.notify || contact.id);
    });
    listen(current, 'messages.upsert', async (batch) => {
      if (batch.type !== 'notify' && batch.type !== 'append') return;
      await inbound?.receive(batch.messages);
      scheduleReplay();
    });
    listen(current, 'groups.upsert', async (value) => {
      await observeWhatsAppGroup({ type: 'groups.upsert', value });
    });
    listen(current, 'groups.update', async (value) => {
      await observeWhatsAppGroup({ type: 'groups.update', value });
    });
    listen(current, 'group-participants.update', async (value) => {
      await observeWhatsAppGroup({ type: 'group-participants.update', value });
    });
    listen(current, 'connection.update', async (update) => {
      if (update.connection === 'open') {
        connected = true;
        failures = 0;
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = undefined;
        }
        const account = current.user?.lid
          ? await resolvePerson(current, index, current.user.lid, current.user.id)
          : current.user?.id
            ? await resolvePerson(current, index, current.user.id)
            : undefined;
        await record({ state: 'connected', ...(account ? { account } : {}), error: undefined });
        await observeWhatsAppConnection(update, link);
        await inbound?.replay();
        index.prune(now());
        scheduleReplay();
      } else if (update.connection === 'close') {
        connected = false;
        const error = update.lastDisconnect?.error;
        const code = error && 'output' in error ? (error.output as { statusCode?: number }).statusCode : undefined;
        if (code === DisconnectReason.loggedOut) {
          auth.clear();
          await record({
            state: 'needs-relink',
            error: { message: 'WhatsApp was logged out; link the account again', at: new Date(now()).toISOString() },
          });
        } else {
          if (error) await report(error);
          scheduleReconnect();
        }
        await observeWhatsAppConnection(update, link);
      } else {
        await observeWhatsAppConnection(update, link);
      }
    });
  }
  function reconnect(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (connecting) return connecting;
    const run = connect().catch(async (error: unknown) => {
      await report(error);
      scheduleReconnect();
    });
    connecting = run;
    void run
      .finally(() => {
        if (connecting === run) connecting = undefined;
      })
      .catch((error: unknown) => log.error('Could not record a WhatsApp connection failure', { err: error }));
    return run;
  }
  return {
    name: 'whatsapp',
    channelType: 'whatsapp',
    supportsThreads: false,
    defaults: WHATSAPP_DEFAULTS,
    async setup(hostConfig) {
      config = hostConfig;
      await state.connect();
      void reconnect();
    },
    async teardown() {
      if (stopped) return;
      stopped = true;
      connected = false;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (replayTimer) clearTimeout(replayTimer);
      await socket?.end(undefined);
      await connecting;
      await Promise.allSettled([...events]);
      await inbound?.settled();
      await state.disconnect();
      auth.close();
      index.close();
    },
    isConnected: () => connected,
    reconnect,
    async requestPairingCode(phoneNumber) {
      if (!/^\d{7,15}$/u.test(phoneNumber))
        throw new Error('WhatsApp pairing requires a phone number with country code, digits only');
      const current = await readWhatsAppLink(options.directory);
      if (current?.state !== 'linking') throw new Error('WhatsApp is not linking an account');
      if (!socket || link?.state !== 'linking') await reconnect();
      if (!socket) throw new ChannelNotConnectedError();
      return socket.requestPairingCode(phoneNumber);
    },
    async resolvePerson(jid, alternate) {
      if (!socket) throw new ChannelNotConnectedError();
      return resolvePerson(socket, index, jid, alternate);
    },
    async openDM(handle) {
      if (/^\d+$/u.test(handle)) return `${handle}@lid`;
      const jid = normalizedJid(handle);
      if (/^\d+@lid$/u.test(jid)) return jid;
      if (!socket || !connected) throw new ChannelNotConnectedError();
      const person = await resolvePerson(socket, index, jid);
      if (!person) throw new Error('WhatsApp recipient has no resolved LID');
      return `${person.lid}@lid`;
    },
    completeDelivery: outbound.complete,
    deliver: (platformId: string, _threadId: string | null, message: OutboundMessage, rowId?: string) =>
      outbound.deliver(platformId, message, rowId),
    async setTyping(platformId) {
      if (socket && connected) await socket.sendPresenceUpdate('composing', platformId);
    },
    async endTyping(platformId) {
      if (socket && connected) await socket.sendPresenceUpdate('paused', platformId);
    },
    async syncConversations() {
      if (!socket || !connected) return [];
      return Object.entries(await socket.groupFetchAllParticipating()).map(([platformId, group]) => ({
        platformId,
        name: group.subject,
        isGroup: true,
      }));
    },
  };
}
