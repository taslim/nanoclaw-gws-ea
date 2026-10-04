/**
 * The caller-described credential connection: how a caller hands one stored
 * credential to the selected gateway without knowing its native records.
 *
 * Setup's credential store offers `GatewayCredentialConnection` to agent
 * providers (`setup/gateways/credential-store.ts` re-exports this contract).
 * The host's runtime writers use `GatewayRuntimeCredentialConnection`
 * through `GatewayProviderDefinition.credentials`. Both live here because the
 * host compiles only `src/`.
 */

/**
 * The one OAuth profile every installed gateway can hold: OpenAI's ChatGPT
 * subscription login. It refreshes at a public token endpoint with a public
 * client id, authenticates with a bearer access token, and routes with an
 * account id the gateway presents in its own header. A gateway that receives
 * any other profile must reject it; nothing here describes OAuth in general.
 */
export interface ChatGptOAuthCredential {
  profile: 'chatgpt';
  accessToken: string;
  refreshToken: string;
  accountId: string;
}
export type GatewayOAuthCredential = ChatGptOAuthCredential;

/**
 * What a caller knows about a credential it cannot name by provider alone:
 * where it goes, how the request carries it, and the non-secret value the
 * runtime presents in its place. Storage, native ids, grants, and refresh
 * scheduling stay inside the gateway.
 */
export type GatewayCredentialTarget = {
  /** Gateway-visible label; one connection per name. */
  name: string;
  /** Exact DNS hostname the credential is scoped to. */
  host: string;
  /** Non-secret marker the runtime sends; gateways doing selective replacement match it. */
  proxyValue: string;
} & (
  | { kind: 'api-key'; injection: { headerName: string; valueFormat: string } }
  | { kind: 'oauth'; oauth: { profile: 'chatgpt'; clientId: string; tokenEndpoint: string } }
);

export interface GatewayCredentialConnection {
  /**
   * Read-only. `null` when nothing is stored. `reusable: false` means the
   * stored entry exists but `keep()` cannot complete it (an expired refresh,
   * a host move the gateway cannot apply without the value), so the caller
   * must supply a value. A stored entry on a different host is offered
   * through `confirmHostChange`; without a confirmation the lookup fails.
   */
  find(options?: {
    confirmHostChange: (previous: string, next: string) => Promise<boolean>;
  }): Promise<{ reusable: boolean } | null>;
  /** Store or replace the value for the entry `find()` observed, preserving its identity and grants. */
  save(value: string | GatewayOAuthCredential): Promise<void>;
  /** Reconcile the entry `find()` observed without a new value. */
  keep(): Promise<void>;
}

/**
 * The connection a gateway gives the host at runtime: the setup contract,
 * plus deleting what `find()` observed. Like the writes, `remove()` re-reads
 * native metadata and refuses an entry that changed since.
 */
export interface GatewayRuntimeCredentialConnection extends GatewayCredentialConnection {
  /** Delete the entry `find()` observed; nothing when it observed none. */
  remove(): Promise<void>;
}
