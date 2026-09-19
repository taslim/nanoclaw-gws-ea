import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { readProvisionJournal, withInstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  createProductionProvisionRegistry,
  reconcileProvisioning,
  ProvisionBoundaryInterruption,
  type ProductionProvisionContext,
  type ProductionProvisionDependencies,
} from './provision.js';
import { defineProvisionPhaseRegistry, type ProvisionPhaseDefinition } from './phases.js';
import { reserveInstance } from './registry.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import type { OnecliCompatibilityReceipt } from './onecli.js';
import { createInstanceRuntimeConfig } from './service.js';
import {
  PROVISION_PHASES,
  type InstanceReservation,
  type InstanceReservationInput,
  type ProvisionPhase,
} from './types.js';

const roots: string[] = [];

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-provision-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function reservation(paths: ControlPlanePaths): InstanceReservationInput {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.com/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { nanoclaw_webhook: 3101, onecli_app: 3201, onecli_gateway: 3301 },
    exclusive_resource_claims: {
      endpoint_url: 'https://assistant.example.com/webhook/gchat',
      gcp_project_id: 'gws-ea-dogfood',
      chat_app_id: 'chat-app-1',
      chat_credential_id: 'chat-credential-1',
      workspace_email: 'assistant@example.com',
      onecli_project: 'gws_ea_1',
    },
  };
}

interface FixtureContext {
  readonly instanceId: string;
  readonly resources: Set<ProvisionPhase>;
  readonly effects: Map<ProvisionPhase, number>;
  readonly pauseAt?: ProvisionPhase;
}

function registry(context: FixtureContext) {
  const entry = (phase: ProvisionPhase): ProvisionPhaseDefinition<FixtureContext> => ({
    resourceKey: () => `${phase.replaceAll('_', '-')}:${'a'.repeat(64)}`,
    probe: async () =>
      context.resources.has(phase)
        ? { status: 'matched' as const }
        : context.pauseAt === phase
          ? {
              status: 'paused' as const,
              pause: { kind: 'human-action' as const, phase, code: 'operator_action', message: 'Continue later.' },
            }
          : { status: 'absent' as const },
    apply: async () => {
      if (context.pauseAt === phase) {
        return {
          status: 'paused' as const,
          pause: { kind: 'human-action' as const, phase, code: 'operator_action', message: 'Continue later.' },
        };
      }
      context.effects.set(phase, (context.effects.get(phase) ?? 0) + 1);
      context.resources.add(phase);
      return { status: 'completed' as const };
    },
  });
  return defineProvisionPhaseRegistry({
    materialize_checkout: entry('materialize_checkout'),
    start_onecli: entry('start_onecli'),
    configure_provider: entry('configure_provider'),
    start_nanoclaw: entry('start_nanoclaw'),
    establish_transport: entry('establish_transport'),
    configure_channel: entry('configure_channel'),
    bind_principal: entry('bind_principal'),
    verify_conversation: entry('verify_conversation'),
    ready: entry('ready'),
  });
}

afterEach(() => {
  roots.length = 0;
});

