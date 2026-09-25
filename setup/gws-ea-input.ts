import * as p from '@clack/prompts';

import {
  describeSecretInput,
  type CloudflareZoneChoice,
  type CreateIngressAnswer,
  type CreateInputFlag,
  type CreatePromptContext,
  type CreateSetupAnswers,
} from '../src/gws-ea/create-input.js';
import { validateExistingGchatEndpoint } from '../src/gws-ea/endpoint.js';
import { isConsumerGoogleAccount } from '../src/gws-ea/gcloud.js';
import { registerSecret } from '../src/gws-ea/redact.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import type { ProviderCredential } from '../src/provider-credential.js';
import { providerProvisioningCapabilityDigest } from '../src/provider-provisioning-capability.js';
import { isValidTimezone, resolveTimezone } from '../src/timezone.js';
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
  password(options: {
    readonly message: string;
    readonly validate?: (value: string | undefined) => string | undefined;
  }): Promise<unknown>;
  confirm(options: { readonly message: string; readonly initialValue: boolean }): Promise<unknown>;
  select(options: {
    readonly message: string;
    readonly options: { readonly value: string; readonly label: string; readonly hint: string }[];
  }): Promise<unknown>;
  isCancel(value: unknown): boolean;
  logInfo(message: string): void;
}

export interface GwsEaCreateInputDependencies {
  /** Whether a person can answer prompts. Without one, every input comes from its flag or secret source. */
  readonly interactive?: boolean;
  readonly providers?: readonly SetupProviderEntry[];
  readonly detectedTimezone?: string;
  readonly providerCapabilityDigest?: string;
  readonly prompts?: PromptAdapter;
}

const defaultPrompts: PromptAdapter = {
  note: (message, title) => p.note(message, title),
  text: (options) => p.text(options),
  password: (options) => p.password(options),
  confirm: (options) => p.confirm(options),
  select: (options) => brightSelect<string>(options),
  isCancel: p.isCancel,
  logInfo: (message) => p.log.info(message),
};

const CLOUDFLARE_ID_PATTERN = /^[0-9a-f]{32}$/u;
const DNS_LABEL_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const DNS_NAME_PATTERN = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/u;
const CLOUDFLARE_API_TOKEN_URL = 'https://dash.cloudflare.com/profile/api-tokens';
export const CLOUDFLARE_API_TOKEN_GUIDANCE = [
  'Create a scoped API token for the intended account and every zone used by managed assistants on this machine:',
  'Account · Cloudflare Tunnel: Edit',
  'Zone · Zone: Read',
  'Zone · DNS: Edit',
  CLOUDFLARE_API_TOKEN_URL,
  '',
  'The token is used only for this setup run and is not stored.',
].join('\n');

function cancelled(): never {
  throw new GwsEaError('cancelled', 'Assistant creation was cancelled');
}

/** Where create input comes from: its flag first, then a prompt when a person is present. */
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

async function askPassword(prompts: PromptAdapter, message: string): Promise<string> {
  const answer = await prompts.password({
    message,
    validate: (value) => (value?.trim() ? undefined : 'Required'),
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string' || !answer.trim()) return cancelled();
  return answer.trim();
}

function workspaceEmailProblem(value: string): string | undefined {
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(value)) return 'Enter a valid email address';
  if (isConsumerGoogleAccount(value)) return 'Enter a Google Workspace address, not a personal Google account';
  return undefined;
}

function systemTimezone(): string {
  return resolveTimezone(Intl.DateTimeFormat().resolvedOptions().timeZone);
}

function displayName(first: string, last: string): string {
  return last ? `${first} ${last}` : first;
}

function defaultDnsLabel(assistantFirstName: string): string {
  const normalized = assistantFirstName
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, '-')
    .replace(/^-+|-+$/gu, '')
    .slice(0, 63)
    .replace(/-+$/gu, '');
  return normalized || 'assistant';
}

function validateDnsLabel(value: string): string | undefined {
  return DNS_LABEL_PATTERN.test(value)
    ? undefined
    : 'Use 1-63 lowercase letters, numbers, or hyphens; start and end with a letter or number';
}

