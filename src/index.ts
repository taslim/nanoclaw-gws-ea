/**
 * NanoClaw — main entry point.
 *
 * Thin orchestrator: init DB, run migrations, start channel adapters,
 * start delivery polls, start sweep, handle shutdown.
 */
import { backfillContainerConfigs } from './backfill-container-configs.js';
import { CENTRAL_DB_PATH } from './config.js';
import { enforceStartupBackoff, resetCircuitBreaker } from './circuit-breaker.js';
import {
  abortGatewaySessionObservers,
  adoptRunningSessions,
  resumeGatewaySessionAdmission,
  stopGatewaySessionsForUnavailability,
} from './container-runner.js';
import { closeDb, initDb } from './db/connection.js';
import { runMigrations } from './db/migrations/index.js';
import { getSessionDriver } from './drivers/index.js';
import { startActiveDeliveryPoll, startSweepDeliveryPoll, setDeliveryAdapter, stopDeliveryPolls } from './delivery.js';
import { startHostInstanceLease, stopHostInstanceLease } from './host-instance.js';
import { startHostSweep, stopHostSweep } from './host-sweep.js';
import { runHostCleanup, startHostModules, stopHostModules } from './host-lifecycle.js';
import { startGatewayApprovalCoordinator, stopGatewayApprovalCoordinator } from './gateway-approval-coordinator.js';
import { startGatewayAvailabilityMonitor } from './gateway-availability.js';
import { getGatewayProvider } from './gateway-providers/index.js';
import { routeInbound } from './router.js';
import { log } from './log.js';
import { enforceUpgradeTripwire } from './upgrade-state.js';

// Response registry lives in response-registry.ts to break the
// circular import cycle: src/index.ts imports src/modules/index.js for side
// effects, and the modules call registerResponseHandler at top level — which
// would hit a TDZ error if the array lived here.
import { getResponseHandlers, type ResponsePayload } from './response-registry.js';

const hostAbortController = new AbortController();

/**
 * A handler that throws rejects the dispatch: the answer is not handled, and
 * a channel that redelivers hands it over again.
 */
async function dispatchResponse(payload: ResponsePayload): Promise<void> {
  for (const handler of getResponseHandlers()) {
    if (await handler(payload)) return;
  }
  log.warn('Unclaimed response', { questionId: payload.questionId, value: payload.value });
}

// Channel barrel — each enabled channel self-registers on import.
// Channel skills uncomment lines in channels/index.ts to enable them.
import './channels/index.js';

// Modules barrel — imports registration modules, including the singular
// mailbox composition slot. Imported for side effects.
import './modules/index.js';

// CLI command barrel — populates the `ncl` registry before the CLI server
// accepts connections.
import './cli/commands/index.js';
import './cli/delivery-action.js';
import { startCliServer, stopCliServer } from './cli/socket-server.js';

import type { ChannelAdapter, ChannelSetup } from './channels/adapter.js';
import {
  initChannelAdapters,
  teardownChannelAdapters,
  createChannelDeliveryAdapter,
} from './channels/channel-registry.js';

let stopGatewayAvailabilityMonitor: (() => void) | undefined;

