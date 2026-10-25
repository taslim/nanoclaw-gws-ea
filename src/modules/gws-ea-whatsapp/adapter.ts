import {
  Browsers,
  DisconnectReason,
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
  type ChannelSetup,
  type OutboundMessage,
} from '../../channels/adapter.js';
import { createAnswers } from '../../channels/answers.js';
import { resolveQuestionRender } from '../../channels/question-render-registry.js';
import { log } from '../../log.js';
import { OutboundRefusedError } from '../../delivery.js';
import { checkOutbound } from '../gws-ea-privacy/outbound.js';
import { SqliteStateAdapter } from '../../state-sqlite.js';
import { WhatsAppAuthStore } from './auth-store.js';
import { WHATSAPP_DEFAULTS } from './defaults.js';
import { WhatsAppContacts, type WhatsAppOutreachRequest } from './contacts.js';
import { createWhatsAppOutreach, type WhatsAppGroupOutreach } from './outreach.js';
import { createWhatsAppGroupEvents, type WhatsAppGroup } from './events.js';
import { normalizedJid, resolvePerson } from './identity.js';
import { createWhatsAppInbound } from './inbound.js';
import { downloadWhatsAppMedia } from './media-download.js';
import { WhatsAppIndex } from './index-store.js';
import { observeWhatsAppConnection, observeWhatsAppGroup } from './observers.js';
import { createWhatsAppOutbound } from './outbound.js';
import { resolveWaWebVersion } from './socket.js';
export { resolveWaWebVersion } from './socket.js';
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
  | 'groupMetadata'
  | 'groupLeave'
  | 'onWhatsApp'
  | 'groupCreate'
  | 'groupParticipantsUpdate'
  | 'updateProfileName'
  | 'updateProfileStatus'
  | 'logout'
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
  openDM(handle: string): Promise<string>;
  /** Resolves once this attempt's socket is constructed, not when it opens; re-reads the saved link record first. */
  reconnect(): Promise<void>;
  /**
   * Authorization and the pairing lifecycle belong to `WhatsAppLinking`; this refuses unless the record is linking,
   * and asks only once the socket has announced it can pair.
   */
  requestPairingCode(phoneNumber: string): Promise<string>;
  resolvePerson(jid: string, alternate?: string | null): Promise<WhatsAppPerson | undefined>;
  completeDelivery(rowId: string): void;
  isOwnMessage(platformId: string, messageId: string): boolean;
  releaseHeldPrincipal(lid: string): Promise<void>;
  setProfile(name: string, about: string): Promise<void>;
  logout(): Promise<void>;
  fetchGroupMembers(platformId: string): Promise<WhatsAppGroup>;
  leaveGroup(platformId: string): Promise<void>;
  resolveNumber(number: string): Promise<WhatsAppPerson | undefined>;
  prepareReachOutDM(person: WhatsAppPerson, request: WhatsAppOutreachRequest): Promise<{ readonly platformId: string }>;
  reachOutDM(
    person: WhatsAppPerson,
    message: OutboundMessage,
    request: WhatsAppOutreachRequest,
  ): Promise<{ readonly platformId: string; readonly messageId: string }>;
  createGroup(
    subject: string,
    people: readonly WhatsAppPerson[],
    request: WhatsAppOutreachRequest,
  ): Promise<WhatsAppGroupOutreach>;
  addParticipant(
    platformId: string,
    person: WhatsAppPerson,
    request: WhatsAppOutreachRequest,
  ): Promise<'added' | 'invited'>;
}
const logger = pino({ level: 'silent' });
/**
 * How long a new socket may take to announce it is ready to pair; it is usually a
 * second or two. It ends well inside the 30-second link timeouts of main's tool and
 * the operator command, after the version lookup's own bounded wait.
 */
const PAIRING_READY_MS = 15_000;

/**
 * Settles when Baileys announces the socket can pair (its first QR) or closes
 * first: a pairing request sent before that finds no open connection.
 */
function pairingAnnounced(current: WhatsAppSocket): Promise<void> {
  const announced = new Promise<void>((resolve, reject) => {
    const settle = (update: BaileysEventMap['connection.update']): void => {
      if (!update.qr && update.connection !== 'close') return;
      current.ev.off('connection.update', settle);
      if (update.qr) resolve();
      else {
        const reason = update.lastDisconnect?.error?.message;
        reject(new Error(`WhatsApp closed its pairing connection before it was ready${reason ? `: ${reason}` : ''}`));
      }
    };
    current.ev.on('connection.update', settle);
  });
  // Only a pairing request awaits this; a socket that reconnects an existing account never announces a QR.
  announced.catch(() => undefined);
  return announced;
}

async function withinPairingWait(announced: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`WhatsApp did not open a pairing connection within ${PAIRING_READY_MS / 1000} seconds`)),
      PAIRING_READY_MS,
    );
  });
  try {
    await Promise.race([announced, late]);
  } finally {
    clearTimeout(timer);
  }
}

