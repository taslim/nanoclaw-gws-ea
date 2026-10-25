import { GwsEaError, type ExclusiveResourceClaims } from './types.js';
import { INSTANCE_ID_PATTERN } from './validation.js';

export const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
/** A Cloud Billing account ID, as Google names it after `billingAccounts/`. */
export const GCP_BILLING_ACCOUNT_PATTERN = /^[0-9A-Z]{6}-[0-9A-Z]{6}-[0-9A-Z]{6}$/u;

/*
 * Constant IDs suffice: each lives in the instance's own project, whose ID
 * derives from its instance ID. The subscriber account may do nothing but pull
 * the subscription.
 */
export const GCHAT_SERVICE_ACCOUNT_ID = 'gws-ea-chat';
export const GCHAT_EVENTS_TOPIC_ID = 'gws-ea-chat-events';
export const GCHAT_EVENTS_SUBSCRIPTION_ID = 'gws-ea-chat-events-pull';

function assertProjectId(projectId: string): void {
  if (!GCP_PROJECT_PATTERN.test(projectId)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
}

export function deriveGcpProjectId(instanceId: string): string {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) throw new GwsEaError('invalid_instance_id', 'Instance ID is invalid');
  return `gws-ea-${instanceId.replaceAll('-', '').slice(0, 20)}`;
}

export function deriveGchatServiceAccountEmail(projectId: string): string {
  assertProjectId(projectId);
  return `${GCHAT_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}

/** The topic a Workspace Events subscription names as its endpoint. */
export function deriveGchatEventsTopic(projectId: string): string {
  assertProjectId(projectId);
  return `projects/${projectId}/topics/${GCHAT_EVENTS_TOPIC_ID}`;
}

export function deriveGchatEventsSubscription(projectId: string): string {
  assertProjectId(projectId);
  return `projects/${projectId}/subscriptions/${GCHAT_EVENTS_SUBSCRIPTION_ID}`;
}

export type GcpClaims = Pick<
  ExclusiveResourceClaims,
  'gcp_project_id' | 'gchat_events_topic' | 'gchat_events_subscription' | 'gchat_subscriber_account'
>;

export function deriveGcpClaims(instanceId: string): GcpClaims {
  const projectId = deriveGcpProjectId(instanceId);
  return {
    gcp_project_id: projectId,
    gchat_events_topic: deriveGchatEventsTopic(projectId),
    gchat_events_subscription: deriveGchatEventsSubscription(projectId),
    gchat_subscriber_account: deriveGchatServiceAccountEmail(projectId),
  };
}
