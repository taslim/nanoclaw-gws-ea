import type { Page } from 'playwright-core';

import {
  ANSWER_LATER,
  ActionRefusal,
  answeredGuard,
  answeringAction,
  forbidden,
  invalidArgs,
  writeActionResponse,
} from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { getSession } from '../../db/sessions.js';
import { wakeContainer } from '../../container-runner.js';
import { isUniqueViolation } from '../../db/errors.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { clearOutbox, writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import { BrowserStore, markBrowserRequestCommitStarted, type BrowserJob, type BrowserRequest } from './db.js';
import type { BrowserRuntime } from './index.js';
import { SiteLeaseStore } from './leases.js';
import { sweepBrowserStartup } from './start-sweep.js';

export const BROWSER_REQUEST_BUDGET_MS = 90_000;
export const BROWSER_REQUEST_MAX_BUDGET_MS = 100_000;

export interface BrowserExecutionContext {
  readonly job: BrowserJob;
  readonly request: BrowserRequest;
  readonly session: Session;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly store: BrowserStore;
  readonly runtime: Pick<BrowserRuntime, 'pageForJob' | 'connection' | 'closeJob' | 'onDisconnected'>;
  page(): Promise<Page>;
  /** Queued executors already own the exclusive job lock. Check again after any external wait. */
  assertActive(): Promise<void>;
  wakeWaiters(jobIds: readonly string[], eventId: string): Promise<void>;
  markCommitStarted(): Promise<void>;
  remaining(): number;
}

export interface BrowserQueuedAction {
  validate(content: Record<string, unknown>): Record<string, unknown>;
  execute(context: BrowserExecutionContext, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  budgetMs?: number;
}

const actions = new Map<string, BrowserQueuedAction>();

/** Each module registers its native action; absent capabilities have no executable action. */
export function registerBrowserQueuedAction(name: string, action: BrowserQueuedAction): void {
  if (actions.has(name)) throw new Error(`Browser action already registered: ${name}`);
  actions.set(name, action);
}

export const browserRequestGuard = defineGuardedAction({
  action: 'gws_ea_browser.request',
  async decide({ actor }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('Only a live browser job may use the host browser.');
    const session = await getSession(actor.sessionId);
    if (
      !session ||
      session.agent_group_id !== actor.agentGroupId ||
      !(await new BrowserStore().jobForSession(session))
    ) {
      return DENY('Only a live browser job may use the host browser.');
    }
    return ALLOW('The sealed browser group, from its own live errand session.');
  },
});

export function registerBrowserActionDelivery(name: string, queue: () => BrowserQueue): void {
  registerDeliveryAction(
    name,
    answeringAction(name, async (content, session, requestId) => {
      await queue().accept(name, content, session, requestId);
      return ANSWER_LATER;
    }),
    answeredGuard(browserRequestGuard),
  );
}

/** Durable acceptance is synchronous with delivery; every browser wait is outside it. */
export class BrowserQueue {
  private ready = false;
  private stopping = false;
  private readonly drains = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, AbortController>();
  private disconnect: (() => void) | undefined;
  readonly leases: SiteLeaseStore;

  constructor(
    readonly store: BrowserStore,
    readonly runtime: BrowserExecutionContext['runtime'],
  ) {
    this.leases = new SiteLeaseStore(store.db);
  }

  async accept(name: string, content: Record<string, unknown>, session: Session, requestId: string): Promise<void> {
    const job = await this.store.jobForSession(session);
    if (!job) throw forbidden('Only a live browser job may use the host browser.');
    const existing = await this.store.db.get<BrowserRequest>(
      'SELECT * FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
      session.id,
      requestId,
    );
    if (existing) {
      this.wake(job.id);
      return;
    }
    const action = actions.get(name);
    if (!action) throw invalidArgs('Unknown browser action.');
    const payload = action.validate(content);
    const budget = content.budget_ms ?? action.budgetMs ?? BROWSER_REQUEST_BUDGET_MS;
    if (
      typeof budget !== 'number' ||
      !Number.isInteger(budget) ||
      budget < 1 ||
      budget > BROWSER_REQUEST_MAX_BUDGET_MS
    ) {
      throw invalidArgs(`budget_ms must be between 1 and ${BROWSER_REQUEST_MAX_BUDGET_MS}.`);
    }
    try {
      if (await this.store.accept(job, session, requestId, name, payload, budget)) this.wake(job.id);
    } catch (_error) {
      // Filesystem/DB error messages may contain host paths or request material.
      throw invalidArgs('The host could not durably accept this browser request; it is safe to retry.');
    }
  }

  /** Approval/relay workers create a fresh bounded attempt, never revive an answered tool request. */
  async enqueueInternal(
    jobId: string,
    name: string,
    payload: Record<string, unknown>,
    requestId: string,
  ): Promise<void> {
    const job = await this.store.getJob(jobId);
    const session = job ? await getSession(job.browser_session_id) : undefined;
    if (!job || !session || job.cancelled || !(await this.store.jobForSession(session, false)))
      throw forbidden('Only a live browser job may use the host browser.');
    await this.accept(name, payload, session, requestId);
  }

