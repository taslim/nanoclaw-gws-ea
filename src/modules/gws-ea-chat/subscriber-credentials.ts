/**
 * The subscriber's credential (KTD3, KTD6): the key of the service account
 * that may do nothing but pull the assistant's Chat subscription. It is read
 * from an owner-only file, never the environment, and the access token
 * google-auth-library's JWT client mints from it stays in this host's memory.
 */
import { gaxios, JWT } from 'google-auth-library';

import { isErrno } from '../../community-portal/errors.js';
import { readOwnerOnlyJson } from '../../gws-ea/secrets.js';
import { GwsEaError } from '../../gws-ea/types.js';
import { isRecord } from '../../gws-ea/validation.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';

/** Pulling, acknowledging, and extending leases on a subscription. */
export const PUBSUB_SCOPE = 'https://www.googleapis.com/auth/pubsub';

/** The subscriber key is missing or unreadable, or Google refuses it. */
export class SubscriberCredentialError extends Error {
  readonly code = 'gchat_subscriber_credential';
}

interface SubscriberKey {
  readonly clientEmail: string;
  readonly privateKey: string;
  readonly privateKeyId?: string;
}

async function readSubscriberKey(file: string): Promise<SubscriberKey> {
  let raw: unknown;
  try {
    raw = await readOwnerOnlyJson(file, 'The Chat subscriber key', 'invalid_chat_subscriber_key');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) {
      throw new SubscriberCredentialError(`The Chat subscriber key is missing: ${file}`, { cause: error });
    }
    if (error instanceof GwsEaError) throw new SubscriberCredentialError(error.message, { cause: error });
    throw error;
  }
  if (
    !isRecord(raw) ||
    typeof raw.client_email !== 'string' ||
    raw.client_email.length === 0 ||
    typeof raw.private_key !== 'string' ||
    raw.private_key.length === 0
  ) {
    throw new SubscriberCredentialError(`The Chat subscriber key is not a service account key: ${file}`);
  }
  return {
    clientEmail: raw.client_email,
    privateKey: raw.private_key,
    ...(typeof raw.private_key_id === 'string' ? { privateKeyId: raw.private_key_id } : {}),
  };
}

export interface SubscriberTokenOptions {
  readonly keyFile: string;
  /** How the JWT client reaches Google's token endpoint; tests pass a fake. */
  readonly fetch?: typeof globalThis.fetch;
}

/**
 * A live Pub/Sub token for the subscriber. The key is read at the first call,
 * and again after Google refuses it, so a replaced key is picked up. Google
 * refusing the key is a `SubscriberCredentialError`; failing to reach Google
 * is a retryable `GoogleApiError`.
 */
export function createSubscriberToken(options: SubscriberTokenOptions): () => Promise<string> {
  let client: Promise<JWT> | undefined;

  async function build(): Promise<JWT> {
    const key = await readSubscriberKey(options.keyFile);
    return new JWT({
      email: key.clientEmail,
      key: key.privateKey,
      ...(key.privateKeyId === undefined ? {} : { keyId: key.privateKeyId }),
      scopes: [PUBSUB_SCOPE],
      ...(options.fetch === undefined ? {} : { transporterOptions: { fetchImplementation: options.fetch } }),
    });
  }

  return async () => {
    client ??= build();
    try {
      const { token } = await (await client).getAccessToken();
      if (!token) throw new SubscriberCredentialError("Google minted no token for the Chat subscriber's key");
      return token;
    } catch (error) {
      // Google out of reach, or asking to be asked later: the key may be fine.
      if (
        error instanceof gaxios.GaxiosError &&
        (error.status === undefined || error.status === 429 || error.status >= 500)
      ) {
        throw new GoogleApiError(error.status ?? 0, "Google could not mint the Chat subscriber's token", {
          cause: error,
        });
      }
      // Anything else is the key: unreadable, unusable, or refused. Read it again next time.
      client = undefined;
      if (error instanceof SubscriberCredentialError) throw error;
      const reason = error instanceof Error ? error.message : String(error);
      throw new SubscriberCredentialError(`The Chat subscriber's key was refused: ${reason}`, { cause: error });
    }
  };
}
