import { isErrno } from '../community-portal/errors.js';
import type { Prerequisites } from './prerequisites.js';
import type { ProductionBootstrapManifest } from './provision.js';
import { registerSecret } from './redact.js';
import { readOperatorFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { normalizePrincipalEmail } from './validation.js';

export const PRINCIPAL_EMAIL_FLAG = 'principal-email';

export function parsePrincipalEmailFlags(values: readonly string[]): readonly string[] {
  const emails = values.map((value) => {
    const email = normalizePrincipalEmail(value);
    if (email === undefined) {
      throw new GwsEaError(
        'invalid_arguments',
        `--${PRINCIPAL_EMAIL_FLAG}: ${JSON.stringify(value)} is not an email address`,
        { details: { flag: `--${PRINCIPAL_EMAIL_FLAG}` } },
      );
    }
    return email;
  });
  return [...new Set(emails)];
}

export const PRINCIPAL_CHAT_EMAIL_FLAG = 'principal-chat-email';

function principalAddressOf(value: string, principalEmails: readonly string[]): string | undefined {
  const email = normalizePrincipalEmail(value);
  return email !== undefined && principalEmails.includes(email) ? email : undefined;
}

function notAPrincipalAddress(principalEmails: readonly string[]): string {
  return `Use one of the principal's addresses: ${principalEmails.join(', ')}`;
}

/** Undefined when `value` is one of the principal's addresses, in any spelling. */
export function principalChatEmailProblem(value: string, principalEmails: readonly string[]): string | undefined {
  return principalAddressOf(value, principalEmails) === undefined ? notAPrincipalAddress(principalEmails) : undefined;
}

export function parsePrincipalChatEmail(value: string, principalEmails: readonly string[]): string {
  const email = principalAddressOf(value, principalEmails);
  if (email === undefined) {
    throw new GwsEaError(
      'invalid_arguments',
      `--${PRINCIPAL_CHAT_EMAIL_FLAG}: ${notAPrincipalAddress(principalEmails)}`,
      { details: { flag: `--${PRINCIPAL_CHAT_EMAIL_FLAG}` } },
    );
  }
  return email;
}

/** One flag per create prompt, so `create` can run without a person. */
export const CREATE_INPUT_FLAGS = [
  'assistant-first-name',
  'assistant-last-name',
  'principal-first-name',
  'principal-last-name',
  'principal-timezone',
  PRINCIPAL_CHAT_EMAIL_FLAG,
  'assistant-workspace-email',
  'provider',
] as const;

export type CreateInputFlag = (typeof CREATE_INPUT_FLAGS)[number];

/**
 * Secrets never travel as flags: each comes from its environment variable or the owner-only `--secrets-file` under
 * the config root, and gws-ea never writes it; the credential gateway holds it.
 */
export const SECRET_INPUTS = {
  providerCredential: 'GWS_EA_PROVIDER_CREDENTIAL',
} as const;

export type SecretInput = keyof typeof SECRET_INPUTS;

export interface SecretSource {
  /** A supplied secret, already registered with the redactor. */
  get(input: SecretInput): string | undefined;
}

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

/** The environment wins over the secrets file; every value is registered for redaction. */
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

export interface CreatePromptContext {
  readonly instanceId: string;
  readonly track: string;
  /** The resolved release source; create never asks for a repository. */
  readonly sourceRemote: string;
  /** The checked host and confirmed Google account this assistant is created on. */
  readonly prerequisites: Prerequisites;
  readonly provided: Readonly<Partial<Record<CreateInputFlag, string>>>;
  /** Empty when no `--principal-email` was passed, so create asks; they become the bootstrap `principal_emails`. */
  readonly providedPrincipalEmails: readonly string[];
  readonly secrets: SecretSource;
}

export interface CreateSetupAnswers {
  readonly assistantWorkspaceEmail: string;
  readonly bootstrapManifest: ProductionBootstrapManifest;
}
