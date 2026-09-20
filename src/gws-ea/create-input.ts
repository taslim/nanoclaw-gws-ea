import type { ProductionBootstrapManifest } from './provision.js';

export const CREATE_SETUP_FIELDS = ['source-remote', 'endpoint', 'workspace-email'] as const;

export type CreateSetupField = (typeof CREATE_SETUP_FIELDS)[number];

export interface CreatePromptContext {
  readonly instanceId: string;
  readonly track: string;
  readonly provided: Readonly<Partial<Record<CreateSetupField, string>>>;
}

export interface CreateSetupAnswers {
  readonly sourceRemote: string;
  readonly endpoint: string;
  readonly assistantWorkspaceEmail: string;
  readonly bootstrapManifest: ProductionBootstrapManifest;
}
