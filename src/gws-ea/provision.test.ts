import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { PauseRequired, pendingActionOf, SignInRequired, type RunEvent } from './events.js';
import { readProvisionJournal, withInstanceOperation, type InstanceOperation } from './journal.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import {
  ABSENT,
  OBSERVATION_WAITS_SECONDS,
  PRESENT,
  runProvisionSteps,
  type ProvisionHumanPause,
  type ProvisionResult,
  type ProvisionStep,
  type ProvisionSteps,
  type StepResource,
} from './phases.js';
import {
  createProductionProvisionSteps,
  installProductionBootstrapManifest,
  loadProductionBootstrapManifest,
  removeProductionBootstrapManifest,
  runProductionProvision,
  type ProductionBootstrapManifest,
  type ProductionProvisionContext,
  type ProductionProvisionDependencies,
} from './provision.js';
import type { MainIdentityDependencies } from './identity.js';
import { reserveInstance } from './registry.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { ONECLI_CLI_VERSION, ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './pins.js';
import type { ObservedOnecliRuntime, OnecliCompatibilityReceipt } from './onecli.js';
import { holdLoopbackPorts } from './ports.js';
import { startRunLog, type RunLog } from './run-log.js';
import {
  createInstanceRuntimeConfig,
  googleChatProjectNumberFile,
  persistInstanceRuntime,
  type UpsertEnvVars,
} from './service.js';
import type { ManagedTransport } from './cloudflare-ingress.js';
import {
  GwsEaError,
  PROVISION_STEPS,
  type AllocatedPorts,
  type InstanceReservation,
  type InstanceReservationInput,
  type ProvisionStepId,
} from './types.js';

const roots: string[] = [];
const providerCapabilityDigest = 'c'.repeat(64);

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-provision-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function reservation(
  paths: ControlPlanePaths,
  allocatedPorts: AllocatedPorts = { nanoclaw_webhook: 3101, onecli_app: 3201, onecli_gateway: 3301 },
): InstanceReservationInput {
  const instanceId = '11111111-1111-4111-8111-111111111111';
  return {
    instance_id: instanceId,
    checkout_realpath: paths.checkoutRoot(instanceId),
    release_track: 'dogfood',
    source_remote: 'https://example.com/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: allocatedPorts,
    exclusive_resource_claims: {
      ingress: { mode: 'existing', endpoint_url: 'https://assistant.example.com/webhook/gchat' },
      gcp_project_id: 'gws-ea-dogfood',
      gcp_account: 'operator@example.com',
      gchat_service_account: 'gws-ea-chat@gws-ea-dogfood.iam.gserviceaccount.com',
      workspace_email: 'assistant@example.com',
      onecli_project: 'gws_ea_1',
    },
  };
}

function managedReservation(
  paths: ControlPlanePaths,
  allocatedPorts: AllocatedPorts = { nanoclaw_webhook: 3101, onecli_app: 3201, onecli_gateway: 3301 },
): InstanceReservationInput {
  const input = reservation(paths, allocatedPorts);
  return {
    ...input,
    exclusive_resource_claims: {
      ...input.exclusive_resource_claims,
      ingress: {
        mode: 'managed-cloudflare',
        account_id: 'a'.repeat(32),
        zone_id: 'b'.repeat(32),
        zone_name: 'example.com',
        hostname: 'assistant.example.com',
        callback_url: 'https://assistant.example.com/webhook/gchat',
        dns_record_id: null,
      },
    },
  };
}

async function listen(server: Server, port: number): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
}

async function close(server: Server): Promise<void> {
  if (!server.listening) return;
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

async function canClaim(port: number): Promise<boolean> {
  const server = createServer();
  try {
    await listen(server, port);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') return false;
    throw error;
  } finally {
    await close(server);
  }
}

function serviceAccount(overrides: Readonly<Record<string, string>> = {}): string {
  const projectId = overrides.project_id ?? 'gws-ea-dogfood';
  return JSON.stringify({
    type: 'service_account',
    project_id: projectId,
    private_key_id: 'chat-credential-1',
    private_key: '-----BEGIN PRIVATE KEY-----\ntest-key-material\n-----END PRIVATE KEY-----\n',
    client_email: `gws-ea-chat@${projectId}.iam.gserviceaccount.com`,
    client_id: '1234567890',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: 'https://www.googleapis.com/robot/v1/metadata/x509/assistant',
    universe_domain: 'googleapis.com',
    ...overrides,
  });
}

function bootstrapManifest(paths: ControlPlanePaths): ProductionBootstrapManifest {
  return {
    schema_version: 1,
    onecli_cli_path: '/usr/local/bin/onecli',
    node_path: process.execPath,
    home_directory: path.dirname(paths.stateRoot),
    platform: process.platform === 'darwin' ? 'macos' : 'linux',
    running_as_root: false,
    docker_endpoint: 'unix:///var/run/docker.sock',
    provider_capability_digest: providerCapabilityDigest,
    provider: {
      id: 'claude',
      name: 'Claude provider',
      type: 'api_key',
      host_pattern: 'api.anthropic.com',
      header_name: 'x-api-key',
      value_format: null,
      path_pattern: null,
      param_name: null,
      param_format: null,
    },
    identity: {
      assistant_display_name: 'Aya',
      principal_display_name: 'Principal',
      principal_timezone: 'America/Los_Angeles',
    },
    selected_messaging_group_id: null,
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DM_PAUSE: ProvisionHumanPause = {
  kind: 'human-action',
  phase: 'bind_principal',
  code: 'principal_dm_required',
  message: 'Ask the principal to send a direct message to the configured Google Chat app, then resume.',
};

/** An in-memory world of named resources for exercising the step engine. */
interface World {
  readonly present: Set<string>;
  readonly observed: string[];
  readonly applied: string[];
  /** Observations left before a resource can be observed conclusively. */
  readonly unknownFor: Map<string, number>;
  /** Observations left while a runtime is still starting. */
  readonly startingFor: Map<string, number>;
  readonly pauseOnObserve: Map<string, ProvisionHumanPause>;
  readonly pauseOnApply: Map<string, ProvisionHumanPause>;
  readonly failOnApply: Map<string, Error>;
  /** The resource whose next apply takes effect, then the process dies. */
  crashAfterApply?: string;
  /** Resources whose next apply takes effect, then Google Cloud reports an expired sign-in. */
  readonly signInExpiresAfterApply: Set<string>;
}

function worldResource(world: World, name: string, unknown?: 'create-by-unique-id'): StepResource<World> {
  return {
    name,
    ...(unknown ? { unknown } : {}),
    observe: async () => {
      world.observed.push(name);
      const pause = world.pauseOnObserve.get(name);
      if (pause) return { status: 'pause', pause };
      const unknownLeft = world.unknownFor.get(name) ?? 0;
      if (unknownLeft > 0) {
        world.unknownFor.set(name, unknownLeft - 1);
        return { status: 'unknown', reason: `Waiting for ${name} to answer…`, evidence: 'HTTP 503 from the API' };
      }
      const startingLeft = world.startingFor.get(name) ?? 0;
      if (startingLeft > 0) {
        world.startingFor.set(name, startingLeft - 1);
        return ABSENT;
      }
      return world.present.has(name) ? PRESENT : ABSENT;
    },
    apply: async () => {
      world.applied.push(name);
      const failure = world.failOnApply.get(name);
      if (failure) throw failure;
      const pause = world.pauseOnApply.get(name);
      if (pause) return pause;
      world.present.add(name);
      if (world.signInExpiresAfterApply.delete(name)) {
        throw new SignInRequired('Google Cloud sign-in for operator@example.test has expired');
      }
      if (world.crashAfterApply === name) {
        world.crashAfterApply = undefined;
        throw new Error('The process died after the effect');
      }
      return undefined;
    },
  };
}

function worldSteps(world: World, ingress: 'existing' | 'managed' = 'existing'): ProvisionSteps<World> {
  const step = (id: ProvisionStepId, extra: Partial<ProvisionStep<World>> = {}): ProvisionStep<World> => ({
    label: `Running ${id}…`,
    resources: [worldResource(world, id)],
    ...extra,
  });
  const runtime = (id: ProvisionStepId): ProvisionStep<World> => step(id, { liveness: { label: `Checking ${id}…` } });
  const principalPauseNeeds = ['start_nanoclaw', 'establish_transport'] as const;
  return {
    materialize_checkout: step('materialize_checkout'),
    provision_gcp: step('provision_gcp'),
    start_onecli: runtime('start_onecli'),
    configure_provider: step('configure_provider'),
    start_nanoclaw: runtime('start_nanoclaw'),
    establish_transport: ingress === 'managed' ? runtime('establish_transport') : step('establish_transport'),
    configure_channel: step('configure_channel'),
    bind_principal: step('bind_principal', { pauseNeeds: principalPauseNeeds }),
    verify_conversation: step('verify_conversation', { pauseNeeds: principalPauseNeeds }),
  };
}

async function engineFixture(ingress: 'existing' | 'managed' = 'existing') {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation(paths));
  const world: World = {
    present: new Set(),
    observed: [],
    applied: [],
    unknownFor: new Map(),
    startingFor: new Map(),
    pauseOnObserve: new Map(),
    pauseOnApply: new Map(),
    failOnApply: new Map(),
    signInExpiresAfterApply: new Set(),
  };
  const sleeps: number[] = [];
  const events: RunEvent[] = [];
  const signIns: string[] = [];
  let steps = worldSteps(world, ingress);
  let signIn: (() => Promise<void>) | undefined = async () => void signIns.push('signed in');
  return {
    paths,
    world,
    sleeps,
    events,
    signIns,
    set signIn(next: (() => Promise<void>) | undefined) {
      signIn = next;
    },
    get steps() {
      return steps;
    },
    set steps(next: ProvisionSteps<World>) {
      steps = next;
    },
    journal: () => readProvisionJournal(paths, reserved.instance_id),
    run: async (run?: RunLog): Promise<ProvisionResult> => {
      const result = await withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProvisionSteps(operation, world, steps, {
          emit: (event) => void events.push(event),
          sleep: async (milliseconds) => void sleeps.push(milliseconds),
          ...(signIn ? { signIn } : {}),
          ...(run ? { run } : {}),
        }),
      );
      if (!result) throw new Error('The instance operation was busy');
      return result;
    },
    instanceId: reserved.instance_id,
  };
}

function startedSteps(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'step-started' ? [event.step] : []));
}