function validateDiscoveredZones(zones: readonly CloudflareZoneChoice[]): readonly CloudflareZoneChoice[] {
  if (zones.length === 0) {
    throw new GwsEaError('cloudflare_zone_required', 'The Cloudflare token has no active zones available');
  }
  const zoneIds = new Set<string>();
  const zoneNames = new Set<string>();
  for (const zone of zones) {
    if (
      Object.keys(zone).sort().join(',') !== 'accountId,accountName,name,status,zoneId' ||
      !CLOUDFLARE_ID_PATTERN.test(zone.accountId) ||
      !CLOUDFLARE_ID_PATTERN.test(zone.zoneId) ||
      !zone.accountName.trim() ||
      zone.status !== 'active' ||
      zone.name !== zone.name.toLowerCase() ||
      !DNS_NAME_PATTERN.test(zone.name)
    ) {
      throw new GwsEaError('invalid_cloudflare_zone', 'Cloudflare returned an invalid or inactive zone');
    }
    if (zoneIds.has(zone.zoneId) || zoneNames.has(zone.name)) {
      throw new GwsEaError('invalid_cloudflare_zone', 'Cloudflare returned a duplicate zone');
    }
    zoneIds.add(zone.zoneId);
    zoneNames.add(zone.name);
  }
  return zones;
}

async function chooseZone(zones: readonly CloudflareZoneChoice[], source: InputSource): Promise<CloudflareZoneChoice> {
  const named = supplied(source, 'cloudflare-zone')?.toLowerCase();
  if (named !== undefined) {
    const zone = zones.find((candidate) => candidate.name === named);
    if (!zone) {
      throw invalidFlag(
        'cloudflare-zone',
        `${named} is not an active zone this token can use (${zones.map((candidate) => candidate.name).join(', ')})`,
      );
    }
    return zone;
  }
  if (zones.length === 1) {
    const zone = zones[0]!;
    logInfo(source, `Using ${zone.name}, the active zone available to this token.`);
    return zone;
  }
  if (!source.interactive) throw missingInput('cloudflare-zone');
  const prompts = source.prompts;
  const selected = await prompts.select({
    message: 'Which Cloudflare zone should host the assistant?',
    options: zones.map((zone) => ({
      value: zone.zoneId,
      label: zone.name,
      hint: zone.accountName,
    })),
  });
  if (prompts.isCancel(selected) || typeof selected !== 'string') return cancelled();
  const zone = zones.find((candidate) => candidate.zoneId === selected);
  if (!zone) throw new GwsEaError('invalid_cloudflare_zone', 'Selected Cloudflare zone is unavailable');
  return zone;
}

async function chooseIngressMode(source: InputSource): Promise<CreateIngressAnswer['mode']> {
  const endpoint = supplied(source, 'endpoint');
  const mode = supplied(source, 'ingress');
  if (mode !== undefined && mode !== 'existing' && mode !== 'managed-cloudflare') {
    throw invalidFlag('ingress', 'use existing or managed-cloudflare');
  }
  if (endpoint !== undefined && mode === 'managed-cloudflare') {
    throw invalidFlag('endpoint', 'applies only to --ingress existing');
  }
  if (endpoint !== undefined) return 'existing';
  if (mode !== undefined) return mode;
  if (!source.interactive) throw missingInput('ingress', ' (existing with --endpoint, or managed-cloudflare)');
  const prompts = source.prompts;
  const selected = await prompts.select({
    message: 'How should Google Chat reach this assistant?',
    options: [
      {
        value: 'managed-cloudflare',
        label: 'Managed Cloudflare',
        hint: 'Create and manage a stable callback automatically',
      },
      {
        value: 'existing',
        label: 'Existing HTTPS endpoint',
        hint: 'Use infrastructure you already operate',
      },
    ],
  });
  if (prompts.isCancel(selected) || (selected !== 'existing' && selected !== 'managed-cloudflare')) return cancelled();
  return selected;
}

function endpointProblem(value: string): string | undefined {
  try {
    validateExistingGchatEndpoint(value);
    return undefined;
  } catch (error) {
    return error instanceof Error ? error.message : 'Enter a valid Google Chat endpoint';
  }
}