describe('resumable provision phase runner', () => {
  it.each(['intent', 'effect', 'verify'] as const)(
    'resumes after interruption at the %s boundary without duplicating a resource',
    async (boundary) => {
      const paths = await testPaths();
      const input = reservation(paths);
      await reserveInstance(paths, input);
      const context: FixtureContext = { instanceId: input.instance_id, resources: new Set(), effects: new Map() };
      let interrupted = false;

      await expect(
        withInstanceOperation(paths, input.instance_id, async (operation) => {
          await reconcileProvisioning(operation, context, registry(context), {
            onBoundary: (event) => {
              if (!interrupted && event.phase === 'materialize_checkout' && event.boundary === boundary) {
                interrupted = true;
                throw new ProvisionBoundaryInterruption(event);
              }
            },
          });
        }),
      ).rejects.toBeInstanceOf(ProvisionBoundaryInterruption);

      await withInstanceOperation(paths, input.instance_id, async (operation) => {
        expect(await reconcileProvisioning(operation, context, registry(context))).toEqual({ status: 'ready' });
      });

      expect(context.effects.get('materialize_checkout')).toBe(1);
      expect([...context.resources]).toEqual(PROVISION_PHASES);
      const journal = await readProvisionJournal(paths, input.instance_id);
      expect(journal.phases.ready.attempts.at(-1)?.succeeded_at).toBeDefined();
    },
  );

  it('releases the instance lock while paused for a human action', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    const context: FixtureContext = {
      instanceId: input.instance_id,
      resources: new Set(PROVISION_PHASES.slice(0, 6)),
      effects: new Map(),
      pauseAt: 'bind_principal',
    };

    const result = await withInstanceOperation(paths, input.instance_id, (operation) =>
      reconcileProvisioning(operation, context, registry(context)),
    );
    expect(result).toMatchObject({ status: 'paused', pause: { phase: 'bind_principal' } });

    await expect(withInstanceOperation(paths, input.instance_id, async () => 'lock-reacquired')).resolves.toBe(
      'lock-reacquired',
    );
  });

  it('re-probes every completed phase and performs no effects on a repeated complete run', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    const context: FixtureContext = { instanceId: input.instance_id, resources: new Set(), effects: new Map() };

    await withInstanceOperation(paths, input.instance_id, (operation) =>
      reconcileProvisioning(operation, context, registry(context)),
    );
    const firstEffects = new Map(context.effects);
    const probes: ProvisionPhase[] = [];
    const definitions = registry(context);
    const wrapped = defineProvisionPhaseRegistry(
      Object.fromEntries(
        PROVISION_PHASES.map((phase) => [
          phase,
          {
            ...definitions[phase],
            probe: async (value: FixtureContext) => {
              probes.push(phase);
              return definitions[phase].probe(value);
            },
          },
        ]),
      ) as unknown as Parameters<typeof defineProvisionPhaseRegistry<FixtureContext>>[0],
    );

    await withInstanceOperation(paths, input.instance_id, async (operation) => {
      expect(await reconcileProvisioning(operation, context, wrapped)).toEqual({ status: 'ready' });
    });
    expect(probes).toEqual(PROVISION_PHASES);
    expect(context.effects).toEqual(firstEffects);
  });

  it('fails closed when a completed phase postcondition has drifted', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    await reserveInstance(paths, input);
    const context: FixtureContext = { instanceId: input.instance_id, resources: new Set(), effects: new Map() };

    await withInstanceOperation(paths, input.instance_id, (operation) =>
      reconcileProvisioning(operation, context, registry(context)),
    );
    context.resources.delete('start_onecli');

    await expect(
      withInstanceOperation(paths, input.instance_id, (operation) =>
        reconcileProvisioning(operation, context, registry(context)),
      ),
    ).rejects.toThrow(/postcondition.*start_onecli/i);
    expect(context.effects.get('start_onecli')).toBe(1);
  });
});

function productionContext(
  operation: Parameters<typeof createProductionProvisionRegistry>[0]['operation'],
  reserved: InstanceReservation,
): ProductionProvisionContext {
  const onecli = createOnecliRuntimeLayout({
    instanceId: reserved.instance_id,
    instanceRoot: operation.paths.instanceRoot(reserved.instance_id),
    project: reserved.exclusive_resource_claims.onecli_project,
    appPort: reserved.allocated_ports.onecli_app,
    gatewayPort: reserved.allocated_ports.onecli_gateway,
    cliExecutable: '/usr/local/bin/onecli',
  });
  const runtime = createInstanceRuntimeConfig(reserved, onecli, {
    nodePath: '/usr/local/bin/node',
    homeDirectory: path.dirname(operation.paths.stateRoot),
    selectedProvider: 'claude',
    gchatBotUserId: 'users/assistant-bot',
  });
  return {
    operation,
    state: {},
    input: {
      release: {
        sourceRemote: reserved.source_remote,
        releaseRef: reserved.release_track,
        commit: reserved.deployed_commit,
      },
      releasePreflight: { checkoutRoot: reserved.checkout_realpath, provider: 'claude' },
      onecli,
      runtime,
      providerCredentialMetadata: {
        name: 'Claude provider',
        type: 'api_key',
        hostPattern: 'api.anthropic.com',
        headerName: 'x-api-key',
      },
      providerCredential: {
        name: 'Claude provider',
        type: 'api_key',
        value: 'test-secret-never-persisted',
        hostPattern: 'api.anthropic.com',
        headerName: 'x-api-key',
      },
      identity: {
        assistantDisplayName: 'Aya',
        assistantWorkspaceEmail: reserved.exclusive_resource_claims.workspace_email,
        principalDisplayName: 'Principal',
        principalTimezone: 'America/Los_Angeles',
      },
      adapterInstance: 'gchat',
      provisioningStartedAt: '2026-09-18T18:00:00.000Z',
      serviceDependencies: {
        platform: 'macos',
        homeDirectory: path.dirname(operation.paths.stateRoot),
        runningAsRoot: false,
      },
    },
  };
}

