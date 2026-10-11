/**
 * The Workspace Events subscription that sends the assistant's Chat events to
 * its topic (KTD2), kept by the host for its whole life with the assistant's
 * own Chat token. One name-only subscription covers every space the
 * assistant is in (`//chat.googleapis.com/spaces/-`) and lives 7 days.
 *
 * On start the host lists the subscriptions for that target and adopts the
 * one it finds, since Google allows one per user, OAuth client, and target.
 * One that delivers to another topic or other events is deleted and created
 * again, because its endpoint cannot change; none, or an expired one, is
 * created. A suspended one is reactivated, which works once the cause, most
 * often a revoked sign-in, is fixed. No local record is kept: Google's list
 * is the record.
 *
 * It is renewed a day after it was last renewed, so a host that goes offline
 * has at least six days of cover. Renewal is judged against the wall clock
 * at least hourly, so a host that slept renews on waking. Google's lifecycle
 * events count only when they name the adopted subscription:
 * `expirationReminder` renews, `suspended` marks it for status, and `expired`
 * creates a new one. Chat events are not judged by their subscription: one
 * retained from an expired subscription still arrives.
 */
import { log } from '../../log.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import { chatHealthError, type ChatHealthRecorder } from './health.js';
import type { WorkspaceEvent } from './pubsub-pull.js';

const WORKSPACE_EVENTS = 'https://workspaceevents.googleapis.com/v1';

/** Every Chat space the assistant is a member of. */
export const CHAT_SUBSCRIPTION_TARGET = '//chat.googleapis.com/spaces/-';
export const CHAT_MESSAGE_CREATED = 'google.workspace.chat.message.v1.created';
export const CHAT_REACTION_CREATED = 'google.workspace.chat.reaction.v1.created';
/** The events subscribed to. Their batch variants arrive without asking; reaction deletions are not wanted. */
export const CHAT_EVENT_TYPES: readonly string[] = [CHAT_MESSAGE_CREATED, CHAT_REACTION_CREATED];

const LIFECYCLE_PREFIX = 'google.workspace.events.subscription.v1.';
export const SUBSCRIPTION_EXPIRATION_REMINDER = `${LIFECYCLE_PREFIX}expirationReminder`;
export const SUBSCRIPTION_SUSPENDED = `${LIFECYCLE_PREFIX}suspended`;
export const SUBSCRIPTION_EXPIRED = `${LIFECYCLE_PREFIX}expired`;

const HOUR_MS = 60 * 60_000;
const DAY_MS = 24 * HOUR_MS;
/** A name-only subscription's longest life. */
const SUBSCRIPTION_LIFETIME_MS = 7 * DAY_MS;
/** How long after a renewal the next is due. */
const RENEW_AFTER_MS = DAY_MS;
/** The longest the supervisor waits before looking at the clock again. */
const CHECK_INTERVAL_MS = HOUR_MS;
/** The wait after a failed attempt, doubling with each failure in a row up to an hour. */
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = HOUR_MS;
const OPERATION_POLL_MS = 1_000;
const OPERATION_MAX_POLLS = 60;

const LIST_FILTER = `(${CHAT_EVENT_TYPES.map((type) => `event_types:"${type}"`).join(' OR ')}) AND target_resource="${CHAT_SUBSCRIPTION_TARGET}"`;

/** Whether an event is about a subscription's life, not about Chat. */
export function isSubscriptionLifecycleEvent(event: WorkspaceEvent): boolean {
  return event.type.startsWith(LIFECYCLE_PREFIX);
}

/** A subscription, as far as the host reads it. */
export interface WorkspaceSubscription {
  /** `subscriptions/{id}`. */
  readonly name: string;
  /** `ACTIVE`, `SUSPENDED`, or `DELETED`. */
  readonly state: string;
  readonly eventTypes: readonly string[];
  /** The Pub/Sub topic it delivers to. */
  readonly topic: string | undefined;
  readonly expireTime: string | undefined;
  readonly suspensionReason: string | undefined;
}

