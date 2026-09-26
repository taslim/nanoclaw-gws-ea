import { isErrno } from '../community-portal/errors.js';
import type { Prerequisites } from './prerequisites.js';
import type { ProductionBootstrapManifest } from './provision.js';
import { registerSecret } from './redact.js';
import { readOperatorFile } from './secrets.js';
import { GwsEaError } from './types.js';

/** One flag per create prompt, so `create` can run without a person. */
export const CREATE_INPUT_FLAGS = [
  'assistant-first-name',
  'assistant-last-name',
  'principal-first-name',
  'principal-last-name',
  'principal-timezone',
  'workspace-email',
  'ingress',
  'endpoint',
  'cloudflare-zone',
  'hostname-label',
  'provider',
] as const;

export type CreateInputFlag = (typeof CREATE_INPUT_FLAGS)[number];

/**
 * Secrets never travel as flags. Each comes from its environment variable or
 * the owner-only `--secrets-file` under the config root, and is never written.
 */
export const SECRET_INPUTS = {
  cloudflareAccountToken: 'GWS_EA_CLOUDFLARE_API_TOKEN',
  providerCredential: 'GWS_EA_PROVIDER_CREDENTIAL',
} as const;

export type SecretInput = keyof typeof SECRET_INPUTS;

export interface SecretSource {
  /** A supplied secret, already registered with the redactor. */
  get(input: SecretInput): string | undefined;
}

/** How an operator supplies a secret without a prompt. */
export function describeSecretInput(input: SecretInput): string {
  return `set ${SECRET_INPUTS[input]} in the environment or in an owner-only --secrets-file under the config root`;
}

function parseSecretsFile(contents: string, file: string): Map<string, string> {
  const known = new Set<string>(Object.values(SECRET_INPUTS));
  const values = new Map<string, string>();
  for (const [index, line] of contents.split(/\r?\n/u).entries()) {
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const match = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/u.exec(line);
    if (!match) {
      throw new GwsEaError('invalid_secrets_file', `Secrets file line ${index + 1} is not KEY=value: ${file}`);
    }
    const key = match[1]!;
    if (!known.has(key)) {
      throw new GwsEaError(
        'invalid_secrets_file',
        `Secrets file names unknown key ${key}; expected ${[...known].join(' or ')}: ${file}`,
      );
    }
    const raw = match[2]!.trim();
    const value = /^(["']).*\1$/u.test(raw) ? raw.slice(1, -1) : raw;
    if (value) values.set(key, value);
  }
  return values;
}

/** Load supplied secrets: the environment first, then the secrets file. Every value is registered for redaction. */
export async function loadSecretSource(options: {
  readonly environment: NodeJS.ProcessEnv;
  readonly file?: string;
  readonly configRoot: string;
}): Promise<SecretSource> {
  let fromFile = new Map<string, string>();
  if (options.file !== undefined) {
    let contents: string;
    try {
      contents = await readOperatorFile(options.file, options.configRoot, 'The secrets file', 'unsafe_secrets_file');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) {
        throw new GwsEaError('secrets_file_missing', `The secrets file does not exist: ${options.file}`, {
          cause: error,
        });
      }
      throw error;
    }
    fromFile = parseSecretsFile(contents, options.file);
  }
  const values = new Map<SecretInput, string>();
  for (const [input, variable] of Object.entries(SECRET_INPUTS) as Array<[SecretInput, string]>) {
    const value = options.environment[variable]?.trim() || fromFile.get(variable);
    if (!value) continue;
    registerSecret(value);
    values.set(input, value);
  }
  return { get: (input) => values.get(input) };
}

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
  /** The resolved release source; create never asks for a repository. */
  readonly sourceRemote: string;
  /** The checked host and confirmed Google account this assistant is created on. */
  readonly prerequisites: Prerequisites;
  readonly provided: Readonly<Partial<Record<CreateInputFlag, string>>>;
  readonly secrets: SecretSource;
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
  readonly ingress: CreateIngressAnswer;
  readonly assistantWorkspaceEmail: string;
  readonly bootstrapManifest: ProductionBootstrapManifest;
}