describe('production provision phase composition', () => {
  it('composes U2-U6 in order, pauses for the principal, and resumes without duplicate effects', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const effects: string[] = [];
    const resources = new Set<string>();
    let principalMode: 'waiting' | 'selection' | 'bound' = 'waiting';
    let principalBound = false;
    const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
    let context: ProductionProvisionContext | undefined;

    const overrides: Partial<ProductionProvisionDependencies> = {
      probeCheckout: async () => (resources.has('checkout') ? { status: 'matched' } : { status: 'absent' }),
      materializeReleaseCheckout: async () => {
        effects.push('materializeReleaseCheckout');
        resources.add('checkout');
        return reserved;
      },
      runReleasePreflight: async () => {
        effects.push('runReleasePreflight');
        return {
          provider: 'claude',
          packageManager: 'pnpm@10.0.0',
          onecli: { gateway: '1.42.0', cli: '2.2.5', sdk: '2.2.1' },
        };
      },
      probeOnecli: async () => (resources.has('onecli') ? { status: 'matched' } : { status: 'absent' }),
      reconcileOnecliRuntime: async () => {
        effects.push('reconcileOnecliRuntime');
        resources.add('onecli');
        return receipt;
      },
      persistOnecliApiKeyFiles: async () => {
        effects.push('persistOnecliApiKeyFiles');
      },
      probeProvider: async (value) => {
        if (!resources.has('provider')) return { status: 'absent' };
        value.state.providerSecretId = 'secret-provider';
        return { status: 'matched' };
      },
      importProviderCredential: async () => {
        effects.push('importProviderCredential');
        resources.add('provider');
        return { id: 'secret-provider', created: true };
      },
      probeNanoclaw: async (value) => {
        if (!resources.has('nanoclaw')) return { status: 'absent' };
        value.state.main = {
          agentGroupId: 'ag-main',
          onecliAgentId: 'onecli-main',
          providerSecretId: 'secret-provider',
        };
        return { status: 'matched' };
      },
      reconcileInstanceRuntime: async () => {
        effects.push('reconcileInstanceRuntime');
        return {
          manager: 'launchd',
          serviceIdentity: 'service',
          serviceDefinitionPath: '/tmp/service',
          runtimeConfigFile: '/tmp/runtime',
          environmentFile: '/tmp/env',
          launcherEntrypoint: '/tmp/launcher',
          hostEntrypoint: '/tmp/host',
          cliPath: '/tmp/ncl',
          cliSocket: '/tmp/ncl.sock',
          standardOutputPath: '/tmp/out',
          standardErrorPath: '/tmp/err',
          imageTag: 'image',
          installLabel: 'install',
        };
      },
      reconcileMainIdentity: async () => {
        effects.push('reconcileMainIdentity');
        resources.add('nanoclaw');
        return {
          agentGroupId: 'ag-main',
          onecliAgentId: 'onecli-main',
          providerSecretId: 'secret-provider',
        };
      },
      verifyRoute: async ({ endpointUrl }) => {
        effects.push('verifyExistingGchatRoute');
        return endpointUrl;
      },
      verifyEndpoint: async (endpoint) => {
        effects.push('verifyExistingGchatEndpoint');
        return { endpointUrl: endpoint.endpointUrl, audienceUrl: endpoint.audienceUrl };
      },
      verifyPrincipalBinding: () =>
        principalBound
          ? {
              status: 'matched',
              agentGroupId: 'ag-main',
              candidate: {
                messagingGroupId: 'mg-principal',
                platformId: 'gchat:spaces/principal',
                userId: 'gchat:users/principal',
                senderName: 'Principal',
                authenticatedMessageId: 'signed-first-dm',
                authenticatedMessageAt: '2026-09-18T18:00:01.000Z',
              },
              welcomeEventId: 'gws-ea-welcome:stable',
            }
          : { status: 'absent' },
      reconcilePrincipal: async (_runtime, selection) => {
        effects.push(`reconcilePrincipalDm:${principalMode}`);
        if (principalMode === 'waiting') return { status: 'waiting' };
        if (principalMode === 'selection' && !selection.messagingGroupId) {
          return {
            status: 'selection-required',
            candidates: [
              {
                messagingGroupId: 'mg-principal',
                platformId: 'gchat:spaces/principal',
                userId: 'gchat:users/principal',
                senderName: 'Principal',
                authenticatedMessageId: 'signed-first-dm',
                authenticatedMessageAt: '2026-09-18T18:00:01.000Z',
              },
              {
                messagingGroupId: 'mg-other',
                platformId: 'gchat:spaces/other',
                userId: 'gchat:users/other',
                senderName: 'Other',
                authenticatedMessageId: 'signed-other-dm',
                authenticatedMessageAt: '2026-09-18T18:00:02.000Z',
              },
            ],
          };
        }
        expect(selection.messagingGroupId).toBe('mg-principal');
        principalBound = true;
        return {
          status: 'bound',
          candidate: {
            messagingGroupId: 'mg-principal',
            platformId: 'gchat:spaces/principal',
            userId: 'gchat:users/principal',
            senderName: 'Principal',
            authenticatedMessageId: 'signed-first-dm',
            authenticatedMessageAt: '2026-09-18T18:00:01.000Z',
          },
          agentGroupId: 'ag-main',
          eventId: 'gws-ea-welcome:stable',
        };
      },
      verifyConversation: () => ({
        ready: true,
        sessionId: 'session-main',
        welcomeInboundId: 'welcome-in',
        welcomeOutboundId: 'welcome-out',
        laterInboundId: 'later-in',
        laterOutboundId: 'later-out',
        deliveredAt: '2026-09-18T18:01:00.000Z',
      }),
    };

    const paused = await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const initial = productionContext(operation, reserved);
      const bootstrapManifestFile = paths.bootstrapFile(reserved.instance_id);
      await writeFile(bootstrapManifestFile, '{}', { mode: 0o600 });
      context = { ...initial, input: { ...initial.input, bootstrapManifestFile } };
      await mkdir(path.dirname(context.input.runtime.secret_files.gchat_credentials), { recursive: true, mode: 0o700 });
      await writeFile(context.input.runtime.secret_files.gchat_credentials, '{}', { mode: 0o600 });
      return reconcileProvisioning(operation, context, createProductionProvisionRegistry(context, overrides));
    });
    expect(effects).toContain('verifyExistingGchatRoute');
    expect(paused).toMatchObject({ status: 'paused', pause: { code: 'principal_dm_required' } });
    await expect(readFile(paths.bootstrapFile(reserved.instance_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    expect(effects.filter((effect) => !effect.startsWith('verifyExisting'))).toEqual([
      'materializeReleaseCheckout',
      'runReleasePreflight',
      'reconcileOnecliRuntime',
      'persistOnecliApiKeyFiles',
      'persistOnecliApiKeyFiles',
      'importProviderCredential',
      'reconcileInstanceRuntime',
      'reconcileMainIdentity',
      'reconcilePrincipalDm:waiting',
    ]);
    const before = await readProvisionJournal(paths, reserved.instance_id);
    const stableKeys = Object.fromEntries(
      PROVISION_PHASES.map((phase) => [phase, before.phases[phase].attempts.at(-1)?.resource_key]),
    );

    principalMode = 'selection';
    const needsSelection = await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      expect(context).toBeDefined();
      const resumed = { ...context!, operation };
      context = resumed;
      return reconcileProvisioning(operation, resumed, createProductionProvisionRegistry(resumed, overrides));
    });
    expect(needsSelection).toMatchObject({
      status: 'paused',
      pause: { code: 'principal_selection_required', choices: [{ id: 'mg-principal' }, { id: 'mg-other' }] },
    });

    principalMode = 'bound';
    let interrupted = false;
    await expect(
      withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        expect(context).toBeDefined();
        const resumed: ProductionProvisionContext = {
          ...context!,
          operation,
          input: { ...context!.input, selectedMessagingGroupId: 'mg-principal' },
        };
        context = resumed;
        return reconcileProvisioning(operation, resumed, createProductionProvisionRegistry(resumed, overrides), {
          onBoundary: (event) => {
            if (!interrupted && event.phase === 'bind_principal' && event.boundary === 'effect') {
              interrupted = true;
              throw new ProvisionBoundaryInterruption(event);
            }
          },
        });
      }),
    ).rejects.toBeInstanceOf(ProvisionBoundaryInterruption);

    const completed = await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const resumed: ProductionProvisionContext = { ...productionContext(operation, reserved), state: {} };
      context = resumed;
      return reconcileProvisioning(operation, resumed, createProductionProvisionRegistry(resumed, overrides));
    });
    expect(completed).toEqual({ status: 'ready' });
    const after = await readProvisionJournal(paths, reserved.instance_id);
    for (const phase of PROVISION_PHASES) {
      expect(after.phases[phase].attempts.at(-1)?.resource_key).toBe(
        stableKeys[phase] ?? after.phases[phase].attempts[0]?.resource_key,
      );
    }
    expect(effects.filter((effect) => effect === 'materializeReleaseCheckout')).toHaveLength(1);
    expect(effects.filter((effect) => effect === 'reconcileOnecliRuntime')).toHaveLength(1);
    expect(effects.filter((effect) => effect === 'importProviderCredential')).toHaveLength(1);
    expect(effects.filter((effect) => effect === 'reconcileInstanceRuntime')).toHaveLength(1);
    expect(effects.filter((effect) => effect === 'reconcileMainIdentity')).toHaveLength(1);
    expect(effects.filter((effect) => effect === 'reconcilePrincipalDm:bound')).toHaveLength(1);

    const completedEffects = [...effects];
    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const restarted: ProductionProvisionContext = { ...productionContext(operation, reserved), state: {} };
      expect(
        await reconcileProvisioning(operation, restarted, createProductionProvisionRegistry(restarted, overrides)),
      ).toEqual({ status: 'ready' });
    });
    expect(effects.filter((effect) => !effect.startsWith('verifyExisting'))).toEqual(
      completedEffects.filter((effect) => !effect.startsWith('verifyExisting')),
    );
  });
});
