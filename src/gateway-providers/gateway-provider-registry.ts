/**
 * Declarative gateway-provider contract and its single registry.
 *
 * A provider translates its native protocol and manages only resources it
 * owns. NanoClaw owns application lifecycle, approvals, reconciliation, and
 * realization of the typed runtime contribution.
 */
import type {
  ContainerSpec,
  DriverCapabilities,
  MountSpec,
  NetworkAccessIntent,
  SessionKey,
} from '../drivers/types.js';
import type { GatewayCredentialTarget, GatewayRuntimeCredentialConnection } from './credential-connection.js';

/** Typed spec content contributed to one session. Raw runtime flags never cross this seam. */
export interface GatewayContribution {
  env?: Record<string, string>;
  mounts?: MountSpec[];
  containers?: ContainerSpec[];
  /** Provider-owned runtime lineage; reserved host labels cannot be overridden. */
  labels?: Record<string, string>;
  /** The only network destination this session may use. */
  networkAccess: NetworkAccessIntent;
}

export interface GatewaySessionInput {
  key: SessionKey;
  /** Adoption must never provision replacement identity for a surviving runtime. */
  disposition?: 'create' | 'adopt';
  /** Stable across host restarts and runtime adoption. */
  runtimeIdentity: string;
  /** The agent group's display name, for gateways that register an agent identity. */
  groupName: string;
  /** The runtime container this session runs in, as the driver named it; providers key per-session resources on it. */
  containerName: string;
  /**
   * The selected driver's capabilities. `sharedNetworkNamespace` decides the
   * proxy URL shape a contribution puts in the agent's env; a provider that
   * composes containers checks `auxiliaryContainers` and degrades or refuses.
   */
  capabilities: DriverCapabilities;
  /** Which stored credentials this session's agent may use, from its group's capabilities. */
  credentialScope: GatewayCredentialScope;
}

/**
 * The stored credentials an agent may use, derived by core from the group's
 * capabilities at every spawn and adoption.
 *
 * `all` (a group stored as `all`) adds no restriction: the identity keeps
 * whatever the gateway's own policy grants it, and a provider must neither
 * widen nor narrow it on NanoClaw's behalf.
 *
 * `only` (a group with an explicit list) limits the identity to exactly the
 * named credentials (connection names, as in `GatewayCredentialTarget.name`)
 * plus those injected within the agent provider's model domains, a domain
 * covering its subdomains. A named credential the gateway does not hold is
 * simply not granted. Only a provider that declares
 * `sessions.enforcesCredentialScope` receives an `only` scope; core refuses
 * to start such a session on any other. A declaring provider applies the
 * scope before `ensure` returns, re-applies it on every call because the
 * gateway may have recreated the identity since, and fails `ensure` when it
 * cannot apply or verify it.
 */
export type GatewayCredentialScope =
  | { kind: 'all' }
  | { kind: 'only'; credentials: readonly string[]; modelDomains: readonly string[] };

export function gatewayRuntimeIdentity(key: SessionKey): string {
  return `${key.installSlug}/${key.agentGroupId}/${key.sessionId}`;
}

/**
 * Result of idempotently ensuring one session. The signal stops observation
 * by this host. Per-session resources use awaited `release` to distinguish
 * runtime termination from host replacement.
 */
export interface GatewaySessionRelease {
  kind: 'session-ended' | 'host-detached';
  reason: string;
}

export interface GatewaySessionLease {
  contribution: GatewayContribution;
  /** Await cleanup. Host detachment preserves resources for the successor. */
  release?(event: GatewaySessionRelease): Promise<void>;
  onUnavailable?(report: (reason: string) => void): void;
}

export type GatewayApprovalDecision = 'approve' | 'deny' | 'unavailable';

/** Privacy-safe request presentation translated from a provider's native protocol. */
export interface GatewayApprovalRequest {
  /** Missing means explicit policy approval for compatibility with older adapters. */
  trigger?: 'default' | 'policy';
  /** Exact verified channel identity selected by the gateway policy. */
  approverUserId?: string;
  approverInstance?: string;
  /** Verified destination selected by the gateway policy adapter. */
  delivery?: { messagingGroupId: string; threadId?: string };
  /** Metadata only: never credentials, query strings, or request bodies. */
  destination?: {
    host: string;
    method?: string;
    /** Adapter-attested; false only when the request has no body and asks for no protocol upgrade. */
    sendsPayload?: boolean;
  };
  /** Selected, bounded display fields may come from the request. Never pass raw bodies, headers, tokens or query strings. */
  summary?: {
    agent: string;
    action: string;
    resource: string;
    reason: string;
    details?: { label: string; value: string }[];
  };
  /** Policy-selected, privacy-reviewed fields. Rejected if oversized; never silently truncated. */
  displayFields?: Array<
    | { label: string; type: 'text' | 'long_text'; value: string }
    | { label: string; type: 'list'; value: string[]; overflow?: number }
  >;
  id: string;
  agentGroupId: string;
  sessionId?: string;
  runtimeIdentity?: string;
  createdAt: string;
  expiresAt?: string;
  title: string;
  question: string;
  audit?: Record<string, string | number | boolean | null>;
}