const FULL_WAIT = OBSERVATION_WAITS_SECONDS.map((seconds) => seconds * 1_000);

describe('step engine', () => {
  it('runs a fresh instance in order, recording when each step started and completed', async () => {
    const engine = await engineFixture();

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });

    expect(startedSteps(engine.events)).toEqual([...PROVISION_STEPS]);
    expect(engine.world.applied).toEqual([...PROVISION_STEPS]);
    const journal = await engine.journal();
    let previous = journal.started_at;
    for (const id of PROVISION_STEPS) {
      const step = journal.steps[id];
      expect(step?.completed_at, id).toBeDefined();
      expect(step!.started_at >= previous, id).toBe(true);
      expect(step!.completed_at! >= step!.started_at, id).toBe(true);
      previous = step!.completed_at!;
    }
  });

  it('resumes an interrupted step by observing its effect, without applying it again', async () => {
    const engine = await engineFixture();
    engine.world.crashAfterApply = 'start_onecli';

    await expect(engine.run()).rejects.toThrow('The process died after the effect');
    const interrupted = await engine.journal();
    expect(interrupted.steps.provision_gcp?.completed_at).toBeDefined();
    expect(interrupted.steps.start_onecli).toEqual({ started_at: expect.any(String) });
    expect(interrupted.last_error).toMatchObject({ step: 'start_onecli', code: 'unexpected' });

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'start_onecli')).toHaveLength(1);
    const resumed = await engine.journal();
    expect(resumed.steps.start_onecli?.started_at).toBe(interrupted.steps.start_onecli?.started_at);
    expect(resumed.last_error).toBeUndefined();
  });

  it('applies only the absent resource of a step with two', async () => {
    const engine = await engineFixture();
    engine.steps = {
      ...engine.steps,
      start_nanoclaw: {
        ...engine.steps.start_nanoclaw,
        resources: [worldResource(engine.world, 'host'), worldResource(engine.world, 'identity')],
      },
    };
    engine.world.present.add('host');

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied).toContain('identity');
    expect(engine.world.applied).not.toContain('host');
  });

  it('waits out an unknown observation and completes without applying', async () => {
    const engine = await engineFixture();
    engine.world.present.add('provision_gcp');
    engine.world.unknownFor.set('provision_gcp', 2);

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied).not.toContain('provision_gcp');
    expect(engine.sleeps).toEqual([1_000, 2_000]);
    expect(engine.events.filter((event) => event.type === 'step-waiting')).toEqual([
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp to answer…' },
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp to answer…' },
    ]);
  });

  it('stops with evidence and changes nothing when an observation stays unknown past the deadline', async () => {
    const engine = await engineFixture();
    engine.world.unknownFor.set('provision_gcp', 99);
    const run = await startRunLog({ paths: engine.paths, command: 'resume', instanceId: engine.instanceId });

    const failure = await engine.run(run).catch((error: unknown) => error);

    expect(failure).toMatchObject({ code: 'observation_unknown', details: { evidence: 'HTTP 503 from the API' } });
    expect((failure as GwsEaError).message).toContain('Waiting for provision_gcp to answer…');
    expect(engine.sleeps).toEqual(FULL_WAIT);
    expect(engine.world.applied).toEqual(['materialize_checkout']);
    const journal = await engine.journal();
    expect(journal.steps.provision_gcp?.completed_at).toBeUndefined();
    expect(journal.last_error).toMatchObject({ step: 'provision_gcp', code: 'observation_unknown' });
    expect(await readFile(journal.last_error!.log!, 'utf8')).toContain('HTTP 503 from the API');
  });

  it('creates a resource under its own unique ID without waiting out an unknown observation', async () => {
    const engine = await engineFixture();
    engine.steps = {
      ...engine.steps,
      provision_gcp: {
        ...engine.steps.provision_gcp,
        resources: [worldResource(engine.world, 'provision_gcp', 'create-by-unique-id')],
      },
    };
    engine.world.unknownFor.set('provision_gcp', 1);

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied).toContain('provision_gcp');
    expect(engine.sleeps).toEqual([]);
  });

  it('waits for a resource it just created to become visible, then completes', async () => {
    const engine = await engineFixture();
    // Absent before the change, then absent twice more while the change propagates.
    engine.world.startingFor.set('provision_gcp', 3);

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
    expect(engine.sleeps).toEqual([1_000, 2_000]);
    expect(engine.events.filter((event) => event.type === 'step-waiting')).toEqual([
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp…' },
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp…' },
    ]);
  });

  it('pauses when an observation needs sign-in, and continues after it', async () => {
    const engine = await engineFixture();
    const signIn: ProvisionHumanPause = {
      kind: 'human-action',
      phase: 'provision_gcp',
      code: 'gcloud_sign_in_required',
      message: 'Sign in to Google Cloud, then resume.',
    };
    engine.world.pauseOnObserve.set('provision_gcp', signIn);

    await expect(engine.run()).resolves.toEqual({ status: 'paused', pause: signIn });
    expect(engine.world.applied).toEqual(['materialize_checkout']);
    expect((await engine.journal()).steps.provision_gcp?.completed_at).toBeUndefined();

    engine.world.pauseOnObserve.clear();
    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
  });

  it('signs in when a step finds the sign-in expired, then retries it without repeating its mutation', async () => {
    const engine = await engineFixture();
    engine.world.signInExpiresAfterApply.add('provision_gcp');
    const run = await startRunLog({ paths: engine.paths, command: 'resume', instanceId: engine.instanceId });

    await expect(engine.run(run)).resolves.toEqual({ status: 'ready' });

    expect(engine.signIns).toEqual(['signed in']);
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
    expect(engine.events.filter((event) => event.type === 'step-failed')).toEqual([]);
    const journal = await engine.journal();
    expect(journal.steps.provision_gcp?.completed_at).toBeDefined();
    expect(journal.last_error).toBeUndefined();
    const rawLog = (await readdir(run.directory, { recursive: true })).find((file) =>
      file.endsWith('provision-gcp.log'),
    );
    expect(await readFile(path.join(run.directory, rawLog!), 'utf8')).toContain(
      'sign-in for operator@example.test has expired',
    );
  });

  it('pauses for sign-in when no person can sign in, and resumes without repeating the mutation', async () => {
    const engine = await engineFixture();
    engine.world.signInExpiresAfterApply.add('provision_gcp');
    engine.signIn = async () => {
      throw new PauseRequired('gcloud_sign_in_required', 'Google Cloud sign-in is required.', ['Sign in.']);
    };

    await expect(engine.run()).rejects.toBeInstanceOf(PauseRequired);
    const paused = await engine.journal();
    expect(paused.steps.provision_gcp?.completed_at).toBeUndefined();
    expect(paused.last_error).toBeUndefined();

    await expect(engine.run()).resolves.toEqual({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
  });

  it('signs in once per step: an expiry that survives sign-in fails the step', async () => {
    const engine = await engineFixture();
    engine.steps = {
      ...engine.steps,
      provision_gcp: {
        ...engine.steps.provision_gcp,
        resources: [
          {
            name: 'provision_gcp',
            observe: async () => {
              throw new SignInRequired('Google Cloud sign-in for operator@example.test has expired');
            },
            apply: async () => undefined,
          },
        ],
      },
    };

    await expect(engine.run()).rejects.toBeInstanceOf(SignInRequired);
    expect(engine.signIns).toEqual(['signed in']);
    expect((await engine.journal()).last_error).toMatchObject({ step: 'provision_gcp', code: 'gcloud_auth_required' });
  });

  it('fails an expired sign-in as-is when the run has no way to sign in', async () => {
    const engine = await engineFixture();
    engine.world.signInExpiresAfterApply.add('provision_gcp');
    engine.signIn = undefined;

    await expect(engine.run()).rejects.toBeInstanceOf(SignInRequired);
    expect((await engine.journal()).last_error).toMatchObject({ step: 'provision_gcp', code: 'gcloud_auth_required' });
  });

  it('records an input pause as a pause, not a failure', async () => {
    const engine = await engineFixture();
    engine.world.failOnApply.set(
      'configure_provider',
      new PauseRequired('input_required', 'The provider credential is required.', ['Set GWS_EA_PROVIDER_CREDENTIAL.']),
    );
    const run = await startRunLog({ paths: engine.paths, command: 'resume', instanceId: engine.instanceId });

    await expect(engine.run(run)).rejects.toBeInstanceOf(PauseRequired);

    const journal = await engine.journal();
    expect(journal.last_error).toBeUndefined();
    expect(journal.steps.configure_provider).toEqual({ started_at: expect.any(String) });
    const progress = await readFile(run.progressLog, 'utf8');
    expect(progress).toMatch(/configure_provider \[\S+\] → paused/u);
    expect(progress).not.toContain('→ failed');
  });

  it('checks completed runtime steps once per run, waiting on one that is still starting', async () => {
    const engine = await engineFixture();
    const chat: ProvisionHumanPause = { ...DM_PAUSE, phase: 'configure_channel', code: 'chat_configuration_required' };
    engine.world.pauseOnApply.set('configure_channel', chat);
    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });

    engine.world.pauseOnApply.clear();
    engine.world.startingFor.set('start_onecli', 2);
    engine.world.observed.length = 0;
    engine.events.length = 0;
    await expect(engine.run()).resolves.toEqual({ status: 'ready' });

    expect(startedSteps(engine.events).slice(0, 2)).toEqual(['start_onecli', 'start_nanoclaw']);
    expect(engine.events[0]).toEqual({ type: 'step-started', step: 'start_onecli', label: 'Checking start_onecli…' });
    expect(engine.world.observed.filter((name) => name === 'start_onecli')).toHaveLength(3);
    expect(engine.world.observed.filter((name) => name === 'start_nanoclaw')).toHaveLength(1);
    expect(engine.world.observed).not.toContain('materialize_checkout');
    expect(engine.world.observed).not.toContain('provision_gcp');
    expect(engine.world.observed).not.toContain('configure_provider');
    expect(engine.sleeps).toEqual([1_000, 2_000]);
    expect(engine.world.applied.filter((name) => name === 'start_onecli')).toHaveLength(1);
  });

  it('repairs a stopped runtime locally only after the bounded wait', async () => {
    const engine = await engineFixture();
    await expect(engine.run()).resolves.toEqual({ status: 'ready' });

    engine.world.present.delete('start_nanoclaw');
    await expect(engine.run()).resolves.toEqual({ status: 'ready' });

    expect(engine.sleeps).toEqual(FULL_WAIT);
    expect(engine.world.applied.filter((name) => name === 'start_nanoclaw')).toHaveLength(2);
    expect(engine.world.applied.filter((name) => name === 'configure_provider')).toHaveLength(1);
  });

  it.each([
    ['existing', ['start_nanoclaw']],
    ['managed', ['start_nanoclaw', 'establish_transport']],
  ] as const)('before the DM pause re-checks only the host (and connector when %s)', async (ingress, rechecked) => {
    const engine = await engineFixture(ingress);
    engine.world.pauseOnApply.set('bind_principal', DM_PAUSE);
    await expect(engine.run()).resolves.toEqual({ status: 'paused', pause: DM_PAUSE });

    engine.world.observed.length = 0;
    await expect(engine.run()).resolves.toEqual({ status: 'paused', pause: DM_PAUSE });

    const afterPause = engine.world.observed.slice(engine.world.observed.lastIndexOf('bind_principal') + 1);
    expect(afterPause).toEqual(rechecked);
  });

  it('still names the pending human action when a failed re-check blocks the pause', async () => {
    const engine = await engineFixture();
    const hostDown = new GwsEaError('nanoclaw_not_ready', 'NanoClaw did not become ready');
    engine.steps = {
      ...engine.steps,
      bind_principal: {
        ...engine.steps.bind_principal,
        resources: [
          {
            name: 'bind_principal',
            observe: async () => ABSENT,
            apply: async () => {
              engine.world.present.delete('start_nanoclaw');
              engine.world.failOnApply.set('start_nanoclaw', hostDown);
              return DM_PAUSE;
            },
          },
        ],
      },
    };

    const failure = await engine.run().catch((error: unknown) => error);

    expect(failure).toBe(hostDown);
    expect(pendingActionOf(failure)).toBe(DM_PAUSE);
    expect((await engine.journal()).last_error).toMatchObject({ step: 'start_nanoclaw', code: 'nanoclaw_not_ready' });
  });

  it('refuses a pre-v3 journal before running any step', async () => {
    const engine = await engineFixture();
    await writeFile(
      engine.paths.journalFile(engine.instanceId),
      JSON.stringify({ schema_version: 1, instance_id: engine.instanceId, phases: {} }),
      { mode: 0o600 },
    );

    await expect(engine.run()).rejects.toMatchObject({ code: 'unsupported_journal' });
    expect(engine.world.observed).toEqual([]);
  });

  it('releases the instance lock while paused for a human action', async () => {
    const engine = await engineFixture();
    engine.world.pauseOnApply.set('bind_principal', DM_PAUSE);

    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });
    await expect(withInstanceOperation(engine.paths, engine.instanceId, async () => 'reacquired')).resolves.toBe(
      'reacquired',
    );
  });
});

