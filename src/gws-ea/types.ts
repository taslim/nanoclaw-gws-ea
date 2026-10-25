export const REGISTRY_SCHEMA_VERSION = 3 as const;
export const INSTANCE_MARKER_SCHEMA_VERSION = 1 as const;

/** NanoClaw's channel type for Google Chat: the prefix of its user IDs and the `channel_type` of its rows. */
export const GCHAT_CHANNEL_TYPE = 'gchat';

/**
 * In run order; a completed `verify_conversation` means the assistant is
 * ready. The host talks in Chat as the assistant from the moment it starts, so
 * Chat is configured and the assistant signed in before `start_nanoclaw`;
 * agents' Google access, which the running host publishes, is connected after.
 */
export const PROVISION_STEPS = [
  'materialize_checkout',
  'provision_gcp',
  'start_onecli',
  'configure_provider',
  'configure_channel',
  'sign_in_google',
  'start_nanoclaw',
  'connect_google',
  'bind_principal',
  'verify_conversation',
] as const;

export type ProvisionStepId = (typeof PROVISION_STEPS)[number];

export interface AllocatedPorts {
  onecli_app: number;
  onecli_gateway: number;
}

/** A retained public namespace and host-only listener claim. Identity stays internal. */
export interface ArtifactsNamespaceClaim {
  readonly hostname: string;
  readonly path_prefix: string;
  readonly listen_port: number;
}

/**
 * What only this assistant may hold, except `gcp_account`, the operator's
 * Google Cloud sign-in. The project is derived from the instance ID, and the
 * topic Google Chat publishes to, the pull subscription the host reads, and
 * the account that may only pull it are derived from the project.
 */
export interface ExclusiveResourceClaims {
  gcp_project_id: string;
  gcp_account: string;
  gchat_events_topic: string;
  gchat_events_subscription: string;
  gchat_subscriber_account: string;
  workspace_email: string;
  /**
   * The web alias the operator was asked to add, claimed before it is offered
   * and kept once verified. It shares the workspace email's mailbox key space,
   * so no address is two assistants'.
   */
  alias_email?: string;
  /** E.164. */
  whatsapp_number?: string;
  artifacts?: ArtifactsNamespaceClaim;
  onecli_project: string;
}

export interface InstanceReservationInput {
  instance_id: string;
  release_track: string;
  source_remote: string;
  deployed_commit: string;
  allocated_ports: AllocatedPorts;
  exclusive_resource_claims: ExclusiveResourceClaims;
}

export type InstanceReservation = Readonly<InstanceReservationInput>;

/** The only reservation fields an update or rollback moves, and only through `swapInstanceRelease`. */
export type ReleaseCoordinates = Readonly<
  Pick<InstanceReservationInput, 'source_remote' | 'release_track' | 'deployed_commit'>
>;

export function shortCommit(commit: string): string {
  return commit.slice(0, 12);
}

export function releaseLine(release: ReleaseCoordinates): string {
  return `${release.release_track} ${shortCommit(release.deployed_commit)}`;
}

export function releaseOf(reservation: ReleaseCoordinates): ReleaseCoordinates {
  return {
    source_remote: reservation.source_remote,
    release_track: reservation.release_track,
    deployed_commit: reservation.deployed_commit,
  };
}

export function sameRelease(left: ReleaseCoordinates, right: ReleaseCoordinates): boolean {
  return (
    left.source_remote === right.source_remote &&
    left.release_track === right.release_track &&
    left.deployed_commit === right.deployed_commit
  );
}

export interface InstanceRegistry {
  schema_version: typeof REGISTRY_SCHEMA_VERSION;
  instances: Record<string, InstanceReservation>;
}

/** Names the assistant a `state/` belongs to; which release runs is the live link and its Git HEAD. */
export interface InstanceMarker {
  schema_version: typeof INSTANCE_MARKER_SCHEMA_VERSION;
  instance_id: string;
}

/** Non-secret facts about a failure, for rendering and diagnosis. */
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

/** As the running host reports it over its command socket. */
export interface WhatsAppCommandData {
  readonly state: 'unlinked' | 'linking' | 'connected' | 'needs-relink';
  readonly number?: string;
  readonly principal?: { readonly lid: string; readonly phoneJid?: string };
  readonly bindingPending?: boolean;
  readonly pairingCode?: string;
}
