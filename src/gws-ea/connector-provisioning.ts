/** Optional setup follows operator lifecycle commands; it cannot undo a serving release. */
import { provisionAssistantWeb, type WebCapabilityDependencies } from './web-connector.js';
import type { CatalogConnectorDependencies } from './catalog-connector.js';
import type { InstanceOperation } from './journal.js';
import type { StepReporter } from './events.js';
import type { NextAction } from './result.js';
import { safeErrorCode, safeErrorMessage } from './redact.js';
import type { ConnectorName } from './connectors.js';

export interface ConnectorProvisioningDependencies {
  readonly web?: WebCapabilityDependencies;
  readonly catalog?: CatalogConnectorDependencies;
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
  occasion: { readonly created?: boolean } = {},
): Promise<ConnectorProvisioningResult> {
  const pending: PendingConnector[] = [];
  const recordEffect = (changed: true | null): void => {
    reporter.emit?.({ type: 'domain-effect', step: 'provision_connectors', changed });
  };
  try {
    const result = await provisionAssistantWeb(operation, { ...dependencies.web, recordEffect });
    if (result?.outcome === 'pending')
      pending.push({
        name: 'web',
        reason: result.reason ?? 'setup_pending',
        message: result.message ?? 'Web setup is pending.',
      });
  } catch (cause) {
    pending.push({ name: 'web', reason: safeErrorCode(cause), message: safeErrorMessage(cause) });
  }
  const next_actions: NextAction[] = pending.some(
    (entry) => !['web_name_unusable', 'web_hostname_claimed'].includes(entry.reason),
  )
    ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'web'] }]
    : [];
  const catalog = await (
    await import('./catalog-connector.js')
  ).provisionCatalogConnectors(
    operation,
    { created: occasion.created === true },
    {
      ...dependencies.catalog,
      recordEffect: (changed) => {
        operation.recordEffect?.(changed);
        recordEffect(changed);
      },
    },
  );
  for (const entry of catalog) {
    pending.push({ name: entry.name, reason: entry.reason, message: entry.message });
    next_actions.push(...entry.next_actions);
  }
  return { pending, next_actions };
}
