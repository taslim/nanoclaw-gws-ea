import os from 'node:os';
import path from 'node:path';

import * as p from '@clack/prompts';

import type {
  CloudflareZoneChoice,
  CreateIngressAnswer,
  CreatePromptContext,
  CreateSetupAnswers,
} from '../src/gws-ea/create-input.js';
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
  readonly providers?: readonly SetupProviderEntry[];
  readonly detectedRuntime?: DetectedRuntime;
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

async function askPassword(prompts: PromptAdapter, message: string): Promise<string> {
  const answer = await prompts.password({
    message,
    validate: (value) => (value?.trim() ? undefined : 'Required'),
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string' || !answer.trim()) return cancelled();
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

async function chooseZone(
  zones: readonly CloudflareZoneChoice[],
  prompts: PromptAdapter,
): Promise<CloudflareZoneChoice> {
  if (zones.length === 1) {
    const zone = zones[0]!;
    prompts.logInfo(`Using ${zone.name}, the active zone available to this token.`);
    return zone;
  }
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

async function collectIngress(
  context: CreatePromptContext,
  prompts: PromptAdapter,
  assistantFirstName: string,
): Promise<CreateIngressAnswer> {
  const suppliedEndpoint = context.provided.endpoint?.trim();
  if (suppliedEndpoint) {
    return { mode: 'existing', endpointUrl: validateExistingGchatEndpoint(suppliedEndpoint) };
  }
  const mode = await prompts.select({
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
  if (prompts.isCancel(mode) || (mode !== 'existing' && mode !== 'managed-cloudflare')) return cancelled();
  if (mode === 'existing') {
    const endpointUrl = await askText(prompts, 'Existing Google Chat webhook endpoint', {
      validate: (value) => {
        try {
          validateExistingGchatEndpoint(value);
          return undefined;
        } catch (error) {
          return error instanceof Error ? error.message : 'Enter a valid Google Chat endpoint';
        }
      },
    });
    return { mode, endpointUrl: validateExistingGchatEndpoint(endpointUrl) };
  }

  const session = context.managedIngressSetup;
  if (!session) {
    throw new GwsEaError('managed_ingress_unavailable', 'Managed Cloudflare setup is unavailable in this release');
  }
  const token = await askPassword(prompts, 'Cloudflare API token');
  const zones = validateDiscoveredZones(await session.discoverZones(token));
  const zone = await chooseZone(zones, prompts);
  const label = await askText(prompts, 'Assistant hostname label', {
    initialValue: defaultDnsLabel(assistantFirstName),
    validate: validateDnsLabel,
  });
  const hostname = `${label}.${zone.name}`;
  const callbackUrl = `https://${hostname}/webhook/gchat`;
  const confirmed = await prompts.confirm({
    message: `Reserve ${hostname} for this assistant?\nGoogle Chat callback: ${callbackUrl}`,
    initialValue: true,
  });
  if (prompts.isCancel(confirmed) || confirmed !== true) return cancelled();
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
  const ingress = await collectIngress(context, prompts, assistantFirst);
  const provider = await chooseProvider(providers, prompts);
  const metadata = provider.provisioning.credentialMetadata({ allowAmbientConfiguration: false });

  return {
    sourceRemote,
    ingress,
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
