import * as p from '@clack/prompts';

import {
  parsePrincipalChatEmail,
  PRINCIPAL_CHAT_EMAIL_FLAG,
  PRINCIPAL_EMAIL_FLAG,
  principalChatEmailProblem,
  type CreateInputFlag,
  type CreatePromptContext,
  type CreateSetupAnswers,
} from '../src/gws-ea/create-input.js';
import {
  normalizePrincipalEmail,
  principalAddressConflict,
  principalAddressesConflict,
} from '../src/gws-ea/validation.js';
import { normalizePersonName, type PersonName, type NameOwner } from '../src/gws-ea/person-name.js';
import { isConsumerGoogleAccount } from '../src/gws-ea/gcloud.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { EMAIL_PATTERN } from '../src/gws-ea/validation.js';
import type { ProviderCredential } from '../src/provider-credential.js';
import { ianaTimezone, resolveTimezone } from '../src/timezone.js';
import { brightSelect } from './lib/bright-select.js';
import { listSetupProviders, type SetupProviderEntry, type SetupProviderProvisioning } from './providers/registry.js';

interface PromptAdapter {
  note(message: string, title?: string): void;
  text(options: {
    readonly message: string;
    readonly initialValue?: string;
    readonly placeholder?: string;
    readonly validate?: (value: string | undefined) => string | undefined;
  }): Promise<unknown>;
  select(options: {
    readonly message: string;
    readonly options: { readonly value: string; readonly label: string; readonly hint: string }[];
  }): Promise<unknown>;
  isCancel(value: unknown): boolean;
  logInfo(message: string): void;
}

export interface GwsEaCreateInputDependencies {
  /** False when no person can answer prompts: every input then comes from its flag or secret source. */
  readonly interactive?: boolean;
  readonly providers?: readonly SetupProviderEntry[];
  readonly detectedTimezone?: string;
  readonly prompts?: PromptAdapter;
}

const defaultPrompts: PromptAdapter = {
  note: (message, title) => p.note(message, title, { output: process.stderr }),
  text: (options) => p.text({ ...options, output: process.stderr }),
  select: (options) => brightSelect<string>({ ...options, output: process.stderr }),
  isCancel: p.isCancel,
  logInfo: (message) => p.log.info(message, { output: process.stderr }),
};

function cancelled(): never {
  throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
}

interface InputSource {
  readonly context: CreatePromptContext;
  readonly prompts: PromptAdapter;
  readonly interactive: boolean;
}

function missingInput(flag: CreateInputFlag, hint = ''): GwsEaError {
  return new GwsEaError(
    'input_required',
    `Missing --${flag}${hint}; pass it, or run gws-ea create in a terminal to be asked.`,
    { details: { flag: `--${flag}` } },
  );
}

function invalidFlag(flag: CreateInputFlag, problem: string): GwsEaError {
  return new GwsEaError('invalid_arguments', `--${flag}: ${problem}`, { details: { flag: `--${flag}` } });
}

function supplied(source: InputSource, flag: CreateInputFlag): string | undefined {
  return source.context.provided[flag]?.trim() || undefined;
}

async function textInput(
  source: InputSource,
  flag: CreateInputFlag,
  message: string,
  options: {
    readonly initialValue?: string;
    readonly placeholder?: string;
    readonly optional?: boolean;
    readonly validate?: (value: string) => string | undefined;
  } = {},
): Promise<string> {
  const value = supplied(source, flag);
  if (value !== undefined) {
    const problem = options.validate?.(value);
    if (problem) throw invalidFlag(flag, problem);
    return value;
  }
  if (!source.interactive) {
    if (options.optional) return '';
    throw missingInput(flag);
  }
  return askText(source.prompts, message, options);
}

function note(source: InputSource, message: string, title: string): void {
  if (source.interactive) source.prompts.note(message, title);
}

function logInfo(source: InputSource, message: string): void {
  if (source.interactive) source.prompts.logInfo(message);
}