/** Core-owned installation scope for gateways whose native event stream is shared. */
export interface GatewayApprovalScope {
  /** Read live group membership. A rejected lookup is not permission to decide. */
  ownsAgentGroup(agentGroupId: string): Promise<boolean>;
}

/** A gateway-owned connection handoff. No credentials cross this boundary. */
export type GatewayConnectionResult =
  | { status: 'action_required'; action: 'operator_console' | 'oauth'; connect_url: string; message: string }
  | { status: 'unsupported'; message: string };

export interface GatewayProviderDefinition {
  kind: string;
  /** Shared approval health for separated host processes. Missing/expired leases must read false. */
  availability?: {
    /** Only the process owning the approval subscription publishes; refreshes a bounded lease. */
    publish(available: boolean): Promise<void>;
    read(): Promise<boolean>;
  };
  /** Read-only handoff: must not grant credentials or change network policy. */
  connections?: {
    connect(input: { agentGroupId: string; host: string }): Promise<GatewayConnectionResult>;
  };
  /**
   * Caller-described credentials the host stores at runtime: setup's
   * connection contract, plus removal. Absent when the gateway takes
   * credentials only at setup.
   */
  credentials?: {
    connection(target: GatewayCredentialTarget): GatewayRuntimeCredentialConnection;
  };
  /** Only the selected gateway's skills and instructions reach an agent. */
  agentSkills: readonly string[];
  sessions: {
    /** Idempotently creates or reconnects whatever this session needs; same call for new and adopted sessions. */
    ensure(input: GatewaySessionInput, signal: AbortSignal): Promise<GatewaySessionLease>;
    /** Declares that `ensure` applies an `only` credential scope (see `GatewayCredentialScope`). */
    enforcesCredentialScope?: true;
    /** Called after surviving sessions have been considered for adoption. */
    reapOrphans?(): void | Promise<void>;
  };
  /** Required for every gateway. Ending while signal is active fails closed. */
  approvals: {
    /** Approval action names owned by an older adapter version and swept during migration. */
    legacyActions?: readonly string[];
    /** Persist decisions until acknowledged. Requires decide and listPending. */
    durable?: boolean;
    subscribe(
      decide: (request: GatewayApprovalRequest) => Promise<GatewayApprovalDecision>,
      signal: AbortSignal,
      resolved?: (requestId: string) => Promise<void>,
      /** Shared-stream adapters must filter ownership before translating or settling requests. */
      scope?: GatewayApprovalScope,
    ): Promise<void>;
    /** Optional restart recovery, when the gateway supports held-request enumeration or late decisions. */
    listPending?(): Promise<GatewayApprovalRequest[]>;
    decide?(requestId: string, decision: GatewayApprovalDecision): Promise<boolean>;
    /**
     * Whether the gateway could attach a stored credential to a request for
     * this destination. May over-report, never under-report; reject when unsure.
     */
    credentialScope?(destination: { host: string; method?: string }): Promise<'credential' | 'none'>;
  };
}

/**
 * Refuse to start a session whose capabilities restrict its credentials on a
 * gateway that does not declare it enforces the restriction: that gateway
 * would ignore the scope and give the agent everything its policy allows.
 */
export function assertCredentialScopeEnforced(definition: GatewayProviderDefinition, input: GatewaySessionInput): void {
  if (input.credentialScope.kind === 'all' || definition.sessions.enforcesCredentialScope === true) return;
  throw new Error(
    `Gateway '${definition.kind}' does not enforce credential scopes, so agent group ` +
      `${input.groupName} (${input.key.agentGroupId}), whose capabilities restrict its credentials, cannot start`,
  );
}

/** Not a union: installable gateway packages bring their own kinds. */
export type GatewayProviderKind = string;

const registry = new Map<GatewayProviderKind, GatewayProviderDefinition>();

export function registerGatewayProvider(definition: GatewayProviderDefinition): void {
  if (registry.has(definition.kind)) {
    throw new Error('Gateway provider already registered: ' + definition.kind);
  }
  registry.set(definition.kind, definition);
}

export function getGatewayProviderRegistration(kind: GatewayProviderKind): GatewayProviderDefinition | undefined {
  return registry.get(kind);
}

export function listGatewayProviderRegistrations(): GatewayProviderDefinition[] {
  return [...registry.values()];
}

/** The kinds this build can actually run. */
export function listGatewayProviderKinds(): GatewayProviderKind[] {
  return [...registry.keys()];
}
