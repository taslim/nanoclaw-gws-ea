import { GwsEaError } from './types.js';

export const GCP_PROJECT_PATTERN = /^[a-z][a-z0-9-]{4,28}[a-z0-9]$/u;
export const GCHAT_SERVICE_ACCOUNT_ID = 'gws-ea-chat';

export function parseGcpProjectNumber(value: unknown): string | undefined {
  return typeof value === 'string' && /^[1-9]\d*$/.test(value) ? value : undefined;
}

export function deriveWorkspaceAddOnIdentity(projectNumber: string): string {
  if (!parseGcpProjectNumber(projectNumber)) {
    throw new GwsEaError('invalid_claim', 'GCP project number is invalid');
  }
  return `service-${projectNumber}@gcp-sa-gsuiteaddons.iam.gserviceaccount.com`;
}

export function deriveGchatServiceAccountEmail(projectId: string): string {
  if (!GCP_PROJECT_PATTERN.test(projectId)) throw new GwsEaError('invalid_claim', 'GCP project ID is invalid');
  return `${GCHAT_SERVICE_ACCOUNT_ID}@${projectId}.iam.gserviceaccount.com`;
}
