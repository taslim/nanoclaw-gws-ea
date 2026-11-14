/**
 * Main hears once that one of its apps needs reconnecting, in a note that does not wake it. The note waits until no
 * running container of main's could still hold the app's tools, so the turn that reads it has no dead tools to try.
 *
 * The refresher reports a refused grant under the app's lock, so a report only records what is owed; checks here
 * deliver it. Its id names the app and the refused generation: repeated refusals of one grant are one note, and a
 * grant that breaks again after a reconnect is a new one.
 */
import { getContainerConfigReadAtMs, getSpawningConfigReadAtMs, isContainerRunning } from '../../container-runner.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { log } from '../../log.js';
import { readMainAgentGroupId } from '../gws-ea-profile/db.js';
import { writeNoteForMain, type NoteForMain, type NoteForMainResult } from '../gws-ea-profile/main-note.js';
import { createPendingPoller } from './poller.js';
import type { RefusedApp } from './refresher.js';
import { ConnectionsStoreError, type ConnectionApp, type ConnectionsStore } from './store.js';

export const NOTE_CHECK_INTERVAL_MS = 5_000;

export function reconnectNoteId(app: RefusedApp): string {
  return `connection-reconnect:${app.appId}:${app.generation}`;
}

interface Owed extends RefusedApp {
  /** When main's servers were first read without the app: a container that read its own later never held it. */
  readonly droppedAt?: number;
  /** The failure last logged for this note: one that keeps failing the same way is logged once. */
  readonly failure?: string;
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

async function mainServerKeys(agentGroupId: string): Promise<ReadonlySet<string>> {
  const row = await getContainerConfig(agentGroupId);
  const parsed: unknown = row ? JSON.parse(row.mcp_servers) : {};
  return new Set(typeof parsed === 'object' && parsed !== null ? Object.keys(parsed) : []);
}

/**
 * A container that read its configuration before the app left it may still hold the app, whether it runs or is
 * still starting; one this host adopted may hold anything a previous host gave it.
 */
async function anyHolding(agentGroupId: string, droppedAt: number): Promise<boolean> {
  for (const session of await getSessionsByAgentGroup(agentGroupId)) {
    const startingReadAt = getSpawningConfigReadAtMs(session.id);
    if (startingReadAt !== undefined && startingReadAt <= droppedAt) return true;
    if (!isContainerRunning(session.id)) continue;
    const readAt = getContainerConfigReadAtMs(session.id);
    if (readAt === undefined || readAt <= droppedAt) return true;
  }
  return false;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error && typeof error.code === 'string'
    ? error.code
    : undefined;
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
    const mainId = await readMainAgentGroupId();
    if (mainId !== null) {
      if ((await mainServerKeys(mainId)).has(app.serverKey))
        return { appId: entry.appId, generation: entry.generation };
      const droppedAt = entry.droppedAt ?? now();
      if (await anyHolding(mainId, droppedAt)) return { appId: entry.appId, generation: entry.generation, droppedAt };
    }
    await write({
      id: reconnectNoteId(entry),
      timestamp: new Date(now()).toISOString(),
      text: noteText(app),
      wake: false,
    });
    return undefined;
  }

  /**
   * Keeps a note that failed owed, so it neither blocks the others nor is lost. Only the error's name and code are
   * logged: a parse error's message can quote main's stored servers, credentials included.
   */
  function failed(entry: Owed, error: unknown): Owed {
    const name = error instanceof Error ? error.name : typeof error;
    const code = error instanceof ConnectionsStoreError ? error.reason : errorCode(error);
    const failure = `${name}:${code ?? ''}`;
    if (entry.failure !== failure) {
      if (error instanceof ConnectionsStoreError)
        log.warn('Reconnect note waits on the connections store', { appId: entry.appId, code });
      else log.error('Reconnect note not delivered; it stays owed', { appId: entry.appId, name, code });
    }
    return { ...entry, failure };
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
          // eslint-disable-next-line no-catch-all/no-catch-all -- one note's failure, logged by name, must not block the others
        } catch (error) {
          next = failed(entry, error);
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

const delivery = createPendingPoller<ReconnectNotes>({
  intervalMs: NOTE_CHECK_INTERVAL_MS,
  run: (notes) => notes.deliver(),
  onError: (err) => log.error('Reconnect notes check failed', { err }),
});

/**
 * Arms delivery for this host and owes again every grant the store still holds refused, so a note a previous host
 * owed but never wrote is not lost; one it did write keeps its id and is not written twice.
 */
export async function startReconnectNotes(
  store: ConnectionsStore,
  signal: AbortSignal,
  dependencies: ReconnectNotesDependencies = {},
): Promise<void> {
  if (signal.aborted) return;
  const notes = createReconnectNotes(store, dependencies);
  delivery.arm(notes, signal);
  let refused: readonly RefusedApp[];
  try {
    refused = await store.refusedGrants();
  } catch (error) {
    if (!(error instanceof ConnectionsStoreError)) throw error;
    log.warn('Reconnect notes not owed again: the connections store is unavailable', { code: error.reason });
    return;
  }
  if (delivery.current() !== notes || signal.aborted || refused.length === 0) return;
  for (const app of refused) notes.owe(app);
  delivery.soon();
}

/** The refresher's `onRefused`: records the note and checks now, then every few seconds while one is owed. */
export function oweReconnectNote(app: RefusedApp): void {
  const notes = delivery.current();
  if (!notes) return;
  notes.owe(app);
  delivery.soon();
}

/** Stops new checks and waits for one in flight. */
export function stopReconnectNotes(): Promise<void> {
  return delivery.stop();
}
