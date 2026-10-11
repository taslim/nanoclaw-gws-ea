/**
 * Whether Google Chat is receiving (KTD12), as the assistant's own host
 * reports it through `ncl gws-ea-chat health`: its pull consumer connected to
 * Pub/Sub, and its Workspace Events subscription active. `status` shows it,
 * and a release serves only once it holds. A broken Google sign-in fails the
 * subscription, and only a new sign-in repairs it, so it is named as one
 * ("sign-in needed"). The consumer pulls with the subscriber key, not the
 * sign-in, so a consumer that is down is its own failure even then.
 */
import type {
  ChatErrorKind,
  ChatHealth,
  ChatHealthError,
  ChatSubscriptionState,
} from '../modules/gws-ea-chat/health.js';
import { redact } from './redact.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

/** The host's report, as `ncl` is asked for it. */
export const CHAT_HEALTH_ARGS: readonly string[] = ['gws-ea-chat', 'health'];

const ERROR_KINDS: Readonly<Record<ChatErrorKind, true>> = {
  sign_in_needed: true,
  subscriber_credential: true,
  unreachable: true,
  failed: true,
};

/** How each subscription state reads after "its subscription is". */
const SUBSCRIPTION_STATES: Readonly<Record<ChatSubscriptionState, string>> = {
  unknown: 'not confirmed yet',
  active: 'active',
  suspended: 'suspended',
  expired: 'expired',
};

function isErrorKind(value: unknown): value is ChatErrorKind {
  return typeof value === 'string' && Object.hasOwn(ERROR_KINDS, value);
}

function isSubscriptionState(value: unknown): value is ChatSubscriptionState {
  return typeof value === 'string' && Object.hasOwn(SUBSCRIPTION_STATES, value);
}

function nullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

/** A side's last failure, null when it has none, or undefined when it is malformed. */
function parseError(value: unknown): ChatHealthError | null | undefined {
  if (value === null) return null;
  if (!isRecord(value) || !isErrorKind(value.kind) || typeof value.message !== 'string' || typeof value.at !== 'string')
    return undefined;
  return { kind: value.kind, message: value.message, at: value.at };
}

/** The host's report with every field checked. */
export function parseChatHealth(value: unknown): ChatHealth {
  const invalid = () => new GwsEaError('invalid_child_output', 'ncl returned an invalid Chat report');
  if (!isRecord(value) || !isRecord(value.consumer) || !isRecord(value.subscription)) throw invalid();
  const { consumer, subscription, signInNeeded } = value;
  const consumerError = parseError(consumer.error);
  const subscriptionError = parseError(subscription.error);
  if (
    typeof signInNeeded !== 'boolean' ||
    typeof consumer.connected !== 'boolean' ||
    !nullableString(consumer.lastPullAt) ||
    consumerError === undefined ||
    !isSubscriptionState(subscription.state) ||
    !nullableString(subscription.name) ||
    !nullableString(subscription.expireTime) ||
    !nullableString(subscription.suspensionReason) ||
    subscriptionError === undefined
  ) {
    throw invalid();
  }
  return {
    consumer: { connected: consumer.connected, lastPullAt: consumer.lastPullAt, error: consumerError },
    subscription: {
      state: subscription.state,
      name: subscription.name,
      expireTime: subscription.expireTime,
      suspensionReason: subscription.suspensionReason,
      error: subscriptionError,
    },
    signInNeeded,
  };
}

/** Whether Chat receives, and when it does not, why, as a clause. */
export type ChatReceiving =
  | { readonly state: 'receiving' }
  | { readonly state: 'sign_in_needed' | 'not_receiving'; readonly reason: string };

/** `clause`, followed by a side's last failure when it has one. */
function failing(clause: string, error: ChatHealthError | null): string {
  return error ? `${clause} (${redact(error.message)})` : clause;
}

/**
 * Whether Chat receives: the consumer connected and the subscription active.
 * A broken sign-in takes precedence over both, since it fails them too.
 */
export function chatReceiving(health: ChatHealth, instanceId: string): ChatReceiving {
  const { consumer, subscription } = health;
  const signIn = `Sign the assistant in again with gws-ea connect-google --id ${instanceId}`;
  if (health.signInNeeded && consumer.connected) {
    const cause =
      subscription.error?.kind === 'sign_in_needed'
        ? redact(subscription.error.message)
        : `Google suspended its Chat subscription (${subscription.suspensionReason ?? 'no reason given'})`;
    return {
      state: 'sign_in_needed',
      reason: `Sign-in needed for Google Chat: ${cause}. ${signIn}`,
    };
  }
  const problems: string[] = [];
  if (!consumer.connected) {
    problems.push(
      consumer.error ? failing('its consumer is not connected', consumer.error) : 'its consumer has not connected yet',
    );
  }
  if (subscription.state !== 'active') {
    problems.push(failing(`its subscription is ${SUBSCRIPTION_STATES[subscription.state]}`, subscription.error));
  }
  if (problems.length === 0) return { state: 'receiving' };
  const reason = `Google Chat is not receiving: ${problems.join('; ')}`;
  return {
    state: 'not_receiving',
    reason: health.signInNeeded ? `${reason}, and its sign-in is broken. ${signIn}` : reason,
  };
}
