export const REGISTRY_SCHEMA_VERSION = 2 as const;
export const INSTANCE_MARKER_SCHEMA_VERSION = 1 as const;
export const PROVISION_JOURNAL_SCHEMA_VERSION = 1 as const;

export const PROVISION_PHASES = [
  'materialize_checkout',
  'provision_gcp',
  'start_onecli',
  'configure_provider',
  'start_nanoclaw',
  'establish_transport',
  'configure_channel',
  'bind_principal',
  'verify_conversation',
  'ready',
] as const;

export type ProvisionPhase = (typeof PROVISION_PHASES)[number];

export interface AllocatedPorts {
  nanoclaw_webhook: number;
  onecli_app: number;
  onecli_gateway: number;
}

export interface ExistingIngressClaim {
  mode: 'existing';
  endpoint_url: string;
}

export interface ManagedCloudflareIngressClaim {
  mode: 'managed-cloudflare';
  account_id: string;
  zone_id: string;
  zone_name: string;
  hostname: string;
  callback_url: string;
  dns_record_id: string | null;
}

export type IngressClaim = ExistingIngressClaim | ManagedCloudflareIngressClaim;

export interface SharedCloudflareMetadata {
  ownership_id: string;
  account_id: string;
  tunnel_name: string;
  tunnel_id: string | null;
}

export interface SharedInfrastructureMetadata {
  cloudflare: SharedCloudflareMetadata | null;
}

export interface ExclusiveResourceClaims {
  ingress: IngressClaim;
  gcp_project_id: string;
  gcp_account: string;
  gchat_service_account: string;
  workspace_email: string;
  onecli_project: string;
}

export interface InstanceReservationInput {
  instance_id: string;
  checkout_realpath: string;
  release_track: string;
  source_remote: string;
  deployed_commit: string;
  allocated_ports: AllocatedPorts;
  exclusive_resource_claims: ExclusiveResourceClaims;
}

export type InstanceReservation = Readonly<InstanceReservationInput>;

export interface InstanceRegistry {
  schema_version: typeof REGISTRY_SCHEMA_VERSION;
  instances: Record<string, InstanceReservation>;
  shared_infrastructure_metadata: SharedInfrastructureMetadata;
}

export function ingressEndpointUrl(claim: IngressClaim): string {
  return claim.mode === 'existing' ? claim.endpoint_url : claim.callback_url;
}

export interface InstanceMarker {
  schema_version: typeof INSTANCE_MARKER_SCHEMA_VERSION;
  instance_id: string;
  deployed_commit: string;
}

export interface JournalObservation {
  matched: boolean;
  observed_at: string;
  resource_key?: string;
}

export interface JournalFailure {
  code: string;
  failed_at: string;
}

export interface JournalAttempt {
  attempt_id: string;
  resource_key: string;
  intended_at: string;
  observation?: JournalObservation;
  failure?: JournalFailure;
  succeeded_at?: string;
}

export interface JournalPhase {
  attempts: JournalAttempt[];
}

export interface ProvisionJournal {
  schema_version: typeof PROVISION_JOURNAL_SCHEMA_VERSION;
  instance_id: string;
  phases: Record<ProvisionPhase, JournalPhase>;
}

/** Structured, non-secret facts about a failure, for rendering and diagnosis. */
export type GwsEaErrorDetails = Readonly<Record<string, string | number | boolean | null | readonly string[]>>;

export interface GwsEaErrorOptions {
  readonly cause?: unknown;
  readonly details?: GwsEaErrorDetails;
}

export class GwsEaError extends Error {
  readonly code: string;
  readonly details: GwsEaErrorDetails | undefined;

  constructor(code: string, message: string, options: GwsEaErrorOptions = {}) {
    super(message, 'cause' in options ? { cause: options.cause } : undefined);
    this.name = 'GwsEaError';
    this.code = code;
    this.details = options.details;
  }
}
