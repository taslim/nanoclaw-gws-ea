import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

import type { CreatePromptContext, CreateSetupAnswers } from '../src/gws-ea/create-input.js';
import { validateExistingGchatEndpoint } from '../src/gws-ea/endpoint.js';
import { resolveTrustedExecutable } from '../src/gws-ea/process.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import type { ProviderCredential } from '../src/provider-credential.js';
import { providerProvisioningCapabilityDigest } from '../src/provider-provisioning-capability.js';
import { isValidTimezone, resolveTimezone } from '../src/timezone.js';
import { brightSelect } from './lib/bright-select.js';
import { listSetupProviders, type SetupProviderEntry, type SetupProviderProvisioning } from './providers/registry.js';

interface DetectedRuntime {
  readonly onecliCliPath: string;
  readonly nodePath: string;
  readonly homeDirectory: string;
  readonly platform: 'macos' | 'linux';
  readonly runningAsRoot: boolean;
}

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
  readonly providers?: readonly SetupProviderEntry[];
  readonly detectedRuntime?: DetectedRuntime;
  readonly detectedTimezone?: string;
  readonly providerCapabilityDigest?: string;
  readonly prompts?: PromptAdapter;
}

const defaultPrompts: PromptAdapter = {
  note: (message, title) => p.note(message, title),
  text: (options) => p.text(options),
  select: (options) => brightSelect<string>(options),
  isCancel: p.isCancel,
  logInfo: (message) => p.log.info(message),
};

function cancelled(): never {
  throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
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

async function suppliedOrAsk(
  context: CreatePromptContext,
  prompts: PromptAdapter,
  field: 'source-remote' | 'endpoint' | 'workspace-email',
  message: string,
  validate?: (value: string) => string | undefined,
): Promise<string> {
  const supplied = context.provided[field]?.trim();
  return supplied || askText(prompts, message, { validate });
}

async function detectRuntime(): Promise<DetectedRuntime> {
  if (process.platform !== 'darwin' && process.platform !== 'linux') {
    throw new GwsEaError('unsupported_platform', 'GWS-EA supports macOS and Linux hosts');
  }
  const onecliSearchPath = [path.join(os.homedir(), '.local', 'bin'), process.env.PATH ?? ''].join(path.delimiter);
  const [onecliCliPath, nodePath] = await Promise.all([
    resolveTrustedExecutable('onecli', onecliSearchPath).catch(() => {
      throw new GwsEaError('onecli_required', 'OneCLI is not installed or is not executable; install it, then retry.');
    }),
    resolveTrustedExecutable(process.execPath),
  ]);
  return {
    onecliCliPath,
    nodePath,
    homeDirectory: os.homedir(),
    platform: process.platform === 'darwin' ? 'macos' : 'linux',
    runningAsRoot: process.getuid?.() === 0,
  };
}

function systemTimezone(): string {
  return resolveTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function displayName(first: string, last: string): string {
  return last ? `${first} ${last}` : first;
}

async function chooseProvider(
  providers: readonly SetupProviderEntry[],
  prompts: PromptAdapter,
): Promise<SetupProviderEntry & { readonly provisioning: SetupProviderProvisioning }> {
  const eligible = providers.filter(
    (provider): provider is SetupProviderEntry & { readonly provisioning: SetupProviderProvisioning } =>
      provider.provisioning !== undefined,
  );
  if (eligible.length === 0) {
    throw new GwsEaError('provider_not_composed', 'This release has no provider with an isolated authentication flow');
  }
  if (eligible.length === 1) {
    prompts.logInfo(`Using ${eligible[0]!.label}, the provider composed into this release.`);
    return eligible[0]!;
  }
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
  const runtime = dependencies.detectedRuntime ?? (await detectRuntime());
  const detectedTimezone = dependencies.detectedTimezone ?? systemTimezone();
  const providers = dependencies.providers ?? listSetupProviders();
  const providerCapabilityDigest =
    dependencies.providerCapabilityDigest ?? (await providerProvisioningCapabilityDigest(process.cwd()));

  prompts.note(`Instance ${context.instanceId}\nRelease track ${context.track}`, 'New assistant');
  const sourceRemote = await suppliedOrAsk(context, prompts, 'source-remote', 'Source repository remote');
  const assistantFirst = await askText(prompts, 'Assistant first name');
  const assistantLast = await askText(prompts, 'Assistant last name', { optional: true, placeholder: 'Optional' });
  const principalFirst = await askText(prompts, 'Principal first name');
  const principalLast = await askText(prompts, 'Principal last name', { optional: true, placeholder: 'Optional' });
  const principalTimezone = await askText(prompts, 'Principal timezone', {
    initialValue: detectedTimezone,
    validate: (value) => (isValidTimezone(value) ? undefined : 'Enter a valid IANA timezone'),
  });
  const assistantWorkspaceEmail = await suppliedOrAsk(
    context,
    prompts,
    'workspace-email',
    'Assistant Google Workspace email',
    (value) => (/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value) ? undefined : 'Enter a valid email address'),
  );
  const endpoint = await suppliedOrAsk(
    context,
    prompts,
    'endpoint',
    'Existing Google Chat webhook endpoint',
    (value) => {
      try {
        validateExistingGchatEndpoint(value);
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : 'Enter a valid Google Chat endpoint';
      }
    },
  );
  const provider = await chooseProvider(providers, prompts);
  const metadata = provider.provisioning.credentialMetadata({ allowAmbientConfiguration: false });

  return {
    sourceRemote,
    endpoint,
    assistantWorkspaceEmail,
    bootstrapManifest: {
      schema_version: 1,
      onecli_cli_path: runtime.onecliCliPath,
      node_path: runtime.nodePath,
      home_directory: runtime.homeDirectory,
      platform: runtime.platform,
      running_as_root: runtime.runningAsRoot,
      provider_capability_digest: providerCapabilityDigest,
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
        assistant_display_name: displayName(assistantFirst, assistantLast),
        principal_display_name: displayName(principalFirst, principalLast),
        principal_timezone: principalTimezone,
      },
      selected_messaging_group_id: null,
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
      allowAmbientConfiguration: false,
    });
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    throw new GwsEaError(
      'provider_authentication_failed',
      error instanceof Error && error.message === 'Provider authentication was cancelled'
        ? error.message
        : `Could not authenticate ${provider.label}; retry to continue provisioning.`,
    );
  }
  if (!collected) throw new GwsEaError('provider_credential_required', 'Provider authentication is required');
  return collected.credential;
}
