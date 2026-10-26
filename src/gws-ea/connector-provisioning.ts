/** Optional setup follows operator lifecycle commands; it cannot undo a serving release. */
import { provisionAssistantVault, type OnePasswordDependencies } from './onepassword.js';
import { provisionAssistantArtifacts, type ArtifactsCapabilityDependencies } from './artifacts-connector.js';
import type { InstanceOperation } from './journal.js';
import type { StepReporter } from './events.js';
import type { NextAction } from './result.js';
import { safeErrorCode, safeErrorMessage } from './redact.js';
import type { ConnectorName } from './connectors.js';

export interface ConnectorProvisioningDependencies {
  readonly onePassword?: Pick<OnePasswordDependencies, 'cli' | 'upsertEnvVars' | 'operatorTerminal' | 'rateLimitState'>;
  readonly artifacts?: ArtifactsCapabilityDependencies;
}
export interface PendingConnector {
  readonly name: ConnectorName;
  readonly reason: string;
  readonly message: string;
}
export interface ConnectorProvisioningResult {
  readonly pending: readonly PendingConnector[];
  readonly next_actions: readonly NextAction[];
}
export async function provisionInstalledConnectors(
  operation: InstanceOperation,
  reporter: StepReporter,
  dependencies: ConnectorProvisioningDependencies = {},
): Promise<ConnectorProvisioningResult> {
  const pending: PendingConnector[] = [];
  const recordEffect = (changed: true | null): void => {
    reporter.emit?.({ type: 'domain-effect', step: 'provision_connectors', changed });
  };
  const run = async (name: 'onepassword' | 'artifacts'): Promise<void> => {
    try {
      const result =
        name === 'onepassword'
          ? await provisionAssistantVault(operation, { ...dependencies.onePassword, recordEffect })
          : await provisionAssistantArtifacts(operation, { ...dependencies.artifacts, recordEffect });
      if (result?.outcome === 'pending')
        pending.push({
          name,
          reason: result.reason ?? 'setup_pending',
          message: result.message ?? `${name} setup is pending.`,
        });
    } catch (cause) {
      pending.push({ name, reason: safeErrorCode(cause), message: safeErrorMessage(cause) });
    }
  };
  await run('onepassword');
  await run('artifacts');
  return {
    pending,
    next_actions: [...new Set(pending.map((entry) => entry.name))].map((name) => ({
      kind: 'command',
      argv: ['gws-ea', 'connectors', 'install', name],
    })),
  };
}
