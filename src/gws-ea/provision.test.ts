import { lstat, mkdir, mkdtemp, readdir, readFile, readlink, rm, utimes, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { NanoclawServiceHelpers } from './service-control.js';
import * as connectorProvisioning from './connector-provisioning.js';

import { PauseRequired, pendingActionOf, SignInRequired, type RunEvent } from './events.js';
import { deriveGcpClaims, deriveGcpProjectId } from './gcp-identity.js';
import { readProvisionJournal, reserveInstance, withInstanceOperation, type InstanceOperation } from './journal.js';
import { CONTROL_PLANE_ROOT, resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
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
import { onePasswordHostPaths, onePasswordInstancePaths } from '../modules/gws-ea-browser/onepassword-policy.js';
import { installOnePassword, ONEPASSWORD_CONTRACT } from './onepassword.js';
import type { AliasStepOptions } from './alias.js';
import { getInstanceReservation } from './registry.js';
import {
  createProductionProvisionSteps,
  fixPrincipalChatAddress,
  installProductionBootstrapManifest,
  loadProductionBootstrapManifest,
  provisionAssistantResources,
  removeProductionBootstrapManifest,
  recordedHost,
  resolveProvisionSource,
  runProductionProvision,
  type ProductionBootstrapManifest,
  type ProductionProvisionContext,
  type ProductionProvisionDependencies,
} from './provision.js';
import type { MainIdentityDependencies } from './identity.js';
import { keepRelease, keptReleaseFiles } from './kept-release.js';
import { createOnecliAdmin } from './onecli-admin.js';
import { createOnecliRuntimeLayout, renderOnecliCompose } from './onecli-compose.js';
import { wrapperImageTag } from './onecli-gateway-image.js';
import { storeGoogleOAuthClient, writeGoogleGrant } from './google-oauth.js';
import { ONECLI_GATEWAY_VERSION, ONECLI_SDK_VERSION } from './pins.js';
import type { OnecliRuntimeReceipt } from './onecli.js';
import { findPortHolder } from './ports.js';
import type { SanitizedCommand } from './process.js';
import { linkReleaseState } from './release-layout.js';
import { stageRelease, type ReleaseStageRequest } from './release-stage.js';
import { startRunLog, type RunLog } from './run-log.js';
import { writeOwnerOnlyFileExclusive } from './secrets.js';
import {
  createInstanceRuntimeConfig,
  googleGrantFile,
  googleOAuthClientFile,
  instanceHostConfiguration,
  instanceServiceDefinitionFile,
  loadInstanceRuntimeConfig,
  persistInstanceRuntime,
  readInstanceHostEnvironment,
  type HostStatusHelpers,
  type UpsertEnvVars,
  type WaitForHostOptions,
} from './service.js';
import { ACCOUNT_ID, FakeOnePassword } from './testing/onepassword-fixture.js';
import { KILLED_INSTALL_LEFTOVER, releaseRepository, stagingWorld } from './testing/release-fixture.js';
import {
  GwsEaError,
  PROVISION_STEPS,
  type AllocatedPorts,
  type InstanceReservation,
  type InstanceReservationInput,
  type ProvisionStepId,
} from './types.js';
import type { ConversationNotReadyReason } from './verify.js';

const roots: string[] = [];

/** Upstream's `.env` writer, which the driver injects; loaded by path because `src/` cannot import `setup/`. */
const { upsertEnvVars } = (await import(path.join(CONTROL_PLANE_ROOT, 'setup', 'set-env.ts'))) as {
  readonly upsertEnvVars: UpsertEnvVars;
};

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-provision-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

const INSTANCE_ID = '11111111-1111-4111-8111-111111111111';
const PROJECT = deriveGcpProjectId(INSTANCE_ID);

function reservation(
  allocatedPorts: AllocatedPorts = { onecli_app: 3201, onecli_gateway: 3301 },
): InstanceReservationInput {
  return {
    instance_id: INSTANCE_ID,
    release_track: 'dogfood',
    source_remote: 'https://example.com/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: allocatedPorts,
    exclusive_resource_claims: {
      ...deriveGcpClaims(INSTANCE_ID),
      gcp_account: 'operator@example.com',
      workspace_email: 'assistant@example.com',
      onecli_project: 'gws_ea_1',
    },
  };
}

function serviceAccount(overrides: Readonly<Record<string, string>> = {}): string {
  const projectId = overrides.project_id ?? PROJECT;
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

/** The Chat subscriber key `provision_gcp` publishes, owner-only in the runtime's secrets. */
async function writeSubscriberKey(
  context: ProductionProvisionContext,
  overrides: Readonly<Record<string, string>> = {},
): Promise<void> {
  const file = context.input.runtime.secret_files.gchat_subscriber_key;
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, serviceAccount(overrides), { mode: 0o600 });
}

function bootstrapManifest(paths: ControlPlanePaths): ProductionBootstrapManifest {
  return {
    schema_version: 2,
    node_path: process.execPath,
    home_directory: path.dirname(paths.stateRoot),
    platform: process.platform === 'darwin' ? 'macos' : 'linux',
    running_as_root: false,
    docker_endpoint: 'unix:///var/run/docker.sock',
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
      assistant_first_name: 'Aya',
      assistant_last_name: null,
      principal_first_name: 'Principal',
      principal_last_name: null,
      principal_timezone: 'America/Los_Angeles',
      principal_emails: ['principal@example.test'],
      principal_chat_email: 'principal@example.test',
    },
  };
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const DM_PAUSE: ProvisionHumanPause = {
  kind: 'human-action',
  phase: 'bind_principal',
  code: 'google_chat_unavailable',
  message:
    'Google Chat did not answer while the assistant opened its direct message with Juno Hale. Resume to try again.',
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

function worldSteps(world: World): ProvisionSteps<World> {
  const step = (id: ProvisionStepId, extra: Partial<ProvisionStep<World>> = {}): ProvisionStep<World> => ({
    label: `Running ${id}…`,
    resources: [worldResource(world, id)],
    ...extra,
  });
  const runtime = (id: ProvisionStepId): ProvisionStep<World> => step(id, { liveness: { label: `Checking ${id}…` } });
  const principalPauseNeeds = ['start_nanoclaw'] as const;
  return {
    materialize_checkout: step('materialize_checkout'),
    provision_gcp: step('provision_gcp'),
    start_onecli: runtime('start_onecli'),
    configure_provider: step('configure_provider'),
    configure_channel: step('configure_channel'),
    sign_in_google: step('sign_in_google'),
    start_nanoclaw: runtime('start_nanoclaw'),
    connect_google: step('connect_google'),
    bind_principal: step('bind_principal', { pauseNeeds: principalPauseNeeds }),
    verify_conversation: step('verify_conversation', { pauseNeeds: principalPauseNeeds }),
  };
}

async function engineFixture() {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation());
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
  let steps = worldSteps(world);
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

/** The steps a terminal shows: those started with a label. */
function labeledSteps(events: readonly RunEvent[]): string[] {
  return events.flatMap((event) => (event.type === 'step-started' && event.label ? [event.step] : []));
}

const FULL_WAIT = OBSERVATION_WAITS_SECONDS.map((seconds) => seconds * 1_000);

/** These provisions stop before the host starts, so NanoClaw's service helpers are never reached. */
const UNUSED_SERVICE_HELPERS: NanoclawServiceHelpers = new Proxy({} as NanoclawServiceHelpers, {
  get: () => {
    throw new Error('The service helpers were reached');
  },
});

describe('step engine', () => {
  it('runs a fresh instance in order, recording when each step started and completed', async () => {
    const engine = await engineFixture();

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });

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

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
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

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
    expect(engine.world.applied).toContain('identity');
    expect(engine.world.applied).not.toContain('host');
  });

  it('waits out an unknown observation and completes without applying', async () => {
    const engine = await engineFixture();
    engine.world.present.add('provision_gcp');
    engine.world.unknownFor.set('provision_gcp', 2);

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
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

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
    expect(engine.world.applied).toContain('provision_gcp');
    expect(engine.sleeps).toEqual([]);
  });

  it('waits for a resource it just created to become visible, then completes', async () => {
    const engine = await engineFixture();
    // Absent before the change, then absent twice more while the change propagates.
    engine.world.startingFor.set('provision_gcp', 3);

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
    expect(engine.sleeps).toEqual([1_000, 2_000]);
    expect(engine.events.filter((event) => event.type === 'step-waiting')).toEqual([
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp…' },
      { type: 'step-waiting', step: 'provision_gcp', reason: 'Waiting for provision_gcp…' },
    ]);
  });

  it('fails the step when a resource it set up stays absent through every wait', async () => {
    const engine = await engineFixture();
    let applies = 0;
    engine.steps = {
      ...engine.steps,
      provision_gcp: {
        ...engine.steps.provision_gcp,
        resources: [
          {
            name: 'the Google Cloud project',
            observe: async () => ABSENT,
            apply: async () => {
              applies += 1;
              return undefined;
            },
          },
        ],
      },
    };

    await expect(engine.run()).rejects.toMatchObject({
      code: 'step_incomplete',
      message: 'the Google Cloud project is still missing after it was set up',
    });

    expect(applies).toBe(1);
    expect(engine.sleeps).toEqual(FULL_WAIT);
    const journal = await engine.journal();
    expect(journal.steps.provision_gcp?.completed_at).toBeUndefined();
    expect(journal.last_error).toMatchObject({ step: 'provision_gcp', code: 'step_incomplete' });
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
    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
    expect(engine.world.applied.filter((name) => name === 'provision_gcp')).toHaveLength(1);
  });

  it('signs in when a step finds the sign-in expired, then retries it without repeating its mutation', async () => {
    const engine = await engineFixture();
    engine.world.signInExpiresAfterApply.add('provision_gcp');
    const run = await startRunLog({ paths: engine.paths, command: 'resume', instanceId: engine.instanceId });

    await expect(engine.run(run)).resolves.toMatchObject({ status: 'ready' });

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

    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });
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
    // A pause after the host has started, so the next run re-checks both runtimes first.
    const signIn: ProvisionHumanPause = { ...DM_PAUSE, phase: 'connect_google', code: 'google_sign_in_required' };
    engine.world.pauseOnApply.set('connect_google', signIn);
    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });

    engine.world.pauseOnApply.clear();
    engine.world.startingFor.set('start_onecli', 2);
    engine.world.observed.length = 0;
    engine.events.length = 0;
    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });

    // A first look at each, logged but not shown; only the runtime still starting gets the shown check.
    expect(engine.events.slice(0, 3)).toEqual([
      { type: 'step-started', step: 'start_onecli' },
      { type: 'step-completed', step: 'start_onecli' },
      { type: 'step-started', step: 'start_onecli', label: 'Checking start_onecli…' },
    ]);
    expect(labeledSteps(engine.events)).not.toContain('start_nanoclaw');
    expect(startedSteps(engine.events).slice(0, 4)).toEqual([
      'start_onecli',
      'start_onecli',
      'start_nanoclaw',
      'connect_google',
    ]);
    expect(engine.world.observed.filter((name) => name === 'start_onecli')).toHaveLength(3);
    expect(engine.world.observed.filter((name) => name === 'start_nanoclaw')).toHaveLength(1);
    expect(engine.world.observed).not.toContain('materialize_checkout');
    expect(engine.world.observed).not.toContain('provision_gcp');
    expect(engine.world.observed).not.toContain('configure_provider');
    expect(engine.sleeps).toEqual([1_000]);
    expect(engine.world.applied.filter((name) => name === 'start_onecli')).toHaveLength(1);
  });

  it('shows no check of a runtime that is running, and shows the check that repairs a stopped one', async () => {
    const engine = await engineFixture();
    engine.world.pauseOnApply.set('connect_google', { ...DM_PAUSE, phase: 'connect_google' });
    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });

    engine.events.length = 0;
    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });
    expect(labeledSteps(engine.events)).toEqual(['connect_google']);

    engine.world.present.delete('start_nanoclaw');
    engine.events.length = 0;
    await expect(engine.run()).resolves.toMatchObject({ status: 'paused' });
    expect(labeledSteps(engine.events)).toEqual(['start_nanoclaw', 'connect_google']);
    expect(engine.world.applied.filter((name) => name === 'start_nanoclaw')).toHaveLength(2);
  });

  it('repairs a stopped runtime locally only after the bounded wait', async () => {
    const engine = await engineFixture();
    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });

    engine.world.present.delete('start_nanoclaw');
    await expect(engine.run()).resolves.toMatchObject({ status: 'ready' });

    expect(engine.sleeps).toEqual(FULL_WAIT);
    expect(engine.world.applied.filter((name) => name === 'start_nanoclaw')).toHaveLength(2);
    expect(engine.world.applied.filter((name) => name === 'configure_provider')).toHaveLength(1);
  });

  it('before the DM pause re-checks only the host', async () => {
    const engine = await engineFixture();
    engine.world.pauseOnApply.set('bind_principal', DM_PAUSE);
    await expect(engine.run()).resolves.toEqual({ status: 'paused', pause: DM_PAUSE });

    engine.world.observed.length = 0;
    await expect(engine.run()).resolves.toEqual({ status: 'paused', pause: DM_PAUSE });

    const afterPause = engine.world.observed.slice(engine.world.observed.lastIndexOf('bind_principal') + 1);
    expect(afterPause).toEqual(['start_nanoclaw']);
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
});