const SUBSCRIPTION_NAME = /^subscriptions\/[^/\s?#]+$/u;
const OPERATION_NAME = /^operations\/[^\s?#]+$/u;

function unreadable(what: string): GoogleApiError {
  return new GoogleApiError(502, `Workspace Events returned an unreadable ${what}`);
}

function text(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function toSubscription(value: unknown): WorkspaceSubscription {
  if (!isRecord(value) || typeof value.name !== 'string' || !SUBSCRIPTION_NAME.test(value.name)) {
    throw unreadable('subscription');
  }
  return {
    name: value.name,
    state: text(value.state) ?? '',
    eventTypes: Array.isArray(value.eventTypes)
      ? value.eventTypes.filter((type): type is string => typeof type === 'string')
      : [],
    topic: isRecord(value.notificationEndpoint) ? text(value.notificationEndpoint.pubsubTopic) : undefined,
    expireTime: text(value.expireTime),
    suspensionReason: text(value.suspensionReason),
  };
}

/** HTTP statuses for the `google.rpc.Code` a finished operation fails with, as Google maps them. */
const RPC_STATUS: Readonly<Record<number, number>> = {
  3: 400,
  5: 404,
  6: 409,
  7: 403,
  8: 429,
  9: 400,
  14: 503,
  16: 401,
};

interface Operation {
  readonly name: string;
  readonly done: boolean;
  readonly error: { readonly code: number; readonly message: string } | undefined;
  readonly response: unknown;
}

function toOperation(value: unknown): Operation {
  if (!isRecord(value)) throw unreadable('operation');
  const done = value.done === true;
  const name = text(value.name) ?? '';
  if (!done && !OPERATION_NAME.test(name)) throw unreadable('operation');
  const error = isRecord(value.error)
    ? {
        code: typeof value.error.code === 'number' ? value.error.code : 2,
        message: text(value.error.message) ?? 'no reason given',
      }
    : undefined;
  return { name, done, error, response: value.response };
}

/**
 * The assistant's Workspace Events calls, which removal also makes once the
 * host is stopped (KTD13). Each change is a long-running operation, waited
 * for here.
 */
export function createWorkspaceEventsApi(client: GoogleClientOptions) {
  async function finish(started: unknown, what: string): Promise<unknown> {
    let operation = toOperation(started);
    for (let polls = 0; !operation.done; polls += 1) {
      if (polls === OPERATION_MAX_POLLS) throw new GoogleApiError(504, `Google did not finish ${what} in time`);
      await new Promise((resolve) => setTimeout(resolve, OPERATION_POLL_MS));
      operation = toOperation(await googleJson(client, `${WORKSPACE_EVENTS}/${operation.name}`));
    }
    if (operation.error) {
      throw new GoogleApiError(
        RPC_STATUS[operation.error.code] ?? 500,
        `Google refused ${what}: ${operation.error.message}`,
      );
    }
    return operation.response;
  }

  return {
    async list(): Promise<WorkspaceSubscription[]> {
      const query = new URLSearchParams({ filter: LIST_FILTER, pageSize: '100' });
      const payload = await googleJson(client, `${WORKSPACE_EVENTS}/subscriptions?${query.toString()}`);
      if (!isRecord(payload)) throw unreadable('subscription list');
      return Array.isArray(payload.subscriptions) ? payload.subscriptions.map(toSubscription) : [];
    },

    async create(topic: string): Promise<WorkspaceSubscription> {
      const started = await googleJson(client, `${WORKSPACE_EVENTS}/subscriptions`, {
        method: 'POST',
        body: {
          targetResource: CHAT_SUBSCRIPTION_TARGET,
          eventTypes: CHAT_EVENT_TYPES,
          notificationEndpoint: { pubsubTopic: topic },
          payloadOptions: { includeResource: false },
          ttl: `${SUBSCRIPTION_LIFETIME_MS / 1_000}s`,
        },
      });
      return toSubscription(await finish(started, 'creating the Chat subscription'));
    },

    async renew(name: string): Promise<WorkspaceSubscription> {
      const started = await googleJson(client, `${WORKSPACE_EVENTS}/${name}?updateMask=ttl`, {
        method: 'PATCH',
        body: { ttl: `${SUBSCRIPTION_LIFETIME_MS / 1_000}s` },
      });
      return toSubscription(await finish(started, 'renewing the Chat subscription'));
    },

    async reactivate(name: string): Promise<WorkspaceSubscription> {
      const started = await googleJson(client, `${WORKSPACE_EVENTS}/${name}:reactivate`, { method: 'POST', body: {} });
      return toSubscription(await finish(started, 'reactivating the Chat subscription'));
    },

    async remove(name: string): Promise<void> {
      const started = await googleJson(client, `${WORKSPACE_EVENTS}/${name}?allowMissing=true`, {
        method: 'DELETE',
      });
      await finish(started, 'deleting the Chat subscription');
    },
  };
}

export type WorkspaceEventsApi = ReturnType<typeof createWorkspaceEventsApi>;

function expired(subscription: WorkspaceSubscription): boolean {
  const expires = Date.parse(subscription.expireTime ?? '');
  return subscription.state === 'DELETED' || (!Number.isNaN(expires) && expires <= Date.now());
}

/** When the next renewal is due: a day after the last, which left it its whole life. */
function renewalDue(subscription: WorkspaceSubscription): number {
  const expires = Date.parse(subscription.expireTime ?? '');
  if (Number.isNaN(expires)) return Date.now() + RENEW_AFTER_MS;
  return expires - SUBSCRIPTION_LIFETIME_MS + RENEW_AFTER_MS;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The suspension reason a `suspended` event carries, in either field spelling Google documents. */
function suspensionReason(data: Readonly<Record<string, unknown>>): string | null {
  if (!isRecord(data.subscription)) return null;
  return text(data.subscription.suspensionReason) ?? text(data.subscription.suspension_reason) ?? null;
}

export interface SubscriptionSupervisorOptions {
  /** `projects/{project}/topics/{topic}`: where the subscription must deliver. */
  readonly topic: string;
  /** A live token for the assistant's own Chat access. */
  readonly token: () => Promise<string>;
  readonly health: ChatHealthRecorder;
  readonly fetch?: typeof globalThis.fetch;
}

export interface SubscriptionSupervisor {
  /** Act on a lifecycle event Google sent about the adopted subscription; others are ignored. */
  handleLifecycleEvent(event: WorkspaceEvent): Promise<void>;
  stop(): Promise<void>;
}

/** Adopt or create the subscription now, and keep it for as long as the supervisor runs. */
export function startSubscriptionSupervisor(options: SubscriptionSupervisorOptions): SubscriptionSupervisor {
  const api = createWorkspaceEventsApi({
    token: options.token,
    ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
  });
  /** The adopted subscription's name. */
  let adopted: string | undefined;
  let nextRunAt = Date.now();
  let failures = 0;
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  /** Attempts run one at a time, in order. */
  let queue: Promise<void> = Promise.resolve();

  function usable(subscription: WorkspaceSubscription): boolean {
    const events = new Set(subscription.eventTypes);
    return (
      subscription.topic === options.topic &&
      events.size === CHAT_EVENT_TYPES.length &&
      CHAT_EVENT_TYPES.every((type) => events.has(type)) &&
      !expired(subscription)
    );
  }

  async function maintain(renewNow: boolean): Promise<WorkspaceSubscription> {
    // Google allows one subscription per user, OAuth client, and target, so the first listed is the one.
    let current: WorkspaceSubscription | undefined = (await api.list())[0];
    if (current !== undefined && !usable(current)) {
      log.warn('Replacing the Chat subscription: it has expired, or delivers to another topic or other events', {
        subscription: current.name,
        state: current.state,
        topic: current.topic,
        eventTypes: current.eventTypes,
      });
      await api.remove(current.name);
      current = undefined;
    }
    if (current === undefined) {
      try {
        const created = await api.create(options.topic);
        log.info('Created the Chat subscription', { subscription: created.name, expireTime: created.expireTime });
        return created;
      } catch (error) {
        if (!(error instanceof GoogleApiError) || error.status !== 409) throw error;
        // Google has one the list did not show yet: adopt it.
        current = (await api.list())[0];
        if (current === undefined || !usable(current)) throw error;
      }
    }
    if (current.state === 'SUSPENDED') {
      options.health.subscription({
        state: 'suspended',
        name: current.name,
        suspensionReason: current.suspensionReason ?? null,
      });
      log.info('Reactivating the suspended Chat subscription', {
        subscription: current.name,
        reason: current.suspensionReason,
      });
      current = await api.reactivate(current.name);
      if (current.state === 'SUSPENDED') throw new Error('Google kept the Chat subscription suspended');
    }
    if (renewNow || Date.now() >= renewalDue(current)) {
      current = await api.renew(current.name);
      log.info('Renewed the Chat subscription', { subscription: current.name, expireTime: current.expireTime });
    }
    return current;
  }

  async function attempt(renewNow: boolean): Promise<void> {
    if (stopped) return;
    try {
      const current = await maintain(renewNow);
      adopted = current.name;
      failures = 0;
      nextRunAt = renewalDue(current);
      options.health.subscription({
        state: 'active',
        name: current.name,
        expireTime: current.expireTime ?? null,
        suspensionReason: null,
        error: null,
      });
      /* eslint-disable-next-line no-catch-all/no-catch-all -- the supervisor never stops on a failure: it is recorded, and tried again later */
    } catch (error) {
      failures += 1;
      nextRunAt = Date.now() + Math.min(RETRY_BASE_MS * 2 ** (failures - 1), RETRY_MAX_MS);
      const failure = chatHealthError(error, 'assistant', new Date().toISOString());
      options.health.subscription({ error: failure });
      log.warn('Could not keep the Chat subscription; trying again', {
        kind: failure.kind,
        err: errorMessage(error),
        retryAt: new Date(nextRunAt).toISOString(),
      });
    }
    schedule();
  }

  function run(renewNow: boolean): Promise<void> {
    queue = queue.then(() => attempt(renewNow));
    return queue;
  }

  function schedule(): void {
    clearTimeout(timer);
    if (stopped) return;
    timer = setTimeout(
      () => {
        if (Date.now() >= nextRunAt) void run(false);
        else schedule();
      },
      Math.min(Math.max(nextRunAt - Date.now(), 0), CHECK_INTERVAL_MS),
    );
  }

  void run(false);

  return {
    async handleLifecycleEvent(event) {
      // Judged against the subscription as the latest attempt left it.
      await queue;
      if (adopted === undefined || event.source !== `//workspaceevents.googleapis.com/${adopted}`) {
        log.info('Ignored a lifecycle event about another Chat subscription', {
          type: event.type,
          source: event.source,
        });
        return;
      }
      if (event.type === SUBSCRIPTION_EXPIRATION_REMINDER) return run(true);
      if (event.type === SUBSCRIPTION_EXPIRED) {
        log.warn('The Chat subscription expired; creating a new one', { subscription: adopted });
        adopted = undefined;
        options.health.subscription({ state: 'expired' });
        return run(false);
      }
      if (event.type === SUBSCRIPTION_SUSPENDED) {
        const reason = suspensionReason(event.data);
        log.warn('Google suspended the Chat subscription', { subscription: adopted, reason });
        options.health.subscription({ state: 'suspended', suspensionReason: reason });
        // Reactivated once its cause is fixed: at the next start, or within the hour.
        nextRunAt = Date.now() + RETRY_MAX_MS;
        schedule();
        return;
      }
      log.info('Ignored an unknown Chat subscription lifecycle event', { type: event.type });
    },

    async stop() {
      stopped = true;
      clearTimeout(timer);
      await queue;
    },
  };
}
