/**
 * The pull consumer (KTD3, KTD4): the host reaches out to Pub/Sub for the
 * assistant's Chat events, so nothing of the host is reachable from outside.
 * Plain REST over `fetch` with the subscriber's token, as the codebase's
 * other Google clients are: a long-poll `pull` of up to 100 events that
 * returns as soon as one lands, `acknowledge`, and `modifyAckDeadline`.
 *
 * An event is acknowledged only once it is handled: its handler resolved,
 * because it was routed, answered, or found to be permanent. A handler that
 * rejects leaves it unacknowledged, and Pub/Sub delivers it again once its
 * lease lapses, which paces the retries. REST does not extend leases the way
 * the gRPC client does, so the consumer extends every event still being
 * handled: waiting for the host to be ready, downloading an attachment,
 * running a slow answer such as an image build, or waiting its turn behind an
 * earlier event of its conversation.
 *
 * Pub/Sub may deliver an event again while its first copy is still being
 * handled. That copy is neither handled nor acknowledged: acknowledging it
 * would retire an event whose first copy may yet fail.
 */
import { log } from '../../log.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError, googleJson, type GoogleClientOptions } from '../gws-ea-inbox/gmail-api.js';
import { chatHealthError, type ChatHealthRecorder } from './health.js';
import { SubscriberCredentialError } from './subscriber-credentials.js';

const PUBSUB = 'https://pubsub.googleapis.com/v1';

/** The most events one pull takes. */
const MAX_EVENTS_PER_PULL = 100;
/** The subscription's ack deadline (KTD3), to which each extension renews an event's lease. */
export const ACK_DEADLINE_SECONDS = 60;
/** How often leases are extended: a third of the deadline, so a lease survives one failed extension. */
const LEASE_EXTENSION_INTERVAL_MS = 20_000;
/** How long Google may hold a pull open before the consumer asks again. */
const PULL_TIMEOUT_MS = 90_000;
/** The wait after a failed call, doubling with each failure in a row up to a minute. */
const BACKOFF_BASE_MS = 1_000;
const BACKOFF_MAX_MS = 60_000;
/** What `roles/pubsub.subscriber` holds, and all the subscriber needs. */
const CONSUME_PERMISSION = 'pubsub.subscriptions.consume';

/** One Workspace event, as Google publishes it: a CloudEvent in Pub/Sub's binding. */
export interface WorkspaceEvent {
  /** Pub/Sub's id for the message carrying it: the same on every delivery. */
  readonly messageId: string;
  /** `ce-type`, such as `google.workspace.chat.message.v1.created`. */
  readonly type: string;
  /** `ce-source`: a subscription lifecycle event's names its subscription. */
  readonly source: string;
  /** `ce-subject`: the resource the event is about. */
  readonly subject: string;
  /** `ce-time`, else when Pub/Sub received it. */
  readonly time: string;
  /** The event's JSON data. A Chat event carries resource names only (KTD2), and a batch event several. */
  readonly data: Readonly<Record<string, unknown>>;
}

interface ReceivedMessage {
  readonly ackId: string;
  readonly messageId: string;
  /** Base64, as Pub/Sub carries it. */
  readonly data: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly publishTime: string;
}

function unreadable(what: string): GoogleApiError {
  return new GoogleApiError(502, `Pub/Sub returned an unreadable ${what}`);
}

function toReceived(value: unknown): ReceivedMessage {
  if (!isRecord(value) || typeof value.ackId !== 'string' || !isRecord(value.message)) throw unreadable('message');
  const message = value.message;
  if (typeof message.messageId !== 'string') throw unreadable('message');
  const attributes = isRecord(message.attributes)
    ? Object.fromEntries(
        Object.entries(message.attributes).flatMap(([key, item]) => (typeof item === 'string' ? [[key, item]] : [])),
      )
    : {};
  return {
    ackId: value.ackId,
    messageId: message.messageId,
    data: typeof message.data === 'string' ? message.data : '',
    attributes,
    publishTime: typeof message.publishTime === 'string' ? message.publishTime : '',
  };
}

