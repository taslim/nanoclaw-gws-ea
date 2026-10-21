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
import { log } from '../../log.js';
import { clearOutbox } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  BrowserExecutionError,
  type BrowserActionName,
  type BrowserActions,
  type BrowserExecutionContext,
} from './actions.js';
import { BrowserOperation } from './operation.js';
import { BrowserStore, markBrowserRequestCommitStarted, type BrowserRequest } from './db.js';
import { SiteLeaseStore } from './leases.js';
import { readBrowserPolicy } from './policy.js';
import { reconcileBrowserGroup } from './reconcile.js';
import { writeBrowserNotice } from './notices.js';
import { browserAdmissionReady } from './group.js';
import { BrowserDiagnosticAttempt } from './diagnostics.js';

export const BROWSER_REQUEST_BUDGET_MS = 90_000;
export const BROWSER_REQUEST_MAX_BUDGET_MS = 100_000;

export const browserRequestGuard = defineGuardedAction({
  action: 'gws_ea_browser.request',
  async decide({ actor }) {
    if (actor.kind !== 'agent' || !actor.sessionId) return DENY('Only a live browser job may use the host browser.');
    if (!(await readBrowserPolicy()).enabled)
      return DENY('The operator needs to enable the browser for this assistant.');
    if (!browserAdmissionReady())
      return DENY('The browser is temporarily unavailable; the operator can check browser health.');
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

export function registerBrowserActionDelivery(name: BrowserActionName, queue: () => BrowserQueue): void {
  registerDeliveryAction(
    name,
    answeringAction(name, async (content, session, requestId) => {
      await reconcileBrowserGroup();
      await queue().accept(name, content, session, requestId);
      return ANSWER_LATER;
    }),
    answeredGuard(browserRequestGuard),
  );
}

export interface BrowserQueueFollowUps {
  finishRequestedCancellation(jobId: string, queue: BrowserQueue): Promise<void>;
  settleRefusedSites(queue: BrowserQueue, jobId: string): Promise<void>;
  recordUnknownBrowserPurchaseRequest(requestId: string): Promise<void>;
}

/** Durable acceptance is synchronous with delivery; every browser wait is outside it. */
export class BrowserQueue {
  private ready = false;
  private stopping = false;
  private readonly drains = new Map<string, Promise<void>>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private readonly running = new Map<string, BrowserOperation>();
  private readonly diagnosticAttempts = new Map<string, BrowserDiagnosticAttempt>();
  private disconnect: (() => void) | undefined;
  readonly leases: SiteLeaseStore;

  constructor(
    readonly store: BrowserStore,
    readonly runtime: BrowserExecutionContext['runtime'],
    private readonly actions: BrowserActions,
    private readonly followUps: BrowserQueueFollowUps,
  ) {
    this.leases = new SiteLeaseStore(store.db);
  }

  private action(name: string) {
    return Object.hasOwn(this.actions, name) ? this.actions[name as BrowserActionName] : undefined;
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
    const action = this.action(name);
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
    this.disconnect = this.runtime.onDisconnected(() => {
      void this.interruptRunning().catch(() =>
        log.warn('Browser requests could not be interrupted', { reason: 'interruption_failed' }),
      );
    });
    this.ready = true;
    for (const request of await this.store.pending()) this.wake(request.job_id);
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.ready = false;
    this.disconnect?.();
    this.disconnect = undefined;
    try {
      await this.interruptRunning();
    } finally {
      await this.idle();
    }
  }

  async idle(): Promise<void> {
    while (this.drains.size) {
      const settled = await Promise.allSettled([...this.drains.values()]);
      const failed = settled.find((result) => result.status === 'rejected');
      if (failed?.status === 'rejected') throw failed.reason;
    }
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

  /** A periodic read never queues behind an errand or a checkout-owning worker. */
  tryWithJobLocks<T>(
    jobIds: readonly string[],
    operation: () => Promise<T>,
  ): Promise<{ acquired: true; value: T } | { acquired: false }> {
    const ids = [...new Set(jobIds)].sort();
    if (ids.some((id) => this.locks.has(id))) return Promise.resolve({ acquired: false });
    const result = Promise.resolve().then(operation);
    for (const id of ids) this.locks.set(id, result);
    void result
      .finally(() => {
        for (const id of ids) if (this.locks.get(id) === result) this.locks.delete(id);
      })
      .catch(() => undefined);
    return result.then((value) => ({ acquired: true, value }));
  }

  private async contextForRequest(
    id: string,
    operation: BrowserOperation,
  ): Promise<BrowserExecutionContext | undefined> {
    const request = await this.store.request(id);
    if (!request) return undefined;
    const job = await this.store.getJob(request.job_id);
    const session = await getSession(request.session_id);
    if (!job || !session) return undefined;
    const assertActive = async (): Promise<void> => {
      operation.assertActive();
      const current = await this.store.request(id);
      const liveJob = await this.store.getJob(job.id);
      operation.assertActive();
      if (!current || current.answered_at || !liveJob || liveJob.cancelled)
        throw new Error('Browser request is no longer active');
    };
    return {
      kind: 'request',
      job,
      request,
      session,
      signal: operation.signal,
      deadline: operation.deadline,
      store: this.store,
      runtime: this.runtime,
      page: async () => {
        await assertActive();
        const page = await this.runtime.pageForJob(job.id);
        operation.ownPage(page);
        await assertActive();
        this.diagnosticAttempts.get(id)?.observe(page);
        return page;
      },
      assertActive,
      wakeWaiters: (jobIds, eventId) => this.wakeWaiters(jobIds, eventId),
      markCommitStarted: async () => {
        await assertActive();
        await markBrowserRequestCommitStarted(this.store.db, request.id);
      },
      remaining: operation.remaining,
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
      // Re-running it could repeat an action; only durable records determine uncertainty.
      await this.finish(current, await this.interruptedAnswer(current, false));
      await this.releaseJobLeases(current.job_id, current.id);
      return;
    }
    const operation = new BrowserOperation(Date.parse(request.accepted_at) + request.budget_ms, () =>
      this.runtime.closeJob(request.job_id),
    );
    const context = await this.contextForRequest(request.id, operation);
    if (!context) {
      await operation.finish();
      await this.finish(request, stopped('interrupted', true));
      return;
    }
    if (context.job.cancelled) {
      await operation.finish();
      await this.finish(started, stopped('interrupted', true));
      return;
    }
    if (!context.remaining()) {
      await operation.finish();
      await this.finish(started, stopped('timeout', true));
      return;
    }
    this.running.set(request.id, operation);
    const diagnostics = new BrowserDiagnosticAttempt({
      jobId: request.job_id,
      requestId: request.id,
      action: request.action,
    });
    this.diagnosticAttempts.set(request.id, diagnostics);
    try {
      const action = this.action(request.action);
      if (!action) {
        await this.finish(started, stopped('interrupted', true));
        return;
      }
      const outcome = await operation.run(() =>
        action.execute(context, JSON.parse(request.payload_json) as Record<string, unknown>),
      );
      await operation.closeAbortedPage();
      const latest = await this.store.request(request.id);
      await this.finish(
        started,
        operation.signal.aborted && latest?.commit_started_at
          ? stopped('unconfirmed', false)
          : 'value' in outcome
            ? outcome.value
            : ((await action.recover?.(started)) ?? stopped(outcome.stopped, false)),
      );
    } catch (error) {
      if (!(error instanceof ActionRefusal))
        diagnostics.record({
          source: 'runtime_error',
          category:
            error instanceof Error && 'code' in error && error.code === 'browser_unavailable'
              ? 'unavailable'
              : 'execution',
        });
      const latest = await this.store.request(request.id);
      await this.finish(
        started,
        latest?.commit_started_at
          ? stopped('unconfirmed', false)
          : error instanceof ActionRefusal
            ? error
            : ((await this.action(request.action)?.recover?.(started)) ??
              (error instanceof Error && 'code' in error && error.code === 'browser_unavailable'
                ? stopped('browser_unavailable', false)
                : new BrowserExecutionError())),
      );
    } finally {
      await operation.finish();
      diagnostics.finish();
      this.diagnosticAttempts.delete(request.id);
      this.running.delete(request.id);
      await this.releaseJobLeases(request.job_id, request.id);
    }
  }

  /** After each request: sites it no longer holds go to their waiters, and a cancellation waiting on it completes. */
  private async releaseJobLeases(jobId: string, eventId: string): Promise<void> {
    try {
      await this.wakeWaiters(await this.leases.releaseUnheldPurchases(jobId), `${eventId}:purchase-holds`);
      const leases = await this.store.db.all<{ site: string }>(
        "SELECT site FROM gws_ea_browser_site_leases WHERE job_id = ? AND state <> 'purchase'",
        jobId,
      );
      for (const lease of leases)
        await this.wakeWaiters(await this.leases.release(jobId, lease.site), `${eventId}:${lease.site}`);
    } finally {
      try {
        await this.followUps.finishRequestedCancellation(jobId, this);
      } finally {
        this.settleRefusedSites(jobId);
      }
    }
  }

  /**
   * A job refused a site waits on it. When another job holds that site only
   * for a confirmed credential attempt, which waits on 1Password alone, it
   * settles now without that job, so the site can go to its waiters. No
   * provider call holds up this job's queue.
   */
  private settleRefusedSites(jobId: string): void {
    void this.followUps
      .settleRefusedSites(this, jobId)
      .catch(() => log.warn('A held credential site could not be settled', { reason: 'settlement_failed' }));
  }

  /**
   * The answer for a request its worker can no longer answer from its own
   * result: unconfirmed after a purchase commit marker, else the action's own
   * recorded outcome, else interrupted.
   */
  async interruptedAnswer(request: BrowserRequest, repeatSafe: boolean): Promise<Record<string, unknown>> {
    if (request.commit_started_at) return stopped('unconfirmed', false);
    return (await this.action(request.action)?.recover?.(request)) ?? stopped('interrupted', repeatSafe);
  }

  async wakeWaiters(jobIds: readonly string[], eventId: string): Promise<void> {
    for (const jobId of jobIds) {
      this.wake(jobId);
      const job = await this.store.getJob(jobId);
      const session = job && !job.cancelled ? await getSession(job.browser_session_id) : undefined;
      if (!session || session.status !== 'active') continue;
      try {
        await writeBrowserNotice(
          session,
          `browser-site-${Buffer.from(`${eventId}\0${jobId}`).toString('base64url')}`,
          JSON.stringify({
            type: 'browser_site_available',
            job: jobId,
            message: 'A site you were waiting for is available. Continue the errand from a fresh observation.',
          }),
        );
      } catch (error) {
        if (!isUniqueViolation(error)) throw error;
      }
      void wakeContainer(session).catch(() => undefined);
    }
  }

  async finish(
    request: BrowserRequest,
    result: Record<string, unknown> | ActionRefusal | BrowserExecutionError,
  ): Promise<void> {
    const at = new Date().toISOString();
    const latest = await this.store.request(request.id);
    if (!latest) return;
    if (
      latest.commit_started_at &&
      !(result instanceof ActionRefusal) &&
      !(result instanceof BrowserExecutionError) &&
      (result.status === 'unconfirmed' || result.reason === 'unconfirmed')
    ) {
      await this.followUps.recordUnknownBrowserPurchaseRequest(request.id);
    }
    const diagnostics = this.diagnosticAttempts.get(request.id)?.finish();
    this.diagnosticAttempts.delete(request.id);
    const frame: ResponseFrame =
      result instanceof ActionRefusal || result instanceof BrowserExecutionError
        ? {
            id: request.request_id,
            ok: false,
            error: { code: result instanceof ActionRefusal ? result.code : 'handler-error', message: result.message },
          }
        : {
            id: request.request_id,
            ok: true,
            data: {
              ...result,
              ...(diagnostics && diagnostics.events.length ? { diagnostics } : {}),
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
      const frame = JSON.parse(request.answer_json) as ResponseFrame;
      await writeActionResponse(session, request.request_id, frame);
      await this.action(request.action)?.deliverAnswer?.(request, frame);
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

  /** Call after the cancellation transaction, outside every DB lock. `running` answers for itself. */
  async interruptJob(jobId: string, running?: string): Promise<void> {
    for (const request of await this.store.pending(jobId)) {
      if (request.id === running) continue;
      this.running.get(request.id)?.abort('interrupted');
      await this.runtime.closeJob(jobId).catch(() => undefined);
      await this.finish(request, await this.interruptedAnswer(request, !request.started_at));
    }
  }

  async interruptRunning(): Promise<void> {
    const interrupted = await Promise.allSettled(
      [...this.running].map(async ([id, operation]) => {
        operation.abort('interrupted');
        const request = await this.store.request(id);
        if (!request) return;
        await operation.closeAbortedPage();
        await this.finish(request, await this.interruptedAnswer(request, false));
      }),
    );
    const failed = interrupted.find((result) => result.status === 'rejected');
    if (failed?.status === 'rejected') throw failed.reason;
  }
}

export function stopped(reason: string, repeatSafe: boolean): Record<string, unknown> {
  return { status: 'stopped', reason, repeat_safe: repeatSafe };
}
