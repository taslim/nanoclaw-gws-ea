/**
 * Main hears once that one of its apps needs reconnecting, in a note that does not wake it. The note waits until no
 * running container of main's could still hold the app's tools, so the turn that reads it has no dead tools to try.
 *
 * The refresher reports a refused grant under the app's lock, so a report only records what is owed; checks here
 * deliver it. Its id names the app and the refused generation: repeated refusals of one grant are one note, and a
 * grant that breaks again after a reconnect is a new one.
 */
import { getContainerConfigReadAtMs, isContainerRunning } from '../../container-runner.js';
import { getDb } from '../../db/connection.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain, type NoteForMain, type NoteForMainResult } from '../gws-ea-profile/main-note.js';
import type { RefusedApp } from './refresher.js';
import { ConnectionsStoreError, type ConnectionApp, type ConnectionsStore } from './store.js';

export const NOTE_CHECK_INTERVAL_MS = 5_000;

export function reconnectNoteId(app: RefusedApp): string {
  return `connection-reconnect:${app.appId}:${app.generation}`;
}

interface Owed extends RefusedApp {
  /** When main's servers were first read without the app: a container that read its own later never held it. */
  readonly droppedAt?: number;
}

export interface ReconnectNotesDependencies {
  readonly write?: (note: NoteForMain) => Promise<NoteForMainResult>;
  readonly now?: () => number;
}

export interface ReconnectNotes {
  /** Records the note; quick, so it can run under the app's lock. */
  owe(app: RefusedApp): void;
  /** Writes every owed note nothing holds back; returns whether any is still owed. */
  deliver(): Promise<boolean>;
}

async function mainAgentGroupId(): Promise<string | null> {
  return (await getDb().hasTable('gws_ea_profile')) ? getMainAgentGroupId() : null;
}

async function mainServerKeys(agentGroupId: string): Promise<ReadonlySet<string>> {
  const row = await getContainerConfig(agentGroupId);
  const parsed: unknown = row ? JSON.parse(row.mcp_servers) : {};
  return new Set(typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : []);
}

/**
 * A container that read its configuration before the app left it may still hold the app; one this host adopted
 * may hold anything a previous host gave it.
 */
async function anyHolding(agentGroupId: string, droppedAt: number): Promise<boolean> {
  for (const session of await getSessionsByAgentGroup(agentGroupId)) {
    if (!isContainerRunning(session.id)) continue;
    const readAt = getContainerConfigReadAtMs(session.id);
    if (readAt === undefined || readAt <= droppedAt) return true;
  }
  return false;
}

function noteText(app: ConnectionApp): string {
  return (
    `The app ${JSON.stringify(app.name)} at ${app.host} needs reconnecting: its service refused to renew access, ` +
    'so its tools are gone until the principal connects it again on their Connections page.'
  );
}

export function createReconnectNotes(
  store: ConnectionsStore,
  dependencies: ReconnectNotesDependencies = {},
): ReconnectNotes {
  const write = dependencies.write ?? writeNoteForMain;
  const now = dependencies.now ?? Date.now;
  const owed = new Map<string, Owed>();

  /** Undefined once the note is written or no longer owed; the entry to keep otherwise. */
  async function settle(entry: Owed): Promise<Owed | undefined> {
    let app: ConnectionApp;
    try {
      app = await store.get(entry.appId);
    } catch (error) {
      if (error instanceof ConnectionsStoreError && error.reason === 'app_not_found') return undefined;
      throw error;
    }
    // Reconnected, disconnected or deleted since: nothing is broken to report.
    if (app.status !== 'needs_reconnecting') return undefined;
    const mainId = await mainAgentGroupId();
    if (mainId !== null) {
      if ((await mainServerKeys(mainId)).has(app.serverKey))
        return { appId: entry.appId, generation: entry.generation };
      const droppedAt = entry.droppedAt ?? now();
      if (await anyHolding(mainId, droppedAt)) return { ...entry, droppedAt };
    }
    await write({
      id: reconnectNoteId(entry),
      timestamp: new Date(now()).toISOString(),
      text: noteText(app),
      wake: false,
    });
    return undefined;
  }

  return {
    owe(app) {
      const current = owed.get(app.appId);
      if (current && current.generation >= app.generation) return;
      owed.set(app.appId, { appId: app.appId, generation: app.generation });
    },
    async deliver() {
      for (const entry of [...owed.values()]) {
        let next: Owed | undefined;
        try {
          next = await settle(entry);
        } catch (error) {
          if (!(error instanceof ConnectionsStoreError)) throw error;
          log.warn('Reconnect note waits on the connections store', { appId: entry.appId, code: error.reason });
          next = entry;
        }
        // A newer refusal recorded meanwhile replaces this one.
        if (owed.get(entry.appId)?.generation !== entry.generation) continue;
        if (next) owed.set(entry.appId, next);
        else owed.delete(entry.appId);
      }
      return owed.size > 0;
    },
  };
}

let armed: { readonly notes: ReconnectNotes; readonly signal: AbortSignal } | undefined;
let timer: NodeJS.Timeout | undefined;
let inFlight: Promise<void> | undefined;
let recheck = false;

function stopTimer(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

function tick(): void {
  if (!armed || armed.signal.aborted) return;
  if (inFlight) {
    recheck = true;
    return;
  }
  const { notes } = armed;
  inFlight = notes
    .deliver()
    .catch((err: unknown) => {
      log.error('Reconnect notes check failed', { err });
      return true;
    })
    .then((pending) => {
      inFlight = undefined;
      if (recheck) {
        recheck = false;
        tick();
      } else if (!pending) stopTimer();
    });
}

/** Arms delivery for this host; owed notes live in its memory, so one owed when it stops is not written. */
export function startReconnectNotes(
  store: ConnectionsStore,
  signal: AbortSignal,
  dependencies: ReconnectNotesDependencies = {},
): void {
  if (signal.aborted) return;
  armed = { notes: createReconnectNotes(store, dependencies), signal };
  signal.addEventListener('abort', stopTimer, { once: true });
}

/** The refresher's `onRefused`: records the note and checks now, then every few seconds while one is owed. */
export function oweReconnectNote(app: RefusedApp): void {
  if (!armed || armed.signal.aborted) return;
  armed.notes.owe(app);
  if (!timer) {
    timer = setInterval(tick, NOTE_CHECK_INTERVAL_MS);
    timer.unref();
  }
  tick();
}

/** Stops new checks and waits for one in flight. */
export async function stopReconnectNotes(): Promise<void> {
  armed = undefined;
  recheck = false;
  stopTimer();
  await inFlight;
}
