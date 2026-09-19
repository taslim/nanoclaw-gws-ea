import * as prompts from '@clack/prompts';
import { GwsEaError } from './types.js';

export const CREATE_SETUP_FIELDS = [
  'source-remote',
  'endpoint',
  'gcp-project',
  'chat-app',
  'chat-credential-id',
  'workspace-email',
  'setup-file',
] as const;

export type CreateSetupField = (typeof CREATE_SETUP_FIELDS)[number];
export type CreateSetupAnswers = Record<CreateSetupField, string>;

export interface CreatePromptContext {
  readonly instanceId: string;
  readonly track: string;
  readonly provided: Readonly<Record<string, string>>;
}

const LABELS: Readonly<Record<CreateSetupField, string>> = {
  'source-remote': 'Source repository remote',
  endpoint: 'Existing HTTPS Google Chat endpoint',
  'gcp-project': 'Dedicated GCP project ID',
  'chat-app': 'Google Chat app ID',
  'chat-credential-id': 'Service-account private_key_id',
  'workspace-email': 'Assistant Workspace email',
  'setup-file': 'Owner-only provisioning input file',
};

async function requiredText(field: CreateSetupField, provided: Readonly<Record<string, string>>): Promise<string> {
  const existing = provided[field];
  if (existing) return existing;
  const answer = await prompts.text({
    message: LABELS[field],
    validate: (value) => (value?.trim() ? undefined : 'Required'),
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string') {
    throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
  }
  return answer.trim();
}

export async function collectCreateSetup(context: CreatePromptContext): Promise<CreateSetupAnswers> {
  prompts.note(`Instance ${context.instanceId}\nRelease track ${context.track}`, 'New assistant');
  const answers = {} as Record<CreateSetupField, string>;
  for (const field of CREATE_SETUP_FIELDS) answers[field] = await requiredText(field, context.provided);
  return answers;
}
