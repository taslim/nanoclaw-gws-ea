/** Operator connectors; agent tool permissions remain in ../capabilities.ts. */
import type { CommandOptions } from './command-parser.js';
import type { ControlPlanePaths } from './paths.js';
import type { ConnectorInspection, ConnectorObservation } from './connector-inspection.js';
import type { VoiceOperatorDependencies } from './local-voice.js';
import type {
  CatalogConnectorDependencies,
  LinkInstallData,
  LinkUninstallData,
  ShopInstallData,
  ShopUninstallData,
} from './catalog-connector.js';
import type { WebCapabilityDependencies, WebConnectorOperation, WebConnectorUninstallData } from './web-connector.js';
import type { OptionDefinition } from './command-definitions.js';
import { DEFAULT_VOICE_MODEL } from './install-voice.js';
import { VOICE_MODEL_CATALOG } from './voice-assets.js';

export const CONNECTOR_NAMES = ['voice', 'web', 'link', 'shop'] as const;
export type ConnectorName = (typeof CONNECTOR_NAMES)[number];
export const CONNECTOR_ACTIONS = ['install', 'uninstall', 'show', 'check'] as const;
export type ConnectorAction = (typeof CONNECTOR_ACTIONS)[number];
export type ConnectorOperation =
  | { readonly name: 'voice'; readonly scope: 'host'; readonly enabled: boolean; readonly installation_dir?: string }
  | WebConnectorOperation
  | WebConnectorUninstallData
  | LinkInstallData
  | LinkUninstallData
  | ShopInstallData
  | ShopUninstallData;