/** The driver injects upstream's `.env` writer; these tests only need the owned keys it receives. */
const recordEnv: UpsertEnvVars = () => undefined;

describe('production bootstrap trust boundary', () => {
  it('ignores caller-authored principal eligibility timestamps and other unknown fields', async () => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    await writeFile(
      file,
      JSON.stringify({ ...bootstrapManifest(paths), provisioning_started_at: '1970-01-01T00:00:00.000Z' }),
      { mode: 0o600 },
    );

    await expect(loadProductionBootstrapManifest(file)).resolves.toEqual(bootstrapManifest(paths));
  });

  it('refuses a bootstrap manifest without a local Docker endpoint', async () => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    await writeFile(file, JSON.stringify({ ...bootstrapManifest(paths), docker_endpoint: 'tcp://192.0.2.10:2376' }), {
      mode: 0o600,
    });

    await expect(loadProductionBootstrapManifest(file)).rejects.toMatchObject({
      code: 'invalid_bootstrap_manifest',
      message: expect.stringContaining('docker_endpoint'),
    });
  });

  it('stages and removes only the validated bootstrap file before reservation publication', async () => {
    const paths = await testPaths();
    const input = reservation(paths);
    const manifest = bootstrapManifest(paths);

    await installProductionBootstrapManifest(paths, input.instance_id, manifest);
    await expect(readFile(paths.bootstrapFile(input.instance_id), 'utf8')).resolves.toContain('"schema_version": 1');
    await removeProductionBootstrapManifest(paths, input.instance_id);
    await expect(readFile(paths.bootstrapFile(input.instance_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.instanceRoot(input.instance_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /** A reserved instance whose host started once: runtime and receipt persisted, bootstrap manifest gone. */
  async function startedInstance(receiptCohort: { gateway: string; cli: string; sdk: string }) {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const onecli = createOnecliRuntimeLayout({
      instanceId: reserved.instance_id,
      instanceRoot: paths.instanceRoot(reserved.instance_id),
      project: reserved.exclusive_resource_claims.onecli_project,
      appPort: reserved.allocated_ports.onecli_app,
      gatewayPort: reserved.allocated_ports.onecli_gateway,
      cliExecutable: '/usr/local/bin/onecli',
    });
    const runtime = createInstanceRuntimeConfig(reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: path.dirname(paths.stateRoot),
      selectedProvider: 'claude',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    await persistInstanceRuntime(runtime, recordEnv);
    await writeFile(
      paths.releasePreflightFile(reserved.instance_id),
      `${JSON.stringify({
        schema_version: 1,
        instance_id: reserved.instance_id,
        deployed_commit: reserved.deployed_commit,
        provider: 'claude',
        providerCapabilityDigest,
        providerCredential: {
          name: 'Claude provider',
          type: 'api_key',
          hostPattern: 'api.anthropic.com',
          headerName: 'x-api-key',
        },
        packageManager: 'pnpm@10.0.0',
        onecli: receiptCohort,
        recorded_by: 'a launcher with other fields',
      })}\n`,
      { mode: 0o600 },
    );
    await mkdir(path.join(reserved.checkout_realpath, 'data'), { recursive: true });
    new Database(path.join(reserved.checkout_realpath, 'data', 'v2.db')).close();
    return { paths, reserved };
  }

  it('treats a database created before the profile migration as unpublished', async () => {
    const { paths, reserved } = await startedInstance({
      gateway: ONECLI_GATEWAY_VERSION,
      cli: ONECLI_CLI_VERSION,
      sdk: ONECLI_SDK_VERSION,
    });

    await expect(
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProductionProvision(operation, { upsertEnvVars: recordEnv }),
      ),
    ).rejects.toMatchObject({ code: 'bootstrap_required' });
  });

  it('resumes past a release receipt whose OneCLI cohort differs from this launcher’s pins', async () => {
    const { paths, reserved } = await startedInstance({ gateway: '1.41.0', cli: '2.2.4', sdk: '2.2.0' });

    // bootstrap_required is raised only after the receipt was accepted.
    await expect(
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProductionProvision(operation, { upsertEnvVars: recordEnv }),
      ),
    ).rejects.toMatchObject({ code: 'bootstrap_required' });
  });
});

function productionContext(operation: InstanceOperation, reserved: InstanceReservation): ProductionProvisionContext {
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
    dockerEndpoint: 'unix:///var/run/docker.sock',
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
      releasePreflight: {
        checkoutRoot: reserved.checkout_realpath,
        provider: 'claude',
        providerCapabilityDigest,
        providerCredential: {
          name: 'Claude provider',
          type: 'api_key',
          hostPattern: 'api.anthropic.com',
          headerName: 'x-api-key',
        },
        onecliCliPath: '/usr/local/bin/onecli',
      },
      onecli,
      runtime,
      gcp: {
        instanceId: reserved.instance_id,
        projectId: reserved.exclusive_resource_claims.gcp_project_id,
        account: reserved.exclusive_resource_claims.gcp_account,
        serviceAccountEmail: reserved.exclusive_resource_claims.gchat_service_account,
        credentialFile: runtime.secret_files.gchat_credentials,
        cwd: reserved.checkout_realpath,
      },
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
      chatConfigured: false,
      serviceDependencies: {
        upsertEnvVars: recordEnv,
        platform: 'macos',
        homeDirectory: path.dirname(operation.paths.stateRoot),
        runningAsRoot: false,
      },
      ingress: reserved.exclusive_resource_claims.ingress,
    },
  };
}

interface ProbeIdentityState {
  agents: Array<{ id: string; identifier: string; name: string; secretMode: 'all' | 'selective' }>;
  readonly onecliCalls: string[][];
  readonly providerSecretIds: string[];
}

function probeIdentityDependencies(
  context: ProductionProvisionContext,
  state: ProbeIdentityState,
): MainIdentityDependencies {
  return {
    runNcl: async (_runtime, args) => {
      if (args[0] === 'status') {
        return {
          project_root: context.input.runtime.checkout_realpath,
          webhook: { port: context.input.runtime.allocated_ports.nanoclaw_webhook, paths: ['/webhook/gchat'] },
          channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
        };
      }
      if (args[0] === 'gws-ea-profile' && args[1] === 'get') {
        return {
          assistant_display_name: context.input.identity.assistantDisplayName,
          assistant_workspace_email: context.input.identity.assistantWorkspaceEmail,
          principal_display_name: context.input.identity.principalDisplayName,
          principal_timezone: context.input.identity.principalTimezone,
          main_agent_group_id: 'ag-main',
        };
      }
      if (args[0] === 'groups' && args[1] === 'get') return { id: 'ag-main', name: 'main' };
      if (args[0] === 'groups' && args[1] === 'config' && args[2] === 'get') {
        return { provider: context.input.runtime.selected_provider };
      }
      throw new Error(`Unexpected ncl probe call: ${args.join(' ')}`);
    },
    runOnecliAdmin: async (_runtime, args) => {
      state.onecliCalls.push([...args]);
      if (args[0] === 'agents' && args[1] === 'list') return state.agents;
      if (args[0] === 'agents' && args[1] === 'secrets') return state.providerSecretIds;
      throw new Error(`Unexpected OneCLI probe call: ${args.join(' ')}`);
    },
  };
}

/** Run one production step through the engine; every other step is already satisfied. */
function runAlone(
  operation: InstanceOperation,
  context: ProductionProvisionContext,
  id: ProvisionStepId,
  step: ProvisionStep<ProductionProvisionContext>,
  runtime: Parameters<typeof runProvisionSteps>[3] = {},
): Promise<ProvisionResult> {
  const satisfied: ProvisionStep<ProductionProvisionContext> = {
    label: 'Already satisfied…',
    resources: [{ name: 'nothing', observe: async () => PRESENT, apply: async () => undefined }],
  };
  const steps = { ...Object.fromEntries(PROVISION_STEPS.map((other) => [other, satisfied])), [id]: step };
  return runProvisionSteps(operation, context, steps as ProvisionSteps<ProductionProvisionContext>, runtime);
}

describe('production provision step composition', () => {
  it.each([
    ['existing', ['start_onecli', 'start_nanoclaw']],
    ['managed', ['start_onecli', 'start_nanoclaw', 'establish_transport']],
  ] as const)('re-checks only runtime steps once complete (%s ingress)', async (mode, runtime) => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, mode === 'managed' ? managedReservation(paths) : reservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const steps = createProductionProvisionSteps(productionContext(operation, reserved));
      expect(PROVISION_STEPS.filter((id) => steps[id].liveness)).toEqual(runtime);
      expect(steps.bind_principal.pauseNeeds).toEqual(['start_nanoclaw', 'establish_transport']);
      expect(steps.verify_conversation.pauseNeeds).toEqual(['start_nanoclaw', 'establish_transport']);
      expect(steps.configure_channel.pauseNeeds).toBeUndefined();
    });
  });

  it('forwards Google Cloud waits through the provision runtime', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const progress: RunEvent[] = [];
    const reason = 'Waiting for Google Cloud to allow Google Chat key creation…';

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const googleCloudResources: ProductionProvisionDependencies['googleCloudResources'] = (dependencies) => [
        {
          name: 'the Google Chat credential',
          observe: async () => ABSENT,
          apply: async () => {
            dependencies?.onWait?.(reason);
            return undefined;
          },
        },
      ];
      const phase = createProductionProvisionSteps(
        context,
        { googleCloudResources },
        { emit: (event) => void progress.push(event) },
      ).provision_gcp.resources[0]!;

      await expect(phase.apply(context)).resolves.toBeUndefined();
    });

    expect(progress).toEqual([{ type: 'step-waiting', step: 'provision_gcp', reason }]);
  });

  it('observes Google Cloud as its own resources, restoring a lifted key policy first', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const resources = createProductionProvisionSteps(productionContext(operation, reserved)).provision_gcp.resources;

      expect(resources.map((resource) => [resource.name, resource.unknown ?? 'wait'])).toEqual([
        ['the Google Chat key-creation policy', 'wait'],
        ['the Google Cloud project', 'create-by-unique-id'],
        ['the Google Cloud APIs', 'wait'],
        ['the Google Chat service account', 'wait'],
        ['the Google Chat credential', 'wait'],
      ]);
    });
  });

  it('accepts only an all-mode canonical main without enumerating its grants', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const state: ProbeIdentityState = {
        agents: [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' }],
        onecliCalls: [],
        providerSecretIds: ['secret-provider'],
      };
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, identityDependencies: probeIdentityDependencies(base, state) },
      };
      const phase = createProductionProvisionSteps(context).start_nanoclaw.resources[1]!;

      await expect(phase.observe(context)).resolves.toEqual(PRESENT);
      expect(state.onecliCalls).toEqual([['agents', 'list', '--max', '0']]);

      state.agents = [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'selective' }];
      state.onecliCalls.length = 0;
      await expect(phase.observe(context)).resolves.toEqual(ABSENT);
      expect(state.onecliCalls).toEqual([['agents', 'list', '--max', '0']]);
    });
  });

  it('repairs a stopped OneCLI runtime only after the liveness wait, and refuses unsafe drift', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      let running = true;
      let unsafe = false;
      const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
      const reconcileOnecliRuntime = vi.fn(async () => {
        running = true;
        return receipt;
      });
      const persistOnecliApiKeyFiles = vi.fn(async () => undefined);
      const observeOnecli = vi.fn(async () => {
        if (unsafe) throw new GwsEaError('unsafe_onecli_owner', 'Foreign OneCLI resource');
        return running ? PRESENT : ABSENT;
      });
      const step = createProductionProvisionSteps(context, {
        observeOnecli,
        reconcileOnecliRuntime,
        persistOnecliApiKeyFiles,
        holdReservedLoopbackPorts: async () => ({ release: async () => undefined }),
      }).start_onecli;
      const sleeps: number[] = [];
      const runtime = { sleep: async (milliseconds: number) => void sleeps.push(milliseconds) };
      await expect(runAlone(operation, context, 'start_onecli', step, runtime)).resolves.toEqual({ status: 'ready' });
      expect(reconcileOnecliRuntime).not.toHaveBeenCalled();

      running = false;
      await expect(runAlone(operation, context, 'start_onecli', step, runtime)).resolves.toEqual({ status: 'ready' });
      expect(sleeps).toEqual(FULL_WAIT);
      expect(reconcileOnecliRuntime).toHaveBeenCalledOnce();
      expect(persistOnecliApiKeyFiles).toHaveBeenCalledWith(receipt, {
        runtime: context.input.runtime.secret_files.onecli_runtime_api_key,
        admin: context.input.runtime.secret_files.onecli_admin_api_key,
      });
      expect(context.state.onecliReceipt).toBe(receipt);

      unsafe = true;
      await expect(runAlone(operation, context, 'start_onecli', step, runtime)).rejects.toMatchObject({
        code: 'unsafe_onecli_owner',
      });
      expect(reconcileOnecliRuntime).toHaveBeenCalledOnce();
    });
  });

  it('reclaims the exact reserved OneCLI ports on a normal resume and holds them until bind', async () => {
    const paths = await testPaths();
    const originalLease = await holdLoopbackPorts();
    const ports = originalLease.ports;
    await originalLease.release();
    const reserved = await reserveInstance(paths, reservation(paths, ports));
    const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
    const bindObservations: boolean[] = [];

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const reconcileOnecliRuntime = vi.fn(async (_layout, dependencies) => {
        bindObservations.push(await canClaim(ports.onecli_app));
        await dependencies.beforeBind?.();
        bindObservations.push(await canClaim(ports.onecli_app));
        return receipt;
      });
      const phase = createProductionProvisionSteps(context, {
        reconcileOnecliRuntime,
        persistOnecliApiKeyFiles: vi.fn(async () => undefined),
      }).start_onecli.resources[0]!;

      await expect(phase.apply(context)).resolves.toBeUndefined();
      expect(reconcileOnecliRuntime).toHaveBeenCalledOnce();
    });

    expect(bindObservations).toEqual([false, true]);
    await expect(canClaim(ports.onecli_app)).resolves.toBe(true);
    await expect(canClaim(ports.onecli_gateway)).resolves.toBe(true);
  });

  it('fails resume when a foreign listener takes an exact released reserved port', async () => {
    const paths = await testPaths();
    const originalLease = await holdLoopbackPorts();
    const ports = originalLease.ports;
    await originalLease.release();
    const foreignListener = createServer();
    await listen(foreignListener, ports.onecli_app);
    const reserved = await reserveInstance(paths, reservation(paths, ports));
    const reconcileOnecliRuntime = vi.fn();

    try {
      await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        const context = productionContext(operation, reserved);
        const phase = createProductionProvisionSteps(context, { reconcileOnecliRuntime }).start_onecli.resources[0]!;

        await expect(phase.apply(context)).rejects.toMatchObject({
          code: 'port_claim_lost',
          message:
            `Reserved onecli_app coordinate 127.0.0.1:${ports.onecli_app} is unavailable. ` +
            `Stop the process using it, then resume with: gws-ea resume --id ${reserved.instance_id}`,
        });
      });
    } finally {
      await close(foreignListener);
    }

    expect(reconcileOnecliRuntime).not.toHaveBeenCalled();
  });

  it('reattaches an owned OneCLI runtime after interruption before its API keys were persisted', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
    const observed = { containers: [], networks: [], volumes: [] } as ObservedOnecliRuntime;
    const portFailure = new GwsEaError('port_claim_lost', 'The owned OneCLI runtime already holds its ports');
    const holdReservedLoopbackPorts = vi.fn(async (): Promise<never> => {
      throw portFailure;
    });
    const inspectOnecliRuntime = vi.fn(async () => observed);
    const validateObservedOnecliRuntime = vi.fn(() => undefined);
    const reconcileOnecliRuntime = vi.fn(async () => receipt);
    const persistOnecliApiKeyFiles = vi.fn(async () => undefined);

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const phase = createProductionProvisionSteps(context, {
        holdReservedLoopbackPorts,
        inspectOnecliRuntime,
        validateObservedOnecliRuntime,
        reconcileOnecliRuntime,
        persistOnecliApiKeyFiles,
      }).start_onecli.resources[0]!;

      await expect(phase.apply(context)).resolves.toBeUndefined();
      expect(inspectOnecliRuntime).toHaveBeenCalledWith(context.input.onecli);
      expect(validateObservedOnecliRuntime).toHaveBeenCalledWith(context.input.onecli, observed);
      expect(reconcileOnecliRuntime).toHaveBeenCalledWith(context.input.onecli, undefined);
      expect(persistOnecliApiKeyFiles).toHaveBeenCalledOnce();
    });
  });

  it('collects a missing credential only after the isolated OneCLI runtime is ready', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const order: string[] = [];

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          providerCredential: undefined,
          requestProviderCredential: async () => {
            order.push('collect');
            return {
              name: 'Claude provider',
              type: 'api_key',
              value: 'prompted-secret',
              hostPattern: 'api.anthropic.com',
              headerName: 'x-api-key',
            };
          },
        },
      };
      const dependencies: Partial<ProductionProvisionDependencies> = {
        reconcileOnecliRuntime: vi.fn(async () => {
          order.push('onecli');
          return {} as OnecliCompatibilityReceipt;
        }),
        persistOnecliApiKeyFiles: vi.fn(async () => undefined),
        importProviderCredential: vi.fn(async (_receipt, credential) => {
          order.push(`import:${credential.value}`);
          return { id: 'secret-provider', created: true };
        }),
      };

      const registry = createProductionProvisionSteps(context, dependencies);
      await registry.start_onecli.resources[0]!.apply(context);
      await registry.configure_provider.resources[0]!.apply(context);
    });

    expect(order).toEqual(['onecli', 'collect', 'import:prompted-secret']);
  });

  it('rejects a credential that does not match the selected provider definition', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const importProviderCredential = vi.fn();

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          providerCredential: undefined,
          requestProviderCredential: async () => ({
            name: 'Different provider',
            type: 'api_key',
            value: 'prompted-secret',
            hostPattern: 'api.anthropic.com',
            headerName: 'x-api-key',
          }),
        },
      };
      const registry = createProductionProvisionSteps(context, {
        importProviderCredential,
      });

      await expect(registry.configure_provider.resources[0]!.apply(context)).rejects.toMatchObject({
        code: 'provider_credential_mismatch',
      });
    });

    expect(importProviderCredential).not.toHaveBeenCalled();
  });

  it('hands the managed transport its instance, claim, and platform, and asks for the account token only through it', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, managedReservation(paths));
    const claim = reserved.exclusive_resource_claims.ingress;
    if (claim.mode !== 'managed-cloudflare') throw new Error('managed fixture');
    const resources = [{ name: 'the managed transport', observe: async () => PRESENT, apply: async () => undefined }];
    let transport: ManagedTransport | undefined;
    const requested: string[] = [];
    let retained: string | undefined;

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          managedIngressSetup: {
            requireAccountToken: (accountId) => {
              if (retained === undefined) {
                throw new GwsEaError('cloudflare_token_required', 'A fresh Cloudflare API token is required.');
              }
              expect(accountId).toBe(claim.account_id);
              return retained;
            },
          },
          requestCloudflareAccountToken: async (accountId, reason) => {
            requested.push(`${accountId}:${reason}`);
            return 'requested-account-token';
          },
        },
      };
      const step = createProductionProvisionSteps(context, {
        managedTransportResources: (received) => {
          transport = received;
          return resources;
        },
      }).establish_transport;

      expect(step.resources).toBe(resources);
      expect(step.liveness).toBeDefined();
      expect(transport).toMatchObject({
        paths,
        instanceId: reserved.instance_id,
        claim,
        platform: 'macos',
        webhookPort: reserved.allocated_ports.nanoclaw_webhook,
      });
      await expect(transport!.accountToken('Cloudflare must route the callback')).resolves.toBe(
        'requested-account-token',
      );
      retained = 'retained-account-token';
      await expect(transport!.accountToken('Cloudflare must route the callback')).resolves.toBe(
        'retained-account-token',
      );
    });

    expect(requested).toEqual([`${claim.account_id}:Cloudflare must route the callback`]);
  });

  it('keeps existing transport behavior and invokes no Cloudflare dependency', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const managedTransportResources = vi.fn();

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const phase = createProductionProvisionSteps(context, {
        verifyRoute: async ({ endpointUrl }) => endpointUrl,
        managedTransportResources,
      }).establish_transport.resources[0]!;

      await expect(phase.observe(context)).resolves.toEqual(PRESENT);
      await expect(phase.apply(context)).resolves.toMatchObject({ code: 'existing_endpoint_required' });
      expect(createProductionProvisionSteps(context).establish_transport.liveness).toBeUndefined();
    });

    expect(managedTransportResources).not.toHaveBeenCalled();
  });

  it('pauses with the exact project-scoped Chat configuration handoff', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const verifyEndpoint = vi.fn();

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const phase = createProductionProvisionSteps(context, { verifyEndpoint }).configure_channel.resources[0]!;

      await expect(phase.observe(context)).resolves.toMatchObject({
        status: 'pause',
        pause: {
          code: 'chat_configuration_required',
          details: [
            'App name: Aya',
            expect.stringContaining('avatar'),
            expect.stringContaining('Google Workspace add-on'),
            expect.stringContaining('https://assistant.example.com/webhook/gchat'),
            expect.stringContaining('visibility'),
          ],
          actionUrl: expect.stringContaining(`project=${reserved.exclusive_resource_claims.gcp_project_id}`),
          resumeFlag: '--chat-configured',
        },
      });
    });

    expect(verifyEndpoint).not.toHaveBeenCalled();
  });

  it('uses the reserved managed callback byte-for-byte in runtime and Chat configuration', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, managedReservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const phase = createProductionProvisionSteps(context).configure_channel.resources[0]!;

      expect(context.input.runtime.endpoint_url).toBe('https://assistant.example.com/webhook/gchat');
      await expect(phase.observe(context)).resolves.toMatchObject({
        status: 'pause',
        pause: {
          details: expect.arrayContaining([expect.stringContaining('https://assistant.example.com/webhook/gchat')]),
        },
      });
    });
  });

  it.each([
    ['project', { project_id: 'different-project' }],
    ['identity', { client_email: 'other@gws-ea-dogfood.iam.gserviceaccount.com' }],
  ] as const)('rejects a service-account %s swap before starting NanoClaw', async (_label, credentialOverride) => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    const startRuntime = vi.fn(async (): Promise<never> => {
      throw new Error('NanoClaw must not start');
    });

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      await mkdir(path.dirname(context.input.runtime.secret_files.gchat_credentials), {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(context.input.runtime.secret_files.gchat_credentials, serviceAccount(credentialOverride), {
        mode: 0o600,
      });
      const definitions = createProductionProvisionSteps(context, { reconcileInstanceRuntime: startRuntime });

      const host = definitions.start_nanoclaw.resources[0]!;
      expect(host.name).toBe('the NanoClaw host');
      await expect(host.apply(context)).rejects.toMatchObject({
        code: 'gchat_credential_mismatch',
      });
    });

    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('continues main identity setup when the exact NanoClaw host already owns its webhook port', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const runNcl = vi.fn(async () => ({
        pid: 1234,
        project_root: reserved.checkout_realpath,
        webhook: { id: 'gchat', port: reserved.allocated_ports.nanoclaw_webhook, paths: ['/webhook/gchat'] },
        channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
      }));
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, identityDependencies: { runNcl } },
      };
      const holdReservedLoopbackPorts = vi.fn(async (): Promise<never> => {
        throw new Error('The owned host already holds the webhook port');
      });
      const reconcileInstanceRuntime = vi.fn(async (): Promise<never> => {
        throw new Error('An already-running host must not be restarted');
      });
      let identified = false;
      const reconcileMainIdentity = vi.fn(async () => {
        identified = true;
        return { agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' };
      });
      const step = createProductionProvisionSteps(context, {
        holdReservedLoopbackPorts,
        reconcileInstanceRuntime,
        reconcileMainIdentity,
        observeMainIdentity: async () => (identified ? PRESENT : ABSENT),
      }).start_nanoclaw;

      await expect(runAlone(operation, context, 'start_nanoclaw', step)).resolves.toEqual({ status: 'ready' });
      expect(runNcl).toHaveBeenCalledWith(context.input.runtime, ['status']);
      expect(holdReservedLoopbackPorts).not.toHaveBeenCalled();
      expect(reconcileInstanceRuntime).not.toHaveBeenCalled();
      expect(reconcileMainIdentity).toHaveBeenCalledOnce();
      expect(context.state.mainAgentGroupId).toBe('ag-main');
    });
  });

  it('waits for an owned NanoClaw host to become ready after its webhook port is claimed', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    let statusCalls = 0;

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          identityDependencies: {
            runNcl: async () => {
              statusCalls++;
              if (statusCalls < 4) throw new GwsEaError('command_failed', 'Host still starting');
              return {
                project_root: reserved.checkout_realpath,
                webhook: { port: reserved.allocated_ports.nanoclaw_webhook, paths: ['/webhook/gchat'] },
                channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
              };
            },
          },
        },
      };
      await mkdir(path.dirname(context.input.runtime.secret_files.gchat_credentials), { recursive: true, mode: 0o700 });
      await writeFile(context.input.runtime.secret_files.gchat_credentials, serviceAccount(), { mode: 0o600 });
      const holdReservedLoopbackPorts = vi.fn(async (): Promise<never> => {
        throw new GwsEaError('port_claim_lost', 'Owned host has the webhook port');
      });
      const reconcileInstanceRuntime = vi.fn();
      let identified = false;
      const reconcileMainIdentity = vi.fn(async () => {
        identified = true;
        return { agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' };
      });
      const nanoclawStartupDelay = vi.fn(async () => undefined);
      const step = createProductionProvisionSteps(context, {
        getOwnedGcpProjectNumber: async () => '441811502258',
        holdReservedLoopbackPorts,
        reconcileInstanceRuntime,
        reconcileMainIdentity,
        observeMainIdentity: async () => (identified ? PRESENT : ABSENT),
        nanoclawStartupDelay,
      }).start_nanoclaw;

      await expect(runAlone(operation, context, 'start_nanoclaw', step)).resolves.toEqual({ status: 'ready' });
      expect(statusCalls).toBeGreaterThanOrEqual(4);
      expect(nanoclawStartupDelay).toHaveBeenCalled();
      expect(reconcileInstanceRuntime).not.toHaveBeenCalled();
      expect(reconcileMainIdentity).toHaveBeenCalledOnce();
    });
  });

  it('waits on a starting host, and restarts a stopped one without restamping its matching main identity', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation(paths));
    let hostStatus: 'running' | 'stopped' | number = 'running';

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const identityState: ProbeIdentityState = {
        agents: [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' }],
        onecliCalls: [],
        providerSecretIds: [],
      };
      const identityDependencies = probeIdentityDependencies(base, identityState);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          identityDependencies: {
            ...identityDependencies,
            runNcl: async (runtime, args) => {
              if (args[0] === 'status' && typeof hostStatus === 'number') {
                hostStatus = hostStatus > 1 ? hostStatus - 1 : 'running';
                throw new GwsEaError('command_failed', 'Host is starting');
              }
              if (args[0] === 'status' && hostStatus === 'stopped') {
                throw new GwsEaError('command_failed', 'Host is stopped');
              }
              return identityDependencies.runNcl!(runtime, args);
            },
          },
        },
      };
      await mkdir(path.dirname(context.input.runtime.secret_files.gchat_credentials), { recursive: true, mode: 0o700 });
      await writeFile(context.input.runtime.secret_files.gchat_credentials, serviceAccount(), { mode: 0o600 });
      const reconcileInstanceRuntime = vi.fn(async () => {
        hostStatus = 'running';
        return {} as Awaited<ReturnType<ProductionProvisionDependencies['reconcileInstanceRuntime']>>;
      });
      const reconcileMainIdentity = vi.fn();
      const step = createProductionProvisionSteps(context, {
        getOwnedGcpProjectNumber: async () => '441811502258',
        holdReservedLoopbackPorts: async () => ({ release: async () => undefined }),
        reconcileInstanceRuntime,
        reconcileMainIdentity,
      }).start_nanoclaw;
      const sleeps: number[] = [];
      const runtime = { sleep: async (milliseconds: number) => void sleeps.push(milliseconds) };
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toEqual({ status: 'ready' });

      hostStatus = 2;
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toEqual({ status: 'ready' });
      expect(sleeps).toEqual([1_000, 2_000]);
      expect(reconcileInstanceRuntime).not.toHaveBeenCalled();

      sleeps.length = 0;
      hostStatus = 'stopped';
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toEqual({ status: 'ready' });
      expect(sleeps).toEqual(FULL_WAIT);
      expect(reconcileInstanceRuntime).toHaveBeenCalledOnce();
      expect(reconcileMainIdentity).not.toHaveBeenCalled();
      expect(context.state.mainAgentGroupId).toBe('ag-main');
    });
  });
});

