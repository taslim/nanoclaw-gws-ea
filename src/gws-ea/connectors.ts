/** Operator connectors; agent tool permissions remain in ../capabilities.ts. */
import type { CommandOptions } from './command-parser.js';
import type { ControlPlanePaths } from './paths.js';
import type { ConnectorInspection, ConnectorObservation } from './connector-inspection.js';
import type { VoiceOperatorDependencies } from './local-voice.js';
import type { OnePasswordDependencies, OnePasswordInstallData } from './onepassword.js';
import type {
  OnePasswordUninstallData,
  OnePasswordUninstallDependencies,
  OnePasswordUninstallPreview,
} from './onepassword-uninstall.js';
import type { WebCapabilityDependencies, WebConnectorOperation, WebConnectorUninstallData } from './web-connector.js';
import type { OptionDefinition } from './command-definitions.js';
import { DEFAULT_VOICE_MODEL } from './install-voice.js';
import { VOICE_MODEL_CATALOG } from './voice-assets.js';

export const CONNECTOR_NAMES = ['voice', 'onepassword', 'web'] as const;
export type ConnectorName = (typeof CONNECTOR_NAMES)[number];
export const CONNECTOR_ACTIONS = ['install', 'uninstall', 'show', 'check'] as const;
export type ConnectorAction = (typeof CONNECTOR_ACTIONS)[number];
export type ConnectorOperation =
  | { readonly name: 'voice'; readonly scope: 'host'; readonly enabled: boolean; readonly installation_dir?: string }
  | OnePasswordInstallData
  | OnePasswordUninstallData
  | WebConnectorOperation
  | WebConnectorUninstallData;
export interface ConnectorLifecycleContext {
  readonly paths: ControlPlanePaths;
  readonly options: CommandOptions;
  readonly voice: VoiceOperatorDependencies;
  readonly onePassword: OnePasswordDependencies & OnePasswordUninstallDependencies;
  readonly web: WebCapabilityDependencies;
  readonly deleteVaults?: boolean;
  readonly confirmedPreview?: OnePasswordUninstallPreview;
}
interface ConnectorInstallResults {
  voice: Extract<ConnectorOperation, { name: 'voice' }>;
  onepassword: OnePasswordInstallData;
  web: WebConnectorOperation;
}
interface ConnectorUninstallResults {
  voice: Extract<ConnectorOperation, { name: 'voice' }>;
  onepassword: OnePasswordUninstallData;
  web: WebConnectorUninstallData;
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
const flag = (name: string, description: string): OptionDefinition => ({ name, type: 'boolean', description });
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
    name: 'onepassword',
    inspect: async (paths, options) =>
      (await import('./connector-inspection.js')).inspectConnector(paths, 'onepassword', options),
    install: async ({ paths, options, onePassword }) =>
      (await import('./onepassword.js')).installOnePassword(
        paths,
        { accountId: options.account, discardUnproven: options['discard-unproven'] },
        onePassword,
      ),
    uninstall: async ({ paths, options, deleteVaults, confirmedPreview, onePassword }) =>
      (await import('./onepassword-uninstall.js')).uninstallOnePassword(
        paths,
        { deleteVaults, confirmedPreview, abandon: options.abandon === 'true' },
        onePassword,
      ),
    summary: 'Provision a private saved-login vault for each compatible assistant.',
    prerequisites: [
      '1Password CLI (op) 2.29 or later.',
      'An operator CLI session: eval "$(OP_BIOMETRIC_UNLOCK_ENABLED=false op signin)".',
      'Operator permission to create service accounts.',
    ],
    account:
      'The operator’s selected 1Password account; principals manage saved logins on their assistant’s private web page.',
    scope: {
      installation: 'host',
      configuration: 'host',
      resources: 'assistant',
      access: 'A separate vault and runtime service account for each assistant.',
    },
    options: {
      install: [
        value('account', 'account_id', 'Exact 1Password account, required before one is recorded.'),
        value(
          'discard-unproven',
          'instance_id|management',
          'Acknowledge an exact interrupted creation after cleaning it up in 1Password.',
        ),
      ],
      uninstall: [
        flag('delete-vaults', 'Confirm deletion of every owned assistant vault, including its items.'),
        flag('abandon', 'Close the retained revocation receipt after completing its operator actions.'),
      ],
      show: [id],
      check: [id],
    },
    effects: {
      install: [
        'Uses the operator’s CLI session to provision compatible current assistants; create and update provision future eligible assistants. Existing vaults and credentials are kept.',
      ],
      uninstall: [
        'Previews owned vaults before confirmation, stops vault use, deletes verified owned vaults and local tokens, and retains service-account IDs for operator revocation.',
      ],
      show: observation,
      check: [
        ...check,
        'Authenticated requests count against the account’s shared request limit; no vault write is tested.',
      ],
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