export interface ConnectorLifecycleContext {
  readonly paths: ControlPlanePaths;
  readonly options: CommandOptions;
  readonly voice: VoiceOperatorDependencies;
  readonly web: WebCapabilityDependencies;
  readonly catalog: CatalogConnectorDependencies;
}
interface ConnectorInstallResults {
  voice: Extract<ConnectorOperation, { name: 'voice' }>;
  web: WebConnectorOperation;
  link: LinkInstallData;
  shop: ShopInstallData;
}
interface ConnectorUninstallResults {
  voice: Extract<ConnectorOperation, { name: 'voice' }>;
  web: WebConnectorUninstallData;
  link: LinkUninstallData;
  shop: ShopUninstallData;
}
export interface ConnectorDefinitionFor<Name extends ConnectorName> {
  readonly inspect: (paths: ControlPlanePaths, options?: ConnectorInspection) => Promise<ConnectorObservation>;
  readonly install: (context: ConnectorLifecycleContext) => Promise<ConnectorInstallResults[Name]>;
  readonly uninstall: (context: ConnectorLifecycleContext) => Promise<ConnectorUninstallResults[Name]>;
  readonly name: Name;
  readonly summary: string;
  readonly prerequisites: readonly string[];
  readonly account: string;
  readonly scope: {
    readonly installation: 'host';
    readonly configuration: 'host';
    readonly resources: 'host' | 'assistant';
    readonly access: string;
  };
  readonly options: Readonly<Record<ConnectorAction, readonly OptionDefinition[]>>;
  readonly effects: Readonly<Record<ConnectorAction, readonly string[]>>;
}
export type ConnectorDefinition = { [Name in ConnectorName]: ConnectorDefinitionFor<Name> }[ConnectorName];
const value = (name: string, valueName: string, description: string): OptionDefinition => ({
  name,
  valueName,
  description,
  type: 'string',
});
const file = (name: string, description: string): OptionDefinition => ({
  name,
  valueName: 'file',
  description,
  type: 'string',
  valueKind: 'file',
});
const id = value(
  'id',
  'instance_id',
  'Inspect this full assistant ID; omitted, inspect the host and compatible assistants.',
);
const observation = ['Read-only local records; readiness is not checked.'];
const check = ['Bounded read-only verification; never installs, provisions, restarts or repairs.'];
export const CONNECTOR_CATALOG: readonly ConnectorDefinition[] = [
  {
    name: 'voice',
    inspect: async (paths, options) =>
      (await import('./connector-inspection.js')).inspectConnector(paths, 'voice', options),
    install: async ({ paths, options, voice }) => {
      const { installLocalVoice } = await import('./local-voice.js');
      const model = options.model ?? DEFAULT_VOICE_MODEL;
      if (model !== 'base' && model !== 'small' && model !== 'large-v3-turbo-q5_0')
        throw new Error('Unsupported voice model');
      const installed = await installLocalVoice(
        paths,
        { model, ...(options.cmake ? { cmake: options.cmake } : {}) },
        voice,
      );
      return { name: 'voice', scope: 'host', enabled: true, installation_dir: installed.installationDir };
    },
    uninstall: async ({ paths, voice }) => {
      await (await import('./local-voice.js')).uninstallLocalVoice(paths, voice);
      return { name: 'voice', scope: 'host', enabled: false };
    },
    summary: 'Recognize voice notes with shared local programs and model assets.',
    prerequisites: ['macOS or Linux on arm64 or x64.', 'CMake, C/C++ compilers, make and tar for installation.'],
    account: 'No external account; installation belongs to this operator host.',
    scope: {
      installation: 'host',
      configuration: 'host',
      resources: 'host',
      access: 'Every compatible managed assistant; recordings remain private.',
    },
    options: {
      install: [
        {
          name: 'model',
          type: 'string',
          valueName: 'model',
          choices: Object.keys(VOICE_MODEL_CATALOG),
          description: `Local model; defaults to ${DEFAULT_VOICE_MODEL}. Reinstall with another model to switch.`,
        },
        file('cmake', 'Trusted absolute CMake executable.'),
      ],
      uninstall: [],
      show: [id],
      check: [id],
    },
    effects: {
      install: [
        'Downloads, builds and verifies pinned shared assets, then makes recognition available to compatible assistants.',
      ],
      uninstall: ['Stops new recognition first, proves managed consumers drained, then removes recipe-owned assets.'],
      show: observation,
      check,
    },
  },
  {
    name: 'web',
    inspect: async (paths, options) =>
      (await import('./connector-inspection.js')).inspectConnector(paths, 'web', options),
    install: async ({ paths, options, web }) =>
      (await import('./web-connector.js')).installWebConnector(
        paths,
        {
          accountId: options.account,
          teamName: options.team,
          zoneId: options.zone,
          credentialFile: options['credential-file'],
          cloudflaredPath: options.cloudflared,
          discardUnproven: options['discard-unproven'],
        },
        web,
      ),
    uninstall: async ({ paths, web }) => (await import('./web-connector.js')).uninstallWebConnector(paths, web),
    summary:
      'Serve HTML artifacts and a principal-only logins page through owned Cloudflare Access and tunnel resources.',
    prerequisites: [
      'An operator Cloudflare account, Access team, active DNS zone and management permissions.',
      'cloudflared 2025.4.0 or later; a compatible running assistant with a complete profile.',
    ],
    account: 'The operator’s recorded Cloudflare account, with assistant-specific access resources.',
    scope: {
      installation: 'host',
      configuration: 'host',
      resources: 'assistant',
      access: 'Eligible artifact authors and their permitted readers; only the principal manages saved logins.',
    },
    options: {
      install: [
        value('account', 'account_id', 'Cloudflare account; required for first setup.'),
        value('team', 'team_name', 'Cloudflare Access team; required for first setup.'),
        value('zone', 'zone_id', 'Active Cloudflare DNS zone.'),
        file(
          'credential-file',
          'Owner-only Cloudflare management credential under the operator config root; omit on first install in a terminal to enter the token securely.',
        ),
        file('cloudflared', 'Trusted absolute cloudflared executable.'),
        value('discard-unproven', 'attempt', 'Acknowledge the exact interrupted remote create after cleaning it up.'),
      ],
      uninstall: [],
      show: [id],
      check: [id],
    },
    effects: {
      install: [
        'Records shared operator configuration and provisions serving for each compatible running assistant; incomplete assistants remain pending.',
      ],
      uninstall: [
        'Closes every assistant’s origin before removing verified owned resources, shared resources last. Local artifact content remains.',
      ],
      show: observation,
      check,
    },
  },
  {
    name: 'link',
    inspect: async (paths, options) =>
      (await import('./connector-inspection.js')).inspectConnector(paths, 'link', options),
    install: async ({ paths, catalog }) => (await import('./catalog-connector.js')).installLink(paths, catalog),
    uninstall: async ({ paths, catalog }) => (await import('./catalog-connector.js')).uninstallLink(paths, catalog),
    summary: 'Run the pinned Link CLI on this host so principals can connect their own Link wallet.',
    prerequisites: ['pnpm on PATH and access to the npm registry for installation.'],
    account: 'No operator account; each principal signs in to their own Link account on the Connections page.',
    scope: {
      installation: 'host',
      configuration: 'host',
      resources: 'host',
      access:
        'Every assistant whose release pins an installed Link version; each principal connects their own account.',
    },
    options: { install: [], uninstall: [], show: [id], check: [id] },
    effects: {
      install: [
        'Installs the Link version this checkout pins from its committed lockfile, records a verified receipt, then offers Link on every assistant whose release pins an installed version.',
      ],
      uninstall: [
        'Stops new Link connections first and disconnects Link on every running assistant; stopped ones disconnect when they next start. Installed versions are removed once every running assistant confirms.',
      ],
      show: observation,
      check,
    },
  },
  {
    name: 'shop',
    inspect: async (paths, options) =>
      (await import('./connector-inspection.js')).inspectConnector(paths, 'shop', options),
    install: async ({ paths, options, catalog }) =>
      (await import('./catalog-connector.js')).installShop(
        paths,
        { clientId: options['client-id'], clientSecretFile: options['client-secret-file'] },
        catalog,
      ),
    uninstall: async ({ paths, catalog }) => (await import('./catalog-connector.js')).uninstallShop(paths, catalog),
    summary: 'Register the operator’s Shopify client so principals can connect their own Shop account.',
    prerequisites: [
      'A Shopify Dev Dashboard client enabled for the personal_agent scope and the https://mcp.shop.com resource.',
      'Web serving for each assistant: the client must allow that assistant’s redirect URL.',
    ],
    account: 'The operator’s Shopify Dev Dashboard client; each principal signs in to their own Shop account.',
    scope: {
      installation: 'host',
      configuration: 'host',
      resources: 'assistant',
      access: 'Every assistant whose release includes the catalog; each principal connects their own account.',
    },
    options: {
      install: [
        value('client-id', 'client_id', 'Client ID of the Shopify Dev Dashboard app; required.'),
        file(
          'client-secret-file',
          'Owner-only file under the operator config root holding the client secret, when the dashboard issued one.',
        ),
      ],
      uninstall: [],
      show: [id],
      check: [id],
    },
    effects: {
      install: [
        'Records the client and lists each assistant’s redirect URL to allow in Shopify; Shop is then offered on every assistant whose release includes the catalog.',
      ],
      uninstall: [
        'Stops new Shop connections first and disconnects Shop on every running assistant; stopped ones disconnect when they next start. The stored client secret is removed once every running assistant confirms.',
      ],
      show: observation,
      check,
    },
  },
];
export function connectorDefinition<Name extends ConnectorName>(
  name: Name,
): Extract<ConnectorDefinition, { name: Name }> {
  const definition = CONNECTOR_CATALOG.find(
    (entry): entry is Extract<ConnectorDefinition, { name: Name }> => entry.name === name,
  );
  if (!definition) throw new Error(`Unregistered connector: ${name}`);
  return definition;
}