/**
 * A production composition whose external boundaries are in-memory: each
 * toggle stands for one human or external condition a step can pause on.
 */
interface ProductionHarness {
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
  readonly effects: string[];
  readonly started: string[];
  readonly sleeps: number[];
  providerCredential: boolean;
  routePublished: boolean;
  chatConfigured: boolean;
  principal: 'waiting' | 'selection' | 'bound';
  selectedMessagingGroupId?: string;
  conversationReady: boolean;
  /** The process dies right after the principal is bound, before the step completes. */
  crashAfterBinding: boolean;
  lastContext?: ProductionProvisionContext;
  run(): Promise<ProvisionResult>;
}

const PRINCIPAL = {
  messagingGroupId: 'mg-principal',
  platformId: 'gchat:spaces/principal',
  userId: 'gchat:users/principal',
  senderName: 'Principal',
  authenticatedMessageId: 'signed-first-dm',
  authenticatedMessageAt: '2026-09-18T18:00:01.000Z',
} as const;

async function productionHarness(): Promise<ProductionHarness> {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation(paths));
  await mkdir(paths.instanceRoot(reserved.instance_id), { recursive: true, mode: 0o700 });
  await writeFile(paths.bootstrapFile(reserved.instance_id), '{}', { mode: 0o600 });
  const resources = new Set<string>();
  const receipt = Object.freeze({}) as OnecliCompatibilityReceipt;
  let principalBound = false;

  const harness: ProductionHarness = {
    paths,
    instanceId: reserved.instance_id,
    effects: [],
    started: [],
    sleeps: [],
    crashAfterBinding: false,
    providerCredential: true,
    routePublished: true,
    chatConfigured: true,
    principal: 'waiting',
    conversationReady: true,
    run: () =>
      withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        const base = productionContext(operation, reserved);
        const context: ProductionProvisionContext = {
          ...base,
          state: {},
          input: {
            ...base.input,
            ...(harness.providerCredential ? {} : { providerCredential: undefined }),
            ...(harness.selectedMessagingGroupId ? { selectedMessagingGroupId: harness.selectedMessagingGroupId } : {}),
            chatConfigured: harness.chatConfigured,
            bootstrapManifestFile: paths.bootstrapFile(reserved.instance_id),
            identityDependencies: {
              runNcl: async (_runtime, args) => {
                if (args[0] === 'status' && resources.has('host')) {
                  return {
                    project_root: reserved.checkout_realpath,
                    webhook: { port: reserved.allocated_ports.nanoclaw_webhook, paths: ['/webhook/gchat'] },
                    channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
                  };
                }
                throw new GwsEaError('command_failed', 'NanoClaw is not running');
              },
            },
          },
        };
        await mkdir(path.dirname(context.input.runtime.secret_files.gchat_credentials), {
          recursive: true,
          mode: 0o700,
        });
        await writeFile(context.input.runtime.secret_files.gchat_credentials, serviceAccount(), { mode: 0o600 });
        harness.lastContext = context;
        const effect = (name: string, resource: string): void => {
          harness.effects.push(name);
          resources.add(resource);
        };
        const overrides: Partial<ProductionProvisionDependencies> = {
          observeCheckout: async () => (resources.has('checkout') ? PRESENT : ABSENT),
          materializeReleaseCheckout: async () => {
            effect('materializeReleaseCheckout', 'checkout');
            return reserved;
          },
          runReleasePreflight: async () => ({
            provider: 'claude',
            providerCapabilityDigest,
            providerCredential: {
              name: 'Claude provider',
              type: 'api_key',
              hostPattern: 'api.anthropic.com',
              headerName: 'x-api-key',
            },
            packageManager: 'pnpm@10.0.0',
            onecli: { gateway: ONECLI_GATEWAY_VERSION, cli: ONECLI_CLI_VERSION, sdk: ONECLI_SDK_VERSION },
          }),
          googleCloudResources: () => [
            {
              name: 'the Google Cloud project',
              observe: async () => (resources.has('gcp') ? PRESENT : ABSENT),
              apply: async () => {
                effect('provisionGoogleCloud', 'gcp');
                return undefined;
              },
            },
          ],
          getOwnedGcpProjectNumber: async () => '441811502258',
          holdReservedLoopbackPorts: async () => ({ release: async () => undefined }),
          observeOnecli: async () => (resources.has('onecli') ? PRESENT : ABSENT),
          reconcileOnecliRuntime: async () => {
            effect('reconcileOnecliRuntime', 'onecli');
            return receipt;
          },
          persistOnecliApiKeyFiles: async () => undefined,
          observeProvider: async (value) => {
            if (!resources.has('provider')) return ABSENT;
            value.state.providerSecretId = 'secret-provider';
            return PRESENT;
          },
          importProviderCredential: async () => {
            effect('importProviderCredential', 'provider');
            return { id: 'secret-provider', created: true };
          },
          observeMainIdentity: async (value) => {
            if (!resources.has('host') || !resources.has('main')) return ABSENT;
            value.state.mainAgentGroupId = 'ag-main';
            return PRESENT;
          },
          reconcileInstanceRuntime: async () => {
            effect('reconcileInstanceRuntime', 'host');
            return {} as Awaited<ReturnType<ProductionProvisionDependencies['reconcileInstanceRuntime']>>;
          },
          nanoclawStartupDelay: async () => undefined,
          reconcileMainIdentity: async () => {
            effect('reconcileMainIdentity', 'main');
            return { agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' };
          },
          verifyRoute: async ({ endpointUrl }) => {
            if (!harness.routePublished) throw new GwsEaError('endpoint_unreachable', 'Route is not published');
            return endpointUrl;
          },
          verifyEndpoint: async (endpoint) => ({
            endpointUrl: endpoint.endpointUrl,
            audienceUrl: endpoint.audienceUrl,
          }),
          verifyPrincipalBinding: () =>
            principalBound
              ? { status: 'matched', agentGroupId: 'ag-main', candidate: PRINCIPAL, welcomeEventId: 'welcome' }
              : { status: 'absent' },
          reconcilePrincipal: async (_runtime, selection) => {
            harness.effects.push(`reconcilePrincipalDm:${harness.principal}`);
            if (harness.principal === 'waiting') return { status: 'waiting' };
            if (harness.principal === 'selection' && !selection.messagingGroupId) {
              return {
                status: 'selection-required',
                candidates: [PRINCIPAL, { ...PRINCIPAL, messagingGroupId: 'mg-other', userId: 'gchat:users/other' }],
              };
            }
            principalBound = true;
            if (harness.crashAfterBinding) {
              harness.crashAfterBinding = false;
              throw new Error('The process died after binding the principal');
            }
            return { status: 'bound', candidate: PRINCIPAL, agentGroupId: 'ag-main', eventId: 'welcome' };
          },
          verifyConversation: () =>
            harness.conversationReady
              ? {
                  ready: true,
                  sessionId: 'session-main',
                  welcomeInboundId: 'welcome-in',
                  welcomeOutboundId: 'welcome-out',
                  laterInboundId: 'later-in',
                  laterOutboundId: 'later-out',
                  deliveredAt: '2026-09-18T18:01:00.000Z',
                }
              : { ready: false, reason: 'later_principal_message_missing' },
        };
        const runtime = {
          emit: (event: RunEvent) => {
            if (event.type === 'step-started') harness.started.push(event.step);
          },
          sleep: async (milliseconds: number) => void harness.sleeps.push(milliseconds),
        };
        return runProvisionSteps(
          operation,
          context,
          createProductionProvisionSteps(context, overrides, runtime),
          runtime,
        );
      }).then((result) => {
        if (!result) throw new Error('The instance operation was busy');
        return result;
      }),
  };
  return harness;
}