  async start(): Promise<void> {
    if (this.ready) return;
    this.stopping = false;
    await sweepBrowserStartup(this);
    this.disconnect = this.runtime.onDisconnected(() => {
      void this.interruptRunning();
    });
    this.ready = true;
    for (const request of await this.store.pending()) this.wake(request.job_id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.disconnect?.();
    this.disconnect = undefined;
    await this.interruptRunning();
    await this.idle();
  }

  async idle(): Promise<void> {
    while (this.drains.size) await Promise.all([...this.drains.values()]);
  }

  wake(jobId: string): void {
    if (!this.ready || this.stopping || this.drains.has(jobId)) return;
    let completed = false;
    const drain = Promise.resolve()
      .then(() => this.drain(jobId))
      .then(() => {
        completed = true;
      })
      .finally(async () => {
        this.drains.delete(jobId);
        // Only close the successful empty-read race here. Storage failures must
        // wait for the periodic sweep, rather than monopolizing the event loop.
        if (completed && this.ready && !this.stopping && (await this.store.hasPending(jobId))) this.wake(jobId);
      });
    this.drains.set(jobId, drain);
    // A durable row remains for startup recovery if the mailbox becomes unavailable.
    void drain.catch(() => undefined);
  }

  withJobLock<T>(jobId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(jobId) ?? Promise.resolve();
    const result = previous.catch(() => undefined).then(operation);
    this.locks.set(jobId, result);
    void result
      .finally(() => {
        if (this.locks.get(jobId) === result) this.locks.delete(jobId);
      })
      .catch(() => undefined);
    return result;
  }

  async contextForRequest(
    id: string,
    signal: AbortSignal = new AbortController().signal,
  ): Promise<BrowserExecutionContext | undefined> {
    const request = await this.store.request(id);
    if (!request) return undefined;
    const job = await this.store.getJob(request.job_id);
    const session = await getSession(request.session_id);
    if (!job || !session) return undefined;
    const deadline = new Date(request.accepted_at).getTime() + request.budget_ms;
    const assertActive = async (): Promise<void> => {
      if (signal.aborted || Date.now() >= deadline) throw new Error('Browser request is no longer active');
      const current = await this.store.request(id);
      const liveJob = await this.store.getJob(job.id);
      if (!current || current.answered_at || liveJob?.cancelled || signal.aborted || Date.now() >= deadline)
        throw new Error('Browser request is no longer active');
    };
    return {
      job,
      request,
      session,
      signal,
      deadline,
      store: this.store,
      runtime: this.runtime,
      page: async () => {
        await assertActive();
        const page = await this.runtime.pageForJob(job.id);
        await assertActive();
        return page;
      },
      assertActive,
      wakeWaiters: (jobIds, eventId) => this.wakeWaiters(jobIds, eventId),
      markCommitStarted: async () => {
        await assertActive();
        await markBrowserRequestCommitStarted(this.store.db, request.id);
      },
      remaining: () => Math.max(0, deadline - Date.now()),
    };
  }

  private async drain(jobId: string): Promise<void> {
    while (this.ready && !this.stopping) {
      for (const answered of await this.store.undelivered(jobId)) await this.deliver(answered);
      const next = await this.store.nextPending(jobId);
      if (!next) return;
      await this.withJobLock(jobId, () => this.execute(next));
    }
  }

  private async execute(request: BrowserRequest): Promise<void> {
    const started = await this.store.start(request.id);
    if (!started) {
      const current = await this.store.request(request.id);
      if (!current || current.answered_at) return;
      if (this.running.has(request.id)) throw new Error('Browser request is already running');
      // A prior worker started this row but failed before recording its answer.
      // Re-running it could repeat an action; only the durable marker determines uncertainty.
      await this.finish(current, stopped(current.commit_started_at ? 'outcome_unknown' : 'interrupted', false));
      await this.releaseJobLeases(current.job_id, current.id);
      return;
    }
    const controller = new AbortController();
    const context = await this.contextForRequest(request.id, controller.signal);
    if (!context) {
      await this.finish(request, stopped('interrupted', true));
      return;
    }
    if (context.job.cancelled) {
      await this.finish(started, stopped('interrupted', true));
      return;
    }
    if (!context.remaining()) {
      await this.finish(started, stopped('timeout', true));
      return;
    }
    this.running.set(request.id, controller);
    let timer: NodeJS.Timeout | undefined;
    let execution: Promise<Record<string, unknown>> | undefined;
    try {
      const timeout = new Promise<Record<string, unknown>>((resolve) => {
        timer = setTimeout(() => {
          controller.abort('timeout');
          resolve(stopped('timeout', false));
        }, context.remaining());
        timer.unref();
      });
      const action = actions.get(request.action);
      if (!action) {
        await this.finish(started, stopped('interrupted', true));
        return;
      }
      execution = action.execute(context, JSON.parse(request.payload_json) as Record<string, unknown>);
      const aborted = new Promise<Record<string, unknown>>((resolve) =>
        controller.signal.addEventListener(
          'abort',
          () => resolve(stopped(controller.signal.reason === 'timeout' ? 'timeout' : 'interrupted', false)),
          { once: true },
        ),
      );
      const result = await Promise.race([execution, timeout, aborted]);
      if (controller.signal.aborted) await this.runtime.closeJob(request.job_id);
      const latest = await this.store.request(request.id);
      await this.finish(
        started,
        controller.signal.aborted && latest?.commit_started_at ? stopped('outcome_unknown', false) : result,
      );
    } catch (error) {
      const latest = await this.store.request(request.id);
      await this.finish(
        started,
        latest?.commit_started_at
          ? stopped('outcome_unknown', false)
          : error instanceof ActionRefusal
            ? error
            : stopped('browser_unavailable', false),
      );
    } finally {
      if (timer) clearTimeout(timer);
      // An interrupted SDK call may finish late. Keep this job quarantined until it settles;
      // its assertActive checks prohibit any further interaction in the meantime.
      if (controller.signal.aborted) await execution?.catch(() => undefined);
      this.running.delete(request.id);
      await this.releaseJobLeases(request.job_id, request.id);
    }
  }

  private async releaseJobLeases(jobId: string, eventId: string): Promise<void> {
    const leases = await this.store.db.all<{ site: string }>(
      "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state <> 'purchase'",
      jobId,
    );
    for (const lease of leases)
      await this.wakeWaiters(await this.leases.release(jobId, lease.site), `${eventId}:${lease.site}`);
  }

  async wakeWaiters(jobIds: readonly string[], eventId: string): Promise<void> {
    for (const jobId of jobIds) {
      this.wake(jobId);
      const job = await this.store.getJob(jobId);
      const session = job && !job.cancelled ? await getSession(job.browser_session_id) : undefined;
      if (!session || session.status !== 'active') continue;
      try {
        await writeSessionMessage(session.agent_group_id, session.id, {
          id: `browser-site-${Buffer.from(`${eventId}\0${jobId}`).toString('base64url')}`,
          kind: 'system',
          timestamp: new Date().toISOString(),
          content: JSON.stringify({
            type: 'browser_site_available',
            job: jobId,
            message: 'A site you were waiting for is available. Continue the errand from a fresh observation.',
          }),
          trigger: true,
        });
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      void wakeContainer(session).catch(() => undefined);
    }
  }

  async finish(request: BrowserRequest, result: Record<string, unknown> | ActionRefusal): Promise<void> {
    const at = new Date().toISOString();
    const latest = await this.store.request(request.id);
    if (!latest) return;
    const frame: ResponseFrame =
      result instanceof ActionRefusal
        ? {
            id: request.request_id,
            ok: false,
            error: { code: result.code, message: result.message },
          }
        : {
            id: request.request_id,
            ok: true,
            data: {
              ...result,
              timing: { accepted_at: request.accepted_at, started_at: latest.started_at, answered_at: at },
            },
          };
    await this.store.answer(request.id, frame, at);
    const answered = await this.store.request(request.id);
    if (answered) await this.deliver(answered);
  }

  async deliver(request: BrowserRequest): Promise<void> {
    if (!request.answer_json || request.delivered_at) return;
    const session = await getSession(request.session_id);
    if (!session) return;
    try {
      await writeActionResponse(session, request.request_id, JSON.parse(request.answer_json) as ResponseFrame);
    } catch (_error) {
      return;
    } // Persisted answer remains eligible for the next mailbox retry.
    clearOutbox(session.agent_group_id, session.id, request.request_id);
    await this.store.delivered(request.id);
  }

  async retryAnswers(): Promise<void> {
    for (const request of await this.store.undelivered()) await this.deliver(request);
    for (const request of await this.store.pending()) this.wake(request.job_id);
  }

  /** Call after the cancellation transaction, outside every DB lock. */
  async interruptJob(jobId: string): Promise<void> {
    for (const request of await this.store.pending(jobId)) {
      this.running.get(request.id)?.abort('interrupted');
      await this.runtime.closeJob(jobId).catch(() => undefined);
      await this.finish(
        request,
        stopped(
          request.commit_started_at ? 'outcome_unknown' : 'interrupted',
          !request.commit_started_at && !request.started_at,
        ),
      );
    }
  }

  async interruptRunning(): Promise<void> {
    for (const [id, controller] of this.running) {
      controller.abort('interrupted');
      const request = await this.store.request(id);
      if (!request) continue;
      await this.runtime.closeJob(request.job_id).catch(() => undefined);
      await this.finish(request, stopped(request.commit_started_at ? 'outcome_unknown' : 'interrupted', false));
    }
  }
}

export function stopped(reason: string, repeatSafe: boolean): Record<string, unknown> {
  return { status: 'stopped', reason, repeat_safe: repeatSafe };
}