async function cloudflareToken(source: InputSource): Promise<string> {
  const token = source.context.secrets.get('cloudflareAccountToken');
  if (token) return token;
  if (!source.interactive) {
    throw new GwsEaError(
      'input_required',
      `Managed Cloudflare ingress needs an API token: ${describeSecretInput('cloudflareAccountToken')}.`,
    );
  }
  note(source, CLOUDFLARE_API_TOKEN_GUIDANCE, 'Cloudflare access');
  const prompted = await askPassword(source.prompts, 'Cloudflare API token');
  registerSecret(prompted);
  return prompted;
}

async function collectIngress(source: InputSource, assistantFirstName: string): Promise<CreateIngressAnswer> {
  const mode = await chooseIngressMode(source);
  if (mode === 'existing') {
    const endpointUrl = await textInput(source, 'endpoint', 'Existing Google Chat webhook endpoint', {
      validate: endpointProblem,
    });
    return { mode, endpointUrl: validateExistingGchatEndpoint(endpointUrl) };
  }

  const session = source.context.managedIngressSetup;
  if (!session) {
    throw new GwsEaError('managed_ingress_unavailable', 'Managed Cloudflare setup is unavailable in this release');
  }
  const token = await cloudflareToken(source);
  const zones = validateDiscoveredZones(await session.discoverZones(token));
  const zone = await chooseZone(zones, source);
  const labelWasSupplied = supplied(source, 'hostname-label') !== undefined;
  const label = await textInput(source, 'hostname-label', 'Assistant hostname label', {
    initialValue: defaultDnsLabel(assistantFirstName),
    validate: validateDnsLabel,
  });
  const hostname = `${label}.${zone.name}`;
  const callbackUrl = `https://${hostname}/webhook/gchat`;
  if (!labelWasSupplied) {
    const confirmed = await source.prompts.confirm({
      message: `Reserve ${hostname} for this assistant?\nGoogle Chat callback: ${callbackUrl}`,
      initialValue: true,
    });
    if (source.prompts.isCancel(confirmed) || confirmed !== true) return cancelled();
  }
  session.retainAccountToken(token);
  return {
    mode,
    accountId: zone.accountId,
    zoneId: zone.zoneId,
    zoneName: zone.name,
    hostname,
    callbackUrl,
  };
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
  const providerCapabilityDigest =
    dependencies.providerCapabilityDigest ?? (await providerProvisioningCapabilityDigest(process.cwd()));

  const source: InputSource = { context, prompts, interactive: dependencies.interactive ?? true };

  note(source, `Instance ${context.instanceId}\nRelease track ${context.track}`, 'New assistant');
  const assistantFirst = await textInput(source, 'assistant-first-name', 'Assistant first name');
  const assistantLast = await textInput(source, 'assistant-last-name', 'Assistant last name', {
    optional: true,
    placeholder: 'Optional',
  });
  const principalFirst = await textInput(source, 'principal-first-name', 'Principal first name');
  const principalLast = await textInput(source, 'principal-last-name', 'Principal last name', {
    optional: true,
    placeholder: 'Optional',
  });
  const principalTimezone = await textInput(source, 'principal-timezone', 'Principal timezone', {
    initialValue: detectedTimezone,
    validate: (value) => (isValidTimezone(value) ? undefined : 'Enter a valid IANA timezone'),
  });
  const assistantWorkspaceEmail = await textInput(source, 'workspace-email', 'Assistant Google Workspace email', {
    validate: workspaceEmailProblem,
  });
  const ingress = await collectIngress(source, assistantFirst);
  const provider = await chooseProvider(providers, source);
  const metadata = provider.provisioning.credentialMetadata({ allowAmbientConfiguration: false });

  return {
    ingress,
    assistantWorkspaceEmail,
    bootstrapManifest: {
      schema_version: 1,
      onecli_cli_path: host.onecliCliPath,
      node_path: host.nodePath,
      home_directory: host.homeDirectory,
      platform: host.platform,
      running_as_root: host.runningAsRoot,
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
