import { GwsEaError } from './types.js';

export const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
/** A Cloud Billing account ID, as Google names it after `billingAccounts/`. */
export const GCP_BILLING_ACCOUNT_PATTERN = /^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/u;

/*
 * The assistant's Google Chat event delivery lives in its own project, so
 * each name below is the instance's own through the project ID derived from
 * its instance ID. Google Chat publishes to the topic, the host pulls the
 * subscription, and the subscriber account may do nothing but pull it.
 */
export const GCHAT_SERVICE_ACCOUNT_ID = 'gws-ea-chat';
export const GCHAT_EVENTS_TOPIC_ID = 'gws-ea-chat-events';
export const GCHAT_EVENTS_SUBSCRIPTION_ID = 'gws-ea-chat-events-pull';

function assertProjectId(projectId: string): void {
  if (!GCP_PROJECT_PATTERN.test(projectId)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
}

export function parseGcpProjectNumber(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export function deriveWorkspaceAddOnIdentity(projectNumber: string): string {
  if (!parseGcpProjectNumber(projectNumber)) {
    throw new GwsEaError('invalid_claim', 'GCP project number is invalid');
  }
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

/** The subscriber account, whose key the host pulls the subscription with. */
export function deriveGchatServiceAccountEmail(projectId: string): string {
  assertProjectId(projectId);
  return `${GCHAT_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

/** The topic a Workspace Events subscription names as its endpoint. */
export function deriveGchatEventsTopic(projectId: string): string {
  assertProjectId(projectId);
  return `projects/${projectId}/topics/${GCHAT_EVENTS_TOPIC_ID}`;
}

/** The pull subscription the host reads Google Chat's events from. */
export function deriveGchatEventsSubscription(projectId: string): string {
  assertProjectId(projectId);
  return `projects/${projectId}/subscriptions/${GCHAT_EVENTS_SUBSCRIPTION_ID}`;
}