describe('production step order and pause outcomes', () => {
  const ORDER = [
    'materialize_checkout',
    'provision_gcp',
    'start_onecli',
    'configure_provider',
    'start_nanoclaw',
    'establish_transport',
    'configure_channel',
    'bind_principal',
  ];

  it('runs the steps in order and pauses for the principal DM, then for a selection, then completes', async () => {
    const harness = await productionHarness();

    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: { phase: 'bind_principal', code: 'principal_dm_required' },
    });
    expect(harness.started.slice(0, ORDER.length)).toEqual(ORDER);
    expect(harness.effects).toEqual([
      'materializeReleaseCheckout',
      'provisionGoogleCloud',
      'reconcileOnecliRuntime',
      'importProviderCredential',
      'reconcileInstanceRuntime',
      'reconcileMainIdentity',
      'reconcilePrincipalDm:waiting',
    ]);

    harness.principal = 'selection';
    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: {
        phase: 'bind_principal',
        code: 'principal_selection_required',
        choices: [{ id: 'mg-principal' }, { id: 'mg-other' }],
      },
    });

    expect(await readFile(googleChatProjectNumberFile(harness.lastContext!.input.runtime), 'utf8')).toBe(
      '441811502258\n',
    );
    await expect(readFile(harness.paths.bootstrapFile(harness.instanceId), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(readFile(harness.paths.releasePreflightFile(harness.instanceId), 'utf8')).resolves.toContain(
      '"providerCredential"',
    );

    harness.principal = 'bound';
    harness.selectedMessagingGroupId = 'mg-principal';
    await expect(harness.run()).resolves.toEqual({ status: 'ready' });
    expect(harness.sleeps).toEqual([]);
    expect(harness.effects.filter((effect) => !effect.startsWith('reconcilePrincipalDm'))).toEqual([
      'materializeReleaseCheckout',
      'provisionGoogleCloud',
      'reconcileOnecliRuntime',
      'importProviderCredential',
      'reconcileInstanceRuntime',
      'reconcileMainIdentity',
    ]);
  });

  const blockers: ReadonlyArray<readonly [ProvisionStepId, string, (harness: ProductionHarness) => void]> = [
    ['configure_provider', 'provider_credential_required', (harness) => void (harness.providerCredential = false)],
    ['establish_transport', 'existing_endpoint_required', (harness) => void (harness.routePublished = false)],
    ['configure_channel', 'chat_configuration_required', (harness) => void (harness.chatConfigured = false)],
  ];

  it.each(blockers)('pauses at %s with %s and continues once the person acts', async (step, code, block) => {
    const harness = await productionHarness();
    block(harness);

    await expect(harness.run()).resolves.toMatchObject({ status: 'paused', pause: { phase: step, code } });
    expect(harness.started.slice(0, ORDER.indexOf(step) + 1)).toEqual(ORDER.slice(0, ORDER.indexOf(step) + 1));

    harness.providerCredential = true;
    harness.routePublished = true;
    harness.chatConfigured = true;
    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: { phase: 'bind_principal', code: 'principal_dm_required' },
    });
  });

  it('resumes after the principal was bound but before the step completed, without binding again', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.crashAfterBinding = true;

    await expect(harness.run()).rejects.toThrow('The process died after binding the principal');
    await expect(harness.run()).resolves.toEqual({ status: 'ready' });
    expect(harness.effects.filter((effect) => effect === 'reconcilePrincipalDm:bound')).toHaveLength(1);
  });

  it('pauses at verify_conversation until a later principal message is answered', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.conversationReady = false;

    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: { phase: 'verify_conversation', code: 'later_principal_message_missing' },
    });

    harness.conversationReady = true;
    await expect(harness.run()).resolves.toEqual({ status: 'ready' });
    expect(harness.effects.filter((effect) => effect === 'reconcilePrincipalDm:bound')).toHaveLength(1);
  });
});
