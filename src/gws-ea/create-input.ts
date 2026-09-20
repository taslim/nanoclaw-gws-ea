import type { ProductionBootstrapManifest } from './provision.js';

export const CREATE_SETUP_FIELDS = ['source-remote', 'endpoint', 'workspace-email'] as const;

export type CreateSetupField = (typeof CREATE_SETUP_FIELDS)[number];

export interface CloudflareZoneChoice {
  readonly accountId: string;
  readonly accountName: string;
  readonly zoneId: string;
  readonly name: string;
  readonly status: 'active';
}

export interface ManagedIngressSetupSession {
  discoverZones(accountToken: string): Promise<readonly CloudflareZoneChoice[]>;
  retainAccountToken(accountToken: string): void;
  clearAccountToken(): void;
}

export interface CreatePromptContext {
  readonly instanceId: string;
  readonly track: string;
  readonly provided: Readonly<Partial<Record<CreateSetupField, string>>>;
  readonly managedIngressSetup?: ManagedIngressSetupSession;
}

export type CreateIngressAnswer =
  | { readonly mode: 'existing'; readonly endpointUrl: string }
  | {
      readonly mode: 'managed-cloudflare';
      readonly accountId: string;
      readonly zoneId: string;
      readonly zoneName: string;
      readonly hostname: string;
      readonly callbackUrl: string;
    };

export interface CreateSetupAnswers {
  readonly sourceRemote: string;
  readonly ingress: CreateIngressAnswer;
  readonly assistantWorkspaceEmail: string;
  readonly bootstrapManifest: ProductionBootstrapManifest;
}