/** The event a message carries; undefined when it carries none it could ever be read as. */
function decodeEvent(message: ReceivedMessage): WorkspaceEvent | undefined {
  const type = message.attributes['ce-type'];
  if (!type) return undefined;
  let data: unknown;
  /* eslint-disable no-catch-all/no-catch-all -- data that is not JSON never becomes JSON: the event is permanent */
  try {
    data = JSON.parse(Buffer.from(message.data, 'base64').toString('utf8'));
  } catch {
    return undefined;
  }
  /* eslint-enable no-catch-all/no-catch-all */
  if (!isRecord(data)) return undefined;
  return {
    messageId: message.messageId,
    type,
    source: message.attributes['ce-source'] ?? '',
    subject: message.attributes['ce-subject'] ?? '',
    time: message.attributes['ce-time'] || message.publishTime,
    data,
  };
}

function eventTime(message: ReceivedMessage, event: WorkspaceEvent | undefined): number {
  return Date.parse(event?.time ?? message.publishTime) || 0;
}

/**
 * The conversation a message belongs to: the Chat space its subject names,
 * whether the subject is the space or a message in it. A message about no
 * space, such as a subscription's lifecycle event, belongs to its source,
 * and those with neither all belong to one.
 */
function conversationOf(message: ReceivedMessage): string {
  const subject = message.attributes['ce-subject'] ?? '';
  return /^\/\/chat\.googleapis\.com\/(spaces\/[^/]+)/u.exec(subject)?.[1] ?? message.attributes['ce-source'] ?? '';
}