/** The driver injects upstream's `.env` writer; these tests only need the owned keys it receives. */
const recordEnv: UpsertEnvVars = () => undefined;

describe('production bootstrap trust boundary', () => {
  it('ignores caller-authored principal eligibility timestamps and other unknown fields', async () => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    await writeFile(
      file,
      JSON.stringify({
        ...bootstrapManifest(paths),
        provisioning_started_at: '1970-01-01T00:00:00.000Z',
        // A manifest written by a create from before the provider capability digest was retired.
        provider_capability_digest: 'c'.repeat(64),
      }),
      { mode: 0o600 },
    );

    await expect(loadProductionBootstrapManifest(file)).resolves.toEqual(bootstrapManifest(paths));
  });

  it('round-trips native name components without losing compound boundaries', async () => {
    const paths = await testPaths();
    const manifest = bootstrapManifest(paths);
    const input = {
      ...manifest,
      identity: {
        ...manifest.identity,
        assistant_first_name: '  María del Mar  ',
        assistant_last_name: '  de la Cruz  ',
        principal_first_name: '  李 小龍  ',
        principal_last_name: null,
      },
    };
    await installProductionBootstrapManifest(paths, INSTANCE_ID, input);
    const stored = await loadProductionBootstrapManifest(paths.bootstrapFile(INSTANCE_ID));
    expect(stored.identity).toMatchObject({
      assistant_first_name: 'María del Mar',
      assistant_last_name: 'de la Cruz',
      principal_first_name: '李 小龍',
      principal_last_name: null,
    });
    expect(stored.identity).not.toHaveProperty('assistant_display_name');
    expect(stored.identity).not.toHaveProperty('principal_display_name');
  });

  it.each([
    { principal_first_name: 'x'.repeat(81) },
    { assistant_last_name: '<script>' },
    { principal_last_name: undefined },
  ])('rejects invalid or missing native name components: %o', async (names) => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    const manifest = bootstrapManifest(paths);
    await writeFile(file, JSON.stringify({ ...manifest, identity: { ...manifest.identity, ...names } }), {
      mode: 0o600,
    });
    await expect(loadProductionBootstrapManifest(file)).rejects.toMatchObject({ code: 'invalid_bootstrap_manifest' });
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

  it("keeps the principal's addresses lowercased and each once, and refuses a manifest without a valid one", async () => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    const manifest = bootstrapManifest(paths);
    const load = async (principalEmails: unknown) => {
      await writeFile(
        file,
        JSON.stringify({ ...manifest, identity: { ...manifest.identity, principal_emails: principalEmails } }),
        { mode: 0o600 },
      );
      return loadProductionBootstrapManifest(file);
    };

    await expect(
      load(['Principal@Example.test', 'second@example.test', 'principal@example.test']),
    ).resolves.toMatchObject({ identity: { principal_emails: ['principal@example.test', 'second@example.test'] } });
    for (const invalid of [undefined, [], ['not-an-email'], 'principal@example.test']) {
      await expect(load(invalid), JSON.stringify(invalid)).rejects.toMatchObject({
        code: 'invalid_bootstrap_manifest',
        message: expect.stringMatching(/principal email/i),
      });
    }
  });

  it("keeps the principal's Google Chat address only as one of their addresses", async () => {
    const paths = await testPaths();
    const file = path.join(path.dirname(paths.configRoot), 'setup.json');
    const manifest = bootstrapManifest(paths);
    const load = async (principalChatEmail: unknown) => {
      await writeFile(
        file,
        JSON.stringify({
          ...manifest,
          identity: {
            ...manifest.identity,
            principal_emails: ['principal@example.test', 'second@example.test'],
            principal_chat_email: principalChatEmail,
          },
        }),
        { mode: 0o600 },
      );
      return loadProductionBootstrapManifest(file);
    };

    await expect(load('Second@Example.test')).resolves.toMatchObject({
      identity: { principal_chat_email: 'second@example.test' },
    });
    for (const invalid of [undefined, 'colleague@example.test', 'not-an-email', ['principal@example.test']]) {
      await expect(load(invalid), JSON.stringify(invalid)).rejects.toMatchObject({
        code: 'invalid_bootstrap_manifest',
        message: expect.stringMatching(/Chat address/u),
      });
    }
  });

  it("fixes the principal's Chat address in the journal while create's setup file holds it, and reads it from there after", async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const manifest = {
      ...bootstrapManifest(paths),
      identity: {
        ...bootstrapManifest(paths).identity,
        principal_emails: ['principal@example.test', 'second@example.test'],
        principal_chat_email: 'second@example.test',
      },
    };

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const journal = await readProvisionJournal(paths, reserved.instance_id);
      await expect(fixPrincipalChatAddress(operation, journal, undefined)).rejects.toMatchObject({
        code: 'bootstrap_required',
      });
      await expect(fixPrincipalChatAddress(operation, journal, manifest)).resolves.toBe('second@example.test');
      // Main is published and the setup file is gone: the journal still holds it.
      const fixed = await readProvisionJournal(paths, reserved.instance_id);
      expect(fixed.decisions.principal_chat_email).toBe('second@example.test');
      await expect(fixPrincipalChatAddress(operation, fixed, undefined)).resolves.toBe('second@example.test');
    });
  });

  it('stages and removes only the validated bootstrap file before reservation publication', async () => {
    const paths = await testPaths();
    const input = reservation();
    const manifest = bootstrapManifest(paths);

    await installProductionBootstrapManifest(paths, input.instance_id, manifest);
    await expect(readFile(paths.bootstrapFile(input.instance_id), 'utf8')).resolves.toContain('"schema_version": 2');
    await removeProductionBootstrapManifest(paths, input.instance_id);
    await expect(readFile(paths.bootstrapFile(input.instance_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(readFile(paths.instanceRoot(input.instance_id), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  /** A reserved instance whose host started once: runtime and receipt persisted, bootstrap manifest gone. */
  async function startedInstance(
    receiptCohort: Readonly<Record<string, string>>,
    olderReceiptFields: Record<string, unknown> = {},
  ) {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const onecli = createOnecliRuntimeLayout({
      instanceId: reserved.instance_id,
      instanceRoot: paths.instanceRoot(reserved.instance_id),
      project: reserved.exclusive_resource_claims.onecli_project,
      appPort: reserved.allocated_ports.onecli_app,
      gatewayPort: reserved.allocated_ports.onecli_gateway,
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    const runtime = createInstanceRuntimeConfig(paths, reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: path.dirname(paths.stateRoot),
      selectedProvider: 'claude',
      dockerEndpoint: 'unix:///var/run/docker.sock',
    });
    await persistInstanceRuntime(runtime, recordEnv);
    const receipt = paths.releasePreflightFile(reserved.instance_id, reserved.deployed_commit);
    await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
    await writeFile(
      receipt,
      `${JSON.stringify({
        schema_version: 1,
        instance_id: reserved.instance_id,
        deployed_commit: reserved.deployed_commit,
        provider: 'claude',
        providerCredential: {
          name: 'Claude provider',
          type: 'api_key',
          hostPattern: 'api.anthropic.com',
          headerName: 'x-api-key',
        },
        packageManager: 'pnpm@10.0.0',
        onecli: receiptCohort,
        recorded_by: 'a launcher with other fields',
        ...olderReceiptFields,
      })}\n`,
      { mode: 0o600 },
    );
    new Database(path.join(runtime.state_root, 'data', 'v2.db')).close();
    return { paths, reserved };
  }

  it('treats a database created before the profile migration as unpublished', async () => {
    const { paths, reserved } = await startedInstance({ gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION });

    await expect(
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProductionProvision(operation, {
          upsertEnvVars: recordEnv,
          hostStatus: servingHost(),
          serviceHelpers: UNUSED_SERVICE_HELPERS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'bootstrap_required' });
  });

  it('still parses an old receipt carrying the provider capability digest', async () => {
    const { paths, reserved } = await startedInstance(
      { gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION },
      { providerCapabilityDigest: 'c'.repeat(64) },
    );

    // bootstrap_required is raised only after the receipt was accepted.
    await expect(
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProductionProvision(operation, {
          upsertEnvVars: recordEnv,
          hostStatus: servingHost(),
          serviceHelpers: UNUSED_SERVICE_HELPERS,
        }),
      ),
    ).rejects.toMatchObject({ code: 'bootstrap_required' });
  });

  it("reads the principal's name and timezone only from main's published profile, a leftover setup file notwithstanding", async () => {
    const { paths, reserved } = await startedInstance({ gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION });
    const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(reserved.instance_id));
    const manifest = bootstrapManifest(paths);
    const resolve = (leftover: ProductionBootstrapManifest | undefined) =>
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        resolveProvisionSource(operation, reserved, runtime, leftover),
      );

    // Until main is published, create's setup file seeds the profile with the principal.
    await expect(resolve(manifest)).resolves.toMatchObject({
      identity: {
        principal: {
          name: { firstName: 'Principal', lastName: null },
          timezone: 'America/Los_Angeles',
          emails: ['principal@example.test'],
        },
      },
      principalDisplayName: 'Principal',
    });

    // Main is published, and the principal has since changed their name and timezone through it.
    const central = new Database(path.join(runtime.state_root, 'data', 'v2.db'));
    try {
      central.exec(`
        CREATE TABLE gws_ea_profile (
          singleton INTEGER PRIMARY KEY, assistant_first_name TEXT, assistant_last_name TEXT, assistant_workspace_email TEXT,
          principal_first_name TEXT, principal_last_name TEXT, principal_timezone TEXT, main_agent_group_id TEXT, updated_at TEXT
        );
        INSERT INTO gws_ea_profile VALUES
          (1, 'Aya', NULL, 'assistant@example.com', 'Juno', 'Hale', 'Europe/London', 'ag-main', '2026-10-10T09:00:00.000Z');
      `);
    } finally {
      central.close();
    }

    for (const leftover of [manifest, undefined]) {
      const source = await resolve(leftover);
      expect(source?.identity, leftover ? 'with the setup file' : 'without it').toEqual({
        assistantName: { firstName: 'Aya', lastName: null },
        assistantWorkspaceEmail: 'assistant@example.com',
      });
      expect(source?.principalDisplayName).toBe('Juno Hale');
    }

    const changed = new Database(path.join(runtime.state_root, 'data', 'v2.db'));
    changed.prepare('UPDATE gws_ea_profile SET principal_last_name = NULL WHERE singleton = 1').run();
    changed.close();
    // A cleared surname remains absent even while create's old principal seed survives.
    await expect(resolve(manifest)).resolves.toMatchObject({
      principalDisplayName: 'Juno',
      profile: { principal_first_name: 'Juno', principal_last_name: null },
    });

    const leftoverManifest = JSON.stringify(manifest);
    await writeFile(paths.bootstrapFile(reserved.instance_id), leftoverManifest, { mode: 0o600 });
    await expect(recordedHost(paths, reserved)).resolves.toEqual({ dockerEndpoint: runtime.docker_endpoint });
    await expect(readFile(paths.bootstrapFile(reserved.instance_id), 'utf8')).resolves.toBe(leftoverManifest);
    await rm(paths.bootstrapFile(reserved.instance_id));
    await expect(recordedHost(paths, reserved)).resolves.toEqual({ dockerEndpoint: runtime.docker_endpoint });
  });

  it('resumes past a release receipt whose OneCLI cohort differs from this launcher’s pins', async () => {
    // An earlier release's receipt also records the OneCLI CLI it pinned, which nothing reads any more.
    const { paths, reserved } = await startedInstance({ gateway: '1.41.0', cli: '2.2.4', sdk: '2.2.0' });

    // bootstrap_required is raised only after the receipt was accepted.
    await expect(
      withInstanceOperation(paths, reserved.instance_id, (operation) =>
        runProductionProvision(operation, {
          upsertEnvVars: recordEnv,
          hostStatus: servingHost(),
          serviceHelpers: UNUSED_SERVICE_HELPERS,
        }),
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
    dockerEndpoint: 'unix:///var/run/docker.sock',
  });
  const runtime = createInstanceRuntimeConfig(operation.paths, reserved, onecli, {
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
        provider: 'claude',
        providerCredential: {
          name: 'Claude provider',
          type: 'api_key',
          hostPattern: 'api.anthropic.com',
          headerName: 'x-api-key',
        },
      },
      onecli,
      runtime,
      gcp: {
        instanceId: reserved.instance_id,
        projectId: reserved.exclusive_resource_claims.gcp_project_id,
        account: reserved.exclusive_resource_claims.gcp_account,
        serviceAccountEmail: reserved.exclusive_resource_claims.gchat_subscriber_account,
        credentialFile: runtime.secret_files.gchat_subscriber_key,
        cwd: runtime.instance_root,
      },
      providerCredentialMetadata: {
        name: 'Claude provider',
        type: 'api_key',
        hostPattern: 'api.anthropic.com',
        headerName: 'x-api-key',
      },
      requestProviderCredential: async () => ({
        name: 'Claude provider',
        type: 'api_key',
        value: 'test-secret-never-persisted',
        hostPattern: 'api.anthropic.com',
        headerName: 'x-api-key',
      }),
      identity: {
        assistantName: { firstName: 'Aya', lastName: null },
        assistantWorkspaceEmail: reserved.exclusive_resource_claims.workspace_email,
        principal: {
          name: { firstName: 'Principal', lastName: null },
          timezone: 'America/Los_Angeles',
          emails: ['principal@example.test'],
        },
      },
      principalDisplayName: 'Principal',
      principalChatEmail: 'principal@example.test',
      adapterInstance: 'gchat',
      provisioningStartedAt: '2026-09-18T18:00:00.000Z',
      chatConfigured: false,
      serviceDependencies: {
        upsertEnvVars: recordEnv,
        platform: 'macos',
        homeDirectory: path.dirname(operation.paths.stateRoot),
        runningAsRoot: false,
      },
      hostStatus: servingHost(),
      google: {
        runtime,
        assistantWorkspaceEmail: reserved.exclusive_resource_claims.workspace_email,
        signIn: async () => {
          throw new Error('unexpected Google sign-in');
        },
        resumeCommand: `gws-ea resume --id ${reserved.instance_id}`,
      },
    },
  };
}

/** What upstream `queryHost` returns for this checkout's running host. */
function hostStatusOf(overrides: Readonly<Record<string, unknown>> = {}) {
  return {
    pid: 4242,
    started_at: '2026-09-25T12:00:00.000Z',
    instance_id: 'host-instance-1',
    // Chat's events are pulled, so the host listens on no webhook.
    webhook: null,
    channels: [{ instance: 'gchat', type: 'gchat', connected: true }],
    ...overrides,
  };
}

/** Upstream's host-status helpers for a host that is up and connected. */
function servingHost(): HostStatusHelpers {
  return { queryHost: async () => hostStatusOf(), waitForHost: async () => hostStatusOf() };
}

/** Write the release receipt create's preflight records, with the OneCLI cohort the release pinned. */
async function writeReleaseReceipt(
  paths: ControlPlanePaths,
  reserved: InstanceReservation,
  onecli: { gateway: string; sdk: string },
): Promise<void> {
  const receipt = paths.releasePreflightFile(reserved.instance_id, reserved.deployed_commit);
  await mkdir(path.dirname(receipt), { recursive: true, mode: 0o700 });
  await writeFile(
    receipt,
    `${JSON.stringify({
      schema_version: 1,
      instance_id: reserved.instance_id,
      deployed_commit: reserved.deployed_commit,
      provider: 'claude',
      providerCredential: {
        name: 'Claude provider',
        type: 'api_key',
        hostPattern: 'api.anthropic.com',
        headerName: 'x-api-key',
      },
      packageManager: 'pnpm@10.0.0',
      onecli,
    })}\n`,
    { mode: 0o600 },
  );
}

interface ProbeIdentityState {
  /** The agents OneCLI lists; one without a secret mode is as a OneCLI from 1.43 on lists it. */
  agents: Array<{ id: string; identifier: string; name: string; secretMode?: 'all' | 'selective' }>;
  /** Every OneCLI request, as `<method> <path>`. */
  readonly onecliCalls: string[];
  /** The principal as the profile holds them; as create declared them by default. */
  principal?: { readonly name: string; readonly timezone: string };
  /** Main's container timezone; the profile's by default. */
  mainTimezone?: string | null;
}

function probeIdentityDependencies(
  context: ProductionProvisionContext,
  state: ProbeIdentityState,
): MainIdentityDependencies {
  return {
    runNcl: async (_runtime, args) => {
      const principal = state.principal ?? { name: 'Principal', timezone: 'America/Los_Angeles' };
      if (args[0] === 'gws-ea-profile' && args[1] === 'get') {
        return {
          assistant_first_name: context.input.identity.assistantName.firstName,
          assistant_last_name: context.input.identity.assistantName.lastName,
          assistant_workspace_email: context.input.identity.assistantWorkspaceEmail,
          principal_display_name: principal.name,
          principal_timezone: principal.timezone,
          main_agent_group_id: 'ag-main',
        };
      }
      if (args[0] === 'groups' && args[1] === 'get') return { id: 'ag-main', name: 'main' };
      if (args[0] === 'groups' && args[1] === 'config' && args[2] === 'get') {
        return {
          provider: context.input.runtime.selected_provider,
          timezone: state.mainTimezone === undefined ? principal.timezone : state.mainTimezone,
        };
      }
      throw new Error(`Unexpected ncl probe call: ${args.join(' ')}`);
    },
    onecliAdmin: async (runtime) =>
      createOnecliAdmin(runtime.onecli_app_url, `oc_${'a'.repeat(64)}`, {
        fetch: async (input, init) => {
          const url = new URL(String(input));
          const call = `${init?.method ?? 'GET'} ${url.pathname}`;
          state.onecliCalls.push(call);
          if (call === 'GET /v1/agents') return new Response(JSON.stringify(state.agents));
          throw new Error(`Unexpected OneCLI probe call: ${call}`);
        },
      }),
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

/** The wrapper gateway an earlier release built from its own firewall files, not this tool's tree. */
const RELEASE_WRAPPER_HASH = '0123456789abcdef';
const RELEASE_GATEWAY_IMAGE = wrapperImageTag(RELEASE_WRAPPER_HASH);

/** The instance's own OneCLI Compose file, as its release rendered it. */
async function writeReleaseCompose(context: ProductionProvisionContext): Promise<void> {
  const layout = context.input.onecli;
  await mkdir(layout.rootDirectory, { recursive: true, mode: 0o700 });
  await writeFile(
    layout.composeFile,
    renderOnecliCompose(layout, { gateway: ONECLI_GATEWAY_VERSION }, RELEASE_GATEWAY_IMAGE),
    { mode: 0o600 },
  );
}

/** A Docker CLI that reports this instance's three OneCLI services running healthy as its release created them. */
function healthyOnecliDocker(context: ProductionProvisionContext) {
  const layout = context.input.onecli;
  const labels = (role: string) => ({ 'dev.gws-ea.instance-id': layout.instanceId, 'dev.gws-ea.onecli-role': role });
  return async (command: { readonly args: readonly string[] }) => {
    const [kind, verb] = command.args;
    const reply = (value: unknown) => ({ stdout: JSON.stringify(value), stderr: '' });
    if (kind === 'container' && verb === 'ls') return { stdout: 'id-postgres\nid-app\nid-gateway\n', stderr: '' };
    if (kind === 'container' && verb === 'inspect') {
      return reply(
        (['postgres', 'app', 'gateway'] as const).map((service) => ({
          Id: `id-${service}`,
          Config: {
            Image:
              service === 'postgres'
                ? 'postgres:18-alpine'
                : service === 'gateway'
                  ? RELEASE_GATEWAY_IMAGE
                  : `ghcr.io/onecli/onecli:${ONECLI_GATEWAY_VERSION}`,
            Labels: {
              'com.docker.compose.project': layout.project,
              'com.docker.compose.service': service,
              'com.docker.compose.config-hash': `hash-${service}`,
              'dev.gws-ea.instance-id': layout.instanceId,
            },
          },
          State: { Running: true, Health: { Status: 'healthy' } },
          NetworkSettings: {
            Ports:
              service === 'postgres'
                ? {}
                : {
                    [service === 'app' ? '10254/tcp' : '10255/tcp']: [
                      {
                        HostIp: '127.0.0.1',
                        HostPort: String(service === 'app' ? layout.appPort : layout.gatewayPort),
                      },
                    ],
                  },
            Networks: Object.fromEntries(
              (service === 'gateway'
                ? [layout.backendNetwork, layout.agentEgressNetwork]
                : [layout.backendNetwork]
              ).map((network) => [network, {}]),
            ),
          },
          Mounts: [
            service === 'postgres'
              ? { Type: 'volume', Name: layout.postgresVolume, Destination: '/var/lib/postgresql' }
              : { Type: 'volume', Name: layout.appVolume, Destination: '/app/data' },
          ],
        })),
      );
    }
    if (kind === 'network') {
      return reply([
        { Name: layout.backendNetwork, Internal: false, Labels: labels('backend') },
        { Name: layout.agentEgressNetwork, Internal: true, Labels: labels('agent-egress') },
      ]);
    }
    if (kind === 'volume') {
      return reply([
        { Name: layout.postgresVolume, Labels: labels('postgres-data') },
        { Name: layout.appVolume, Labels: labels('app-data') },
      ]);
    }
    // The provenance label the release's gateway build stamped.
    if (kind === 'image' && verb === 'inspect') return { stdout: `${RELEASE_WRAPPER_HASH}\n`, stderr: '' };
    // `config --hash`: each service's configuration is the one its container was created from.
    if (kind === 'compose')
      return { stdout: 'app hash-app\ngateway hash-gateway\npostgres hash-postgres\n', stderr: '' };
    throw new Error(`unexpected docker command: ${command.args.join(' ')}`);
  };
}

describe('production provision step composition', () => {
  it('re-checks only runtime steps once complete', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const steps = createProductionProvisionSteps(productionContext(operation, reserved));
      expect(PROVISION_STEPS.filter((id) => steps[id].liveness)).toEqual(['start_onecli', 'start_nanoclaw']);
      // Chat's events are pulled by the host, so the principal's pauses need only the host.
      expect(steps.bind_principal.pauseNeeds).toEqual(['start_nanoclaw']);
      expect(steps.verify_conversation.pauseNeeds).toEqual(['start_nanoclaw']);
      expect(steps.configure_channel.pauseNeeds).toBeUndefined();
    });
  });

  it('forwards Google Cloud waits through the provision runtime', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
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

  it('observes Google Cloud as its own resources, restoring a relaxed member-domain policy after the publisher grant and a lifted key policy only after the key', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const resources = createProductionProvisionSteps(productionContext(operation, reserved)).provision_gcp.resources;

      expect(resources.map((resource) => [resource.name, resource.unknown ?? 'wait'])).toEqual([
        ['the Google Cloud project', 'create-by-unique-id'],
        ['the billing account link', 'wait'],
        ['the Google Cloud APIs', 'wait'],
        ['the Google Chat events topic', 'wait'],
        ['the Google Chat events subscription', 'wait'],
        ['the publisher grant on the topic', 'wait'],
        ['the member-domain policy', 'wait'],
        ['the Chat subscriber account', 'wait'],
        ["the subscriber's grant on the subscription", 'wait'],
        ['the Chat subscriber key', 'wait'],
        ['the key-creation policy', 'wait'],
      ]);
    });
  });

  it('accepts only an all-mode canonical main without enumerating its grants', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const state: ProbeIdentityState = {
        agents: [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' }],
        onecliCalls: [],
      };
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, identityDependencies: probeIdentityDependencies(base, state) },
      };
      const phase = createProductionProvisionSteps(context).start_nanoclaw.resources[1]!;

      await expect(phase.observe(context)).resolves.toEqual(PRESENT);
      expect(state.onecliCalls).toEqual(['GET /v1/agents']);

      // A OneCLI that no longer lists secret modes leaves main on its default, all.
      state.agents = [{ id: 'oc-main', identifier: 'ag-main', name: 'main' }];
      await expect(phase.observe(context)).resolves.toEqual(PRESENT);

      state.agents = [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'selective' }];
      state.onecliCalls.length = 0;
      await expect(phase.observe(context)).resolves.toEqual(ABSENT);
      expect(state.onecliCalls).toEqual(['GET /v1/agents']);
    });
  });

  it("observes main's identity from the profile alone: the principal's own changes stand, and main runs in the profile's timezone", async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      // The principal changed their name and timezone through main after create.
      const state: ProbeIdentityState = {
        agents: [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' }],
        onecliCalls: [],
        principal: { name: 'Juno Hale', timezone: 'Europe/London' },
      };
      const { principal: _seed, ...published } = base.input.identity;
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, identity: published, identityDependencies: probeIdentityDependencies(base, state) },
      };
      const phase = createProductionProvisionSteps(context).start_nanoclaw.resources[1]!;

      await expect(phase.observe(context)).resolves.toEqual(PRESENT);

      // Main's container drifted from the profile's timezone, so the identity is repaired.
      for (const drifted of ['America/Los_Angeles', null]) {
        state.mainTimezone = drifted;
        await expect(phase.observe(context), String(drifted)).resolves.toEqual(ABSENT);
      }
    });
  });

  it('repairs a completed OneCLI runtime whose container stopped at once, and refuses unsafe drift', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    await writeReleaseReceipt(paths, reserved, { gateway: ONECLI_GATEWAY_VERSION, sdk: '2.2.1' });

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      let stopped = false;
      let unsafe = false;
      const receipt = Object.freeze({}) as OnecliRuntimeReceipt;
      const reconcileOnecliRuntime = vi.fn(async () => {
        stopped = false;
        return receipt;
      });
      const persistOnecliApiKeyFiles = vi.fn(async () => undefined);
      const observeOnecli = vi.fn(async () => {
        if (unsafe) throw new GwsEaError('unsafe_onecli_owner', 'Foreign OneCLI resource');
        return stopped ? { status: 'absent' as const, reason: 'its gateway container is stopped' } : PRESENT;
      });
      const step = createProductionProvisionSteps(context, {
        observeOnecli,
        reconcileOnecliRuntime,
        persistOnecliApiKeyFiles,
      }).start_onecli;
      const sleeps: number[] = [];
      const runtime = { sleep: async (milliseconds: number) => void sleeps.push(milliseconds) };
      await expect(runAlone(operation, context, 'start_onecli', step, runtime)).resolves.toMatchObject({
        status: 'ready',
      });
      expect(reconcileOnecliRuntime).not.toHaveBeenCalled();

      stopped = true;
      await expect(runAlone(operation, context, 'start_onecli', step, runtime)).resolves.toMatchObject({
        status: 'ready',
      });
      expect(step.resources[0]!.absentMeansStopped).toBe(true);
      expect(sleeps).toEqual([]);
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

  it('runs and checks OneCLI at the pins its release recorded, not this launcher’s', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const recorded = { gateway: '1.41.3', sdk: '2.2.0' };
    await writeReleaseReceipt(paths, reserved, recorded);
    const receipt = Object.freeze({}) as OnecliRuntimeReceipt;

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const reconcileOnecliRuntime = vi.fn(async () => receipt);
      const verifyOnecliRuntime = vi.fn(async () => receipt);
      const registry = createProductionProvisionSteps(context, {
        reconcileOnecliRuntime,
        verifyOnecliRuntime,
        persistOnecliApiKeyFiles: vi.fn(async () => undefined),
        importProviderCredential: vi.fn(async () => ({ id: 'secret-provider', created: true })),
      });

      await registry.start_onecli.resources[0]!.apply(context);
      context.state.onecliReceipt = undefined;
      await registry.configure_provider.resources[0]!.apply(context);

      const pins = { gateway: recorded.gateway };
      expect(recorded.gateway).not.toBe(ONECLI_GATEWAY_VERSION);
      expect(reconcileOnecliRuntime).toHaveBeenCalledWith(context.input.onecli, pins, undefined);
      // A resumed provider step checks the running vault instead of starting it again.
      expect(verifyOnecliRuntime).toHaveBeenCalledWith(context.input.onecli, pins, undefined);
      expect(reconcileOnecliRuntime).toHaveBeenCalledOnce();
    });
  });

  it('adopts a healthy OneCLI runtime its release created, interrupted before its API keys were persisted', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    await writeReleaseReceipt(paths, reserved, { gateway: ONECLI_GATEWAY_VERSION, sdk: '2.2.1' });

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, onecliDependencies: { dockerCommandRunner: healthyOnecliDocker(base) } },
      };
      // Its gateway is not the one this tool's tree builds; the instance's own record says which it runs.
      await writeReleaseCompose(context);
      const reconcileOnecliRuntime = vi.fn(async () => Object.freeze({}) as OnecliRuntimeReceipt);
      const step = createProductionProvisionSteps(context, {
        reconcileOnecliRuntime,
        persistOnecliApiKeyFiles: vi.fn(async () => {
          await mkdir(path.dirname(context.input.runtime.secret_files.onecli_admin_api_key), { recursive: true });
          await writeOwnerOnlyFileExclusive(context.input.runtime.secret_files.onecli_runtime_api_key, 'oc_key');
          await writeOwnerOnlyFileExclusive(context.input.runtime.secret_files.onecli_admin_api_key, 'oc_key');
        }),
      }).start_onecli;

      await expect(step.resources[0]!.observe(context)).resolves.toMatchObject({
        status: 'absent',
        reason: expect.stringContaining('API key'),
      });
      await expect(runAlone(operation, context, 'start_onecli', step)).resolves.toMatchObject({ status: 'ready' });
      expect(reconcileOnecliRuntime).toHaveBeenCalledOnce();
      await expect(step.resources[0]!.observe(context)).resolves.toEqual(PRESENT);
    });
  });

  it('asks for the provider credential and imports it with the OneCLI receipt the run already holds', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    await writeReleaseReceipt(paths, reserved, { gateway: ONECLI_GATEWAY_VERSION, sdk: '2.2.1' });
    const collected = {
      name: 'Claude provider',
      type: 'api_key',
      value: 'prompted-secret',
      hostPattern: 'api.anthropic.com',
      headerName: 'x-api-key',
    };
    const requestProviderCredential = vi.fn(async () => collected);
    const receipt = Object.freeze({}) as OnecliRuntimeReceipt;
    const verifyOnecliRuntime = vi.fn(async () => receipt);
    const importProviderCredential = vi.fn(async () => ({ id: 'secret-provider', created: true }));

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = { ...base, input: { ...base.input, requestProviderCredential } };
      const registry = createProductionProvisionSteps(context, {
        reconcileOnecliRuntime: vi.fn(async () => receipt),
        verifyOnecliRuntime,
        persistOnecliApiKeyFiles: vi.fn(async () => undefined),
        importProviderCredential,
      });

      await registry.start_onecli.resources[0]!.apply(context);
      await registry.configure_provider.resources[0]!.apply(context);
      expect(context.state.providerSecretId).toBe('secret-provider');
    });

    expect(requestProviderCredential).toHaveBeenCalledOnce();
    expect(verifyOnecliRuntime).not.toHaveBeenCalled();
    expect(importProviderCredential).toHaveBeenCalledWith(receipt, collected, undefined);
  });

  it('rejects a credential that does not match the selected provider definition', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const importProviderCredential = vi.fn();

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
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

  it('asks for the Chat API configuration and the sign-in client in one console visit while the client is still needed', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const project = reserved.exclusive_resource_claims.gcp_project_id;
    const account = reserved.exclusive_resource_claims.gcp_account;

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      const phase = createProductionProvisionSteps(context).configure_channel.resources[0]!;

      // The Chat link first; each link alone on its line, then one field to a line.
      await expect(phase.observe(context)).resolves.toEqual({
        status: 'pause',
        pause: {
          kind: 'human-action',
          phase: 'configure_channel',
          code: 'chat_configuration_required',
          message:
            "Do two things in this assistant's Google Cloud project, then confirm the first and give the second's file.",
          details: [
            '1. Configure the Google Chat API:',
            `   https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${project}`,
            '   App name: Aya',
            '   Avatar URL: a public HTTPS image of the assistant',
            '   Description: a short line, such as "Executive assistant to Principal"',
            '   Interactive features: off, since the assistant talks in Chat as its own account, not as a Chat app',
            '   Save',
            "2. Create the assistant's Google sign-in client:",
            `   https://console.cloud.google.com/auth/overview?project=${project}`,
            '   Get started:',
            '     App name: Aya',
            `     User support email: ${account}`,
            '     Audience: Internal',
            `     Contact email: ${account}`,
            '     Agree to the Google API Services: User Data Policy, then Create',
            '   Clients, then Create client:',
            '     Application type: Desktop app',
            '     Name: leave the default',
            '     Create, then Download JSON',
          ],
          resumeFlag: '--chat-configured --google-client-file <file>',
        },
      });
    });
  });

  /** The ways the assistant's sign-in can already have its client, so the Chat pause need not ask for it. */
  const SIGN_IN_CLIENT_READY: ReadonlyArray<
    readonly [string, (context: ProductionProvisionContext) => Promise<ProductionProvisionContext>]
  > = [
    [
      'is given on this run',
      async (context) => ({
        ...context,
        input: { ...context.input, google: { ...context.input.google, clientFile: '/downloads/client.json' } },
      }),
    ],
    [
      'was kept from an earlier run',
      async (context) => {
        await storeGoogleOAuthClient(googleOAuthClientFile(context.input.runtime), {
          client_id: '123-abc.apps.googleusercontent.com',
          client_secret: 'GOCSPX-desktop-secret',
        });
        return context;
      },
    ],
    [
      'already signed the assistant in',
      async (context) => {
        await writeGoogleGrant(googleGrantFile(context.input.runtime), {
          schema_version: 3,
          account: context.input.google.assistantWorkspaceEmail,
          sub: '104857395723948572901',
          client_id: '123-abc.apps.googleusercontent.com',
          client_secret: 'GOCSPX-desktop-secret',
          consents: [{ refresh_token: '1//refresh-token', scopes: ['openid'] }],
          granted_at: '2026-10-12T00:00:00.000Z',
        });
        return context;
      },
    ],
  ];

  it.each(SIGN_IN_CLIENT_READY)(
    "pauses for the Chat API configuration alone once the sign-in's client %s: the assistant's name, avatar, and description, with interactive features off",
    async (_label, ready) => {
      const paths = await testPaths();
      const reserved = await reserveInstance(paths, reservation());

      await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        const context = await ready(productionContext(operation, reserved));
        const phase = createProductionProvisionSteps(context).configure_channel.resources[0]!;

        const observed = await phase.observe(context);
        expect(observed).toEqual({
          status: 'pause',
          pause: {
            kind: 'human-action',
            phase: 'configure_channel',
            code: 'chat_configuration_required',
            message: "Configure the Google Chat API for this assistant's project, then confirm it.",
            details: [
              `https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat?project=${reserved.exclusive_resource_claims.gcp_project_id}`,
              'App name: Aya',
              'Avatar URL: a public HTTPS image of the assistant',
              'Description: a short line, such as "Executive assistant to Principal"',
              'Interactive features: off, since the assistant talks in Chat as its own account, not as a Chat app',
              'Save',
            ],
            resumeFlag: '--chat-configured',
          },
        });
        // No endpoint, callback, or add-on: Chat's events are pulled.
        const shown = JSON.stringify(observed);
        expect(shown).not.toMatch(/endpoint|webhook|https:\/\/assistant|add-on|visibility/iu);
        await expect(phase.apply(context)).resolves.toMatchObject({ code: 'chat_configuration_required' });
      });
    },
  );

  it("takes the operator's confirmation as the Chat configuration", async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = { ...base, input: { ...base.input, chatConfigured: true } };
      const phase = createProductionProvisionSteps(context).configure_channel.resources[0]!;

      await expect(phase.observe(context)).resolves.toEqual(PRESENT);
    });
  });

  it.each([
    ['project', { project_id: 'different-project' }],
    ['identity', { client_email: `other@${PROJECT}.iam.gserviceaccount.com` }],
  ] as const)('rejects a service-account %s swap before starting NanoClaw', async (_label, credentialOverride) => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const startRuntime = vi.fn(async (): Promise<never> => {
      throw new Error('NanoClaw must not start');
    });

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const context = productionContext(operation, reserved);
      await writeSubscriberKey(context, credentialOverride);
      const definitions = createProductionProvisionSteps(context, { reconcileInstanceRuntime: startRuntime });

      const host = definitions.start_nanoclaw.resources[0]!;
      expect(host.name).toBe('the NanoClaw host');
      await expect(host.apply(context)).rejects.toMatchObject({
        code: 'gchat_credential_mismatch',
      });
    });

    expect(startRuntime).not.toHaveBeenCalled();
  });

  it('continues main identity setup when this checkout’s host already serves, without restarting it', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const queryHost = vi.fn(async () => hostStatusOf());
      const waitForHost = vi.fn();
      const context: ProductionProvisionContext = {
        ...base,
        input: { ...base.input, hostStatus: { queryHost, waitForHost } },
      };
      const reconcileInstanceRuntime = vi.fn(async (): Promise<never> => {
        throw new Error('An already-running host must not be restarted');
      });
      let identified = false;
      const reconcileMainIdentity = vi.fn(async () => {
        identified = true;
        return { agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' };
      });
      const step = createProductionProvisionSteps(context, {
        reconcileInstanceRuntime,
        reconcileMainIdentity,
        observeMainIdentity: async () => (identified ? PRESENT : ABSENT),
      }).start_nanoclaw;

      await expect(runAlone(operation, context, 'start_nanoclaw', step)).resolves.toMatchObject({ status: 'ready' });
      expect(queryHost).toHaveBeenCalledWith(paths.checkoutRoot(reserved.instance_id));
      expect(waitForHost).not.toHaveBeenCalled();
      expect(reconcileInstanceRuntime).not.toHaveBeenCalled();
      expect(reconcileMainIdentity).toHaveBeenCalledOnce();
      expect(context.state.mainAgentGroupId).toBe('ag-main');
    });
  });

  it('waits with a reason while a started host has not opened its socket', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    const events: RunEvent[] = [];
    let socketOpen = false;

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const socketClosed = () =>
        new Error(`connect ENOENT ${path.join(base.input.runtime.state_root, 'data/ncl.sock')}`);
      const waitForHost = vi.fn(async (_root: string, _options?: WaitForHostOptions) => {
        socketOpen = true;
        return hostStatusOf();
      });
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          hostStatus: {
            queryHost: async () => {
              if (!socketOpen) throw socketClosed();
              return hostStatusOf();
            },
            waitForHost,
          },
        },
      };
      await writeSubscriberKey(context);
      const reconcileInstanceRuntime = vi.fn(async () => ({ pid: 4242 }) as never);
      const step = createProductionProvisionSteps(
        context,
        {
          reconcileInstanceRuntime,
          instanceServicePid: async () => undefined,
          reconcileMainIdentity: vi.fn(async () => ({ agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' })),
          observeMainIdentity: async () => (socketOpen ? PRESENT : ABSENT),
        },
        { emit: (event) => void events.push(event) },
      ).start_nanoclaw;

      await expect(
        runAlone(operation, context, 'start_nanoclaw', step, { emit: (event) => void events.push(event) }),
      ).resolves.toMatchObject({ status: 'ready' });
      expect(reconcileInstanceRuntime).toHaveBeenCalledOnce();
      expect(waitForHost).toHaveBeenCalledWith(paths.checkoutRoot(reserved.instance_id), {
        channel: 'gchat',
        pid: 4242,
        alive: expect.any(Function),
        timeoutMs: expect.any(Number),
      });
      expect(events).toContainEqual({
        type: 'step-waiting',
        step: 'start_nanoclaw',
        reason: 'Waiting for the assistant to connect Google Chat…',
      });
    });
  });

  it('stops with the host’s reason and its error log at the instance path when it does not become ready', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          hostStatus: {
            queryHost: async () => hostStatusOf(),
            waitForHost: async () => {
              throw new Error('Channel gchat is not connected in the running host. Check logs/nanoclaw.error.log.');
            },
          },
        },
      };
      await writeSubscriberKey(context);
      const host = createProductionProvisionSteps(context, {
        reconcileInstanceRuntime: vi.fn(async () => ({ pid: 4242 }) as never),
      }).start_nanoclaw.resources[0]!;

      await expect(host.apply(context)).rejects.toMatchObject({
        code: 'nanoclaw_not_ready',
        message: `Channel gchat is not connected in the running host. Check ${path.join(paths.instanceRoot(reserved.instance_id), 'logs', 'nanoclaw.error.log')}.`,
      });
    });
  });

  it('waits on a starting host, and restarts a stopped one at once without restamping its matching main identity', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());
    let host: 'serving' | 'stopped' | number = 'serving';

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const identityState: ProbeIdentityState = {
        agents: [{ id: 'oc-main', identifier: 'ag-main', name: 'main', secretMode: 'all' }],
        onecliCalls: [],
      };
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          identityDependencies: probeIdentityDependencies(base, identityState),
          hostStatus: {
            queryHost: async () => {
              if (typeof host === 'number') throw new Error('connect ENOENT data/ncl.sock');
              if (host === 'stopped') throw new Error('connect ECONNREFUSED data/ncl.sock');
              return hostStatusOf();
            },
            waitForHost: async () => hostStatusOf(),
          },
        },
      };
      await writeSubscriberKey(context);
      const reconcileInstanceRuntime = vi.fn(async () => {
        host = 'serving';
        return { pid: 4242 } as never;
      });
      const reconcileMainIdentity = vi.fn();
      const events: RunEvent[] = [];
      const step = createProductionProvisionSteps(context, {
        reconcileInstanceRuntime,
        reconcileMainIdentity,
        // The service runs a process while the host starts; its socket opens after `host` more looks.
        instanceServicePid: async () => {
          if (typeof host !== 'number') return undefined;
          host = host > 1 ? host - 1 : 'serving';
          return 4242;
        },
      }).start_nanoclaw;
      const sleeps: number[] = [];
      const runtime = {
        sleep: async (milliseconds: number) => void sleeps.push(milliseconds),
        emit: (event: RunEvent) => void events.push(event),
      };
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toMatchObject({
        status: 'ready',
      });

      host = 2;
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toMatchObject({
        status: 'ready',
      });
      // The first look, logged but not shown, finds the host starting; the shown check waits for it.
      expect(sleeps).toEqual([1_000]);
      expect(events).toContainEqual({
        type: 'step-started',
        step: 'start_nanoclaw',
        label: 'Checking the assistant…',
      });
      expect(events).toContainEqual({
        type: 'step-waiting',
        step: 'start_nanoclaw',
        reason: 'The assistant is starting (pid 4242)',
      });
      expect(reconcileInstanceRuntime).not.toHaveBeenCalled();

      sleeps.length = 0;
      host = 'stopped';
      await expect(runAlone(operation, context, 'start_nanoclaw', step, runtime)).resolves.toMatchObject({
        status: 'ready',
      });
      expect(step.resources[0]!.absentMeansStopped).toBe(true);
      expect(sleeps).toEqual([]);
      expect(reconcileInstanceRuntime).toHaveBeenCalledOnce();
      expect(reconcileMainIdentity).not.toHaveBeenCalled();
      expect(context.state.mainAgentGroupId).toBe('ag-main');
    });
  });

  it('waits on a host whose Google Chat channel has not connected yet', async () => {
    const paths = await testPaths();
    const reserved = await reserveInstance(paths, reservation());

    await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
      const base = productionContext(operation, reserved);
      const context: ProductionProvisionContext = {
        ...base,
        input: {
          ...base.input,
          hostStatus: {
            queryHost: async () => hostStatusOf({ channels: [{ instance: 'gchat', type: 'gchat', connected: false }] }),
            waitForHost: vi.fn(),
          },
        },
      };
      const host = createProductionProvisionSteps(context).start_nanoclaw.resources[0]!;

      await expect(host.observe(context)).resolves.toMatchObject({
        status: 'unknown',
        reason: 'Channel gchat is not connected in the running host',
        evidence: expect.stringContaining(
          path.join(paths.instanceRoot(reserved.instance_id), 'logs', 'nanoclaw.error.log'),
        ),
      });
    });
  });
});

