/**
 * The Google HTTP the Chat delivery speaks, faked at the `fetch` boundary:
 * Pub/Sub's pull subscription, Workspace Events' subscriptions, and the
 * OAuth endpoint the subscriber's JWT client mints its token from. It keeps
 * what Google keeps:
 *
 * - Pub/Sub hands out each unacknowledged message whose lease has lapsed,
 *   with a new ack id each time, and leases it for the ack deadline; a
 *   pull with nothing to hand out is held open until a message is ready, or
 *   for `emptyPullHoldMs` when set. A message may also be handed out again
 *   while leased (`redeliverNow`), as at-least-once delivery allows.
 * - Each event's source (`ce-source`) names the subscription it came
 *   through, not the Chat resource it is about (`ce-subject`).
 * - Workspace Events keeps one subscription per target: creating a second
 *   is ALREADY_EXISTS. Each change is a long-running operation, finished at
 *   once unless `slowOperations` makes the next ones finish on a later poll.
 * - Pub/Sub answers only the subscriber's token and Workspace Events only
 *   the assistant's; anything else is 401.
 *
 * Every request is recorded. A test makes a side fail (`pubsubFailure`,
 * `workspaceFailure`, `tokenFailure`) until it clears it.
 */
import { ACK_DEADLINE_SECONDS } from '../pubsub-pull.js';

export const ASSISTANT_TOKEN = 'assistant-chat-token';
export const SUBSCRIBER_TOKEN = 'subscriber-pubsub-token';
export const PROJECT = 'gws-ea-juno-hale-1a2b';
export const TOPIC = `projects/${PROJECT}/topics/gws-ea-chat-events`;
export const SUBSCRIPTION = `projects/${PROJECT}/subscriptions/gws-ea-chat-events-pull`;

const PUBSUB_PATH = `/v1/${SUBSCRIPTION}:`;

export interface Failure {
  readonly status: number;
  readonly message: string;
}

export interface RecordedRequest {
  readonly method: string;
  readonly url: URL;
  readonly body: unknown;
  readonly authorization: string | null;
}

interface StoredMessage {
  readonly id: string;
  readonly data: string;
  readonly attributes: Readonly<Record<string, string>>;
  readonly publishTime: string;
  acked: boolean;
  leaseUntil: number;
  readonly ackIds: string[];
}

export interface PublishedEvent {
  readonly type: string;
  readonly data: Readonly<Record<string, unknown>>;
  /** `ce-source`: the subscription the event came through, the one Google holds now unless a test names another. */
  readonly source?: string;
  readonly subject?: string;
  readonly time?: string;
}

export interface StoredSubscription {
  name: string;
  targetResource: string;
  eventTypes: string[];
  notificationEndpoint: { pubsubTopic: string };
  payloadOptions: { includeResource: boolean };
  state: string;
  expireTime: string;
  suspensionReason?: string;
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}

function refusal(failure: Failure, status = 'FAILED'): Response {
  return json(failure.status, { error: { code: failure.status, message: failure.message, status } });
}

function requestUrl(input: string | URL | Request): URL {
  if (input instanceof URL) return input;
  return new URL(typeof input === 'string' ? input : input.url);
}