export function createWhatsAppAdapter(options: WhatsAppAdapterOptions): WhatsAppAdapter {
  const now = options.now ?? Date.now;
  const auth = new WhatsAppAuthStore(options.directory);
  const index = new WhatsAppIndex(options.directory, indexAccount);
  const state = new SqliteStateAdapter('gws-ea-whatsapp');
  let socket: WhatsAppSocket | undefined;
  /** The current socket's announcement that it can pair. */
  let pairable: { readonly socket: WhatsAppSocket; readonly announced: Promise<void> } | undefined;
  let connected = false;
  let stopped = false;
  let unlinking = false;
  let discardInbound = false;
  let link: WhatsAppLink | undefined;
  let config: ChannelSetup | undefined;
  let connecting: Promise<void> | undefined;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let replayTimer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;
  let inbound: ReturnType<typeof createWhatsAppInbound> | undefined;
  let mediaAbort = new AbortController();
  const contacts = new WhatsAppContacts(
    options.directory,
    () => {
      const phone = socket?.user?.id ?? link?.account?.phoneJid;
      if (!phone || !/^\d+@s\.whatsapp\.net$/u.test(normalizedJid(phone)))
        throw new Error('WhatsApp linked number is unavailable');
      return normalizedJid(phone);
    },
    now,
  );
  const groupEvents = createWhatsAppGroupEvents({
    socket: () => {
      if (!socket || !connected) throw new ChannelNotConnectedError();
      return socket;
    },
    index,
    link: () => link,
  });
  const events = new Set<Promise<void>>();
  const outbound = createWhatsAppOutbound({
    index,
    contacts,
    resolvePerson: async (jid) => (socket ? resolvePerson(socket, index, jid) : undefined),
    state,
    directSendAllowed,
    socket: () => socket,
    connected: () => connected,
    now,
    sender: () => `whatsapp:${link?.account?.lid ?? 'assistant'}`,
  });

  const outreach = createWhatsAppOutreach({
    socket: () => {
      if (!socket || !connected) throw new ChannelNotConnectedError();
      return socket;
    },
    contacts,
    principal: () => link?.principal,
    resolve: async (jid) => (socket ? resolvePerson(socket, index, jid) : undefined),
    deliver: outbound.deliver,
    now,
  });

  function indexAccount(): string {
    const phone = link?.number
      ? `${link.number.slice(1)}@s.whatsapp.net`
      : (socket?.user?.id ?? link?.account?.phoneJid);
    if (!phone) throw new ChannelNotConnectedError();
    return normalizedJid(phone);
  }
  async function directSendAllowed(person: WhatsAppPerson): Promise<boolean> {
    const current = await readWhatsAppLink(options.directory);
    if (!current) return false;
    if (current.principal?.lid === person.lid) return current.principal.phoneJid === person.phoneJid;
    return !(
      current.principalNumber &&
      !current.principal &&
      person.phoneJid === `${current.principalNumber.slice(1)}@s.whatsapp.net`
    );
  }
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
    if (stopped || reconnectTimer || link?.pairing || link?.state !== 'connected') return;
    const delay = Math.min(60_000, 1_000 * 2 ** Math.min(failures++, 6));
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      void reconnect();
    }, delay);
    reconnectTimer.unref();
  }
  function scheduleReplay(): void {
    if (stopped || replayTimer || !connected || !index.hasUnrouted()) return;
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
      if (stopped || unlinking || socket !== current) return Promise.resolve();
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
    mediaAbort.abort();
    mediaAbort = new AbortController();
    const mediaSignal = mediaAbort.signal;
    socket = undefined;
    connected = false;
    await previous?.end(undefined);
    groupEvents.reset();
    // Signal keys can be committed before the first credentials event; their identity must already be durable.
    auth.saveCreds();
    const current = (options.makeSocket ?? makeWASocket)({
      version,
      auth: auth.state,
      logger,
      browser: Browsers.macOS('Desktop'),
      markOnlineOnConnect: false,
      ...(link.pairing ? { qrTimeout: Math.max(1, link.pairing.expiresAt - now()) } : {}),
      syncFullHistory: false,
      shouldSyncHistoryMessage: () => false,
      // rc14's native resend checks its memory cache before getMessage; every resend must consult the durable ledger.
      enableRecentMessageCache: false,
      getMessage: async (key) => {
        if (!connected) return undefined;
        if (!key.remoteJid || !key.id) return undefined;
        let chat = key.remoteJid;
        if (!chat.endsWith('@g.us')) {
          const person = await resolvePerson(current, index, chat);
          if (!person || !(await directSendAllowed(person)) || !(await contacts.retry(key.id))) return undefined;
          chat = `${person.lid}@lid`;
        }
        return index.message(chat, key.id)?.fromMe ? index.wireMessage(chat, key.id) : undefined;
      },
    });
    socket = current;
    pairable = { socket: current, announced: pairingAnnounced(current) };
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
      onDirectMessage: (person, at) => contacts.received(person.lid, at),
      answers,
      download:
        options.downloadMedia ?? ((message) => downloadWhatsAppMedia(message, current.updateMediaMessage, mediaSignal)),
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
      if (!connected) {
        for (const message of batch.messages) index.intake(message);
        return;
      }
      await inbound?.receive(batch.messages);
      scheduleReplay();
    });
    listen(current, 'messages.update', (updates) => contacts.updates(updates));
    listen(current, 'groups.upsert', async (value) => {
      await observeWhatsAppGroup({ type: 'groups.upsert', value });
      await groupEvents.event({ type: 'groups.upsert', value });
    });
    listen(current, 'groups.update', async (value) => {
      await observeWhatsAppGroup({ type: 'groups.update', value });
      await groupEvents.event({ type: 'groups.update', value });
    });
    listen(current, 'group-participants.update', async (value) => {
      await observeWhatsAppGroup({ type: 'group-participants.update', value });
      await groupEvents.event({ type: 'group-participants.update', value });
    });
    listen(current, 'chats.delete', (ids) => groupEvents.deleted(ids));
    listen(current, 'connection.update', async (update) => {
      contacts.connection(update);
      if (update.connection === 'open') {
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
        if (link?.number && account?.phoneJid !== `${link.number.slice(1)}@s.whatsapp.net`) {
          socket = undefined;
          discardInbound = true;
          auth.clear({ kind: 'discarded' });
          await current.end(new Error('Linked WhatsApp account does not match the admitted assistant number'));
          await observeWhatsAppConnection({ connection: 'close' }, link);
          return;
        }
        connected = true;
        await record({ state: 'connected', ...(account ? { account } : {}), error: undefined });
        await contacts.notify();
        await observeWhatsAppConnection(update, link);
        link = await readWhatsAppLink(options.directory);
        await inbound?.replay();
        index.prune(now());
        scheduleReplay();
      } else if (update.connection === 'close') {
        connected = false;
        if (unlinking) return;
        const error = update.lastDisconnect?.error;
        const code = error && 'output' in error ? (error.output as { statusCode?: number }).statusCode : undefined;
        if (code === DisconnectReason.loggedOut) {
          auth.clear({ kind: 'logged-out', account: indexAccount() });
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
      mediaAbort.abort();
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (replayTimer) clearTimeout(replayTimer);
      await socket?.end(undefined);
      await connecting;
      await Promise.allSettled([...events]);
      await inbound?.settled();
      if (discardInbound) index.discardUnrouted();
      await state.disconnect();
      auth.close();
      index.close();
      contacts.close();
    },
    isConnected: () => connected,
    reconnect,
    async requestPairingCode(phoneNumber) {
      if (!/^\d{7,15}$/u.test(phoneNumber))
        throw new Error('WhatsApp pairing requires a phone number with country code, digits only');
      const current = await readWhatsAppLink(options.directory);
      if (current?.state !== 'linking') throw new Error('WhatsApp is not linking an account');
      if (!socket || link?.state !== 'linking') await reconnect();
      const pairing = socket;
      if (!pairing || pairable?.socket !== pairing) throw new ChannelNotConnectedError();
      await withinPairingWait(pairable.announced);
      if (socket !== pairing) throw new Error('WhatsApp replaced its pairing connection before it was ready');
      return pairing.requestPairingCode(phoneNumber);
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
    isOwnMessage: (platformId, messageId) => index.message(platformId, messageId)?.fromMe === true,
    async releaseHeldPrincipal(lid) {
      link = await readWhatsAppLink(options.directory);
      if (link?.principal?.lid !== lid) throw new Error('Only the bound principal’s pending messages may be released');
      index.releaseHeld(lid);
      scheduleReplay();
    },
    async setProfile(name, about) {
      if (!socket || !connected) throw new ChannelNotConnectedError();
      const check = await checkOutbound([name, about], 'others');
      if (!check.allowed) throw new OutboundRefusedError('gws-ea-privacy:audience', check.reason);
      await socket.updateProfileName(name);
      await socket.updateProfileStatus(about);
    },
    async logout() {
      if (!socket || !connected) {
        const record = await readWhatsAppLink(options.directory);
        const account = record?.number ? `${record.number.slice(1)}@s.whatsapp.net` : record?.account?.phoneJid;
        if (account && auth.loggedOut(account)) {
          discardInbound = true;
          return;
        }
        if (!auth.authenticated && record?.state === 'linking' && !record.account) {
          unlinking = true;
          await socket?.end(undefined);
          discardInbound = true;
          return;
        }
        throw new ChannelNotConnectedError();
      }
      unlinking = true;
      try {
        await socket.logout();
        await socket.end(undefined);
      } catch (error) {
        unlinking = false;
        throw error;
      }
      discardInbound = true;
      connected = false;
      auth.clear({ kind: 'logged-out', account: indexAccount() });
    },
    async leaveGroup(platformId) {
      if (!/^[A-Za-z0-9-]+@g\.us$/u.test(platformId)) throw new Error('Leaving requires a WhatsApp group address.');
      if (!socket || !connected) throw new ChannelNotConnectedError();
      await socket.groupLeave(platformId);
    },
    fetchGroupMembers: groupEvents.fetchGroupMembers,
    ...outreach,
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
