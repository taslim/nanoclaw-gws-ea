import type { BrowserRef } from './observe.js';
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

export const BROWSER_ACTION_NAMES = [
  'browser',
  'fill_secret',
  'credential_form',
  'sign_in_code',
  'browser_relay_sign_in',
  'save_recipe',
  'run_recipe',
  'request_consent',
  'purchase',
  'browser_purchase_commit',
  'watch',
  'list_watches',
  'cancel_watch',
  'browser_watch_book',
] as const;

export type BrowserActionName = (typeof BROWSER_ACTION_NAMES)[number];

export type BrowserActions = Readonly<Record<BrowserActionName, BrowserQueuedAction>>;

/** Unexpected execution faults carry no page-authored or credential-bearing error payload. */
export class BrowserExecutionError extends Error {
  constructor() {
    super('The browser action failed unexpectedly.');
  }
}

export type BrowserStopReason =
  | 'stale_ref'
  | 'not_actionable'
  | 'timeout'
  | 'navigation_failed'
  | 'navigated'
  | 'purchase_control'
  | 'speaks_as_principal'
  | 'account_security'
  | 'consent_control'
  | 'consent_required'
  | 'secret_field'
  | 'card_field'
  | 'read_only'
  | 'unapproved_commit'
  | 'blocked_address'
  | 'challenge'
  | 'sign_in_wall'
  | 'site_busy'
  | 'window_closed'
  | 'browser_unavailable'
  | 'alias_unavailable'
  | 'personal_data'
  | 'interrupted';
export type BrowserAction =
  | { kind: 'navigate'; url: string }
  | { kind: 'observe' | 'screenshot' }
  | ({ kind: 'click' | 'download' } & BrowserRef)
  | ({ kind: 'type'; text: string } & BrowserRef)
  | ({ kind: 'select'; value: string } & BrowserRef)
  | ({ kind: 'key'; key: string } & BrowserRef)
  | { kind: 'scroll'; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }
  | { kind: 'wait_for'; text?: string; timeout_ms?: number }
  | { kind: 'form_input'; fields: Array<BrowserRef & { value: string }>; submit?: BrowserRef }
  | ({ kind: 'upload'; path: string } & BrowserRef);

export interface BrowserBatch {
  actions: BrowserAction[];
}
/** Host callers may replay on a signed-out page; none of these options are model inputs. */
export interface BrowserBatchOptions {
  page?: Page;
  record?: boolean;
  readOnly?: boolean;
  siteAccess?: import('./commit-classifier.js').BrowserSiteAccess;
  /** Host-only persisted targets, in the action's target order. Never converted through model refs. */
  targets?: readonly import('./locators.js').StructuredBrowserLocator[];
}
export interface BrowserActionData {
  trace_index?: number;
  image_index?: number;
  path?: string;
  filename?: string;
  bytes?: number;
}
export type BrowserActionResult = { index: number } & (
  | { status: 'not_executed' }
  | ({ status: 'completed' } & BrowserActionData)
  | {
      status: 'stopped';
      reason: BrowserStopReason;
      trace_index?: number;
      consent?: readonly import('./consent.js').ConsentStopView[];
    }
);

export function browserActionRefs(action: BrowserAction): BrowserRef[] {
  if ('ref' in action) return [action];
  return action.kind === 'form_input' ? [...action.fields, ...(action.submit ? [action.submit] : [])] : [];
}