describe('create on the release layout', () => {
  /** A reserved assistant whose release is a real repository; staging's install, build, and Docker are faked. */
  async function releaseCreate() {
    const paths = await testPaths();
    const repository = await releaseRepository(path.dirname(paths.stateRoot));
    const reserved = await reserveInstance(paths, {
      ...reservation(),
      source_remote: repository.remote,
      deployed_commit: repository.commit,
    });
    const staging = stagingWorld();
    const serviceCommands: SanitizedCommand[] = [];
    const contextOf = (operation: InstanceOperation): ProductionProvisionContext => {
      const base = productionContext(operation, reserved);
      return {
        ...base,
        input: {
          ...base.input,
          serviceDependencies: {
            ...base.input.serviceDependencies,
            upsertEnvVars,
            restartService: async () => undefined,
            runCommand: async (command) => {
              serviceCommands.push(command);
              return { stdout: '', stderr: '' };
            },
            uid: 501,
          },
          // Create's OneCLI step renders its Compose file first; the Docker it then reaches is not needed here.
          onecliDependencies: {
            dockerCommandRunner: async () => {
              throw new Error('Docker is not reached');
            },
          },
        },
      };
    };
    /** Run `use` with create's production steps, staging through the fixture. */
    const withSteps = async <T>(
      use: (
        steps: ProvisionSteps<ProductionProvisionContext>,
        context: ProductionProvisionContext,
        operation: InstanceOperation,
      ) => Promise<T>,
    ): Promise<T> => {
      const result = await withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        const context = contextOf(operation);
        const steps = createProductionProvisionSteps(context, {
          stageRelease: (request) => stageRelease(request, staging.seams),
        });
        return { value: await use(steps, context, operation) };
      });
      if (!result) throw new Error('The instance operation was busy');
      return result.value;
    };
    return {
      paths,
      reserved,
      layout: paths.instanceLayout(reserved.instance_id),
      release: repository.commit.slice(0, 8),
      staging: staging.world,
      serviceCommands,
      withSteps,
      runReleaseStep: () =>
        withSteps((steps, context, operation) =>
          runAlone(operation, context, 'materialize_checkout', steps.materialize_checkout),
        ),
    };
  }

  /** The release layout create leaves, as its directories hold it. */
  async function expectReleaseLayout(create: Awaited<ReturnType<typeof releaseCreate>>): Promise<void> {
    const { layout, release, reserved } = create;
    expect(await readlink(layout.current)).toBe(release);
    expect((await readdir(layout.root)).sort()).toEqual(
      ['.release-home', 'kept', 'logs', 'nanoclaw', 'provision.json', release, 'state'].sort(),
    );
    // The release holds no state: each of NanoClaw's state roots, and its logs, is a link to the assistant's own.
    for (const [link, target] of [
      ['.env', '../state/.env'],
      ['data', '../state/data'],
      ['groups', '../state/groups'],
      ['store', '../state/store'],
      ['logs', '../logs'],
    ] as const) {
      expect((await lstat(path.join(layout.release(release), link))).isSymbolicLink()).toBe(true);
      expect(await readlink(path.join(layout.release(release), link))).toBe(target);
    }
    expect((await readdir(layout.state)).sort()).toEqual(['.env', 'data', 'groups', 'store']);
    expect((await readdir(path.join(layout.state, 'data'), { recursive: true })).sort()).toEqual([
      'gws-ea',
      path.join('gws-ea', 'instance.json'),
    ]);
    expect(await readdir(layout.logs)).toEqual([]);
    expect(await readdir(path.join(layout.root, 'kept'))).toEqual([release]);
    expect((await readdir(layout.kept(release))).sort()).toEqual([
      'host-environment.json',
      'onecli-compose.yaml',
      'release-preflight.json',
      'service-definition',
    ]);
    expect(JSON.parse(await readFile(layout.receipt(release), 'utf8'))).toMatchObject({
      instance_id: reserved.instance_id,
      deployed_commit: reserved.deployed_commit,
      onecli: { gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION },
    });
    // gws-ea's `.env` keys in the assistant's state are the ones kept with its release.
    expect(readInstanceHostEnvironment(layout.state)).toEqual(
      JSON.parse(await readFile(keptReleaseFiles(layout.kept(release)).hostEnvironment, 'utf8')),
    );
  }

  it('leaves exactly the release layout: the live link, the release and its links, state, logs, and what is kept', async () => {
    const create = await releaseCreate();

    await expect(create.runReleaseStep()).resolves.toMatchObject({ status: 'ready' });

    await expectReleaseLayout(create);
    // The release runs its own agent image, built for it while staging.
    const install = create.reserved.instance_id.replaceAll('-', '');
    expect(create.staging.faked.map((command) => command.args.join(' '))).toContainEqual(
      expect.stringMatching(new RegExp(`--tag nanoclaw-agent-v2-${install}:r-${create.release} -$`, 'u')),
    );
  });

  it('resumes a create killed during the release install by staging the release again, leaving nothing stray', async () => {
    const create = await releaseCreate();
    const { layout, release } = create;
    create.staging.killInstall = true;

    await expect(create.runReleaseStep()).rejects.toThrow('The install was killed');
    // Staging wrote nothing into the assistant's state, linked nothing, kept nothing, and nothing is live.
    expect((await readdir(layout.state)).sort()).toEqual(['.env', 'data', 'groups', 'store']);
    expect(await readFile(path.join(layout.state, '.env'), 'utf8')).toBe('');
    await expect(lstat(path.join(layout.release(release), 'data'))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(layout.kept(release))).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(lstat(layout.current)).rejects.toMatchObject({ code: 'ENOENT' });

    await expect(create.runReleaseStep()).resolves.toMatchObject({ status: 'ready' });

    // A fresh checkout, installed again: the killed install's work is gone with the release it began.
    expect(create.staging.git.filter((subcommand) => subcommand === 'init')).toHaveLength(2);
    expect(create.staging.setup.filter((command) => command.args[0] === 'install')).toHaveLength(2);
    await expect(lstat(path.join(layout.release(release), KILLED_INSTALL_LEFTOVER))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expectReleaseLayout(create);
  });

  it("keeps with the release exactly what create's own steps then run, so the first update has a rollback target", async () => {
    const create = await releaseCreate();
    await create.runReleaseStep();

    await create.withSteps(async (steps, context) => {
      // Create's OneCLI step renders the Compose file itself before it reaches Docker.
      await expect(steps.start_onecli.resources[0]!.apply(context)).rejects.toThrow('Docker is not reached');
      // Create's service step installs the service definition when it starts the host.
      await writeSubscriberKey(context);
      await expect(steps.start_nanoclaw.resources[0]!.apply(context)).resolves.toBeUndefined();

      const kept = keptReleaseFiles(create.layout.kept(create.release));
      expect(await readFile(context.input.onecli.composeFile, 'utf8')).toBe(await readFile(kept.compose, 'utf8'));
      expect(
        await readFile(instanceServiceDefinitionFile(context.input.runtime, context.input.serviceDependencies), 'utf8'),
      ).toBe(await readFile(kept.serviceDefinition, 'utf8'));
      expect(readInstanceHostEnvironment(context.input.runtime.state_root)).toEqual(
        JSON.parse(await readFile(kept.hostEnvironment, 'utf8')),
      );
    });
    // The host starts on its release, stamped by the release's own script, without building any image.
    expect(create.serviceCommands.map((command) => [command.command, command.cwd])).toContainEqual([
      'pnpm',
      create.layout.release(create.release),
    ]);
    expect(create.serviceCommands.some((command) => command.command === 'docker')).toBe(false);
    expect(create.serviceCommands.some((command) => command.args.includes('container'))).toBe(false);
  });
});

