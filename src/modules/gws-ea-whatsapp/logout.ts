/** Removal-only native sign-out. The caller has stopped and drained this exact instance before opening it. */
import fs from 'node:fs';
import path from 'node:path';
import {
  Browsers,
  DisconnectReason,
  jidNormalizedUser,
  makeWASocket,
  type BaileysEventEmitter,
  type UserFacingSocketConfig,
  type WASocket,
} from '@whiskeysockets/baileys';
import { pino } from 'pino';
import { isRecord } from '../../gws-ea/validation.js';
import { WhatsAppAuthStore } from './auth-store.js';
import { readWhatsAppLink } from './paths.js';
import { resolveWaWebVersion } from './socket.js';

const LOGOUT_TIMEOUT_MS = 30_000;
type LogoutSocket = Pick<WASocket, 'logout' | 'end'> & { readonly ev: BaileysEventEmitter };
export interface WhatsAppLogoutOptions {
  readonly directory: string;
  readonly number?: string;
  readonly makeSocket?: (config: UserFacingSocketConfig) => LogoutSocket;
  readonly resolveVersion?: () => Promise<[number, number, number]>;
}

/** A native logout writes remove-companion-device; Baileys exposes no separate server acknowledgment. */
export async function logoutWhatsAppAccount(options: WhatsAppLogoutOptions): Promise<void> {
  const link = await readWhatsAppLink(options.directory);
  const number = link?.number ?? options.number;
  const expected = number ? `${number.slice(1)}@s.whatsapp.net` : undefined;
  if (!fs.existsSync(path.join(options.directory, 'auth.sqlite'))) {
    if (link?.state === 'linking' && !link.account) return;
    if (expected || link?.account) throw new Error('WhatsApp credentials are missing; native logout cannot be proven.');
    return;
  }
  const auth = new WhatsAppAuthStore(options.directory);
  let socket: LogoutSocket | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let finished = false;
  try {
    const account =
      expected ?? (auth.state.creds.me?.id ? jidNormalizedUser(auth.state.creds.me.id) : auth.loggedOutAccount());
    if (account && auth.loggedOut(account)) return;
    if (!auth.authenticated) {
      if (link?.account || link?.state === 'connected' || link?.state === 'needs-relink')
        throw new Error('WhatsApp has no registered credentials or native logout proof.');
      return; // An unregistered pending pairing never created a linked device.
    }
    if (!account || !auth.state.creds.me?.id || jidNormalizedUser(auth.state.creds.me.id) !== account)
      throw new Error('WhatsApp credentials do not match the account to remove.');
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(
        () => reject(new Error('WhatsApp native logout timed out; credentials were retained.')),
        LOGOUT_TIMEOUT_MS,
      );
    });
    const signOut = async () => {
      const version = await (options.resolveVersion ?? resolveWaWebVersion)();
      if (finished) return;
      socket = (options.makeSocket ?? makeWASocket)({
        version,
        auth: auth.state,
        logger: pino({ level: 'silent' }),
        browser: Browsers.macOS('Desktop'),
        markOnlineOnConnect: false,
        syncFullHistory: false,
        shouldSyncHistoryMessage: () => false,
        fireInitQueries: false,
        enableRecentMessageCache: false,
        connectTimeoutMs: LOGOUT_TIMEOUT_MS,
      });
      let closedAsLoggedOut = false;
      await new Promise<void>((resolve, reject) => {
        socket!.ev.on('creds.update', (update) => {
          if (!finished) auth.saveCreds(update);
        });
        socket!.ev.on('connection.update', (update) => {
          if (finished) return;
          if (update.connection === 'open') resolve();
          if (update.connection === 'close') {
            const error = update.lastDisconnect?.error;
            closedAsLoggedOut =
              !!error &&
              'output' in error &&
              isRecord(error.output) &&
              error.output.statusCode === DisconnectReason.loggedOut;
            if (closedAsLoggedOut) resolve();
            else reject(new Error('WhatsApp closed before native logout; credentials were retained.'));
          }
        });
      });
      if (finished) return;
      if (!closedAsLoggedOut) await socket.logout();
      if (finished) return;
      // Finish closing before any credentials can be erased, including Baileys' asynchronous end after logout.
      await socket.end(undefined);
      if (finished) return;
      auth.clear({ kind: 'logged-out', account });
    };
    await Promise.race([signOut(), deadline]);
  } finally {
    finished = true;
    if (timeout) clearTimeout(timeout);
    try {
      await socket?.end(undefined);
    } finally {
      auth.close();
    }
  }
}
