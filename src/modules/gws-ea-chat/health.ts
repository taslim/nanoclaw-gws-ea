/**
 * Whether Chat is receiving: the pull consumer and the Workspace Events
 * subscription each record what their last attempt found, and the control
 * plane reads it through `gws-ea-chat health`. It lives in this host's memory
 * only: the host owns the subscription's whole life and keeps no local record
 * of it, so a restarted host learns it all again from Google. A subscription
 * recorded active reads as expired once its expiry passes: if every renewal
 * since failed, Google has stopped delivering.
 *
 * A broken Google sign-in is named as one: the assistant's grant refused, or
 * the subscription suspended for its authorization. Only a new sign-in brings
 * Chat back then.
 */
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { GoogleGrantRevokedError, GoogleScopeNotGrantedError, GoogleTokenError } from '../gws-ea-google/tokens.js';
import { SubscriberCredentialError } from './subscriber-credentials.js';

/**
 * What kind of failure an attempt ended in:
 * - `sign_in_needed`: Google refuses the assistant's sign-in, or it lacks the
 *   Chat scopes.
 * - `subscriber_credential`: the subscriber key is missing or unreadable, or
 *   Google refuses it.
 * - `unreachable`: Google could not be reached, rate-limited the call, or
 *   failed on its side.
 * - `failed`: anything else, as its message says.
 */
export type ChatErrorKind = 'sign_in_needed' | 'subscriber_credential' | 'unreachable' | 'failed';

export interface ChatHealthError {
  readonly kind: ChatErrorKind;
  readonly message: string;
  readonly at: string;
}

/**
 * `unknown` until the host has confirmed one with Google, and again whenever
 * it finds Google holds none it can use and has not made a new one yet;
 * `expired` when the active one's expiry passed with no renewal.
 */
export type ChatSubscriptionState = 'unknown' | 'active' | 'suspended' | 'expired';

export interface ChatConsumerHealth {
  /** Pub/Sub accepts the subscriber, and the consumer's last call to it succeeded. */
  readonly connected: boolean;
  /** When a pull last returned, with events or without. */
  readonly lastPullAt: string | null;
  /** The failure the last attempt ended in; null once one succeeds. */
  readonly error: ChatHealthError | null;
}

export interface ChatSubscriptionHealth {
  readonly state: ChatSubscriptionState;
  /** `subscriptions/{id}`, once one is adopted. */
  readonly name: string | null;
  readonly expireTime: string | null;
  /** Google's reason, while suspended. */
  readonly suspensionReason: string | null;
  /** The failure the last attempt ended in; null once one succeeds. */
  readonly error: ChatHealthError | null;
}

export interface ChatHealth {
  readonly consumer: ChatConsumerHealth;
  readonly subscription: ChatSubscriptionHealth;
  /** Only a new Google sign-in brings Chat back. */
  readonly signInNeeded: boolean;
}

export interface ChatHealthRecorder {
  consumer(update: Partial<ChatConsumerHealth>): void;
  subscription(update: Partial<ChatSubscriptionHealth>): void;
  read(): ChatHealth;
}

/**
 * Suspensions a new sign-in cannot lift: the topic is gone or refuses
 * Google's publisher, which the assistant's project must fix. Every other
 * reason is treated as the assistant's authorization.
 */
const ENDPOINT_SUSPENSIONS: ReadonlySet<string> = new Set([
  'ENDPOINT_PERMISSION_DENIED',
  'ENDPOINT_NOT_FOUND',
  'ENDPOINT_RESOURCE_EXHAUSTED',
]);

export function createChatHealth(): ChatHealthRecorder {
  let consumer: ChatConsumerHealth = { connected: false, lastPullAt: null, error: null };
  let subscription: ChatSubscriptionHealth = {
    state: 'unknown',
    name: null,
    expireTime: null,
    suspensionReason: null,
    error: null,
  };
  return {
    consumer(update) {
      consumer = { ...consumer, ...update };
    },
    subscription(update) {
      subscription = { ...subscription, ...update };
    },
    read() {
      const suspendedForSignIn =
        subscription.state === 'suspended' && !ENDPOINT_SUSPENSIONS.has(subscription.suspensionReason ?? '');
      const expires = Date.parse(subscription.expireTime ?? '');
      const lapsed = subscription.state === 'active' && !Number.isNaN(expires) && expires <= Date.now();
      return {
        consumer,
        subscription: lapsed ? { ...subscription, state: 'expired' } : subscription,
        signInNeeded: suspendedForSignIn || subscription.error?.kind === 'sign_in_needed',
      };
    },
  };
}

export const chatHealth: ChatHealthRecorder = createChatHealth();

/**
 * `credential` is what the failed call carried: the assistant's own Chat token
 * for the subscription, or the subscriber key for Pub/Sub.
 */
export function chatErrorKind(error: unknown, credential: 'assistant' | 'subscriber'): ChatErrorKind {
  if (error instanceof SubscriberCredentialError) return 'subscriber_credential';
  if (error instanceof GoogleGrantRevokedError || error instanceof GoogleScopeNotGrantedError) return 'sign_in_needed';
  if (error instanceof GoogleTokenError) return error.refused ? 'sign_in_needed' : 'unreachable';
  if (error instanceof GoogleApiError) {
    if (error.retryable) return 'unreachable';
    if (credential === 'subscriber')
      return error.status === 401 || error.status === 403 ? 'subscriber_credential' : 'failed';
    return error.status === 401 ? 'sign_in_needed' : 'failed';
  }
  return 'failed';
}

export function chatHealthError(error: unknown, credential: 'assistant' | 'subscriber', at: string): ChatHealthError {
  return {
    kind: chatErrorKind(error, credential),
    message: error instanceof Error ? error.message : String(error),
    at,
  };
}