/** A JSON body as its value, and a form body (the token exchange's) as its fields. */
function requestBody(raw: RequestInit['body']): unknown {
  if (raw === undefined || raw === null) return undefined;
  const text = typeof raw === 'string' ? raw : raw instanceof URLSearchParams ? raw.toString() : String(raw);
  /* eslint-disable no-catch-all/no-catch-all -- a body that is not JSON is a form */
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return Object.fromEntries(new URLSearchParams(text));
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

function aborted(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('The operation was aborted', 'AbortError');
}

export class FakeGoogleEvents {
  readonly requests: RecordedRequest[] = [];
  readonly messages = new Map<string, StoredMessage>();
  readonly subscriptions = new Map<string, StoredSubscription>();
  /** Every Pub/Sub call fails with this while set. */
  pubsubFailure: Failure | undefined;
  /** Every Workspace Events call fails with this while set. */
  workspaceFailure: Failure | undefined;
  /** The token endpoint refuses with this OAuth error while set. */
  tokenFailure: { readonly status: number; readonly error: string } | undefined;
  /** Pub/Sub grants the subscriber the consume permission. */
  mayConsume = true;
  /** How long an empty pull is held before it returns empty; undefined holds it until a message is ready. */
  emptyPullHoldMs: number | undefined;
  /** This many next lists leave the stored subscriptions out, as a list that has not caught up yet. */
  staleLists = 0;
  /** This many next operations finish on their first poll instead of at once. */
  slowOperations = 0;

  private nextId = 1;
  private readonly waiting = new Set<() => void>();
  private readonly operations = new Map<string, unknown>();

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const authorization = new Headers(init?.headers).get('authorization');
    this.requests.push({ method, url, body: requestBody(init?.body), authorization });
    const body = this.requests[this.requests.length - 1]?.body;
    switch (url.host) {
      case 'pubsub.googleapis.com':
        return this.pubsub(url, body, authorization, init?.signal ?? undefined);
      case 'workspaceevents.googleapis.com':
        return this.workspaceEvents(method, url, body, authorization);
      case 'oauth2.googleapis.com':
        return this.token(body);
      default:
        throw new TypeError(`fetch failed: no fake for ${url.host}`);
    }
  };

  /** Google publishing one event to the topic; returns its Pub/Sub message id. */
  publish(event: PublishedEvent): string {
    const id = `pubsub-${this.nextId++}`;
    const time = event.time ?? new Date().toISOString();
    this.messages.set(id, {
      id,
      data: Buffer.from(JSON.stringify(event.data)).toString('base64'),
      attributes: {
        'ce-id': `event-${id}`,
        'ce-type': event.type,
        'ce-source': event.source ?? this.deliveringSubscription(),
        'ce-subject': event.subject ?? '//chat.googleapis.com/spaces/AAAAjuno',
        'ce-time': time,
        'ce-specversion': '1.0',
      },
      publishTime: new Date().toISOString(),
      acked: false,
      leaseUntil: 0,
      ackIds: [],
    });
    this.wake();
    return id;
  }

  /** A message Pub/Sub carries that is no CloudEvent; returns its id. */
  publishRaw(data: string, attributes: Readonly<Record<string, string>> = {}): string {
    const id = `pubsub-${this.nextId++}`;
    this.messages.set(id, {
      id,
      data: Buffer.from(data).toString('base64'),
      attributes,
      publishTime: new Date().toISOString(),
      acked: false,
      leaseUntil: 0,
      ackIds: [],
    });
    this.wake();
    return id;
  }

  /** Pub/Sub handing a message out again while its lease still runs. */
  redeliverNow(id: string): void {
    const message = this.messages.get(id);
    if (!message) throw new Error(`No message ${id}`);
    message.leaseUntil = 0;
    this.wake();
  }

  /** How many times the message was acknowledged, by any of its ack ids. */
  acks(id: string): number {
    const ackIds = new Set(this.messages.get(id)?.ackIds ?? []);
    return this.calls('acknowledge')
      .flatMap((request) => ackIdsOf(request))
      .filter((ackId) => ackIds.has(ackId)).length;
  }

  /** The Pub/Sub calls of one method (`pull`, `acknowledge`, ...), or the Workspace Events calls matching `PATCH`, etc. */
  calls(method: string): RecordedRequest[] {
    return this.requests.filter((request) =>
      request.url.host === 'pubsub.googleapis.com'
        ? request.url.pathname.endsWith(`:${method}`)
        : `${request.method} ${request.url.pathname}`.startsWith(method),
    );
  }

  /** A subscription Google already holds for the assistant. */
  seedSubscription(fields: Partial<StoredSubscription> = {}): StoredSubscription {
    const subscription: StoredSubscription = {
      name: `subscriptions/chat-${this.nextId++}`,
      targetResource: '//chat.googleapis.com/spaces/-',
      eventTypes: ['google.workspace.chat.message.v1.created', 'google.workspace.chat.reaction.v1.created'],
      notificationEndpoint: { pubsubTopic: TOPIC },
      payloadOptions: { includeResource: false },
      state: 'ACTIVE',
      expireTime: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
      ...fields,
    };
    this.subscriptions.set(subscription.name, subscription);
    return subscription;
  }

  /**
   * An event's source, as Google names it: the full name of the subscription
   * it came through, not the Chat resource. That is the one Google holds now,
   * or an earlier one when it holds none.
   */
  private deliveringSubscription(): string {
    const [current] = this.subscriptions.values();
    return `//workspaceevents.googleapis.com/${current?.name ?? 'subscriptions/chat-earlier'}`;
  }

  private wake(): void {
    for (const resume of [...this.waiting]) resume();
  }

  /** Resolves once something may be ready, after `ms` when given, or when `signal` aborts. */
  private wait(signal: AbortSignal | undefined, ms?: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const done = (error?: Error) => {
        this.waiting.delete(resume);
        clearTimeout(timer);
        signal?.removeEventListener('abort', abort);
        if (error) reject(error);
        else resolve();
      };
      const resume = () => done();
      const abort = () => done(aborted(signal as AbortSignal));
      const timer = ms === undefined ? undefined : setTimeout(resume, ms);
      if (signal?.aborted) return abort();
      this.waiting.add(resume);
      signal?.addEventListener('abort', abort, { once: true });
    });
  }

  private ready(): StoredMessage[] {
    return [...this.messages.values()].filter((message) => !message.acked && message.leaseUntil <= Date.now());
  }

  private lease(message: StoredMessage, seconds: number): void {
    message.leaseUntil = Date.now() + seconds * 1_000;
    // Wake a held pull when the lease lapses.
    setTimeout(() => this.wake(), seconds * 1_000);
  }

  private async pubsub(
    url: URL,
    body: unknown,
    authorization: string | null,
    signal: AbortSignal | undefined,
  ): Promise<Response> {
    if (!url.pathname.startsWith(PUBSUB_PATH)) return refusal({ status: 404, message: 'Resource not found' });
    if (this.pubsubFailure) return refusal(this.pubsubFailure);
    if (authorization !== `Bearer ${SUBSCRIBER_TOKEN}`) {
      return refusal({ status: 401, message: 'Request had invalid authentication credentials.' }, 'UNAUTHENTICATED');
    }
    const method = url.pathname.slice(PUBSUB_PATH.length);
    const record = (body ?? {}) as Record<string, unknown>;
    if (method === 'testIamPermissions') return json(200, this.mayConsume ? { permissions: record.permissions } : {});
    if (method === 'pull') {
      const started = Date.now();
      for (;;) {
        const ready = this.ready().slice(0, Number(record.maxMessages));
        if (ready.length > 0) {
          return json(200, {
            receivedMessages: ready.map((message) => {
              const ackId = `${message.id}-ack-${message.ackIds.length + 1}`;
              message.ackIds.push(ackId);
              this.lease(message, ACK_DEADLINE_SECONDS);
              return {
                ackId,
                message: {
                  data: message.data,
                  attributes: message.attributes,
                  messageId: message.id,
                  publishTime: message.publishTime,
                },
              };
            }),
          });
        }
        const hold = this.emptyPullHoldMs === undefined ? undefined : this.emptyPullHoldMs - (Date.now() - started);
        if (hold !== undefined && hold <= 0) return json(200, {});
        await this.wait(signal, hold);
      }
    }
    const ackIds = Array.isArray(record.ackIds) ? record.ackIds.map(String) : [];
    const owners = ackIds.flatMap((ackId) =>
      [...this.messages.values()].filter((message) => message.ackIds.includes(ackId)),
    );
    if (method === 'acknowledge') {
      for (const message of owners) message.acked = true;
      return json(200, {});
    }
    if (method === 'modifyAckDeadline') {
      for (const message of owners) this.lease(message, Number(record.ackDeadlineSeconds));
      return json(200, {});
    }
    return refusal({ status: 404, message: `No fake for ${method}` });
  }

  private finish(response: unknown): Response {
    const name = `operations/op-${this.nextId++}`;
    if (this.slowOperations > 0) {
      this.slowOperations -= 1;
      this.operations.set(name, response);
      return json(200, { name, done: false });
    }
    return json(200, { name, done: true, response });
  }

  private workspaceEvents(method: string, url: URL, body: unknown, authorization: string | null): Response {
    if (this.workspaceFailure) return refusal(this.workspaceFailure);
    if (authorization !== `Bearer ${ASSISTANT_TOKEN}`) {
      return refusal({ status: 401, message: 'Request had invalid authentication credentials.' }, 'UNAUTHENTICATED');
    }
    const path = url.pathname.replace(/^\/v1\//u, '');
    const record = (body ?? {}) as Record<string, unknown>;
    if (method === 'GET' && path.startsWith('operations/')) {
      const response = this.operations.get(path);
      if (response === undefined) return refusal({ status: 404, message: 'No such operation' });
      return json(200, { name: path, done: true, response });
    }
    if (method === 'GET' && path === 'subscriptions') {
      if (this.staleLists > 0) {
        this.staleLists -= 1;
        return json(200, {});
      }
      const filter = url.searchParams.get('filter') ?? '';
      const listed = [...this.subscriptions.values()].filter((sub) => filter.includes(`"${sub.targetResource}"`));
      return json(200, listed.length === 0 ? {} : { subscriptions: listed });
    }
    if (method === 'POST' && path === 'subscriptions') {
      const target = String(record.targetResource);
      if ([...this.subscriptions.values()].some((sub) => sub.targetResource === target)) {
        return refusal({ status: 409, message: 'Subscription already exists.' }, 'ALREADY_EXISTS');
      }
      const subscription: StoredSubscription = {
        name: `subscriptions/chat-${this.nextId++}`,
        targetResource: target,
        eventTypes: (record.eventTypes as string[]) ?? [],
        notificationEndpoint: record.notificationEndpoint as { pubsubTopic: string },
        payloadOptions: record.payloadOptions as { includeResource: boolean },
        state: 'ACTIVE',
        expireTime: new Date(Date.now() + parseInt(String(record.ttl), 10) * 1_000).toISOString(),
      };
      this.subscriptions.set(subscription.name, subscription);
      return this.finish({ ...subscription });
    }
    const [name, verb] = path.split(':') as [string, string | undefined];
    const subscription = this.subscriptions.get(name);
    if (method === 'DELETE') {
      this.subscriptions.delete(name);
      return this.finish({});
    }
    if (!subscription) return refusal({ status: 404, message: 'Subscription not found.' }, 'NOT_FOUND');
    if (method === 'PATCH' && url.searchParams.get('updateMask') === 'ttl') {
      subscription.expireTime = new Date(Date.now() + parseInt(String(record.ttl), 10) * 1_000).toISOString();
      return this.finish({ ...subscription });
    }
    if (method === 'POST' && verb === 'reactivate') {
      subscription.state = 'ACTIVE';
      delete subscription.suspensionReason;
      return this.finish({ ...subscription });
    }
    return refusal({ status: 404, message: `No fake for ${method} ${path}` });
  }

  private token(body: unknown): Response {
    if (this.tokenFailure) {
      return json(this.tokenFailure.status, { error: this.tokenFailure.error, error_description: 'Refused' });
    }
    const assertion = String((body as Record<string, unknown> | undefined)?.assertion ?? '');
    if (assertion.split('.').length !== 3) return json(400, { error: 'invalid_request' });
    return json(200, { access_token: SUBSCRIBER_TOKEN, expires_in: 3600, token_type: 'Bearer' });
  }
}

function ackIdsOf(request: RecordedRequest): string[] {
  const body = request.body as { ackIds?: unknown } | undefined;
  return Array.isArray(body?.ackIds) ? body.ackIds.map(String) : [];
}