/** The subscriber's REST calls on one subscription. */
function createPubSubApi(client: GoogleClientOptions, subscription: string) {
  const url = (method: string) => `${PUBSUB}/${subscription}:${method}`;
  return {
    /** Refused unless Pub/Sub lets the subscriber pull this subscription. */
    async assertMayConsume(): Promise<void> {
      const payload = await googleJson(client, url('testIamPermissions'), {
        method: 'POST',
        body: { permissions: [CONSUME_PERMISSION] },
      });
      const granted = isRecord(payload) && Array.isArray(payload.permissions) ? payload.permissions : [];
      if (!granted.includes(CONSUME_PERMISSION)) {
        throw new SubscriberCredentialError(`The Chat subscriber may not pull ${subscription}`);
      }
    },

    /** The events Pub/Sub hands out now, waiting while it holds the pull open. */
    async pull(stop: AbortSignal): Promise<ReceivedMessage[]> {
      const patience = AbortSignal.timeout(PULL_TIMEOUT_MS);
      let payload: unknown;
      try {
        payload = await googleJson(client, url('pull'), {
          method: 'POST',
          body: { maxMessages: MAX_EVENTS_PER_PULL },
          signal: AbortSignal.any([stop, patience]),
        });
      } catch (error) {
        // Google held the pull open past the consumer's patience: no events this time.
        if (patience.aborted && !stop.aborted) return [];
        throw error;
      }
      if (!isRecord(payload)) {
        if (patience.aborted) return [];
        throw unreadable('pull');
      }
      return Array.isArray(payload.receivedMessages) ? payload.receivedMessages.map(toReceived) : [];
    },

    async acknowledge(ackIds: readonly string[]): Promise<void> {
      await googleJson(client, url('acknowledge'), { method: 'POST', body: { ackIds } });
    },

    async modifyAckDeadline(ackIds: readonly string[], seconds: number): Promise<void> {
      await googleJson(client, url('modifyAckDeadline'), {
        method: 'POST',
        body: { ackIds, ackDeadlineSeconds: seconds },
      });
    },
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const done = () => {
      clearTimeout(timer);
      signal.removeEventListener('abort', done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', done, { once: true });
  });
}

export interface PullConsumerOptions {
  /** `projects/{project}/subscriptions/{subscription}`. */
  readonly subscription: string;
  /** A live Pub/Sub token for the subscriber. */
  readonly token: () => Promise<string>;
  /**
   * Handles one event. It resolves once the event is handled, so it is
   * acknowledged, and rejects when it must come again.
   */
  readonly handle: (event: WorkspaceEvent) => Promise<void>;
  readonly health: ChatHealthRecorder;
  readonly fetch?: typeof globalThis.fetch;
}

export interface PullConsumer {
  /**
   * Stop pulling and extending leases. An event still being handled is
   * acknowledged if its handler resolves; otherwise Pub/Sub delivers it again
   * once its lease lapses.
   */
  stop(): Promise<void>;
}

/**
 * Start pulling. Before its first pull, and after any failure, the consumer
 * proves Pub/Sub lets the subscriber pull, so health shows it connected
 * without waiting for an event. The events of one conversation, a Chat
 * space, are handled one after another in the order they were pulled, each
 * batch in event-time order, while other conversations and the next pull go
 * on without them.
 */
export function startPullConsumer(options: PullConsumerOptions): PullConsumer {
  const api = createPubSubApi(
    { token: options.token, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) },
    options.subscription,
  );
  const stopping = new AbortController();
  /** The ack id of each event being handled or waiting its turn, by its Pub/Sub message id. */
  const inFlight = new Map<string, string>();
  /** The last event queued in each conversation, which the next one waits for, until it settles. */
  const tails = new Map<string, Promise<void>>();

  async function extendLeases(): Promise<void> {
    if (inFlight.size === 0) return;
    try {
      await api.modifyAckDeadline([...inFlight.values()], ACK_DEADLINE_SECONDS);
      /* eslint-disable-next-line no-catch-all/no-catch-all -- the next extension tries again; a lapsed lease only brings a copy, which is skipped */
    } catch (error) {
      log.warn('Could not extend the leases of the Chat events being handled', {
        events: inFlight.size,
        err: errorMessage(error),
      });
    }
  }
  const leases = setInterval(() => void extendLeases(), LEASE_EXTENSION_INTERVAL_MS);

  async function settle(message: ReceivedMessage, event: WorkspaceEvent | undefined): Promise<void> {
    try {
      if (event === undefined) {
        log.warn('Acknowledging a Pub/Sub message that is no Workspace event', { messageId: message.messageId });
      } else {
        try {
          await options.handle(event);
          /* eslint-disable-next-line no-catch-all/no-catch-all -- any failure leaves the event for Pub/Sub to deliver again */
        } catch (error) {
          log.warn('A Chat event was not handled; Pub/Sub delivers it again', {
            messageId: message.messageId,
            type: event.type,
            err: errorMessage(error),
          });
          return;
        }
      }
      try {
        await api.acknowledge([message.ackId]);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- an event delivered again after it was handled is dropped by the router's dedupe */
      } catch (error) {
        log.warn('Could not acknowledge a handled Chat event', {
          messageId: message.messageId,
          err: errorMessage(error),
        });
      }
    } finally {
      inFlight.delete(message.messageId);
    }
  }

  /**
   * Queue a pulled batch in event-time order, each event behind the earlier
   * ones of its conversation. Each is in flight from now, so its lease is
   * extended while it waits its turn.
   */
  function dispatch(received: readonly ReceivedMessage[]): void {
    const batch: { readonly message: ReceivedMessage; readonly event: WorkspaceEvent | undefined }[] = [];
    for (const message of received) {
      if (inFlight.has(message.messageId)) {
        log.debug('Skipped a copy of a Chat event still being handled', { messageId: message.messageId });
        continue;
      }
      inFlight.set(message.messageId, message.ackId);
      batch.push({ message, event: decodeEvent(message) });
    }
    batch.sort((a, b) => eventTime(a.message, a.event) - eventTime(b.message, b.event));
    for (const { message, event } of batch) {
      const conversation = conversationOf(message);
      const tail = (tails.get(conversation) ?? Promise.resolve()).then(() => settle(message, event));
      tails.set(conversation, tail);
      void tail.then(() => {
        if (tails.get(conversation) === tail) tails.delete(conversation);
      });
    }
  }

  const loop = (async () => {
    let connected = false;
    let failures = 0;
    while (!stopping.signal.aborted) {
      try {
        if (!connected) {
          await api.assertMayConsume();
          connected = true;
          options.health.consumer({ connected: true, error: null });
        }
        const received = await api.pull(stopping.signal);
        failures = 0;
        options.health.consumer({ connected: true, lastPullAt: new Date().toISOString(), error: null });
        dispatch(received);
        /* eslint-disable-next-line no-catch-all/no-catch-all -- the consumer never stops on a failure: it is recorded, and the loop waits and tries again */
      } catch (error) {
        if (stopping.signal.aborted) break;
        connected = false;
        failures += 1;
        const wait = Math.min(BACKOFF_BASE_MS * 2 ** (failures - 1), BACKOFF_MAX_MS);
        const failure = chatHealthError(error, 'subscriber', new Date().toISOString());
        options.health.consumer({ connected: false, error: failure });
        log.warn('Could not pull Chat events; trying again', { kind: failure.kind, err: failure.message, wait });
        await pause(wait, stopping.signal);
      }
    }
    options.health.consumer({ connected: false });
  })();

  return {
    async stop() {
      stopping.abort();
      clearInterval(leases);
      await loop;
    },
  };
}
