export const REGISTRY_SCHEMA_VERSION = 1 as const;
export const INSTANCE_MARKER_SCHEMA_VERSION = 1 as const;
export const PROVISION_JOURNAL_SCHEMA_VERSION = 1 as const;

export const PROVISION_PHASES = [
  'materialize_checkout',
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

export interface ExclusiveResourceClaims {
  endpoint_url: string;
  gcp_project_id: string;
  chat_app_id: string;
  chat_credential_id: string;
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

export class GwsEaError extends Error {
  readonly code: string;

  constructor(code: string, message: string) {
    super(message);
    this.name = 'GwsEaError';
    this.code = code;
  }
}
