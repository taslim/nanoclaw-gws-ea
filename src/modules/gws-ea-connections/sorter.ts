import { randomUUID } from 'node:crypto';

import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { DEFAULT_MODEL } from '../../config.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { isUniqueViolation } from '../../db/errors.js';
import { getSession } from '../../db/sessions.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { log as hostLog } from '../../log.js';
import { requestWake } from '../../request-wake.js';
import { resolveSystemSession, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-external-email/index.js';
import type { ToolDefinition } from './canonical.js';
import { buildSortPrompt, resolveFinalToolUpdates, sorterVersion, type ParsedSortToolEntry } from './sort-rules.js';
import { ConnectionsStoreError, type ConnectionsStore, type PinnedAppTool } from './store.js';

export {
  buildSortPrompt,
  evaluateToolFloors,
  FLOOR_VERBS,
  PASSTHROUGH_TOKENS,
  READ_EXEMPT_NOUN_VERBS,
  READ_LEADING_VERBS,
  resolveFinalToolUpdates,
  SORTER_PROMPT_HASH,
  SORTER_PROMPT_TEXT,
  sorterVersion,
  tokenizeToolName,
  type ParsedSortToolEntry,
  type ToolFloorResult,
} from './sort-rules.js';

export const SORT_TOOLS_ACTION = 'sort_tools';
export const APP_SORT_THREAD_PREFIX = 'system:gws-ea-app-sort:';
export const DEFAULT_SORT_TIMEOUT_MS = 120_000;
export const DEFAULT_MAX_SORT_ATTEMPTS = 3;
const REASON_MAX = 200;

function parseSortToolsPayload(content: Record<string, unknown>): readonly ParsedSortToolEntry[] {
  const allowedTopKeys = new Set(['action', 'requestId', 'tools']);
  if (Object.keys(content).some((key) => !allowedTopKeys.has(key))) {
    throw invalidArgs('sort_tools accepts only the tools array.');
  }
  const rawTools = content.tools;
  if (!Array.isArray(rawTools)) {
    throw invalidArgs('tools must be an array of tool labels.');
  }
  const allowedEntryKeys = new Set(['name', 'definition_hash', 'label', 'reason']);
  const entries: ParsedSortToolEntry[] = [];
  for (const raw of rawTools) {
    if (!isRecord(raw) || Object.keys(raw).some((key) => !allowedEntryKeys.has(key))) {
      throw invalidArgs('Each tool entry must contain only name, definition_hash, label, and reason.');
    }
    const { name, definition_hash: definitionHash, label, reason } = raw;
    if (typeof name !== 'string' || !name.trim()) {
      throw invalidArgs('Each tool entry requires a non-empty name.');
    }
    if (typeof definitionHash !== 'string' || !definitionHash.trim()) {
      throw invalidArgs('Each tool entry requires a non-empty definition_hash.');
    }
    if (label !== 'ask_first' && label !== 'just_do') {
      throw invalidArgs('label must be ask_first or just_do.');
    }
    if (typeof reason !== 'string' || !reason.trim() || hasControlCharacters(reason.replace(/\s+/gu, ' '))) {
      throw invalidArgs('Each tool entry requires a one-line plain-language reason.');
    }
    entries.push({
      name: name.trim(),
      definitionHash: definitionHash.trim(),
      label,
      reason: reason.replace(/\s+/gu, ' ').trim().slice(0, REASON_MAX),
    });
  }
  return entries;
}

interface PendingSort {
  readonly sortId: string;
  readonly appId: string;
  readonly listHash: string;
  readonly sessionId: string;
  readonly threadId: string;
  readonly sorterVersion: string;
  readonly expected: ReadonlyMap<string, { readonly definitionHash: string; readonly definition: ToolDefinition }>;
  readonly waiters: Array<() => void>;
  readonly claim: () => boolean;
  readonly finish: () => void;
}

interface QueuedSortJob {
  readonly appId: string;
  readonly listHash?: string;
  readonly waiters: Array<() => void>;
}

export interface AppToolSorterDependencies {
  readonly store: ConnectionsStore;
  readonly timeoutMs?: number;
  readonly maxAttempts?: number;
  readonly signal?: AbortSignal;
  readonly now?: () => number;
}

export interface AppToolSorter {
  enqueue(appId: string, listHash?: string): Promise<void>;
  enqueuePending(): Promise<void>;
  handleSortToolsReply(
    content: Record<string, unknown>,
    session: Session,
  ): Promise<{ readonly status: 'accepted'; readonly labelled: number; readonly unsettled: number }>;
  stop(): Promise<void>;
}

export function createAppToolSorter(dependencies: AppToolSorterDependencies): AppToolSorter {
  const { store } = dependencies;
  const timeoutMs = dependencies.timeoutMs ?? DEFAULT_SORT_TIMEOUT_MS;
  const maxAttempts = dependencies.maxAttempts ?? DEFAULT_MAX_SORT_ATTEMPTS;
  const now = dependencies.now ?? Date.now;

  const queue: QueuedSortJob[] = [];
  let running = false;
  let stopped = false;
  let activeSort: PendingSort | undefined;
  let drainPromise: Promise<void> | undefined;

  async function resolveExternalEmailModel(groupId: string): Promise<string> {
    const config = await getContainerConfig(groupId);
    return config?.model ?? (DEFAULT_MODEL || 'default');
  }

  async function failTargets(pending: PendingSort, status: 'failed' | 'timed_out'): Promise<void> {
    const at = new Date(now()).toISOString();
    const targets = [...pending.expected.entries()].map(([name, info]) => ({
      name,
      definitionHash: info.definitionHash,
    }));
    await store.markToolSortFailed(pending.appId, targets, {
      maxAttempts,
      sorterVersion: pending.sorterVersion,
      at,
    });
    await store.finishToolSort(pending.sortId, status, at);
  }

  async function runOneSort(job: QueuedSortJob): Promise<void> {
    if (stopped || dependencies.signal?.aborted) return;
    let pin: Awaited<ReturnType<ConnectionsStore['getPin']>>;
    let allTools: readonly PinnedAppTool[];
    try {
      const app = await store.get(job.appId);
      if (app.status !== 'connected') return;
      pin = await store.getPin(job.appId);
      if (!pin) return;
      allTools = await store.listTools(job.appId);
    } catch (error) {
      if (error instanceof ConnectionsStoreError) return;
      throw error;
    }

    const targets = allTools.filter((tool) => tool.label === null || tool.unsettled);
    if (targets.length === 0) return;

    const attempt = Math.max(...targets.map((tool) => tool.sortAttempts), 0) + 1;
    if (attempt > maxAttempts) return;

    const groupId = await getExternalEmailAgentGroupId();
    if (!groupId) {
      await store.markToolSortFailed(
        job.appId,
        targets.map((t) => ({ name: t.name, definitionHash: t.definitionHash })),
        { maxAttempts, at: new Date(now()).toISOString() },
      );
      return;
    }

    const model = await resolveExternalEmailModel(groupId);
    const version = sorterVersion(model);
    const threadId = `${APP_SORT_THREAD_PREFIX}${job.appId}:${pin.listHash}`;
    const { session } = await resolveSystemSession(groupId, threadId);
    const sortId = `sort-${randomUUID()}`;
    const startedAt = new Date(now()).toISOString();

    await store.recordToolSortStart({
      id: sortId,
      appId: job.appId,
      listHash: pin.listHash,
      sorterVersion: version,
      attempt,
      at: startedAt,
    });

    const expected = new Map(
      targets.map((tool) => [tool.name, { definitionHash: tool.definitionHash, definition: tool.definition }]),
    );

    await new Promise<void>((resolve) => {
      let claimed = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const waiters: Array<() => void> = [];

      const onAbort = (): void => {
        if (pending.claim()) pending.finish();
      };

      const pending: PendingSort = {
        sortId,
        appId: job.appId,
        listHash: pin.listHash,
        sessionId: session.id,
        threadId,
        sorterVersion: version,
        expected,
        waiters,
        claim: () => {
          if (claimed) return false;
          claimed = true;
          if (timer) {
            clearTimeout(timer);
            timer = undefined;
          }
          dependencies.signal?.removeEventListener('abort', onAbort);
          if (activeSort === pending) activeSort = undefined;
          return true;
        },
        finish: () => {
          for (const notify of waiters.splice(0)) notify();
          resolve();
        },
      };
      activeSort = pending;

      if (stopped || dependencies.signal?.aborted) {
        if (pending.claim()) pending.finish();
        return;
      }

      dependencies.signal?.addEventListener('abort', onAbort, { once: true });

      timer = setTimeout(() => {
        if (!pending.claim()) return;
        void failTargets(pending, 'timed_out')
          .catch((error: unknown) => {
            hostLog.warn('Could not record timed-out app tool sort', { appId: job.appId, error });
          })
          .finally(() => pending.finish());
      }, timeoutMs);
      timer.unref?.();

      const promptText = buildSortPrompt(targets);
      void (async () => {
        try {
          try {
            await writeSessionMessage(groupId, session.id, {
              id: `app-sort-${pin.listHash}-${attempt}`,
              kind: 'chat',
              timestamp: startedAt,
              content: JSON.stringify({ text: promptText, sender: 'system' }),
              trigger: true,
            });
          } catch (error) {
            if (!isUniqueViolation(error)) throw error;
          }
          await requestWake(session, 'inbound-message');
          /* eslint-disable-next-line no-catch-all/no-catch-all -- wake failure marks sort failed and unblocks queue */
        } catch (error) {
          hostLog.warn('Could not wake app tool sorter session', { appId: job.appId, error });
          if (pending.claim()) {
            await failTargets(pending, 'failed').catch(() => undefined);
            pending.finish();
          }
        }
      })();
    });
  }

  function kickQueue(): void {
    if (running || stopped) return;
    running = true;
    drainPromise = (async () => {
      try {
        while (!stopped && !dependencies.signal?.aborted && queue.length > 0) {
          const next = queue.shift()!;
          try {
            await runOneSort(next);
            /* eslint-disable-next-line no-catch-all/no-catch-all -- isolate one failed sort job from the queue */
          } catch (error) {
            hostLog.warn('App tool sort failed unexpectedly', { appId: next.appId, error });
          } finally {
            for (const notify of next.waiters) notify();
          }
        }
      } finally {
        running = false;
        drainPromise = undefined;
      }
    })();
  }

  return {
    enqueue(appId: string, listHash?: string): Promise<void> {
      if (stopped || dependencies.signal?.aborted) return Promise.resolve();
      return new Promise<void>((resolve) => {
        if (activeSort && activeSort.appId === appId && (listHash === undefined || activeSort.listHash === listHash)) {
          activeSort.waiters.push(resolve);
          return;
        }
        const existing = queue.find(
          (item) => item.appId === appId && (item.listHash === listHash || listHash === undefined),
        );
        if (existing) {
          existing.waiters.push(resolve);
        } else {
          queue.push({ appId, listHash, waiters: [resolve] });
        }
        kickQueue();
      });
    },

    async enqueuePending(): Promise<void> {
      if (stopped || dependencies.signal?.aborted) return;
      let pendingApps: readonly { readonly appId: string; readonly listHash: string }[];
      try {
        pendingApps = await store.appsNeedingSort();
      } catch (error) {
        if (error instanceof ConnectionsStoreError) return;
        throw error;
      }
      for (const entry of pendingApps) {
        void this.enqueue(entry.appId, entry.listHash);
      }
    },

    async handleSortToolsReply(
      content: Record<string, unknown>,
      session: Session,
    ): Promise<{ readonly status: 'accepted'; readonly labelled: number; readonly unsettled: number }> {
      const groupId = await getExternalEmailAgentGroupId();
      if (!groupId || session.agent_group_id !== groupId) {
        throw forbidden('Only the isolated tool sorter may call sort_tools.');
      }
      if (
        session.messaging_group_id !== null ||
        !session.thread_id ||
        !session.thread_id.startsWith(APP_SORT_THREAD_PREFIX)
      ) {
        throw forbidden('sort_tools is only accepted from an active tool-sorting session.');
      }
      const current = await getSession(session.id);
      const pending = activeSort;
      if (
        !pending ||
        pending.sessionId !== session.id ||
        pending.threadId !== session.thread_id ||
        current?.status !== 'active' ||
        current.agent_group_id !== groupId ||
        current.messaging_group_id !== null ||
        current.thread_id !== session.thread_id
      ) {
        throw forbidden('No active tool sort matches this session.');
      }

      let entries: readonly ParsedSortToolEntry[];
      try {
        entries = parseSortToolsPayload(content);
      } catch (error) {
        if (pending.claim()) {
          await failTargets(pending, 'failed');
          pending.finish();
        }
        throw error;
      }

      if (!pending.claim()) {
        throw forbidden('No active tool sort matches this session.');
      }

      const at = new Date(now()).toISOString();
      const { updates, missing } = resolveFinalToolUpdates(pending.expected, entries);
      if (updates.length > 0) {
        await store.applyToolLabels(pending.appId, updates, {
          sorterVersion: pending.sorterVersion,
          at,
        });
      }
      if (missing.length > 0) {
        await store.markToolSortFailed(pending.appId, missing, {
          maxAttempts,
          sorterVersion: pending.sorterVersion,
          at,
        });
      }
      await store.finishToolSort(pending.sortId, missing.length === 0 ? 'completed' : 'failed', at);
      pending.finish();
      return { status: 'accepted', labelled: updates.length, unsettled: missing.length };
    },

    async stop(): Promise<void> {
      stopped = true;
      const pending = activeSort;
      if (pending?.claim()) pending.finish();
      while (queue.length > 0) {
        const job = queue.shift()!;
        for (const notify of job.waiters) notify();
      }
      if (drainPromise) await drainPromise;
    },
  };
}

export const sortToolsGuard = defineGuardedAction({
  action: 'gws_ea_connections.sort_tools',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getExternalEmailAgentGroupId())
      ? ALLOW('The isolated external-email tool sorter answers its own sort task.')
      : DENY('Only the isolated tool sorter may call sort_tools.');
  },
});

let activeSorter: AppToolSorter | undefined;

export function getAppToolSorter(): AppToolSorter | undefined {
  return activeSorter;
}

export function startAppToolSorter(dependencies: AppToolSorterDependencies): AppToolSorter {
  const sorter = createAppToolSorter(dependencies);
  activeSorter = sorter;
  return sorter;
}

export async function stopAppToolSorter(): Promise<void> {
  const current = activeSorter;
  activeSorter = undefined;
  if (current) await current.stop();
}

export function registerSortToolsAction(
  dependencies: { readonly sorter: () => AppToolSorter | undefined } = { sorter: getAppToolSorter },
): void {
  registerDeliveryAction(
    SORT_TOOLS_ACTION,
    answeringAction(SORT_TOOLS_ACTION, async (content, session) => {
      const sorter = dependencies.sorter();
      if (!sorter) throw forbidden('The app tool sorter is not running.');
      return sorter.handleSortToolsReply(content, session);
    }),
    answeredGuard(sortToolsGuard),
  );
}