describe('port holders', () => {
  it('names the process lsof reports, and nobody when lsof finds none or is missing', async () => {
    const answers: Array<Error | string> = [
      'p5150\ncpython3.12\n',
      new GwsEaError('command_failed', 'Command failed (exit code 1): lsof'),
      new GwsEaError('executable_not_found', 'lsof was not found on PATH'),
    ];
    const run = vi.fn(async () => {
      const answer = answers.shift()!;
      if (answer instanceof Error) throw answer;
      return { stdout: answer, stderr: '' };
    });

    await expect(findPortHolder(52882, run)).resolves.toEqual({ pid: 5150, command: 'python3.12' });
    await expect(findPortHolder(52882, run)).resolves.toBeUndefined();
    await expect(findPortHolder(52882, run)).resolves.toBeUndefined();
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({ command: 'lsof', args: expect.arrayContaining(['-iTCP:52882', '-sTCP:LISTEN']) }),
    );
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
  chatConfigured: boolean;
  /** What opening the principal's DM finds: Google does not answer, or it opens. */
  principal: 'unavailable' | 'bound';
  /** The address each bind opened the DM with, and the moment it bound them at. */
  readonly binds: Array<{ readonly chatEmail: string; readonly verifiedAt: string }>;
  conversationReady: boolean;
  /** Not-ready answers the conversation check gives first, before `conversationReady` decides. */
  conversationReasons: ConversationNotReadyReason[];
  /** The process dies right after the principal is bound, before the step completes. */
  crashAfterBinding: boolean;
  lastContext?: ProductionProvisionContext;
  run(): Promise<ProvisionResult>;
}

const PRINCIPAL = {
  messagingGroupId: 'mg-principal',
  platformId: 'gchat:spaces/dm-2001',
  userId: 'gchat:users/2001',
} as const;

/** One of the principal's addresses that create did not name for Google Chat. */
const OTHER_ADDRESS = 'principal@home.example.test';

/**
 * A release staged as `stageRelease` leaves it, without a checkout to build:
 * its folder linked to the assistant's state, and what is kept with it, its
 * receipt last.
 */
async function stageWithoutCheckout(request: ReleaseStageRequest): Promise<void> {
  const layout = request.paths.instanceLayout(request.view.instance_id);
  const release = request.view.deployed_commit.slice(0, 8);
  await mkdir(layout.release(release), { recursive: true, mode: 0o700 });
  await linkReleaseState(layout, release);
  await keepRelease(
    layout.kept(release),
    {
      compose: 'services: {}\n',
      serviceDefinition: 'the service definition\n',
      hostEnvironment: instanceHostConfiguration(request.runtime),
    },
    {
      instanceId: request.view.instance_id,
      commit: request.view.deployed_commit,
      preflight: {
        ...request.provider,
        packageManager: 'pnpm@10.0.0',
        onecli: { gateway: ONECLI_GATEWAY_VERSION, sdk: ONECLI_SDK_VERSION },
      },
    },
  );
}

async function productionHarness(): Promise<ProductionHarness> {
  const paths = await testPaths();
  const reserved = await reserveInstance(paths, reservation());
  await mkdir(paths.instanceRoot(reserved.instance_id), { recursive: true, mode: 0o700 });
  await writeFile(paths.bootstrapFile(reserved.instance_id), '{}', { mode: 0o600 });
  const resources = new Set<string>();
  const receipt = Object.freeze({}) as OnecliRuntimeReceipt;
  /** When the principal was bound; undefined until they are. */
  let boundAt: string | undefined;

  const harness: ProductionHarness = {
    paths,
    instanceId: reserved.instance_id,
    effects: [],
    started: [],
    sleeps: [],
    crashAfterBinding: false,
    providerCredential: true,
    chatConfigured: true,
    principal: 'unavailable',
    binds: [],
    conversationReady: true,
    conversationReasons: [],
    run: () =>
      withInstanceOperation(paths, reserved.instance_id, async (operation) => {
        const base = productionContext(operation, reserved);
        const context: ProductionProvisionContext = {
          ...base,
          state: {},
          input: {
            ...base.input,
            ...(harness.providerCredential ? {} : { requestProviderCredential: undefined }),
            // The principal has another address; only the one create named for Chat may be opened.
            identity: {
              ...base.input.identity,
              principal: { ...base.input.identity.principal!, emails: ['principal@example.test', OTHER_ADDRESS] },
            },
            chatConfigured: harness.chatConfigured,
            bootstrapManifestFile: paths.bootstrapFile(reserved.instance_id),
            hostStatus: {
              queryHost: async () => {
                if (resources.has('host')) return hostStatusOf();
                throw new Error(`connect ENOENT ${path.join(base.input.runtime.state_root, 'data/ncl.sock')}`);
              },
              waitForHost: async () => hostStatusOf(),
            },
          },
        };
        await writeSubscriberKey(context);
        harness.lastContext = context;
        const effect = (name: string, resource: string): void => {
          harness.effects.push(name);
          resources.add(resource);
        };
        const overrides: Partial<ProductionProvisionDependencies> = {
          observeCheckout: async () => (resources.has('checkout') ? PRESENT : ABSENT),
          stageRelease: async (request) => {
            effect('stageRelease', 'checkout');
            await stageWithoutCheckout(request);
          },
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
          googleSignInResources: () => [
            {
              name: "the assistant's Google sign-in",
              observe: async () => (resources.has('sign-in') ? PRESENT : ABSENT),
              apply: async () => {
                effect('signInGoogle', 'sign-in');
                return undefined;
              },
            },
          ],
          googleAccessResources: () => [
            {
              name: "agents' Google access",
              observe: async () => (resources.has('google') ? PRESENT : ABSENT),
              apply: async () => {
                if (!resources.has('host')) throw new Error("Agents' access is published by the running host");
                effect('connectGoogle', 'google');
                return undefined;
              },
            },
          ],
          observeOnecli: async () => (resources.has('onecli') ? PRESENT : ABSENT),
          reconcileOnecliRuntime: async () => {
            effect('reconcileOnecliRuntime', 'onecli');
            return receipt;
          },
          verifyOnecliRuntime: async () => receipt,
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
            if (!resources.has('sign-in')) throw new Error('The host talks in Chat as the assistant from its start');
            effect('reconcileInstanceRuntime', 'host');
            return { pid: 4242 } as Awaited<ReturnType<ProductionProvisionDependencies['reconcileInstanceRuntime']>>;
          },
          instanceServicePid: async () => undefined,
          reconcileMainIdentity: async () => {
            effect('reconcileMainIdentity', 'main');
            return { agentGroupId: 'ag-main', onecliAgentId: 'onecli-main' };
          },
          verifyPrincipalBinding: () =>
            boundAt === undefined
              ? { status: 'absent' }
              : {
                  status: 'matched',
                  agentGroupId: 'ag-main',
                  principal: { ...PRINCIPAL, boundAt },
                  welcomeEventId: 'welcome',
                },
          bindPrincipal: async (_runtime, input) => {
            harness.effects.push(`bindPrincipal:${harness.principal}`);
            harness.binds.push({ chatEmail: input.chatEmail, verifiedAt: input.verifiedAt });
            if (harness.principal === 'unavailable') {
              return { status: 'unavailable', reason: 'Google refused /v1/spaces:setup: Backend error' };
            }
            boundAt = input.verifiedAt;
            if (harness.crashAfterBinding) {
              harness.crashAfterBinding = false;
              throw new Error('The process died after binding the principal');
            }
            return {
              status: 'bound',
              principal: { ...PRINCIPAL, boundAt },
              agentGroupId: 'ag-main',
              eventId: 'welcome',
            };
          },
          sleep: async (milliseconds) => void harness.sleeps.push(milliseconds),
          verifyConversation: () =>
            harness.conversationReasons.length > 0
              ? { ready: false, reason: harness.conversationReasons.shift()! }
              : harness.conversationReady
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
    'configure_channel',
    'sign_in_google',
    'start_nanoclaw',
    'connect_google',
    'bind_principal',
  ];

  it("signs in before the host starts, connects agents' access after it, then binds the principal through the DM the assistant opens", async () => {
    const harness = await productionHarness();

    // Google Chat does not answer the first time the assistant opens the principal's DM.
    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: { phase: 'bind_principal', code: 'google_chat_unavailable' },
    });
    expect(harness.started.slice(0, ORDER.length)).toEqual(ORDER);
    expect(harness.effects).toEqual([
      'stageRelease',
      'provisionGoogleCloud',
      'reconcileOnecliRuntime',
      'importProviderCredential',
      'signInGoogle',
      'reconcileInstanceRuntime',
      'reconcileMainIdentity',
      'connectGoogle',
      'bindPrincipal:unavailable',
    ]);
    await expect(readFile(harness.paths.bootstrapFile(harness.instanceId), 'utf8')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(
      readFile(harness.paths.releasePreflightFile(harness.instanceId, 'a'.repeat(40)), 'utf8'),
    ).resolves.toContain('"providerCredential"');

    harness.principal = 'bound';
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    expect(harness.sleeps).toEqual([]);
    expect(harness.effects.filter((effect) => !effect.startsWith('bindPrincipal'))).toEqual([
      'stageRelease',
      'provisionGoogleCloud',
      'reconcileOnecliRuntime',
      'importProviderCredential',
      'signInGoogle',
      'reconcileInstanceRuntime',
      'reconcileMainIdentity',
      'connectGoogle',
    ]);
    // One address, the one create named; every attempt binds at the moment the step began.
    const began = (await readProvisionJournal(harness.paths, harness.instanceId)).steps.bind_principal!.started_at;
    expect(harness.binds).toEqual([
      { chatEmail: 'principal@example.test', verifiedAt: began },
      { chatEmail: 'principal@example.test', verifiedAt: began },
    ]);
  });

  const blockers: ReadonlyArray<readonly [ProvisionStepId, string, (harness: ProductionHarness) => void]> = [
    ['configure_provider', 'provider_credential_required', (harness) => void (harness.providerCredential = false)],
    ['configure_channel', 'chat_configuration_required', (harness) => void (harness.chatConfigured = false)],
  ];

  it.each(blockers)('pauses at %s with %s and continues once the person acts', async (step, code, block) => {
    const harness = await productionHarness();
    block(harness);

    await expect(harness.run()).resolves.toMatchObject({ status: 'paused', pause: { phase: step, code } });
    expect(harness.started.slice(0, ORDER.indexOf(step) + 1)).toEqual(ORDER.slice(0, ORDER.indexOf(step) + 1));

    harness.providerCredential = true;
    harness.chatConfigured = true;
    await expect(harness.run()).resolves.toMatchObject({
      status: 'paused',
      pause: { phase: 'bind_principal', code: 'google_chat_unavailable' },
    });
  });

  it('pauses with the error when Google stays unavailable, trying no other address, and binds once it answers', async () => {
    const harness = await productionHarness();
    harness.principal = 'unavailable';

    const paused = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({
      phase: 'bind_principal',
      code: 'google_chat_unavailable',
      message:
        'Google Chat did not answer while the assistant opened its direct message with Principal ' +
        '(Google refused /v1/spaces:setup: Backend error). Resume to try again.',
    });
    expect(harness.binds.map((bind) => bind.chatEmail)).toEqual(['principal@example.test']);

    harness.principal = 'bound';
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    expect(harness.binds.map((bind) => bind.chatEmail)).toEqual(['principal@example.test', 'principal@example.test']);
  });

  it('resumes after the principal was bound but before the step completed, without binding again', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.crashAfterBinding = true;

    await expect(harness.run()).rejects.toThrow('The process died after binding the principal');
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    expect(harness.effects.filter((effect) => effect === 'bindPrincipal:bound')).toHaveLength(1);
  });

  /** A NanoClaw log line as the host writes it: local time of day, colored level and message. */
  function logLine(at: Date, level: string, message: string, data = ''): string {
    const two = (value: number) => String(value).padStart(2, '0');
    const stamp = `${two(at.getHours())}:${two(at.getMinutes())}:${two(at.getSeconds())}.${String(at.getMilliseconds()).padStart(3, '0')}`;
    return `[${stamp}] \x1b[33m${level}\x1b[39m \x1b[36m${message}\x1b[39m${data}`;
  }

  async function writeErrorLog(harness: ProductionHarness, lines: readonly string[], writtenAt: Date): Promise<string> {
    const errorLog = path.join(harness.lastContext!.input.runtime.instance_root, 'logs', 'nanoclaw.error.log');
    await mkdir(path.dirname(errorLog), { recursive: true });
    await writeFile(errorLog, `${lines.join('\n')}\n`);
    await utimes(errorLog, writtenAt, writtenAt);
    return errorLog;
  }

  it('shows a DM pause the errors logged since it began, redacted, and none from before', async () => {
    const harness = await productionHarness();
    const first = await harness.run();
    const began = (await readProvisionJournal(harness.paths, harness.instanceId)).steps.bind_principal!.started_at;
    const errorLog = path.join(harness.lastContext!.input.runtime.instance_root, 'logs', 'nanoclaw.error.log');
    expect(first).toMatchObject({
      status: 'paused',
      pause: {
        phase: 'bind_principal',
        code: 'google_chat_unavailable',
        details: ['Principal: Principal (principal@example.test)', `No errors logged since ${began} in ${errorLog}`],
      },
    });

    const start = new Date(began).getTime();
    const after = new Date(start + 1_000);
    await writeErrorLog(
      harness,
      [
        logLine(new Date(start - 60_000), 'ERROR', 'Logged before the pause'),
        logLine(after, 'WARN', 'Google Chat request rejected', ' authorization="Bearer abcdefghijklmnop"'),
        '    at verifyRequest (gchat.js:1:1)',
      ],
      new Date(start + 2_000),
    );

    const details = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    const stamp = logLine(after, 'WARN', '').slice(0, 14);
    expect(details.pause.details).toEqual([
      'Principal: Principal (principal@example.test)',
      `Errors logged since ${began} in ${errorLog}:`,
      `  ${stamp} WARN Google Chat request rejected authorization="Bearer [REDACTED]"`,
      '      at verifyRequest (gchat.js:1:1)',
    ]);
  });

  it('shows nothing from an error log last written before the pause began', async () => {
    const harness = await productionHarness();
    await harness.run();
    const began = (await readProvisionJournal(harness.paths, harness.instanceId)).steps.bind_principal!.started_at;
    const start = new Date(began).getTime();
    // Written a day earlier at a later time of day: the file's last write dates it.
    const errorLog = await writeErrorLog(
      harness,
      [logLine(new Date(start + 1_000), 'ERROR', 'Logged the day before')],
      new Date(start - 86_400_000 + 2_000),
    );

    await expect(harness.run()).resolves.toMatchObject({
      pause: {
        details: ['Principal: Principal (principal@example.test)', `No errors logged since ${began} in ${errorLog}`],
      },
    });
  });

  it('names the bound principal and its errors when the conversation is not answered yet', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.conversationReady = false;
    await harness.run();
    const began = (await readProvisionJournal(harness.paths, harness.instanceId)).steps.verify_conversation!.started_at;
    const start = new Date(began).getTime();
    const errorLog = await writeErrorLog(
      harness,
      [logLine(new Date(start + 1_000), 'ERROR', 'Delivery failed')],
      new Date(start + 2_000),
    );

    const paused = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({ phase: 'verify_conversation', code: 'later_principal_message_missing' });
    expect(paused.pause.details).toEqual([
      'Bound principal: Principal (gchat:users/2001)',
      `Errors logged since ${began} in ${errorLog}:`,
      `  ${logLine(new Date(start + 1_000), 'ERROR', '').slice(0, 14)} ERROR Delivery failed`,
    ]);
  });

  it('waits while the assistant delivers its welcome, then watches one pause through the reply and the answer', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.conversationReady = false;
    harness.conversationReasons = ['welcome_not_delivered', 'welcome_not_delivered', 'welcome_not_delivered'];

    const paused = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({
      phase: 'verify_conversation',
      code: 'later_principal_message_missing',
      message:
        "Ask the principal to reply to the assistant's welcome in Google Chat, if they have not yet; setup finishes " +
        "once the assistant answers them. If they are outside the assistant's Google Workspace organization, the " +
        'welcome reaches them as a message request to accept first.',
    });
    expect(harness.sleeps.filter((milliseconds) => milliseconds === 2_000)).toHaveLength(2);

    // The pause watches without changing anything, and a reply the assistant has not answered yet keeps it watching.
    await expect(paused.pause.settled?.()).resolves.toBe(false);
    harness.conversationReasons = ['reply_not_delivered'];
    await expect(paused.pause.settled?.()).resolves.toBe(false);
    harness.conversationReady = true;
    await expect(paused.pause.settled?.()).resolves.toBe(true);
  });

  it('watches for the answer to a reply already there, without a delivery wait first', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.conversationReady = false;
    harness.conversationReasons = Array.from({ length: 40 }, () => 'reply_not_delivered' as const);

    const paused = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({
      phase: 'verify_conversation',
      code: 'reply_not_delivered',
      message:
        'The principal has replied; setup finishes once the assistant answers them. If it does not, check the errors below.',
    });
    expect(harness.sleeps.filter((milliseconds) => milliseconds === 2_000)).toEqual([]);
    await expect(paused.pause.settled?.()).resolves.toBe(false);

    harness.conversationReasons = [];
    harness.conversationReady = true;
    await expect(paused.pause.settled?.()).resolves.toBe(true);
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
  });

  it('stops waiting on a delivery after a minute, and names it without a watch', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    harness.conversationReady = false;
    harness.conversationReasons = Array.from({ length: 40 }, () => 'welcome_not_delivered' as const);

    const paused = (await harness.run()) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({
      code: 'welcome_not_delivered',
      message: 'The assistant has not delivered its welcome; check the errors below, then resume.',
    });
    expect(paused.pause.settled).toBeUndefined();
    expect(harness.sleeps.filter((milliseconds) => milliseconds === 2_000)).toHaveLength(30);
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
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    expect(harness.effects.filter((effect) => effect === 'bindPrincipal:bound')).toHaveLength(1);
  });
});

