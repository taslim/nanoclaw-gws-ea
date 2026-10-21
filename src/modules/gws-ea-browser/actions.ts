import type { Page } from 'playwright-core';
import type { ResponseFrame } from '../../cli/frame.js';
import type { Session } from '../../types.js';
import type { BrowserStore, BrowserJob, BrowserRequest } from './db.js';
import type { BrowserRuntime } from './runtime.js';

interface BrowserContext {
  readonly job: BrowserJob;
  readonly session: Session;
  readonly signal: AbortSignal;
  readonly deadline: number;
  readonly store: BrowserStore;
  readonly runtime: Pick<BrowserRuntime, 'pageForJob' | 'connection' | 'closeJob' | 'onDisconnected'>;
  page(): Promise<Page>;
  /** Queued executors already own the exclusive job lock. Check again after any external wait. */
  assertActive(): Promise<void>;
  wakeWaiters(jobIds: readonly string[], eventId: string): Promise<void>;
  remaining(): number;
}

export interface BrowserExecutionContext extends BrowserContext {
  readonly kind: 'request';
  readonly request: Pick<BrowserRequest, 'id'>;
  markCommitStarted(): Promise<void>;
}

export interface BrowserWatchExecutionContext extends BrowserContext {
  readonly kind: 'watch_check';
  readonly check: { readonly id: string };
}

export type BrowserOperationContext = BrowserExecutionContext | BrowserWatchExecutionContext;

export function browserOperationId(context: BrowserOperationContext): string {
  return context.kind === 'watch_check' ? context.check.id : context.request.id;
}

export interface BrowserQueuedAction {
  validate(content: Record<string, unknown>): Record<string, unknown>;
  execute(context: BrowserExecutionContext, payload: Record<string, unknown>): Promise<Record<string, unknown>>;
  /** Host-only deferred callers receive every durable terminal outcome, including recovery and timeout. */
  deliverAnswer?(request: BrowserRequest, frame: ResponseFrame): Promise<void>;
  /**
   * The durable outcome of a request its worker cannot answer from its own
   * result (a crash, interruption, timeout or failure), recorded before the
   * answer. Undefined leaves the generic stop. Never a reason to run again.
   */
  recover?(request: BrowserRequest): Promise<Record<string, unknown> | undefined>;
  budgetMs?: number;
}

export type BrowserActionName =
  | 'browser'
  | 'fill_secret'
  | 'credential_form'
  | 'sign_in_code'
  | 'browser_relay_sign_in'
  | 'save_recipe'
  | 'run_recipe'
  | 'request_consent'
  | 'purchase'
  | 'browser_purchase_commit'
  | 'watch'
  | 'list_watches'
  | 'cancel_watch'
  | 'browser_watch_book';

export type BrowserActions = Readonly<Record<BrowserActionName, BrowserQueuedAction>>;
