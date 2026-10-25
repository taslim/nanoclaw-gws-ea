/**
 * Where the host finds the assistant's Chat delivery: the owner-only file
 * holding the subscriber account's JSON key, and the assistant's Google Cloud
 * project. The topic Google Chat publishes to and the pull subscription the
 * host reads are named from the project (gcp-identity.ts), so nothing else is
 * configured.
 *
 * gws-ea sets both keys in the host's environment, as it does the grant
 * file's; a hand-run host may set them in its `.env`. The key itself never
 * reaches the environment, a container, or an argument list: only its path
 * does.
 *
 * Keep this free of Chat and host-runtime imports: the control plane imports
 * the key names.
 */
import { readEnvFile } from '../../env.js';
import { deriveGchatEventsSubscription, deriveGchatEventsTopic } from '../../gws-ea/gcp-identity.js';

export const GCHAT_SUBSCRIBER_KEY_FILE_ENV = 'GWS_EA_CHAT_SUBSCRIBER_KEY_FILE';
export const GCHAT_PROJECT_ID_ENV = 'GWS_EA_GCP_PROJECT_ID';

export interface ChatDeliveryConfig {
  readonly subscriberKeyFile: string;
  /** `projects/{project}/topics/{topic}`: where the Workspace Events subscription delivers. */
  readonly topic: string;
  /** `projects/{project}/subscriptions/{subscription}`: what the host pulls. */
  readonly subscription: string;
}

function configured(key: string): string | undefined {
  return process.env[key]?.trim() || readEnvFile([key])[key]?.trim() || undefined;
}

/** Undefined when neither key is set; throws when only one is. */
export function readChatDeliveryConfig(): ChatDeliveryConfig | undefined {
  const subscriberKeyFile = configured(GCHAT_SUBSCRIBER_KEY_FILE_ENV);
  const projectId = configured(GCHAT_PROJECT_ID_ENV);
  if (subscriberKeyFile === undefined && projectId === undefined) return undefined;
  if (subscriberKeyFile === undefined || projectId === undefined) {
    const missing = subscriberKeyFile === undefined ? GCHAT_SUBSCRIBER_KEY_FILE_ENV : GCHAT_PROJECT_ID_ENV;
    throw new Error(`Google Chat delivery is half configured: ${missing} is not set`);
  }
  return {
    subscriberKeyFile,
    topic: deriveGchatEventsTopic(projectId),
    subscription: deriveGchatEventsSubscription(projectId),
  };
}