describe('the vault a new assistant inherits from 1Password enablement', () => {
  /** A created assistant on a host where 1Password was enabled before its creation reached the end. */
  async function createdOnEnabledHost(): Promise<{
    readonly harness: ProductionHarness;
    readonly provider: FakeOnePassword;
  }> {
    const harness = await productionHarness();
    const provider = new FakeOnePassword();
    // Enabled while this assistant was still being created: enable leaves it to its own create.
    const enabled = await installOnePassword(
      harness.paths,
      { accountId: ACCOUNT_ID },
      { cli: provider.cli(), upsertEnvVars, operatorTerminal: true },
    );
    expect(enabled.assistants).toMatchObject([
      { instance_id: harness.instanceId, outcome: 'skipped', reason: 'not_created' },
    ]);
    harness.principal = 'bound';
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    const runtime = harness.lastContext!.input.runtime;
    // Its runtime predates the locator binding; the vault's reconciliation binds it.
    await persistInstanceRuntime(runtime, upsertEnvVars);
    const release = harness.paths.instanceLayout(harness.instanceId).release('aaaaaaaa');
    await mkdir(path.join(release, 'src/gws-ea'), { recursive: true, mode: 0o700 });
    await writeFile(
      path.join(release, 'src/gws-ea/onepassword-compatibility.json'),
      JSON.stringify({ schemaVersion: 1, contract: ONEPASSWORD_CONTRACT }),
    );
    return { harness, provider };
  }

  function finish(harness: ProductionHarness, provider: FakeOnePassword, events: RunEvent[] = []) {
    return withInstanceOperation(harness.paths, harness.instanceId, (operation) =>
      provisionAssistantResources(
        operation,
        { emit: (event) => events.push(event) },
        { cli: provider.cli(), upsertEnvVars, operatorTerminal: true },
        { skip: true },
      ),
    );
  }

  it('changes nothing and asks nothing on a host without 1Password', async () => {
    const harness = await productionHarness();
    harness.principal = 'bound';
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    const provider = new FakeOnePassword();
    const events: RunEvent[] = [];
    await expect(finish(harness, provider, events)).resolves.toMatchObject({ status: 'ready' });
    expect(provider.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('creates its own vault once every step is complete, and a resume creates nothing again', async () => {
    const { harness, provider } = await createdOnEnabledHost();
    const events: RunEvent[] = [];

    await expect(finish(harness, provider, events)).resolves.toMatchObject({ status: 'ready' });

    expect(provider.vaults.size).toBe(1);
    expect([...provider.vaults.values()][0].name).toBe('Assistant assistant@example.com');
    expect(events).toContainEqual({ type: 'domain-effect', step: 'provision_connectors', changed: true });
    const runtime = harness.lastContext!.input.runtime;
    expect((await readFile(onePasswordInstancePaths(runtime.instance_root).runtimeTokenFile, 'utf8')).trim()).toBe(
      [...provider.serviceAccounts.values()].find((account) => account.access !== 'create_vaults')?.token,
    );
    expect(await readFile(path.join(runtime.state_root, '.env'), 'utf8')).toContain(
      `GWS_EA_ONEPASSWORD_POLICY_FILE=${onePasswordHostPaths(harness.paths.configRoot).policyFile}`,
    );

    const calls = provider.calls.length;
    await expect(finish(harness, provider)).resolves.toMatchObject({ status: 'ready' });
    // Already provisioned: no request and no desktop prompt.
    expect(provider.calls.length).toBe(calls);
    expect(provider.vaults.size).toBe(1);
  });

  it('pauses with its cause when the operator is not signed in, and continues on resume', async () => {
    const { harness, provider } = await createdOnEnabledHost();
    provider.signedIn = false;

    const paused = await finish(harness, provider);

    expect(paused).toMatchObject({
      status: 'paused',
      pause: { kind: 'human-action', phase: 'provision_onepassword', code: 'onepassword_sign_in_required' },
    });
    const pause = (paused as Extract<ProvisionResult, { status: 'paused' }>).pause;
    expect(pause.message).toContain('Unlock the 1Password app');
    expect(provider.vaults.size).toBe(0);

    provider.signedIn = true;
    await expect(finish(harness, provider)).resolves.toMatchObject({ status: 'ready' });
    expect(provider.vaults.size).toBe(1);
  });

  it('names the discard that clears an unproven creation in its pause', async () => {
    const { harness, provider } = await createdOnEnabledHost();
    provider.after = (args) => {
      if (args[0] === 'vault' && args[1] === 'create') {
        provider.after = undefined;
        throw new GwsEaError('command_timeout', 'Command timed out after 60.0s');
      }
    };
    const paused = (await finish(harness, provider)) as Extract<ProvisionResult, { status: 'paused' }>;
    expect(paused.pause).toMatchObject({ code: 'onepassword_vault_creation_unproven' });
    expect(paused.pause.message).toContain('without gws-ea recording it');
    expect(paused.pause.details).toContain(
      `Then: gws-ea connectors install onepassword --discard-unproven ${harness.instanceId}`,
    );
  });

  it('reports operator-only vault setup as optional without calling op from a non-interactive create', async () => {
    const { harness, provider } = await createdOnEnabledHost();
    const calls = provider.calls.length;
    const result = await withInstanceOperation(harness.paths, harness.instanceId, (operation) =>
      provisionAssistantResources(
        operation,
        {},
        { cli: provider.cli(), upsertEnvVars, operatorTerminal: false },
        { skip: true },
      ),
    );
    expect(result).toMatchObject({
      status: 'paused',
      pause: {
        code: 'onepassword_operator_sign_in_needed',
        optional: true,
        details: expect.arrayContaining(['Then: gws-ea connectors install onepassword']),
      },
    });
    expect(provider.calls).toHaveLength(calls);
  });

  it.each(['web_name_unusable', 'web_hostname_claimed', 'web_hostname_foreign'])(
    'continues through alias setup when web is pending for %s',
    async (reason) => {
      const harness = await productionHarness();
      const provisioning = vi.spyOn(connectorProvisioning, 'provisionInstalledConnectors').mockResolvedValue({
        pending: [{ name: 'web', reason, message: 'The address cannot be claimed.' }],
        next_actions:
          reason === 'web_hostname_foreign'
            ? [{ kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'web'] }]
            : [],
      });
      try {
        const result = await withInstanceOperation(harness.paths, harness.instanceId, (operation) =>
          provisionAssistantResources(operation, {}, {}, { skip: true }),
        );
        expect(result).toMatchObject({ status: 'ready', pendingConnectors: [{ name: 'web', reason }] });
        expect(
          (await readProvisionJournal(harness.paths, harness.instanceId)).decisions.alias_skipped_at,
        ).toBeDefined();
        expect(result).not.toHaveProperty('pause');
      } finally {
        provisioning.mockRestore();
      }
    },
  );

  it('keeps the 1Password discard target off the pending web install command', async () => {
    const harness = await productionHarness();
    const provisioning = vi.spyOn(connectorProvisioning, 'provisionInstalledConnectors').mockResolvedValue({
      pending: [
        { name: 'onepassword', reason: 'vault_creation_unproven', message: 'Vault creation is unproven.' },
        { name: 'web', reason: 'setup_pending', message: 'Web setup is pending.' },
      ],
      next_actions: [
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'onepassword'] },
        { kind: 'command', argv: ['gws-ea', 'connectors', 'install', 'web'] },
      ],
    });
    try {
      const result = await withInstanceOperation(harness.paths, harness.instanceId, (operation) =>
        provisionAssistantResources(operation, {}),
      );
      expect(result).toMatchObject({
        status: 'paused',
        pause: {
          details: [
            `Then: gws-ea connectors install onepassword --discard-unproven ${harness.instanceId}`,
            'Then: gws-ea connectors install web',
            `Continue with gws-ea resume --id ${harness.instanceId}.`,
          ],
        },
      });
    } finally {
      provisioning.mockRestore();
    }
  });
});