async function askText(
  prompts: PromptAdapter,
  message: string,
  options: {
    readonly initialValue?: string;
    readonly placeholder?: string;
    readonly optional?: boolean;
    readonly validate?: (value: string) => string | undefined;
  } = {},
): Promise<string> {
  const answer = await prompts.text({
    message,
    ...(options.initialValue ? { initialValue: options.initialValue } : {}),
    ...(options.placeholder ? { placeholder: options.placeholder } : {}),
    validate: (value) => {
      const trimmed = value?.trim() ?? '';
      if (!trimmed && !options.optional) return 'Required';
      return trimmed ? options.validate?.(trimmed) : undefined;
    },
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string') return cancelled();
  return answer.trim();
}

function workspaceEmailProblem(value: string): string | undefined {
  if (!EMAIL_PATTERN.test(value)) return 'Enter a valid email address';
  if (isConsumerGoogleAccount(value)) return 'Enter a Google Workspace address, not a personal Google account';
  return undefined;
}

/** Never the assistant's own address, and never two spellings of one address (`principalAddressConflict`). */
async function principalEmailsInput(source: InputSource, assistantWorkspaceEmail: string): Promise<string[]> {
  const assistant = assistantWorkspaceEmail.trim().toLowerCase();
  const provided = source.context.providedPrincipalEmails;
  if (provided.length > 0) {
    const conflict = principalAddressesConflict(provided, [assistant]);
    if (conflict !== undefined) {
      throw new GwsEaError('invalid_arguments', `--${PRINCIPAL_EMAIL_FLAG}: ${conflict}`, {
        details: { flag: `--${PRINCIPAL_EMAIL_FLAG}` },
      });
    }
    return [...provided];
  }
  if (!source.interactive) {
    throw new GwsEaError(
      'input_required',
      `Missing --${PRINCIPAL_EMAIL_FLAG}; pass it once per address, or run gws-ea create in a terminal to be asked.`,
      { details: { flag: `--${PRINCIPAL_EMAIL_FLAG}` } },
    );
  }
  const answer = await askText(source.prompts, 'Principal email addresses', {
    placeholder: 'Comma-separated',
    validate: (value) => principalEmailsFrom(value, assistant).problem,
  });
  return principalEmailsFrom(answer, assistant).emails;
}

function principalEmailsFrom(value: string, assistant: string): { emails: string[]; problem?: string } {
  const entries = value
    .split(',')
    .map((entry) => entry.trim())
    .filter((entry) => entry !== '');
  if (entries.length === 0) return { emails: [], problem: 'Enter at least one email address' };
  const emails: string[] = [];
  for (const entry of entries) {
    const email = normalizePrincipalEmail(entry);
    if (email === undefined) return { emails: [], problem: `${entry} is not an email address` };
    const conflict = principalAddressConflict(email, emails, [assistant]);
    if (conflict !== undefined) return { emails: [], problem: conflict };
    if (!emails.includes(email)) emails.push(email);
  }
  return { emails };
}

/** The address the assistant opens its Google Chat DM with; it must be one of the principal's. */
async function principalChatEmailInput(source: InputSource, principalEmails: readonly string[]): Promise<string> {
  const [first, ...others] = principalEmails;
  if (first === undefined) throw new GwsEaError('input_required', "The principal's addresses are missing");
  const answer =
    others.length === 0 && supplied(source, PRINCIPAL_CHAT_EMAIL_FLAG) === undefined
      ? first
      : await textInput(source, PRINCIPAL_CHAT_EMAIL_FLAG, 'Principal Google Chat address', {
          initialValue: first,
          validate: (value) => principalChatEmailProblem(value, principalEmails),
        });
  return parsePrincipalChatEmail(answer, principalEmails);
}

function systemTimezone(): string {
  return resolveTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

async function personNameInput(source: InputSource, owner: NameOwner): Promise<PersonName> {
  const label = owner === 'assistant' ? 'Assistant' : 'Principal';
  const problem = (firstName: string, lastName: string | null): string | undefined => {
    try {
      normalizePersonName({ firstName, lastName }, owner);
      return undefined;
    } catch (error) {
      if (error instanceof Error) return error.message;
      throw error;
    }
  };
  const firstName = await textInput(source, `${owner}-first-name`, `${label} first name`, {
    validate: (value) => problem(value, null),
  });
  const lastName = await textInput(source, `${owner}-last-name`, `${label} last name`, {
    optional: true,
    placeholder: 'Optional',
    validate: (value) => problem(firstName, value),
  });
  return normalizePersonName({ firstName, lastName }, owner);
}

async function chooseProvider(
  providers: readonly SetupProviderEntry[],
  source: InputSource,
): Promise<SetupProviderEntry & { readonly provisioning: SetupProviderProvisioning }> {
  const eligible = providers.filter(
    (provider): provider is SetupProviderEntry & { readonly provisioning: SetupProviderProvisioning } =>
      provider.provisioning !== undefined,
  );
  if (eligible.length === 0) {
    throw new GwsEaError('provider_not_composed', 'This release has no provider with an isolated authentication flow');
  }
  const named = supplied(source, 'provider');
  if (named !== undefined) {
    const provider = eligible.find((entry) => entry.value === named);
    if (!provider) {
      throw invalidFlag('provider', `use one of ${eligible.map((entry) => entry.value).join(', ')}`);
    }
    return provider;
  }
  if (eligible.length === 1) {
    logInfo(source, `Using ${eligible[0]!.label}, the provider composed into this release.`);
    return eligible[0]!;
  }
  if (!source.interactive) throw missingInput('provider');
  const prompts = source.prompts;
  const selected = await prompts.select({
    message: 'Which agent runtime should power your assistant?',
    options: eligible.map(({ value, label, hint }) => ({ value, label, hint })),
  });
  if (prompts.isCancel(selected) || typeof selected !== 'string') return cancelled();
  const provider = eligible.find((entry) => entry.value === selected);
  if (!provider) throw new GwsEaError('provider_not_composed', 'Selected provider is not composed into this release');
  return provider;
}

export async function collectGwsEaCreateInput(
  context: CreatePromptContext,
  dependencies: GwsEaCreateInputDependencies = {},
): Promise<CreateSetupAnswers> {
  const prompts = dependencies.prompts ?? defaultPrompts;
  const host = context.prerequisites;
  const detectedTimezone = dependencies.detectedTimezone ?? systemTimezone();
  const providers = dependencies.providers ?? listSetupProviders();

  const source: InputSource = { context, prompts, interactive: dependencies.interactive ?? true };

  note(
    source,
    [
      `Release track ${context.track}.`,
      'Your operator Google Cloud account manages resources. The assistant uses its own Workspace account for mail and Chat.',
      'Principal addresses identify the person served; choose their Chat address from that list. Provider sign-in is a separate identity.',
    ].join('\n'),
    'New assistant',
  );
  const assistantName = await personNameInput(source, 'assistant');
  const assistantWorkspaceEmail = await textInput(
    source,
    'assistant-workspace-email',
    'Assistant Google Workspace email',
    { validate: workspaceEmailProblem },
  );
  const principalName = await personNameInput(source, 'principal');
  const principalEmails = await principalEmailsInput(source, assistantWorkspaceEmail);
  const principalChatEmail = await principalChatEmailInput(source, principalEmails);
  const givenTimezone = await textInput(source, 'principal-timezone', 'Principal timezone', {
    initialValue: detectedTimezone,
    validate: (value) => (ianaTimezone(value) === undefined ? 'Enter a valid IANA timezone' : undefined),
  });
  // Held in the zone's own spelling, since main's container runs in it.
  const principalTimezone = ianaTimezone(givenTimezone);
  if (principalTimezone === undefined) throw invalidFlag('principal-timezone', 'Enter a valid IANA timezone');
  const provider = await chooseProvider(providers, source);
  const metadata = provider.provisioning.credentialMetadata({ allowAmbientConfiguration: false });

  return {
    assistantWorkspaceEmail,
    bootstrapManifest: {
      schema_version: 2,
      node_path: host.nodePath,
      home_directory: host.homeDirectory,
      platform: host.platform,
      running_as_root: host.runningAsRoot,
      docker_endpoint: host.dockerEndpoint,
      provider: {
        id: provider.value,
        name: metadata.name,
        type: metadata.type,
        host_pattern: metadata.hostPattern,
        header_name: metadata.headerName ?? null,
        value_format: metadata.valueFormat ?? null,
        path_pattern: metadata.pathPattern ?? null,
        param_name: metadata.paramName ?? null,
        param_format: metadata.paramFormat ?? null,
      },
      identity: {
        assistant_first_name: assistantName.firstName,
        assistant_last_name: assistantName.lastName,
        principal_first_name: principalName.firstName,
        principal_last_name: principalName.lastName,
        principal_timezone: principalTimezone,
        principal_emails: principalEmails,
        principal_chat_email: principalChatEmail,
      },
    },
  };
}

export async function authenticateGwsEaProvider(
  providerId: string,
  providers: readonly SetupProviderEntry[] = listSetupProviders(),
): Promise<ProviderCredential> {
  const provider = providers.find((entry) => entry.value === providerId);
  if (!provider?.provisioning) {
    throw new GwsEaError('provider_not_composed', `Provider ${providerId} is not composed for isolated enrollment`);
  }
  let collected: Awaited<ReturnType<typeof provider.provisioning.collectCredential>>;
  try {
    collected = await provider.provisioning.collectCredential({
      allowSkip: false,
      output: process.stderr,
      allowAmbientConfiguration: false,
    });
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    if (error instanceof Error && error.message === 'Provider authentication was cancelled')
      throw new GwsEaError('cancelled', error.message);
    throw new GwsEaError(
      'provider_authentication_failed',
      `Could not authenticate ${provider.label}; retry to continue provisioning.`,
    );
  }
  if (!collected) throw new GwsEaError('provider_credential_required', 'Provider authentication is required');
  return collected.credential;
}