async function main(): Promise<void> {
  log.info('NanoClaw starting');

  // 0. Circuit breaker — backoff on rapid restarts
  await enforceStartupBackoff();

  // 0.5 Upgrade tripwire — refuse to start if this install was updated
  // outside the sanctioned path (raw `git pull` instead of /update-nanoclaw).
  enforceUpgradeTripwire();

  // Select once and fail before serving if the configured package is absent.
  const gatewayProvider = getGatewayProvider();

  // 1. Init central DB
  const db = await initDb(CENTRAL_DB_PATH, { role: 'host' });
  await runMigrations(db, undefined, { mode: 'auto' });
  log.info('Central DB ready', { dialect: db.dialect });

  // 1b. Backfill container_configs from legacy container.json files.
  // Idempotent — skips groups that already have a config row.
  if (db.dialect === 'sqlite') await backfillContainerConfigs();
  else log.info('Skipping local container.json backfill for non-local central DB');

  // Prepare the runtime; inbound routing waits until approval health and adoption are ready.
  await getSessionDriver().ensureReady?.();
  await startHostInstanceLease();
  let releaseInbound!: () => void;
  const inboundReady = new Promise<void>((resolve) => {
    releaseInbound = resolve;
  });

  // 2. Channel adapters
  await initChannelAdapters((adapter: ChannelAdapter): ChannelSetup => {
    return {
      // Resolves once the message is routed and rejects when routing fails,
      // so an adapter that keeps its own cursor retries rather than skips.
      onInbound(platformId, threadId, message) {
        return inboundReady
          .then(() =>
            routeInbound({
              channelType: adapter.channelType,
              // The one host-side stamping seam: adapters stay instance-blind,
              // the host stamps the receiving instance on every inbound event.
              instance: adapter.instance ?? adapter.channelType,
              platformId,
              threadId,
              message: {
                id: message.id,
                kind: message.kind,
                content: JSON.stringify(message.content),
                timestamp: message.timestamp,
                isMention: message.isMention,
                isGroup: message.isGroup,
                authenticatedSender: message.authenticatedSender,
                deduplicate: message.deduplicate,
                quiet: message.quiet,
                reaction: message.reaction,
              },
            }),
          )
          .catch((err: unknown) => {
            log.error('Failed to route inbound message', { channelType: adapter.channelType, err });
            throw err;
          });
      },
      onInboundEvent(event) {
        // Admin transports may target another channel and carry display
        // identity for routing, but cannot assert platform authentication.
        inboundReady
          .then(() =>
            routeInbound({
              ...event,
              message: {
                ...event.message,
                authenticatedSender: undefined,
                deduplicate: adapter.channelType === 'cli' ? event.message.deduplicate : undefined,
              },
            }),
          )
          .catch((err) => {
            log.error('Failed to route inbound event', {
              sourceAdapter: adapter.channelType,
              targetChannelType: event.channelType,
              err,
            });
          });
      },
      onMetadata(platformId, name, isGroup) {
        log.info('Channel metadata discovered', {
          channelType: adapter.channelType,
          platformId,
          name,
          isGroup,
        });
      },
      // Like onInbound: an answer waits for inbound readiness, and the promise
      // settles once its handler has, rejecting when the handler fails.
      onAction(questionId, selectedOption, userId, address, answer) {
        return inboundReady
          .then(() =>
            dispatchResponse({
              questionId,
              value: selectedOption,
              reason: answer?.reason,
              userId,
              channelType: adapter.channelType,
              instance: address?.instance ?? adapter.instance ?? adapter.channelType,
              messageId: address?.messageId,
              platformId: address?.platformId ?? '',
              threadId: address?.threadId ?? null,
              deferResolution: answer?.deferResolution,
            }),
          )
          .catch((err: unknown) => {
            log.error('Failed to handle question response', { questionId, err });
            throw err;
          });
      },
    };
  });

  // 3. Delivery adapter bridge — dispatches to channel adapters by EXACT
  // registry key (instance ?? channelType): a named instance with an
  // offline adapter is never rerouted through a sibling bot. See
  // createChannelDeliveryAdapter in channels/channel-registry.ts.
  const deliveryAdapter = createChannelDeliveryAdapter();
  // Every host caller gets the guarded adapter, so approval cards and module
  // sends pass the outbound guards that channel replies pass.
  const guardedDelivery = setDeliveryAdapter(deliveryAdapter);

  // 4. Core starts the selected gateway's normalized approval subscription
  // only after persistence and delivery are ready.
  await startGatewayApprovalCoordinator(gatewayProvider, guardedDelivery, stopGatewaySessionsForUnavailability, {
    onAvailable: resumeGatewaySessionAdmission,
    waitUntilReady: true,
  });
  stopGatewayAvailabilityMonitor = await startGatewayAvailabilityMonitor(
    gatewayProvider,
    stopGatewaySessionsForUnavailability,
    resumeGatewaySessionAdmission,
  );
  await adoptRunningSessions();
  releaseInbound();

  // 6. Start registered host modules. Imports only registered callbacks; the
  // actual work begins here, after DB + delivery are ready and before polls.
  await startHostModules({ db, deliveryAdapter: guardedDelivery, signal: hostAbortController.signal });

  // 6. Start delivery polls
  startActiveDeliveryPoll();
  startSweepDeliveryPoll();
  log.info('Delivery polls started');

  // 8. Start host sweep
  startHostSweep();
  log.info('Host sweep started');

  // 9. Start the `ncl` CLI socket server (data/ncl.sock).
  await startCliServer();

  log.info('NanoClaw running');
}

/** Graceful shutdown. */
let shuttingDown: Promise<void> | undefined;
function shutdown(signal: string, exitCode = 0): Promise<void> {
  shuttingDown ??= (async () => {
    log.info('Shutdown signal received', { signal });
    hostAbortController.abort();
    try {
      await runHostCleanup([
        () => stopGatewayAvailabilityMonitor?.(),
        stopGatewayApprovalCoordinator,
        abortGatewaySessionObservers,
        stopHostModules,
        // Stamp the durable stop before closing the DB.
        stopHostInstanceLease,
        stopDeliveryPolls,
        stopHostSweep,
        stopCliServer,
        teardownChannelAdapters,
        closeDb,
      ]);
      // eslint-disable-next-line no-catch-all/no-catch-all -- every cleanup stage has run; report failure through the exit status
    } catch (err) {
      log.error('Host shutdown incomplete', { err });
      exitCode = 1;
    }
    if (exitCode === 0) resetCircuitBreaker();
    process.exit(exitCode);
  })();
  return shuttingDown;
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

main().catch(async (err) => {
  log.fatal('Startup failed', { err });
  await shutdown('startup-failure', 1);
});