describe('the web alias an assistant with the browser enabled gets', () => {
  /** The running host as the alias step first reaches it: its profile, and no web alias asked for yet. */
  function aliasHostNcl() {
    const calls: string[] = [];
    const ncl = async (_runtime: unknown, args: readonly string[]): Promise<unknown> => {
      calls.push(args.join(' '));
      switch (args.slice(0, 2).join(' ')) {
        case 'gws-ea-profile get':
          return {
            assistant_display_name: 'Aya',
            assistant_workspace_email: 'assistant@example.com',
            principal_emails: ['principal@example.test'],
          };
        case 'gws-ea-alias get':
          return { alias: null, candidate: null };
        case 'gws-ea-alias propose':
          return { alias: null, candidate: args[args.indexOf('--address') + 1] };
        default:
          throw new Error(`unexpected ncl ${args.join(' ')}`);
      }
    };
    return { ncl, calls };
  }

  async function readyAssistant() {
    const harness = await productionHarness();
    harness.principal = 'bound';
    await expect(harness.run()).resolves.toMatchObject({ status: 'ready' });
    const runtime = harness.lastContext!.input.runtime;
    await persistInstanceRuntime(runtime, upsertEnvVars);
    return harness;
  }

  function finish(harness: ProductionHarness, alias: AliasStepOptions & { skip?: boolean }, events: RunEvent[] = []) {
    return withInstanceOperation(harness.paths, harness.instanceId, (operation) =>
      provisionAssistantResources(operation, { emit: (event) => events.push(event) }, {}, alias),
    );
  }

  it('skips optional identity durably without asking the host', async () => {
    const harness = await readyAssistant();
    const host = aliasHostNcl();
    const events: RunEvent[] = [];

    await expect(finish(harness, { ncl: host.ncl, skip: true }, events)).resolves.toMatchObject({ status: 'ready' });
    expect(host.calls).toEqual([]);
    expect(events).toEqual([]);
  });

  it('pauses with the candidate claimed once every step is complete', async () => {
    const harness = await readyAssistant();
    const host = aliasHostNcl();
    const events: RunEvent[] = [];

    const paused = await finish(harness, { ncl: host.ncl }, events);

    expect(paused).toMatchObject({
      status: 'paused',
      pause: {
        phase: 'provision_alias',
        code: 'alias_required',
        // "Aya" reads the same reversed, so its first letter moves to the end.
        message:
          'Add yaa@example.com as an alias of assistant@example.com in the Google Admin console, then confirm it.',
        resumeFlag: '--alias-added',
      },
    });
    expect(events).toContainEqual({
      type: 'step-started',
      step: 'provision_alias',
      label: "Setting up the assistant's web alias…",
    });
    expect(
      (await getInstanceReservation(harness.paths, harness.instanceId)).exclusive_resource_claims.alias_email,
    ).toBe('yaa@example.com');
  });
});
