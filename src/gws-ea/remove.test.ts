import { randomUUID } from 'node:crypto';
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import privateFiles from 'node:fs/promises';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { writePrivate } from '../community-portal/private-file.js';
import { WhatsAppAuthStore } from '../modules/gws-ea-whatsapp/auth-store.js';
import { writeWhatsAppLink } from '../modules/gws-ea-whatsapp/paths.js';
import { FakeSocket } from '../modules/gws-ea-whatsapp/testing/fake-socket.js';
import { WhatsAppLinking } from '../modules/gws-ea-whatsapp/link.js';
import { logoutWhatsAppAccount } from '../modules/gws-ea-whatsapp/logout.js';
import { getInstallScopedNames } from '../install-slug.js';
import { ASSISTANT_TOKEN, FakeGoogleEvents } from '../modules/gws-ea-chat/testing/fake-google-events.js';
import { GOOGLE_GRANT_FILE_NAME, GOOGLE_SIGN_IN_SCOPES } from '../modules/gws-ea-google/grant.js';
import { retireCapturedServiceAccount } from '../modules/gws-ea-browser/onepassword-cli.js';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
} from '../modules/gws-ea-browser/onepassword-policy.js';
import { runCli, type CliRuntime } from './cli.js';
import { PauseRequired } from './events.js';
import type { GcloudCommandRunner } from './gcloud.js';
import { deriveGcpClaims } from './gcp-identity.js';
import {
  acquireInstanceOperation,
  recordKeyPolicyLifted,
  recordStepCompleted,
  recordStepStarted,
  reserveInstance,
  withInstanceOperation,
} from './journal.js';
import { ONECLI_INSTANCE_LABEL, ONECLI_RESOURCE_ROLE_LABEL } from './onecli-compose.js';
import { vaultCreationRecord } from './onepassword.js';
import {
  advanceOperation,
  beginOperation,
  commitOperationRelease,
  OPERATION_PHASES,
  type OperationFollowUp,
  type OperationPhase,
} from './operation.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from './paths.js';
import type { SanitizedCommand, SanitizedCommandOutcome, SanitizedCommandOutcomeRunner } from './process.js';
import {
  claimInstanceAlias,
  claimInstanceWhatsApp,
  readRegistry,
  swapInstanceRelease,
  writeInstanceMarker,
} from './registry.js';
import { createInstanceRuntimeConfig, persistInstanceRuntime } from './service.js';
import { createOnecliRuntimeLayout } from './onecli-compose.js';
import { fence, linkReleaseState, pointCurrent, releaseName, type InstanceLayout } from './release-layout.js';
import {
  describeRemoval,
  removeAssistant,
  RemovalPause,
  type RemovalDependencies,
  type RemovalInteraction,
} from './remove.js';
import type { NanoclawServiceHandle, NanoclawServiceHelpers } from './service-control.js';
import {
  ACCOUNT_ID as ONEPASSWORD_ACCOUNT,
  FakeOnePassword,
  OP,
  OTHER_ACCOUNT_ID,
  providerId,
} from './testing/onepassword-fixture.js';
import { expectResultContract } from './testing/result-contract.js';
import { GwsEaError, type InstanceReservationInput, type ProvisionStepId } from './types.js';

// Removal must never reach a real gcloud, Docker, or service manager from these tests.
vi.mock('./process.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./process.js')>();
  const refuse = async (command: { readonly command: string }): Promise<never> => {
    throw new Error(`A real ${command.command} command ran`);
  };
  return { ...actual, runSanitizedCommand: refuse, runSanitizedCommandOutcome: refuse };
});
/**
 * Root-owned files a test has removal find without writing them: a system
 * unit lives at a fixed path under `/etc`, outside any test root. Only the
 * existence check sees them; every other path is the real filesystem's.
 */
const rootOwnedFiles = vi.hoisted(() => new Set<string>());
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  const access: typeof actual.access = async (file, mode) => {
    if (typeof file === 'string' && rootOwnedFiles.has(file)) return;
    return actual.access(file, mode);
  };
  return { ...actual, access };
});

const roots: string[] = [];

afterEach(async () => {
  rootOwnedFiles.clear();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

const ACCOUNT = 'operator@example.test';
const DOCKER = 'unix:///var/run/docker.sock';
const KEY_CONSTRAINTS = ['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation'];
/** Domain restricted sharing: the legacy list constraint, then the managed one. */
const MEMBER_CONSTRAINTS = ['iam.allowedPolicyMemberDomains', 'iam.managed.allowedPolicyMembers'];

async function testPaths(): Promise<ControlPlanePaths> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-remove-'));
  roots.push(root);
  return resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') });
}

function reservationInput(options: { readonly label?: string; readonly port?: number } = {}): InstanceReservationInput {
  const label = options.label ?? 'target';
  const port = options.port ?? 33_001;
  const instanceId = randomUUID();
  return {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: port + 100, onecli_gateway: port + 200 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: ACCOUNT,
      workspace_email: `${label}@example.test`,
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  };
}

/** Reserve, optionally materialize the checkout with its marker, and record which steps started. */
async function reserve(
  paths: ControlPlanePaths,
  input: InstanceReservationInput,
  options: {
    readonly checkout?: boolean;
    readonly started?: readonly ProvisionStepId[];
    readonly lifted?: boolean;
  } = {},
): Promise<InstanceReservationInput> {
  await reserveInstance(paths, input);
  if (options.checkout ?? true) await writeInstanceMarker(paths, input.instance_id);
  await withInstanceOperation(paths, input.instance_id, async (operation) => {
    for (const step of options.started ?? []) {
      await recordStepStarted(operation, step);
      if (step === 'materialize_checkout') await recordStepCompleted(operation, step);
    }
    if (options.lifted) await recordKeyPolicyLifted(operation, true);
  });
  return input;
}

function ok(stdout = '', stderr = ''): SanitizedCommandOutcome {
  return { stdout, stderr, exitCode: 0 };
}

function failed(stderr: string): SanitizedCommandOutcome {
  return { stdout: '', stderr, exitCode: 1 };
}

/**
 * NanoClaw's service helpers, faked: detection answers what the service is
 * now, a stop leaves it stopped, and a stop or drain lands in `order`.
 */
function nanoclawService(order: string[], detected: NanoclawServiceHandle) {
  let current = detected;
  return {
    createCommandRunner: vi.fn<NanoclawServiceHelpers['createCommandRunner']>(() => ({
      run: () => '',
      tryRun: () => ({ ok: true, stdout: '' }),
    })),
    detectService: vi.fn<NanoclawServiceHelpers['detectService']>(() => current),
    stopService: vi.fn<NanoclawServiceHelpers['stopService']>(async (handle) => {
      order.push('service-stop');
      current = { ...handle, active: false };
    }),
    startService: vi.fn<NanoclawServiceHelpers['startService']>(),
    drainContainers: vi.fn<NanoclawServiceHelpers['drainContainers']>(async () => void order.push('drain')),
    verifyServiceHealth: vi.fn<NanoclawServiceHelpers['verifyServiceHealth']>(async () => true),
  } satisfies NanoclawServiceHelpers;
}
type FakeNanoclawService = ReturnType<typeof nanoclawService>;

/** One Google Cloud project as gcloud reports it to the reserved account. */
class FakeGcloud {
  project: { labels: Record<string, string>; lifecycleState: string } | undefined;
  signedIn = true;
  /** The member-domain constraints the project has a policy of its own for. */
  readonly memberPolicies = new Set<string>();
  /** The reserved account may delete the project's own policies. */
  canDeletePolicy = true;
  /** Google will not describe the project, though its policies still answer. */
  projectHidden = false;
  readonly calls: string[] = [];
  readonly mutations: string[] = [];

  constructor(readonly input: InstanceReservationInput) {}

  owned(): this {
    this.project = {
      labels: { 'gws-ea-instance': this.input.instance_id, 'gws-ea-managed': 'true' },
      lifecycleState: 'ACTIVE',
    };
    return this;
  }

  readonly run: GcloudCommandRunner = async (command) => {
    const projectId = this.input.exclusive_resource_claims.gcp_project_id;
    const words = command.args.filter((arg) => arg !== `--account=${ACCOUNT}` && arg !== '--quiet');
    const line = words.join(' ');
    this.calls.push(line);
    if (line === 'version --format=json') return ok('{"Google Cloud SDK":"540.0.0"}\n');
    if (line === 'auth print-access-token') {
      return this.signedIn
        ? ok('ya29.removal-canary\n')
        : failed(
            `ERROR: (gcloud.auth.print-access-token) There was a problem refreshing auth tokens for account ${ACCOUNT}: invalid_grant\n\nto obtain new credentials.`,
          );
    }
    if (!this.project || (this.projectHidden && line === `projects describe ${projectId} --format=json`)) {
      return failed(
        `ERROR: (gcloud.${words.slice(0, 2).join('.')}) [${ACCOUNT}] does not have permission to access projects instance [${projectId}] (or it may not exist): The caller does not have permission.`,
      );
    }
    if (line === `projects describe ${projectId} --format=json`) {
      return ok(
        JSON.stringify({
          projectId,
          projectNumber: '441811502258',
          lifecycleState: this.project.lifecycleState,
          labels: this.project.labels,
        }),
      );
    }
    if (line === `projects delete ${projectId}`) {
      this.project.lifecycleState = 'DELETE_REQUESTED';
      this.mutations.push('projects delete');
      return ok();
    }
    if (words[0] === 'org-policies' && words[1] === 'set-policy') {
      const policy = JSON.parse(await readFile(words[2]!, 'utf8')) as {
        name: string;
        spec: { rules: { enforce: boolean }[] };
      };
      this.mutations.push(`set-policy ${policy.name.split('/').at(-1)} enforce=${policy.spec.rules[0]!.enforce}`);
      return ok();
    }
    for (const constraint of MEMBER_CONSTRAINTS) {
      const name = `projects/441811502258/policies/${constraint}`;
      if (line === `org-policies describe ${constraint} --project=${projectId} --format=json`) {
        if (this.memberPolicies.has(constraint)) return ok(JSON.stringify({ name }));
        return failed(
          [
            `ERROR: (gcloud.org-policies.describe) NOT_FOUND: A Policy of constraint constraints/${constraint} on resource projects/441811502258 does not exist.`,
            "- '@type': type.googleapis.com/google.rpc.ErrorInfo",
            '  domain: orgpolicy.googleapis.com',
            '  reason: POLICY_NOT_FOUND',
          ].join('\n'),
        );
      }
      if (line === `org-policies delete ${constraint} --project=${projectId}` && this.memberPolicies.has(constraint)) {
        if (!this.canDeletePolicy) {
          return failed(
            `ERROR: (gcloud.org-policies.delete) PERMISSION_DENIED: Permission 'orgpolicy.policies.delete' denied on resource '//cloudresourcemanager.googleapis.com/projects/${projectId}' (or it may not exist).`,
          );
        }
        this.memberPolicies.delete(constraint);
        this.mutations.push(`delete-policy ${constraint}`);
        return ok('{}\n', `Deleted policy [${name}].\n`);
      }
    }
    throw new Error(`Unexpected gcloud command: ${line}`);
  };
}

const COMPOSE_PROJECT = 'com.docker.compose.project';
/** An agent group with its own image, `<repository>:<agent group ID>`. */
const AGENT_GROUP = 'ag-research';

/** An image ID, one hex digit repeated. */
function imageId(digit: string): string {
  return `sha256:${digit.repeat(64)}`;
}

function installOf(input: InstanceReservationInput): string {
  return input.instance_id.replaceAll('-', '');
}

/** The assistant's own agent-image repository. */
function repositoryOf(input: InstanceReservationInput): string {
  return getInstallScopedNames(installOf(input)).containerImageBase;
}

interface FakeContainer {
  readonly id: string;
  /** The ID of the image it runs. */
  readonly image: string;
  readonly labels: Readonly<Record<string, string>>;
}

interface FakeNamedResource {
  readonly name: string;
  readonly labels: Readonly<Record<string, string>>;
}

/** The values each `flag` in `args` was given. */
function flagValues(args: readonly string[], flag: string): string[] {
  return args.flatMap((arg, index) => (args[index - 1] === flag ? [arg] : []));
}

/** Whether `labels` carries every `--filter label=<key>=<value>` in `args`. */
function labelsMatch(labels: Readonly<Record<string, string>>, args: readonly string[]): boolean {
  return flagValues(args, '--filter')
    .filter((filter) => filter.startsWith('label='))
    .every((filter) => {
      const [key, value] = filter.slice('label='.length).split(/=(.*)/su);
      return key !== undefined && labels[key] === value;
    });
}

/**
 * One Docker daemon, answering the commands removal runs the way Docker does:
 * removing an image's last tag deletes the image; deleting by ID untags and
 * deletes an image whose tags are all in one repository; nothing deletes an
 * image a container runs; and `compose down` deletes the images its services
 * ran only when given `--rmi`.
 */
class FakeDocker {
  /** Each image by ID, with the references (`repository:tag`) naming it. */
  readonly images = new Map<string, Set<string>>();
  containers: FakeContainer[] = [];
  networks: FakeNamedResource[] = [];
  volumes: FakeNamedResource[] = [];
  readonly calls: string[] = [];

  image(id: string, ...references: string[]): this {
    this.images.set(id, new Set(references));
    return this;
  }

  /** Every reference in `repository`, sorted. */
  tags(repository: string): string[] {
    return [...this.images.values()]
      .flatMap((references) => [...references])
      .filter((reference) => reference.startsWith(`${repository}:`))
      .sort();
  }

  /**
   * An assistant as create and one update left it: the agent images of the
   * release it runs and the one it keeps to roll back to, an agent group's own
   * image, its containers, and its OneCLI stack.
   */
  assistant(
    input: InstanceReservationInput,
    images: { readonly live: string; readonly kept: string; readonly group: string },
    onecli: { readonly gateway: string; readonly postgres: string; readonly app: string },
  ): this {
    const install = installOf(input);
    const repository = repositoryOf(input);
    const project = input.exclusive_resource_claims.onecli_project;
    this.image(images.live, `${repository}:r-bbbbbbbb`)
      .image(images.kept, `${repository}:r-aaaaaaaa`)
      .image(images.group, `${repository}:${AGENT_GROUP}`);
    const agent = { 'nanoclaw-install': install };
    this.containers.push(
      { id: `${install}-agent`, image: images.group, labels: agent },
      { id: `${install}-exited`, image: images.live, labels: agent },
      ...(['postgres', 'app', 'gateway'] as const).map((service) => ({
        id: `${install}-${service}`,
        image: onecli[service],
        labels: {
          [COMPOSE_PROJECT]: project,
          'com.docker.compose.service': service,
          [ONECLI_INSTANCE_LABEL]: input.instance_id,
        },
      })),
    );
    const owned = (role: string) => ({
      [COMPOSE_PROJECT]: project,
      [ONECLI_INSTANCE_LABEL]: input.instance_id,
      [ONECLI_RESOURCE_ROLE_LABEL]: role,
    });
    this.networks.push(
      { name: `${project}-backend`, labels: owned('backend') },
      { name: `${project}-agent-egress`, labels: owned('agent-egress') },
    );
    this.volumes.push(
      { name: `${project}-postgres`, labels: owned('postgres-data') },
      { name: `${project}-app`, labels: owned('app-data') },
    );
    return this;
  }

  /** Everything Docker holds for one assistant: its repository's tags, and its containers, networks, and volumes. */
  of(input: InstanceReservationInput) {
    const install = installOf(input);
    const project = input.exclusive_resource_claims.onecli_project;
    const mine = (labels: Readonly<Record<string, string>>): boolean =>
      labels['nanoclaw-install'] === install || labels[COMPOSE_PROJECT] === project;
    return {
      tags: this.tags(repositoryOf(input)),
      containers: this.containers.filter((container) => mine(container.labels)),
      networks: this.networks.filter((network) => mine(network.labels)),
      volumes: this.volumes.filter((volume) => mine(volume.labels)),
    };
  }

  /** Delete an image by ID or reference, returning Docker's refusal, if any. */
  #remove(reference: string): string | undefined {
    const runBy = (id: string) => this.containers.find((container) => container.image === id);
    const byId = this.images.get(reference);
    if (byId) {
      const repositories = new Set([...byId].map((tag) => tag.slice(0, tag.lastIndexOf(':'))));
      if (repositories.size > 1) {
        return `conflict: unable to delete ${reference} (must be forced) - image is referenced in multiple repositories`;
      }
      const container = runBy(reference);
      if (container) {
        return `conflict: unable to delete ${reference} - image is being used by container ${container.id}`;
      }
      this.images.delete(reference);
      return undefined;
    }
    for (const [id, references] of this.images) {
      if (!references.has(reference)) continue;
      const container = runBy(id);
      if (references.size === 1 && container) {
        return `conflict: unable to remove repository reference "${reference}" (must force) - container ${container.id} is using its referenced image`;
      }
      references.delete(reference);
      if (references.size === 0) this.images.delete(id);
      return undefined;
    }
    return `Error response from daemon: No such image: ${reference}`;
  }

  run(args: readonly string[]): SanitizedCommandOutcome {
    this.calls.push(args.join(' '));
    const [group, verb, ...rest] = args;
    const listed = (items: readonly string[]) => ok(items.map((item) => `${item}\n`).join(''));
    if (group === 'ps' || (group === 'container' && verb === 'ls')) {
      return listed(this.containers.filter((container) => labelsMatch(container.labels, args)).map(({ id }) => id));
    }
    if (group === 'rm' && verb === '--force') {
      this.containers = this.containers.filter((container) => !rest.includes(container.id));
      return ok();
    }
    if (group === 'container' && verb === 'inspect') {
      const inspected = this.containers
        .filter((container) => rest.includes(container.id))
        .map((container) => ({
          Id: container.id,
          Config: {
            Image: [...(this.images.get(container.image) ?? [])][0] ?? container.image,
            Labels: container.labels,
          },
          State: { Running: true },
          NetworkSettings: { Networks: {}, Ports: {} },
          Mounts: [],
        }));
      return ok(JSON.stringify(inspected));
    }
    if ((group === 'network' || group === 'volume') && verb === 'ls') {
      const named = flagValues(args, '--filter').flatMap((filter) => {
        const exact = /^name=\^(.+)\$$/u.exec(filter);
        return exact?.[1] ? [exact[1]] : [];
      });
      const resources = group === 'network' ? this.networks : this.volumes;
      return listed(
        resources
          .filter((resource) => named.every((name) => resource.name === name) && labelsMatch(resource.labels, args))
          .map(({ name }) => name),
      );
    }
    if (group === 'image' && verb === 'ls' && flagValues(args, '--format')[0] === '{{.Repository}}:{{.Tag}}') {
      return listed(this.tags(args.at(-1) ?? ''));
    }
    if (group === 'image' && verb === 'inspect') {
      const id = args.at(-1) ?? '';
      const references = this.images.get(id);
      if (!references) return { stdout: '', stderr: `Error response from daemon: No such image: ${id}`, exitCode: 1 };
      return ok(
        `${JSON.stringify([{ Id: id, RepoTags: [...references], Created: '2026-09-01T00:00:00Z', Config: { Labels: null } }])}\n`,
      );
    }
    if (group === 'tag') {
      const source = verb ?? '';
      const target = rest[0] ?? '';
      const id = this.images.has(source)
        ? source
        : [...this.images].find(([, references]) => references.has(source))?.[0];
      if (!id) return { stdout: '', stderr: `Error response from daemon: No such image: ${source}`, exitCode: 1 };
      for (const references of this.images.values()) references.delete(target);
      this.images.get(id)?.add(target);
      return ok();
    }
    if (group === 'image' && verb === 'rm') {
      const refusals = rest.flatMap((reference) => this.#remove(reference) ?? []);
      return refusals.length === 0 ? ok() : { stdout: '', stderr: refusals.join('\n'), exitCode: 1 };
    }
    if (group === 'compose' && args.includes('down')) {
      const project = flagValues(args, '--project-name')[0];
      const inProject = (labels: Readonly<Record<string, string>>): boolean => labels[COMPOSE_PROJECT] === project;
      const stopped = this.containers.filter((container) => inProject(container.labels));
      this.containers = this.containers.filter((container) => !inProject(container.labels));
      this.networks = this.networks.filter((network) => !inProject(network.labels));
      if (args.includes('--volumes')) this.volumes = this.volumes.filter((volume) => !inProject(volume.labels));
      // Compose only warns about an image it could not delete.
      if (args.includes('--rmi')) for (const container of stopped) this.#remove(container.image);
      return ok();
    }
    throw new Error(`Unexpected docker command: ${args.join(' ')}`);
  }
}

/**
 * Removal's local commands, Docker's answered by `docker`, and `pkill -f` and
 * `pgrep -f` by the command lines in `processes` their pattern matches (JS
 * reads the extended regular expressions removal writes as POSIX does).
 */
function teardownCommands(
  docker: FakeDocker,
  calls: string[] = [],
  processes = new Set<string>(),
): SanitizedCommandOutcomeRunner {
  return async (command) => {
    calls.push(`${command.command} ${command.args.join(' ')}`);
    if (command.command === 'docker') return docker.run(command.args);
    if (command.command === 'pkill' || command.command === 'pgrep') {
      const pattern = new RegExp(command.args.at(-1) ?? '', 'u');
      const matching = [...processes].filter((line) => pattern.test(line));
      if (command.command === 'pkill') for (const line of matching) processes.delete(line);
      return matching.length === 0 ? failed('') : ok(command.command === 'pgrep' ? '4242\n' : '');
    }
    throw new Error(`Unexpected command: ${command.command} ${command.args.join(' ')}`);
  };
}

const REFRESH_TOKEN = '1//assistant-refresh-token';

/** Where the assistant's Google sign-in lives: in its instance's secrets, as every runtime keeps it. */
function grantFile(paths: ControlPlanePaths, input: InstanceReservationInput): string {
  return path.join(paths.instanceRoot(input.instance_id), 'secrets', GOOGLE_GRANT_FILE_NAME);
}

/** The assistant signed in to Google, as `sign_in_google` leaves it. */
async function signIn(paths: ControlPlanePaths, input: InstanceReservationInput): Promise<void> {
  await writePrivate(grantFile(paths, input), {
    schema_version: 3,
    account: input.exclusive_resource_claims.workspace_email,
    sub: '104857395723948572901',
    client_id: 'juno-hale-client.apps.googleusercontent.com',
    client_secret: 'juno-hale-client-secret',
    consents: [{ refresh_token: REFRESH_TOKEN, scopes: GOOGLE_SIGN_IN_SCOPES }],
    granted_at: '2026-10-01T12:00:00.000Z',
  });
}

/**
 * Google as the assistant's sign-in reaches it: the token endpoint, which
 * mints its refresh token exactly the scopes asked for unless it refuses, and
 * Workspace Events, which holds the assistant's subscriptions.
 */
class FakeAssistantGoogle {
  readonly events = new FakeGoogleEvents();
  /** The OAuth error the token endpoint refuses with while set. */
  refusal: string | undefined;

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    if (url.host !== 'oauth2.googleapis.com') return this.events.fetch(input, init);
    const form = new URLSearchParams(String(init?.body));
    const answer = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    if (form.get('grant_type') !== 'refresh_token' || form.get('refresh_token') !== REFRESH_TOKEN) {
      return answer(400, { error: 'invalid_request' });
    }
    if (this.refusal) return answer(400, { error: this.refusal });
    return answer(200, { access_token: ASSISTANT_TOKEN, expires_in: 3600, scope: form.get('scope') });
  };
}

interface World {
  readonly gcloud: FakeGcloud;
  readonly google: FakeAssistantGoogle;
  readonly order: string[];
  readonly interaction: { [K in keyof RemovalInteraction]: ReturnType<typeof vi.fn<RemovalInteraction[K]>> };
  readonly dependencies: RemovalDependencies & {
    readonly resolveDocker: ReturnType<typeof vi.fn<NonNullable<RemovalDependencies['resolveDocker']>>>;
  };
}

/** Every boundary faked; each records into `order` when it changes something. */
function world(input: InstanceReservationInput): World {
  const gcloud = new FakeGcloud(input);
  const google = new FakeAssistantGoogle();
  const order: string[] = [];
  const interaction = {
    signInToGoogleCloud: vi.fn<RemovalInteraction['signInToGoogleCloud']>(async () => {
      gcloud.signedIn = true;
    }),
  };
  const runGcloud: GcloudCommandRunner = async (command) => {
    const outcome = await gcloud.run(command);
    if (command.args.slice(0, 2).join(' ') === 'projects delete') order.push('gcp');
    return outcome;
  };
  const fetch: typeof globalThis.fetch = async (request, init) => {
    const response = await google.fetch(request, init);
    if (init?.method === 'DELETE' && response.ok) order.push('chat-subscription');
    return response;
  };
  return {
    gcloud,
    google,
    order,
    interaction,
    dependencies: {
      interaction,
      platform: 'linux',
      runGcloud,
      fetch,
      resolveDocker: vi.fn(async (recorded: string | undefined) => recorded ?? DOCKER),
      uninstallNanoclaw: vi.fn(async () => void order.push('nanoclaw')),
      removeOnecli: vi.fn(async () => void order.push('onecli')),
      sleep: async () => undefined,
    },
  };
}

async function exists(file: string): Promise<boolean> {
  return access(file).then(
    () => true,
    () => false,
  );
}

async function expectGone(paths: ControlPlanePaths, input: InstanceReservationInput): Promise<void> {
  expect((await readRegistry(paths)).instances[input.instance_id]).toBeUndefined();
  expect(await exists(paths.instanceRoot(input.instance_id))).toBe(false);
  expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
}

/** `gws-ea remove --yes` for `input`, through `world`'s boundaries, recording what it prints. */
function removeCommand(paths: ControlPlanePaths, input: InstanceReservationInput, { dependencies }: World) {
  const io = { out: [] as string[], err: [] as string[] };
  const run = (args: readonly string[]): Promise<number> =>
    runCli(['remove', '--id', input.instance_id, '--yes', ...args], {
      paths,
      stdout: (line) => io.out.push(line),
      stderr: (line) => io.err.push(line),
      removeAssistant: (removalPaths, id, options) =>
        removeAssistant(removalPaths, id, { ...dependencies, ...options, interaction: dependencies.interaction }),
    });
  return { run, io };
}

describe('removal from any partial state', () => {
  it('removes a reservation with no journal locally, without gcloud or Docker', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { checkout: false });
    await rm(paths.journalFile(input.instance_id));
    const { dependencies, interaction, gcloud } = world(input);

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    await expectGone(paths, input);
    expect(gcloud.calls).toEqual([]);
    expect(dependencies.resolveDocker).not.toHaveBeenCalled();
    expect(interaction.signInToGoogleCloud).not.toHaveBeenCalled();
    expect(dependencies.uninstallNanoclaw).not.toHaveBeenCalled();
    expect(dependencies.removeOnecli).not.toHaveBeenCalled();
    expect(outcome).toEqual({ removed: ['instance-files'], abandoned: [] });
  });

  it('deletes a created project when the checkout is gone, skipping everything that never started', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      checkout: false,
      started: ['materialize_checkout', 'provision_gcp'],
    });
    const { dependencies, gcloud, order } = world(input);
    gcloud.owned();

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    const projectId = input.exclusive_resource_claims.gcp_project_id;
    expect(order).toEqual(['gcp']);
    expect(gcloud.calls).toEqual([
      'version --format=json',
      'auth print-access-token',
      `projects describe ${projectId} --format=json`,
      ...MEMBER_CONSTRAINTS.map(
        (constraint) => `org-policies describe ${constraint} --project=${projectId} --format=json`,
      ),
      `projects delete ${projectId}`,
      `projects describe ${projectId} --format=json`,
    ]);
    expect(dependencies.resolveDocker).not.toHaveBeenCalled();
    expect(outcome.removed).toEqual(['gcp-project', 'instance-files']);
    await expectGone(paths, input);
  });

  it('pauses on a started project Google will not show, then abandons it on request with its evidence', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'provision_gcp', 'start_onecli'],
      lifted: true,
    });
    const removal = world(input);
    const { dependencies, gcloud } = removal;
    const { run: cli, io } = removeCommand(paths, input, removal);

    expect(await cli([])).toBe(10);
    const paused = io.out.join('\n');
    expect(paused).toContain('Paused at remove_gcp_project');
    expect(paused).toContain(input.exclusive_resource_claims.gcp_project_id);
    expect(paused).toContain('(or it may not exist)');
    expect(paused).toContain(`gws-ea remove --id ${input.instance_id} --yes --abandon gcp-project`);
    expect(gcloud.mutations).toEqual([]);
    expect((await readRegistry(paths)).instances[input.instance_id]).toBeDefined();

    // Abandoning records the evidence and the policy lift it could not restore, and continues. Policies Google
    // will not show belong to the project left behind: no member-domain relax is claimed.
    const removeOnecli = vi
      .fn<NonNullable<RemovalDependencies['removeOnecli']>>()
      .mockRejectedValueOnce(new GwsEaError('docker_stopped', 'Docker is not running'))
      .mockResolvedValueOnce(undefined);
    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli, abandon: new Set(['gcp-project']) }),
    ).rejects.toMatchObject({ code: 'docker_stopped' });
    const receipt = JSON.parse(await readFile(paths.removalFile(input.instance_id), 'utf8')) as Record<string, unknown>;
    expect(receipt).toMatchObject({
      schema_version: 3,
      instance_id: input.instance_id,
      reservation: input,
      completed: {},
      abandoned: {
        'gcp-project': { at: expect.any(String), evidence: expect.stringContaining('(or it may not exist)') },
      },
      key_policy_unrestored: { at: expect.any(String), evidence: expect.stringContaining('may not exist') },
    });
    expect(receipt).not.toHaveProperty('member_policy_unrestored');

    io.out.length = 0;
    expect(await cli(['--abandon', 'gcp-project'])).toBe(0);
    expect(io.out.join('\n')).toContain(
      `Left behind: Google Cloud project ${input.exclusive_resource_claims.gcp_project_id}`,
    );
    expect(io.out.join('\n')).toContain('key-creation policy');
    expect(io.out.join('\n')).not.toContain('member-domain policy');
    expect(gcloud.mutations).toEqual([]);
    await expectGone(paths, input);
  });

  it('records a member-domain override Google shows but refuses to delete on a project it will not show', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'provision_gcp'] });
    const { dependencies, gcloud } = world(input);
    gcloud.owned().memberPolicies.add('iam.allowedPolicyMemberDomains');
    gcloud.projectHidden = true;
    gcloud.canDeletePolicy = false;

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['gcp-project']),
    });

    expect(outcome).toMatchObject({
      abandoned: [{ resource: 'gcp-project', evidence: expect.stringContaining('(or it may not exist)') }],
      memberPolicyUnrestored: expect.stringMatching(/^iam\.allowedPolicyMemberDomains: .*PERMISSION_DENIED/su),
    });
    expect(gcloud.mutations).toEqual([]);
    await expectGone(paths, input);
  });

  it('restores a lifted key-creation policy before it deletes the project', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'provision_gcp'],
      lifted: true,
    });
    const { dependencies, gcloud } = world(input);
    gcloud.owned();

    await expect(removeAssistant(paths, input.instance_id, dependencies)).resolves.toMatchObject({ abandoned: [] });

    expect(gcloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
      'projects delete',
    ]);
  });

  it('still deletes the project, and says so, when Google refuses to restore a relaxed member-domain policy', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'provision_gcp'] });
    const removal = world(input);
    removal.gcloud.owned().memberPolicies.add('iam.allowedPolicyMemberDomains');
    removal.gcloud.canDeletePolicy = false;
    const { run: cli, io } = removeCommand(paths, input, removal);
    const projectId = input.exclusive_resource_claims.gcp_project_id;

    expect(await cli([])).toBe(0);

    expect(removal.gcloud.mutations).toEqual(['projects delete']);
    expect(io.out.join('\n')).toContain(
      `The member-domain policy relaxed on Google Cloud project ${projectId} was not restored: iam.allowedPolicyMemberDomains: `,
    );
    await expectGone(paths, input);
  });

  it("does not let one assistant's stuck removal block creating, resuming, or removing another", async () => {
    const paths = await testPaths();
    // Its project was created, and Google will no longer show it.
    const stuck = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'provision_gcp'] });
    const { dependencies } = world(stuck);

    await expect(removeAssistant(paths, stuck.instance_id, dependencies)).rejects.toBeInstanceOf(PauseRequired);
    await expect(access(paths.removalFile(stuck.instance_id))).resolves.toBeUndefined();

    const next = await reserve(paths, reservationInput({ label: 'next', port: 35_001 }));
    const operation = await acquireInstanceOperation(paths, next.instance_id);
    expect(operation).not.toBeNull();
    operation?.release();
    await removeAssistant(paths, next.instance_id, world(next).dependencies);
    await expectGone(paths, next);

    await expect(acquireInstanceOperation(paths, stuck.instance_id)).rejects.toMatchObject({
      code: 'removal_in_progress',
    });
    expect((await readRegistry(paths)).instances[stuck.instance_id]).toEqual(stuck);
  });
});

describe("removal of the assistant's Google Chat subscription (KTD13)", () => {
  const STARTED = [
    'materialize_checkout',
    'provision_gcp',
    'start_onecli',
    'sign_in_google',
    'start_nanoclaw',
  ] as const;

  it('stops the host before deleting the subscription with the assistant’s sign-in, and deletes the project after', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    await signIn(paths, input);
    const voicePolicy = path.join(paths.configRoot, 'voice.json');
    const voiceAssets = path.join(paths.stateRoot, 'voice', 'shared-model.bin');
    await mkdir(path.dirname(voiceAssets), { recursive: true, mode: 0o700 });
    const policy = JSON.stringify({ schemaVersion: 1, enabled: true, installationDir: path.dirname(voiceAssets) });
    await writeFile(voicePolicy, policy, { mode: 0o600 });
    await writeFile(voiceAssets, 'shared immutable model');
    const removal = world(input);
    const browserFiles = ['browser/profile/Cookies', 'browser/staging/private-download'].map((relative) =>
      path.join(paths.instanceRoot(input.instance_id), relative),
    );
    for (const file of browserFiles) {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
      await writeFile(file, 'private browser material', { mode: 0o600 });
    }
    const uninstall = removal.dependencies.uninstallNanoclaw!;
    const dependencies = {
      ...removal.dependencies,
      uninstallNanoclaw: async (...args: Parameters<typeof uninstall>) => {
        for (const file of browserFiles) expect(await readFile(file, 'utf8')).toBe('private browser material');
        await uninstall(...args);
      },
    };
    removal.gcloud.owned();
    removal.google.events.seedSubscription();

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(removal.order).toEqual(['nanoclaw', 'chat-subscription', 'gcp', 'onecli']);
    expect(removal.dependencies.resolveDocker).toHaveBeenCalledOnce();
    expect(removal.google.events.subscriptions.size).toBe(0);
    // Listed for the assistant's own target with its own Chat token before any change, which proves the sign-in, then
    // once the host stopped: listed, deleted, and listed again to see it gone.
    const calls = removal.google.events.requests.filter(
      (request) => request.url.host === 'workspaceevents.googleapis.com',
    );
    expect(calls.map((request) => `${request.method} ${request.url.pathname}`)).toEqual([
      'GET /v1/subscriptions',
      'GET /v1/subscriptions',
      expect.stringMatching(/^DELETE \/v1\/subscriptions\/chat-/u),
      'GET /v1/subscriptions',
    ]);
    expect(calls[0]!.url.searchParams.get('filter')).toContain('target_resource="//chat.googleapis.com/spaces/-"');
    expect(new Set(calls.map((request) => request.authorization))).toEqual(new Set([`Bearer ${ASSISTANT_TOKEN}`]));
    expect(outcome).toEqual({
      removed: ['nanoclaw', 'chat-subscription', 'gcp-project', 'onecli', 'instance-files'],
      abandoned: [],
    });
    await expectGone(paths, input);
    for (const file of browserFiles) expect(await exists(file)).toBe(false);
    expect(await readFile(voicePolicy, 'utf8')).toBe(policy);
    expect(await readFile(voiceAssets, 'utf8')).toBe('shared immutable model');
  });

  it('counts the subscription gone without asking Google when the assistant never signed in', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'start_nanoclaw'] });
    const removal = world(input);

    const outcome = await removeAssistant(paths, input.instance_id, removal.dependencies);

    expect(removal.google.events.requests).toEqual([]);
    expect(outcome.removed).toEqual(['nanoclaw', 'chat-subscription', 'instance-files']);
  });

  it("pauses before any change when Google refuses the assistant's sign-in, then completes, leaving the subscription behind on request", async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    await signIn(paths, input);
    const removal = world(input);
    removal.gcloud.owned();
    removal.google.refusal = 'invalid_grant';
    const subscription = removal.google.events.seedSubscription();
    const { run, io } = removeCommand(paths, input, removal);

    expect(await run([])).toBe(10);
    const paused = io.out.join('\n');
    expect(paused).toContain('Paused at prerequisites');
    expect(paused).toContain("Google no longer accepts the assistant's sign-in");
    expect(paused).toContain('Google deletes it within 7 days');
    expect(paused).toContain(`gws-ea remove --id ${input.instance_id} --yes --abandon chat-subscription`);
    expect(removal.order).toEqual([]);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);

    io.out.length = 0;
    expect(await run(['--abandon', 'chat-subscription'])).toBe(0);
    expect(removal.order).toEqual(['nanoclaw', 'gcp', 'onecli']);
    expect(removal.google.events.subscriptions.has(subscription.name)).toBe(true);
    expect(io.out.join('\n')).toContain("Left behind: the assistant's Google Chat subscription");
    await expectGone(paths, input);
  });

  it('pauses at the subscription when Workspace Events refuses the sign-in once the host stopped, and abandons it on request', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    await signIn(paths, input);
    const removal = world(input);
    removal.gcloud.owned();
    removal.google.events.seedSubscription();
    const uninstallNanoclaw = vi.fn<NonNullable<RemovalDependencies['uninstallNanoclaw']>>(async () => {
      removal.order.push('nanoclaw');
      removal.google.events.workspaceFailure = { status: 403, message: 'Workspace Events API is disabled in project' };
    });
    const dependencies = { ...removal.dependencies, uninstallNanoclaw };

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toMatchObject({
      code: 'chat_subscription_unobservable',
      resource: 'chat-subscription',
    });
    expect(removal.order).toEqual(['nanoclaw']);

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['chat-subscription']),
    });

    expect(uninstallNanoclaw).toHaveBeenCalledOnce();
    expect(removal.order).toEqual(['nanoclaw', 'gcp', 'onecli']);
    expect(outcome.abandoned).toEqual([
      { resource: 'chat-subscription', evidence: expect.stringContaining('Workspace Events API is disabled') },
    ]);
    await expectGone(paths, input);
  });

  it('stops before any change while Google cannot be reached, with nothing to abandon, and finishes on retry', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    await signIn(paths, input);
    const removal = world(input);
    removal.gcloud.owned();
    removal.google.events.seedSubscription();
    removal.google.events.workspaceFailure = { status: 503, message: 'The service is currently unavailable.' };

    await expect(
      removeAssistant(paths, input.instance_id, { ...removal.dependencies, abandon: new Set(['chat-subscription']) }),
    ).rejects.toThrow(/currently unavailable/u);
    expect(removal.order).toEqual([]);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);

    removal.google.events.workspaceFailure = undefined;
    await removeAssistant(paths, input.instance_id, removal.dependencies);

    expect(removal.order).toEqual(['nanoclaw', 'chat-subscription', 'gcp', 'onecli']);
    await expectGone(paths, input);
  });

  it('counts the subscription removed, and deletes the project, only once Google shows none left after its deletion', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    await signIn(paths, input);
    const removal = world(input);
    removal.gcloud.owned();
    removal.google.events.seedSubscription();
    // A host still running makes the assistant a new subscription as soon as its own is deleted.
    let hostRunning = true;
    const fetch: typeof globalThis.fetch = async (request, init) => {
      const response = await removal.dependencies.fetch!(request, init);
      if (init?.method === 'DELETE' && hostRunning) removal.google.events.seedSubscription();
      return response;
    };
    const dependencies = { ...removal.dependencies, fetch };

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toMatchObject({
      code: 'chat_subscription_removal_incomplete',
    });
    expect(removal.order).toEqual(['nanoclaw', 'chat-subscription']);
    expect(removal.gcloud.mutations).toEqual([]);

    hostRunning = false;
    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(removal.google.events.subscriptions.size).toBe(0);
    expect(outcome).toEqual({
      removed: ['nanoclaw', 'chat-subscription', 'gcp-project', 'onecli', 'instance-files'],
      abandoned: [],
    });
    await expectGone(paths, input);
  });
});

describe('removal after an update or rollback', () => {
  const TARGET = 'b'.repeat(40);
  const RECORDED_DOCKER = 'unix:///var/run/recorded-docker.sock';
  const STOP = { at: '2026-09-28T10:00:00.000Z', graceful: true } as const;

  function release(input: InstanceReservationInput, commit: string) {
    return { source_remote: input.source_remote, release_track: input.release_track, deployed_commit: commit };
  }

  /** The runtime record in the assistant's state: a home of the test's own, and the recorded endpoint. */
  async function recordRuntime(paths: ControlPlanePaths, input: InstanceReservationInput): Promise<void> {
    await writePrivate(paths.runtimeFile(input.instance_id), {
      home_directory: path.join(paths.stateRoot, 'home'),
      docker_endpoint: RECORDED_DOCKER,
    });
  }

  /**
   * Both releases staged beside the assistant's state as an update stages
   * them, each linked to the state with its receipt kept, and the rollback
   * material an update and a rollback leave: a snapshot and a quarantine.
   */
  async function releasesBeside(paths: ControlPlanePaths, input: InstanceReservationInput): Promise<InstanceLayout> {
    const layout = paths.instanceLayout(input.instance_id);
    await recordRuntime(paths, input);
    for (const commit of [input.deployed_commit, TARGET]) {
      const name = releaseName(commit);
      await mkdir(layout.release(name), { recursive: true, mode: 0o700 });
      await writeFile(path.join(layout.release(name), 'release.txt'), `${name}\n`);
      await linkReleaseState(layout, name);
      await writePrivate(layout.receipt(name), { instance_id: input.instance_id, deployed_commit: commit });
    }
    for (const kept of [layout.snapshot('20260928T100000000Z'), layout.quarantine('20260929T100000000Z')]) {
      await mkdir(path.join(kept, 'data'), { recursive: true, mode: 0o700 });
    }
    return layout;
  }

  /**
   * An update from the reserved commit to `TARGET`, or a rollback back from
   * it, run through its record until `phase`, with the live link where that
   * phase leaves it: the release it moves from until the fence, none while
   * fenced, the one it moves to once switched.
   */
  async function operatedUntil(
    paths: ControlPlanePaths,
    input: InstanceReservationInput,
    kind: 'update' | 'rollback',
    phase: OperationPhase,
    followUps: readonly OperationFollowUp[] = [],
  ): Promise<void> {
    const layout = await releasesBeside(paths, input);
    const original = release(input, input.deployed_commit);
    const updated = release(input, TARGET);
    if (kind === 'rollback') await swapInstanceRelease(paths, input.instance_id, original, updated);
    const [from, to] = kind === 'update' ? [original, updated] : [updated, original];
    const reached = OPERATION_PHASES.indexOf(phase);
    const fenced = reached >= OPERATION_PHASES.indexOf('fenced') && reached < OPERATION_PHASES.indexOf('switched');
    if (!fenced) {
      const live = reached < OPERATION_PHASES.indexOf('fenced') ? from : to;
      await pointCurrent(layout, releaseName(live.deployed_commit));
    }
    const operation = await acquireInstanceOperation(
      paths,
      input.instance_id,
      kind === 'update' ? { command: 'update', target: to } : { command: 'rollback' },
    );
    if (!operation) throw new Error('The test instance operation was busy');
    try {
      await beginOperation(operation, { kind, from, to });
      for (const step of OPERATION_PHASES.slice(1, reached + 1)) {
        if (step === 'committed') await commitOperationRelease(operation);
        else if (step === 'fenced') {
          await advanceOperation(operation, step, {
            stop: STOP,
            manifest: { central_migrations: [], session_tables: {} },
          });
        } else if (step === 'snapshotted' && kind === 'rollback')
          await advanceOperation(operation, step, { mode: 'snapshot' });
        else if (step === 'verified') await advanceOperation(operation, step, { follow_ups: followUps });
        else await advanceOperation(operation, step);
      }
    } finally {
      operation.release();
    }
  }

  it.each(OPERATION_PHASES)('completes with an update interrupted at %s', async (phase) => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_onecli', 'start_nanoclaw'],
    });
    await operatedUntil(paths, input, 'update', phase, [{ kind: 'prune' }]);
    const reservation = (await readRegistry(paths)).instances[input.instance_id]!;
    const { dependencies } = world(reservation);

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(outcome.removed).toEqual(['nanoclaw', 'chat-subscription', 'onecli', 'instance-files']);
    // The recorded Docker endpoint is found in the assistant's state, live link or none.
    expect(dependencies.resolveDocker).toHaveBeenCalledWith(RECORDED_DOCKER);
    expect(dependencies.uninstallNanoclaw).toHaveBeenCalledWith(reservation, expect.anything());
    await expectGone(paths, reservation);
  });

  it.each(OPERATION_PHASES)('completes with a rollback interrupted at %s', async (phase) => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    await operatedUntil(paths, input, 'rollback', phase, [{ kind: 'prune' }]);
    const repository = repositoryOf(input);
    const docker = new FakeDocker()
      .image(imageId('1'), `${repository}:r-bbbbbbbb`)
      .image(imageId('2'), `${repository}:r-aaaaaaaa`)
      .image(imageId('3'), `${repository}:${AGENT_GROUP}`);
    const reservation = (await readRegistry(paths)).instances[input.instance_id]!;
    const { uninstallNanoclaw: _fake, ...dependencies } = world(reservation).dependencies;

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      runCommand: teardownCommands(docker),
      serviceHelpers: nanoclawService([], { mode: 'none', active: false }),
    });

    expect(outcome.removed).toEqual(['nanoclaw', 'chat-subscription', 'instance-files']);
    expect(dependencies.resolveDocker).toHaveBeenCalledWith(RECORDED_DOCKER);
    expect([...docker.images.keys()]).toEqual([]);
    await expectGone(paths, reservation);
  });

  it('removes by instance identity alone when the operation record cannot be read', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout'] });
    await operatedUntil(paths, input, 'update', 'started');
    await writeFile(paths.operationFile(input.instance_id), '{torn', { mode: 0o600 });

    await removeAssistant(paths, input.instance_id, world(input).dependencies);

    await expectGone(paths, input);
  });

  /** Images every assistant may share: gateways by content, and OneCLI's own. */
  const SHARED_IMAGES = {
    'gws-ea-onecli-gateway:0a1b2c3d4e5f': imageId('a'),
    'gws-ea-onecli-gateway:6a7b8c9d0e1f': imageId('b'),
    'postgres:18-alpine': imageId('c'),
    'ghcr.io/onecli/onecli:1.4.0': imageId('d'),
  } as const;

  /**
   * A, whose one update is recorded and finished, beside B on one Docker. A
   * runs the gateway B moved on from and keeps for its rollback; B runs the
   * newer one; both run OneCLI's images.
   */
  async function besidePeer(paths: ControlPlanePaths) {
    const started = ['materialize_checkout', 'start_onecli', 'start_nanoclaw'] as const;
    const a = await reserve(paths, reservationInput(), { started });
    const b = await reserve(paths, reservationInput({ label: 'peer', port: 34_001 }), { started });
    await operatedUntil(paths, a, 'update', 'committed');
    const docker = new FakeDocker();
    for (const [reference, id] of Object.entries(SHARED_IMAGES)) docker.image(id, reference);
    const onecli = { postgres: imageId('c'), app: imageId('d') };
    docker
      .assistant(
        a,
        { live: imageId('1'), kept: imageId('2'), group: imageId('3') },
        { ...onecli, gateway: imageId('a') },
      )
      .assistant(
        b,
        { live: imageId('5'), kept: imageId('6'), group: imageId('7') },
        { ...onecli, gateway: imageId('b') },
      );
    const calls: string[] = [];
    const { uninstallNanoclaw: _uninstall, removeOnecli: _removeOnecli, ...dependencies } = world(a).dependencies;
    return {
      a,
      b,
      docker,
      calls,
      dependencies: {
        ...dependencies,
        runCommand: teardownCommands(docker, calls),
        serviceHelpers: nanoclawService([], { mode: 'none', active: false }),
      },
    };
  }

  it("deletes every release, its image tags, and every group's image after an update, and nothing of another assistant's", async () => {
    const paths = await testPaths();
    const { a, b, docker, calls, dependencies } = await besidePeer(paths);
    const repository = repositoryOf(a);
    expect(await exists(paths.instanceLayout(a.instance_id).release(releaseName(a.deployed_commit)))).toBe(true);
    expect(docker.of(a).tags).toEqual([
      `${repository}:${AGENT_GROUP}`,
      `${repository}:r-aaaaaaaa`,
      `${repository}:r-bbbbbbbb`,
    ]);
    const peer = docker.of(b);

    await removeAssistant(paths, a.instance_id, dependencies);

    // Nothing of A's is left: no tag in its repository, no image it built, no container, network, or volume.
    expect(docker.of(a)).toEqual({ tags: [], containers: [], networks: [], volumes: [] });
    for (const digit of ['1', '2', '3']) expect(docker.images.has(imageId(digit))).toBe(false);
    await expectGone(paths, a);
    // B's are exactly as they were, and removal never named B.
    expect(docker.of(b)).toEqual(peer);
    expect(await exists(paths.markerFile(b.instance_id))).toBe(true);
    expect(calls.filter((call) => call.includes(installOf(b)) || call.includes(b.instance_id))).toEqual([]);
  });

  it('keeps the gateway image B runs, the one it keeps for its rollback, and every other shared image', async () => {
    const paths = await testPaths();
    const { a, b, docker, calls, dependencies } = await besidePeer(paths);
    const shared = (): Record<string, string[]> =>
      Object.fromEntries(Object.values(SHARED_IMAGES).map((id) => [id, [...(docker.images.get(id) ?? [])]]));
    const before = shared();

    await removeAssistant(paths, a.instance_id, dependencies);

    // A's gateway container went with its OneCLI stack, but not the image it ran, which B's rollback needs.
    expect(docker.of(a).containers).toEqual([]);
    expect(shared()).toEqual(before);
    expect(docker.containers.find((container) => container.id === `${installOf(b)}-gateway`)?.image).toBe(imageId('b'));
    const named = calls.filter((call) =>
      Object.entries(SHARED_IMAGES).some(([reference, id]) => call.includes(reference) || call.includes(id)),
    );
    expect(named).toEqual([]);
  });

  it('keeps the agent image a peer shares until the last assistant whose tag names it is removed', async () => {
    const paths = await testPaths();
    const { a, b, docker, dependencies } = await besidePeer(paths);
    // Both updated to one release, so both run the one image A's update built and labeled, each under its own tag.
    const shared = imageId('4');
    for (const ran of [imageId('1'), imageId('5')]) docker.images.delete(ran);
    docker.image(shared, `${repositoryOf(a)}:r-bbbbbbbb`, `${repositoryOf(b)}:r-bbbbbbbb`);
    docker.containers = docker.containers.map((container) =>
      [imageId('1'), imageId('5')].includes(container.image) ? { ...container, image: shared } : container,
    );

    await removeAssistant(paths, a.instance_id, dependencies);

    expect(docker.of(a).tags).toEqual([]);
    expect([...(docker.images.get(shared) ?? [])]).toEqual([`${repositoryOf(b)}:r-bbbbbbbb`]);
    expect(docker.of(b).tags).toContain(`${repositoryOf(b)}:r-bbbbbbbb`);

    await recordRuntime(paths, b);
    const { uninstallNanoclaw: _uninstall, removeOnecli: _removeOnecli, ...peer } = world(b).dependencies;
    await removeAssistant(paths, b.instance_id, {
      ...peer,
      runCommand: teardownCommands(docker),
      serviceHelpers: nanoclawService([], { mode: 'none', active: false }),
    });

    // With the last tag naming it gone, so is the image; nothing of either assistant's is left.
    expect(docker.images.has(shared)).toBe(false);
    expect([docker.of(a).tags, docker.of(b).tags]).toEqual([[], []]);
    expect([...docker.images.keys()].sort()).toEqual(Object.values(SHARED_IMAGES).sort());
    await expectGone(paths, b);
  });

  it('deletes a displaced image by the ID its record holds, unless another repository still tags it', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    const repository = repositoryOf(input);
    const peerRepository = getInstallScopedNames(randomUUID().replaceAll('-', '')).containerImageBase;
    const olderGroup = imageId('9');
    const identical = imageId('f');
    // Committed, its cleanup still to run: the group's rebuild displaced the group's old image, and an earlier
    // rebuild displaced an identical build another assistant tags.
    await operatedUntil(paths, input, 'update', 'committed', [
      { kind: 'reclaim_image', image_id: olderGroup },
      { kind: 'reclaim_image', image_id: identical },
    ]);
    const docker = new FakeDocker()
      .image(imageId('1'), `${repository}:r-bbbbbbbb`)
      .image(imageId('2'), `${repository}:r-aaaaaaaa`)
      .image(imageId('3'), `${repository}:${AGENT_GROUP}`)
      .image(olderGroup)
      .image(identical, `${peerRepository}:r-bbbbbbbb`);
    const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

    await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      runCommand: teardownCommands(docker),
      serviceHelpers: nanoclawService([], { mode: 'none', active: false }),
    });

    expect([...docker.images]).toEqual([[identical, new Set([`${peerRepository}:r-bbbbbbbb`])]]);
    await expectGone(paths, input);
  });
});

describe('removal in any phase', () => {
  /** Docker holding the assistant's images, containers, and OneCLI project, and the command line of its host. */
  function running(input: InstanceReservationInput, host: string) {
    const docker = new FakeDocker().assistant(
      input,
      { live: imageId('1'), kept: imageId('2'), group: imageId('3') },
      { postgres: imageId('c'), app: imageId('d'), gateway: imageId('a') },
    );
    return { docker, processes: new Set([`/usr/local/bin/node ${host}/dist/index.js`]) };
  }

  it("removes a fenced assistant, finding its host by its root and leaving another assistant's", async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'start_nanoclaw'] });
    const peer = await reserve(paths, reservationInput({ label: 'peer', port: 34_001 }), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    const layout = paths.instanceLayout(input.instance_id);
    await mkdir(layout.release('aaaaaaaa'), { recursive: true, mode: 0o700 });
    await linkReleaseState(layout, 'aaaaaaaa');
    await fence(layout);
    // Each host runs from the release folder the live link named when it started, never through the link.
    const { docker, processes } = running(input, layout.release('aaaaaaaa'));
    const peerHost = `/usr/local/bin/node ${paths.instanceLayout(peer.instance_id).release('aaaaaaaa')}/dist/index.js`;
    processes.add(peerHost);
    const { uninstallNanoclaw: _uninstall, removeOnecli: _removeOnecli, ...dependencies } = world(input).dependencies;

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      runCommand: teardownCommands(docker, [], processes),
      serviceHelpers: nanoclawService([], { mode: 'none', active: false }),
    });

    expect(outcome.removed).toEqual(['nanoclaw', 'chat-subscription', 'instance-files']);
    expect(processes).toEqual(new Set([peerHost]));
    await expectGone(paths, input);
    expect(await exists(paths.markerFile(peer.instance_id))).toBe(true);
  });
});

describe('removal safety', () => {
  it.each(['unknown ID', 'mismatched marker'] as const)(
    'refuses %s before touching either registered assistant',
    async (condition) => {
      const paths = await testPaths();
      const started = ['materialize_checkout', 'start_onecli', 'start_nanoclaw'] as const;
      const first = await reserve(paths, reservationInput(), { started });
      const second = await reserve(paths, reservationInput({ label: 'peer', port: 34_001 }), { started });
      const targetId = condition === 'unknown ID' ? randomUUID() : first.instance_id;
      if (condition === 'mismatched marker') {
        await writeFile(
          paths.markerFile(first.instance_id),
          JSON.stringify({
            schema_version: 1,
            instance_id: second.instance_id,
            deployed_commit: first.deployed_commit,
          }),
          { mode: 0o600 },
        );
      }
      const before = await readFile(paths.registryFile);
      const { dependencies, gcloud } = world(first);

      await expect(removeAssistant(paths, targetId, dependencies)).rejects.toMatchObject({
        code: condition === 'unknown ID' ? 'unknown_instance' : 'marker_mismatch',
      });
      expect(gcloud.calls).toEqual([]);
      expect(dependencies.resolveDocker).not.toHaveBeenCalled();
      expect(dependencies.uninstallNanoclaw).not.toHaveBeenCalled();
      expect(dependencies.removeOnecli).not.toHaveBeenCalled();
      expect(await readFile(paths.registryFile)).toEqual(before);
      expect((await readRegistry(paths)).instances).toEqual({
        [first.instance_id]: first,
        [second.instance_id]: second,
      });
      expect(await exists(paths.removalFile(targetId))).toBe(false);
      expect(await exists(paths.markerFile(second.instance_id))).toBe(true);
    },
  );

  it('refuses before any effect when the checkout exists without its marker', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'provision_gcp'] });
    await rm(paths.markerFile(input.instance_id));
    const { dependencies, gcloud } = world(input);

    await expect(removeAssistant(paths, input.instance_id, dependencies)).rejects.toMatchObject({
      code: 'marker_missing',
    });
    expect(gcloud.calls).toEqual([]);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it('resumes after a failure without repeating completed teardown', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'provision_gcp', 'start_onecli', 'start_nanoclaw'],
    });
    const { dependencies, gcloud } = world(input);
    gcloud.owned();
    const removeOnecli = vi
      .fn<NonNullable<RemovalDependencies['removeOnecli']>>()
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce(undefined);

    await expect(removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli })).rejects.toThrow(
      /docker unavailable/u,
    );
    await removeAssistant(paths, input.instance_id, { ...dependencies, removeOnecli });

    expect(dependencies.uninstallNanoclaw).toHaveBeenCalledOnce();
    expect(gcloud.mutations).toEqual(['projects delete']);
    expect(removeOnecli).toHaveBeenCalledTimes(2);
    await expectGone(paths, input);
  });

  it('signs in once when Google sign-in expired, then continues', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'provision_gcp'] });
    const { dependencies, gcloud, interaction } = world(input);
    gcloud.owned().signedIn = false;

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(interaction.signInToGoogleCloud).toHaveBeenCalledExactlyOnceWith(ACCOUNT);
    expect(gcloud.mutations).toEqual(['projects delete']);
  });

  it.each(['linux', 'macos'] as const)(
    "stops the %s service through NanoClaw's helpers, then cleans up after it at the recorded endpoint",
    async (platform) => {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(), {
        started: ['materialize_checkout', 'start_nanoclaw'],
      });
      const home = path.join(paths.stateRoot, 'home');
      const recorded = 'unix:///run/user/501/docker.sock';
      await writePrivate(paths.runtimeFile(input.instance_id), {
        home_directory: home,
        docker_endpoint: recorded,
      });
      const installId = input.instance_id.replaceAll('-', '');
      const names = getInstallScopedNames(installId);
      const definition =
        platform === 'linux'
          ? path.join(home, '.config', 'systemd', 'user', `${names.systemdUnit}.service`)
          : path.join(home, 'Library', 'LaunchAgents', `${names.launchdLabel}.plist`);
      await mkdir(path.dirname(definition), { recursive: true });
      await writeFile(definition, 'unit', { mode: 0o600 });
      const order: string[] = [];
      const serviceHelpers = nanoclawService(order, {
        mode: platform === 'linux' ? 'systemd-user' : 'launchd',
        active: true,
        name: platform === 'linux' ? names.systemdUnit : names.launchdLabel,
        definition,
      });
      const commands: SanitizedCommand[] = [];
      const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
        commands.push(command);
        order.push(`${command.command} ${command.args[0]}`);
        if (['pkill', 'pgrep'].includes(command.command)) return failed('');
        if (command.args.includes('is-active')) return { stdout: 'inactive\n', stderr: '', exitCode: 3 };
        return ok();
      };
      const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

      await removeAssistant(paths, input.instance_id, { ...dependencies, platform, runCommand, serviceHelpers });

      // Bound to this assistant: its checkout, install, home, and recorded Docker endpoint.
      expect(serviceHelpers.detectService).toHaveBeenCalledWith(
        paths.checkoutRoot(input.instance_id),
        expect.objectContaining({
          platform: platform === 'linux' ? 'linux' : 'darwin',
          home,
          installSlug: installId,
        }),
      );
      expect(serviceHelpers.createCommandRunner).toHaveBeenCalledWith({
        env: expect.objectContaining({ HOME: home, DOCKER_HOST: recorded, NANOCLAW_INSTALL_ID: installId }),
      });
      expect(await exists(definition)).toBe(false);
      // NanoClaw stops the service; the stray-host kill, drain, and container removal follow it.
      expect(order.indexOf('service-stop')).toBe(0);
      expect(order.indexOf('pkill -f')).toBeLessThan(order.indexOf('drain'));
      expect(order.indexOf('drain')).toBeLessThan(order.indexOf('docker ps'));
      const service = commands.filter((command) => ['launchctl', 'systemctl'].includes(command.command));
      if (platform === 'linux') {
        // Disabled as well, so neither login nor boot starts it again.
        expect(service.map((command) => command.args.join(' '))).toEqual([
          `--user disable --now ${names.systemdUnit}.service`,
          `--user is-active ${names.systemdUnit}.service`,
          '--user daemon-reload',
        ]);
        for (const command of service) {
          expect(command.env).toMatchObject({
            XDG_RUNTIME_DIR: expect.any(String),
            DBUS_SESSION_BUS_ADDRESS: expect.any(String),
          });
        }
      } else {
        expect(service).toEqual([]);
      }
      const docker = commands.filter((command) => command.command === 'docker');
      expect(docker.map((command) => command.args.slice(0, 2).join(' '))).toEqual(['ps -aq', 'image ls']);
      for (const command of docker) expect(command.env?.DOCKER_HOST).toBe(recorded);
      await expectGone(paths, input);
    },
  );

  it('cleans up a stray host and a stopped container though no service runs it', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    const { containerInstallLabel } = getInstallScopedNames(input.instance_id.replaceAll('-', ''));
    const order: string[] = [];
    const serviceHelpers = nanoclawService(order, { mode: 'unmanaged', active: true, name: '4242' });
    let host = true;
    let containers = ['stopped123'];
    const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
      const line = `${command.command} ${command.args.join(' ')}`;
      order.push(line);
      if (command.command === 'pkill') {
        host = false;
        return ok();
      }
      if (command.command === 'pgrep') return host ? ok('4242\n') : failed('');
      if (line === `docker ps -aq --filter label=${containerInstallLabel}`) return ok(containers.join('\n'));
      if (line === 'docker rm --force stopped123') {
        containers = [];
        return ok();
      }
      return ok();
    };
    const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

    await removeAssistant(paths, input.instance_id, { ...dependencies, runCommand, serviceHelpers });

    // The host outside the service is not NanoClaw's to stop; the stray-host kill takes it.
    expect(serviceHelpers.stopService).not.toHaveBeenCalled();
    expect(order).toContain('drain');
    expect(order.indexOf('drain')).toBeGreaterThan(order.findIndex((line) => line.startsWith('pkill')));
    expect(order).toContain('docker rm --force stopped123');
    expect(host).toBe(false);
    expect(containers).toEqual([]);
    await expectGone(paths, input);
  });

  /**
   * launchd holding a job under the assistant's label whose plist was deleted
   * outside gws-ea. NanoClaw finds a job by its plist, so its detection sees at
   * most the job's host, running outside any service; its stop, given the
   * job's label, boots the job out and stops its host unless the job `sticks`.
   * A host killed while its job is loaded is only started again.
   */
  function launchdWithoutPlist(
    input: InstanceReservationInput,
    launchd: { loaded: boolean; readonly sticks: boolean },
  ) {
    const label = getInstallScopedNames(installOf(input)).launchdLabel;
    const state = { host: launchd.loaded };
    const order: string[] = [];
    const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
      const line = `${command.command} ${command.args.join(' ')}`;
      order.push(line);
      if (command.command === 'pkill') state.host = launchd.loaded;
      if (command.command === 'pgrep') return state.host ? ok('4242\n') : failed('');
      if (command.command === 'launchctl') throw new Error(`Unexpected command: ${line}`);
      return ok();
    };
    const serviceHelpers = nanoclawService(
      order,
      state.host ? { mode: 'unmanaged', active: true, name: '4242' } : { mode: 'none', active: false },
    );
    serviceHelpers.stopService.mockImplementation(async (handle) => {
      order.push(`service-stop ${handle.name}`);
      if (launchd.sticks) {
        throw new Error(`NanoClaw service ${handle.name} did not stop (PID 4242). Once it has exited, start it again`);
      }
      launchd.loaded = false;
      state.host = false;
    });
    return { label, state, order, runCommand, serviceHelpers };
  }

  async function macosRemoval(paths: ControlPlanePaths) {
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    await writePrivate(paths.runtimeFile(input.instance_id), {
      home_directory: path.join(paths.stateRoot, 'home'),
      docker_endpoint: DOCKER,
    });
    const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;
    return { input, dependencies: { ...dependencies, platform: 'macos' as const } };
  }

  it("stops by its label, through NanoClaw's stop, a launchd job still loaded after its plist was deleted, before killing its host", async () => {
    const paths = await testPaths();
    const { input, dependencies } = await macosRemoval(paths);
    const launchd = { loaded: true, sticks: false };
    const { label, state, order, runCommand, serviceHelpers } = launchdWithoutPlist(input, launchd);

    await removeAssistant(paths, input.instance_id, { ...dependencies, runCommand, serviceHelpers });

    // The job NanoClaw would have detected from its plist, in the environment detection was given.
    const plist = path.join(paths.stateRoot, 'home', 'Library', 'LaunchAgents', `${label}.plist`);
    expect(serviceHelpers.stopService).toHaveBeenCalledExactlyOnceWith(
      { mode: 'launchd', name: label, definition: plist, active: true },
      serviceHelpers.detectService.mock.calls[0]![1],
    );
    expect(order.indexOf(`service-stop ${label}`)).toBeLessThan(order.findIndex((line) => line.startsWith('pkill')));
    expect({ loaded: launchd.loaded, host: state.host }).toEqual({ loaded: false, host: false });
    await expectGone(paths, input);
  });

  it('stops, killing nothing, when a launchd job without its plist stays loaded after its bootout', async () => {
    const paths = await testPaths();
    const { input, dependencies } = await macosRemoval(paths);
    const { order, runCommand, serviceHelpers } = launchdWithoutPlist(input, { loaded: true, sticks: true });

    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, runCommand, serviceHelpers }),
    ).rejects.toMatchObject({ code: 'service_still_running', message: expect.stringContaining('did not stop') });
    expect(order.some((line) => line.startsWith('pkill'))).toBe(false);
    expect(serviceHelpers.drainContainers).not.toHaveBeenCalled();
    expect(await exists(paths.instanceRoot(input.instance_id))).toBe(true);
  });

  it('refuses before any change when it has no NanoClaw service helpers to stop the host with', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    const runCommand = vi.fn(async (): Promise<SanitizedCommandOutcome> => ok());
    const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

    await expect(removeAssistant(paths, input.instance_id, { ...dependencies, runCommand })).rejects.toMatchObject({
      code: 'interactive_setup_unavailable',
    });
    expect(runCommand).not.toHaveBeenCalled();
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
    expect(await exists(paths.instanceRoot(input.instance_id))).toBe(true);
  });

  it.runIf(typeof process.getuid === 'function' && process.getuid() !== 0)(
    'refuses without root when a system unit runs beside the user unit, before stopping or touching either',
    async () => {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(), {
        started: ['materialize_checkout', 'start_nanoclaw'],
      });
      const home = path.join(paths.stateRoot, 'home');
      await writePrivate(paths.runtimeFile(input.instance_id), {
        home_directory: home,
        docker_endpoint: DOCKER,
      });
      const { systemdUnit } = getInstallScopedNames(installOf(input));
      const userUnit = path.join(home, '.config', 'systemd', 'user', `${systemdUnit}.service`);
      await mkdir(path.dirname(userUnit), { recursive: true });
      await writeFile(userUnit, 'user unit', { mode: 0o600 });
      const systemUnit = path.join('/etc/systemd/system', `${systemdUnit}.service`);
      rootOwnedFiles.add(systemUnit);
      const order: string[] = [];
      const serviceHelpers = nanoclawService(order, {
        mode: 'systemd-user',
        active: true,
        name: systemdUnit,
        definition: userUnit,
      });
      const runCommand = vi.fn(async (): Promise<SanitizedCommandOutcome> => ok());
      const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

      await expect(
        removeAssistant(paths, input.instance_id, { ...dependencies, platform: 'linux', runCommand, serviceHelpers }),
      ).rejects.toMatchObject({ code: 'root_required', message: expect.stringContaining(systemUnit) });
      // No service stopped or disabled, no host killed, no container drained, and the user unit still in place.
      expect(serviceHelpers.stopService).not.toHaveBeenCalled();
      expect(runCommand).not.toHaveBeenCalled();
      expect(order).toEqual([]);
      expect(await readFile(userUnit, 'utf8')).toBe('user unit');
      expect(await exists(paths.instanceRoot(input.instance_id))).toBe(true);
    },
  );

  it('waits for a stray NanoClaw host it stopped to go, and names one that never does', async () => {
    for (const goneAfter of [2, Infinity]) {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(), {
        started: ['materialize_checkout', 'start_nanoclaw'],
      });
      let checks = 0;
      const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
        if (command.command !== 'pgrep') return ok();
        checks += 1;
        return checks > goneAfter ? failed('') : ok();
      };
      const sleep = vi.fn(async () => undefined);
      const serviceHelpers = nanoclawService([], { mode: 'none', active: false });
      const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

      const removal = removeAssistant(paths, input.instance_id, {
        ...dependencies,
        runCommand,
        sleep,
        serviceHelpers,
      });
      if (goneAfter === Infinity) {
        await expect(removal).rejects.toMatchObject({
          code: 'nanoclaw_removal_incomplete',
          message: expect.stringContaining('host process is still running'),
        });
        expect(checks).toBe(10);
      } else {
        await removal;
        expect(checks).toBe(3);
        await expectGone(paths, input);
      }
      expect(sleep).toHaveBeenCalledTimes(checks - 1);
    }
  });

  it.each([
    [
      'NanoClaw cannot stop it',
      (helpers: FakeNanoclawService) =>
        helpers.stopService.mockRejectedValueOnce(new Error('Boot-out failed: 5: Input/output error')),
      /Input\/output error/u,
    ],
  ] as const)('stops, keeping the service definition, when %s', async (_why, arrange, reason) => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), {
      started: ['materialize_checkout', 'start_nanoclaw'],
    });
    const home = path.join(paths.stateRoot, 'home');
    await writePrivate(paths.runtimeFile(input.instance_id), {
      home_directory: home,
      docker_endpoint: DOCKER,
    });
    const names = getInstallScopedNames(input.instance_id.replaceAll('-', ''));
    const cookies = path.join(paths.instanceRoot(input.instance_id), 'browser', 'profile', 'Cookies');
    await mkdir(path.dirname(cookies), { recursive: true, mode: 0o700 });
    await writeFile(cookies, 'recoverable profile', { mode: 0o600 });
    const definition = path.join(home, 'Library', 'LaunchAgents', `${names.launchdLabel}.plist`);
    await mkdir(path.dirname(definition), { recursive: true });
    await writeFile(definition, 'plist', { mode: 0o600 });
    const serviceHelpers = nanoclawService([], { mode: 'launchd', active: true, name: names.launchdLabel, definition });
    arrange(serviceHelpers);
    const runCommand = vi.fn(async (): Promise<SanitizedCommandOutcome> => ok());
    const { uninstallNanoclaw: _fake, ...dependencies } = world(input).dependencies;

    await expect(
      removeAssistant(paths, input.instance_id, { ...dependencies, platform: 'macos', runCommand, serviceHelpers }),
    ).rejects.toThrow(reason);
    expect(await exists(definition)).toBe(true);
    expect(await readFile(cookies, 'utf8')).toBe('recoverable profile');
    // Nothing after the service stop ran: no host kill, drain, or container removal.
    expect(runCommand).not.toHaveBeenCalled();
    expect(serviceHelpers.drainContainers).not.toHaveBeenCalled();
  });
});

/** The host's 1Password setup as enabling leaves it: its management service account, token and policy. */
async function onePasswordHost(paths: ControlPlanePaths, provider: FakeOnePassword): Promise<string> {
  const id = providerId('MANAGEMENT', 1);
  const token = 'ops_host-management-service-account-token';
  provider.serviceAccounts.set(id, { id, name: 'GWS-EA management', token, access: 'create_vaults' });
  const host = onePasswordHostPaths(paths.configRoot);
  await writeOnePasswordHostPolicy(host.policyFile, {
    schemaVersion: 2,
    enabled: true,
    accountId: ONEPASSWORD_ACCOUNT,
    signInAddress: 'hale.1password.com',
    cliPath: OP,
    managementServiceAccountId: id,
  });
  await writeFile(host.managementTokenFile, `${token}\n`, { mode: 0o600 });
  return id;
}

let nextProviderId = 10;

/**
 * One assistant's vault and runtime service account, recorded in its instance
 * as provisioning leaves them: `unverified` when its token was captured but
 * never verified, `unproven` when no token was kept from its creation either.
 */
async function assistantVault(
  paths: ControlPlanePaths,
  input: InstanceReservationInput,
  provider: FakeOnePassword,
  options: {
    readonly items?: number;
    readonly creator?: string | 'operator';
    readonly accountId?: string;
    readonly runtime?: 'recorded' | 'unverified' | 'unproven';
  } = {},
) {
  const management = [...provider.serviceAccounts.values()].find((account) => account.access === 'create_vaults');
  const creator = options.creator ?? management?.id ?? providerId('MANAGEMENT', 1);
  const vaultId = providerId('VAULT', (nextProviderId += 1));
  const runtimeId = providerId('RUNTIME', (nextProviderId += 1));
  const token = `ops_runtime-token-${runtimeId}`;
  provider.vaults.set(vaultId, {
    id: vaultId,
    name: `Assistant ${input.exclusive_resource_claims.workspace_email}`,
    creator: creator === 'operator' ? 'operator' : creator,
    grants: new Map(),
    items: options.items ?? 0,
  });
  provider.serviceAccounts.set(runtimeId, { id: runtimeId, name: 'GWS-EA runtime', token, access: vaultId });
  const files = onePasswordInstancePaths(paths.instanceRoot(input.instance_id));
  await mkdir(path.dirname(files.runtimeTokenFile), { recursive: true, mode: 0o700 });
  await writeFile(files.runtimeTokenFile, `${token}\n`, { mode: 0o600 });
  const runtime = options.runtime ?? 'recorded';
  if (runtime === 'unproven') await retireCapturedServiceAccount(files.runtimeTokenFile, 'GWS-EA runtime');
  await writeOnePasswordResources(files.resourceFile, {
    schemaVersion: 2,
    instanceId: input.instance_id,
    accountId: options.accountId ?? ONEPASSWORD_ACCOUNT,
    vault: {
      id: vaultId,
      createdBy:
        creator === 'operator'
          ? { kind: 'operator' }
          : { kind: 'management_service_account', serviceAccountId: creator },
    },
    operatorGrant: null,
    runtimeServiceAccountId: runtime === 'recorded' ? runtimeId : null,
    retiredRuntimeServiceAccountIds: [],
  });
  return { vaultId, runtimeId, tokenFile: files.runtimeTokenFile, resourceFile: files.resourceFile };
}

/**
 * A vault creation cut off before 1Password answered: the provider created
 * the vault, and the instance holds only the intent, with no vault ID.
 */
async function unprovenVault(paths: ControlPlanePaths, input: InstanceReservationInput, provider: FakeOnePassword) {
  const name = `Assistant ${input.exclusive_resource_claims.workspace_email}`;
  const management = [...provider.serviceAccounts.values()].find((account) => account.access === 'create_vaults');
  const vaultId = providerId('VAULT', (nextProviderId += 1));
  provider.vaults.set(vaultId, { id: vaultId, name, creator: management!.id, grants: new Map(), items: 0 });
  const files = onePasswordInstancePaths(paths.instanceRoot(input.instance_id));
  await mkdir(path.dirname(files.resourceFile), { recursive: true, mode: 0o700 });
  await writeFile(
    vaultCreationRecord(files),
    `${JSON.stringify({ schemaVersion: 1, instanceId: input.instance_id, accountId: ONEPASSWORD_ACCOUNT, vaultName: name, startedAt: new Date().toISOString() })}\n`,
    { mode: 0o600 },
  );
  return { name, vaultId };
}

/** The 1Password requests that changed something, as `op` words. */
function vaultDeletions(provider: FakeOnePassword): string[] {
  return provider.calls.map((call) => call.args.join(' ')).filter((call) => call.startsWith('vault delete'));
}

async function receiptOf(paths: ControlPlanePaths, input: InstanceReservationInput) {
  return JSON.parse(await readFile(paths.removalFile(input.instance_id), 'utf8')) as {
    completed: Record<string, string>;
    abandoned: Record<string, { evidence: string }>;
    onepassword?: Record<string, unknown>;
  };
}

describe("removal of the assistant's 1Password resources (KTD9, AE5)", () => {
  const STARTED = ['materialize_checkout', 'start_nanoclaw'] as const;

  async function setUp(options: Parameters<typeof assistantVault>[3] = {}) {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    const management = await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    const vault = await assistantVault(paths, input, provider, options);
    const scene = world(input);
    return {
      paths,
      provider,
      management,
      input,
      vault,
      ...scene,
      dependencies: { ...scene.dependencies, onePassword: provider.cli() },
    };
  }

  it('stops the host before deleting an empty owned vault and the local token, keeping the account to revoke', async () => {
    const { paths, provider, management, input, vault, dependencies, order } = await setUp();
    const atStop: boolean[] = [];
    provider.after = (args) => {
      if (args[0] === 'vault' && args[1] === 'delete') order.push('vault-delete');
    };
    const uninstallNanoclaw = vi.fn(async () => {
      order.push('nanoclaw');
      atStop.push(await exists(vault.tokenFile), provider.vaults.has(vault.vaultId));
    });

    const preview = await describeRemoval(paths, input.instance_id, { onePassword: provider.cli() });
    expect(preview.onepassword).toMatchObject({
      vault_id: vault.vaultId,
      owned: true,
      item_count: 0,
      vault: 'delete',
      runtime_service_account_ids: [vault.runtimeId],
    });

    const outcome = await removeAssistant(paths, input.instance_id, { ...dependencies, uninstallNanoclaw });

    expect(order).toEqual(['nanoclaw', 'vault-delete']);
    // Nothing of 1Password changed before the host stopped.
    expect(atStop).toEqual([true, true]);
    expect(provider.vaults.has(vault.vaultId)).toBe(false);
    expect(vaultDeletions(provider)).toEqual([`vault delete ${vault.vaultId}`]);
    // Removal revokes nothing: the runtime account still works until the operator revokes it.
    expect(provider.serviceAccounts.has(vault.runtimeId)).toBe(true);
    expect(provider.serviceAccounts.has(management)).toBe(true);
    expect(outcome.removed).toEqual(['nanoclaw', 'chat-subscription', 'instance-files']);
    expect(outcome.onepassword).toMatchObject({
      account_id: ONEPASSWORD_ACCOUNT,
      vault_id: vault.vaultId,
      vault: 'deleted',
      item_count: 0,
      runtime_token: 'deleted',
      revoke_service_account_ids: [vault.runtimeId],
      receipt_file: paths.removalFile(input.instance_id),
    });
    // Local removal is complete; the receipt outside the instance keeps the provider-only work.
    expect((await readRegistry(paths)).instances[input.instance_id]).toBeUndefined();
    expect(await exists(paths.instanceRoot(input.instance_id))).toBe(false);
    const receipt = await receiptOf(paths, input);
    expect(receipt.onepassword).toMatchObject({
      account_id: ONEPASSWORD_ACCOUNT,
      vault_id: vault.vaultId,
      vault_creator: management,
      runtime_service_account_ids: [vault.runtimeId],
      vault: { outcome: 'deleted', item_count: 0 },
    });
    expect(String(receipt.onepassword?.operator_action)).toContain(vault.runtimeId);
    expect(String(receipt.onepassword?.operator_action)).toContain('1Password.com');
    expect(JSON.stringify(receipt)).not.toContain('ops_');
  });

  it.each([
    { items: 3, deleteVault: false, vault: 'retained' },
    { items: 3, deleteVault: true, vault: 'deleted' },
  ])(
    'with $items items and deleteVault $deleteVault, the vault is $vault',
    async ({ items, deleteVault, vault: expected }) => {
      const { paths, provider, input, vault, dependencies } = await setUp({ items });

      const preview = await describeRemoval(paths, input.instance_id, { deleteVault, onePassword: provider.cli() });
      expect(preview.onepassword).toMatchObject({
        vault_id: vault.vaultId,
        owned: true,
        item_count: items,
        vault: expected === 'deleted' ? 'delete' : 'retain',
        runtime_service_account_ids: [vault.runtimeId],
      });
      const outcome = await removeAssistant(paths, input.instance_id, { ...dependencies, deleteVault });

      expect(outcome.onepassword).toMatchObject({ vault: expected, item_count: items, runtime_token: 'deleted' });
      expect(provider.vaults.has(vault.vaultId)).toBe(expected === 'retained');
      if (expected === 'retained') {
        expect(vaultDeletions(provider)).toEqual([]);
        expect(provider.vaults.get(vault.vaultId)?.items).toBe(items);
      }
    },
  );

  it.each([
    ['another management account created it', { creator: providerId('MANAGEMENTOLD', 2) }],
    ['the operator created it', { creator: 'operator' }],
    ['it is recorded in another account', { accountId: OTHER_ACCOUNT_ID }],
  ] as const)('keeps a vault, even when deletion was chosen, when %s', async (_label, options) => {
    const { paths, provider, input, vault, dependencies } = await setUp(options);

    const outcome = await removeAssistant(paths, input.instance_id, { ...dependencies, deleteVault: true });

    expect(outcome.onepassword).toMatchObject({
      vault: 'retained',
      item_count: null,
      revoke_service_account_ids: [vault.runtimeId],
    });
    expect(vaultDeletions(provider)).toEqual([]);
    expect(provider.vaults.has(vault.vaultId)).toBe(true);
  });

  it("leaves a peer's vault, token and record and the host's shared management resources untouched", async () => {
    const { paths, provider, management, input, vault, dependencies } = await setUp();
    const peer = await reserve(paths, reservationInput({ label: 'peer', port: 34_001 }), { started: STARTED });
    const peerVault = await assistantVault(paths, peer, provider);
    const host = onePasswordHostPaths(paths.configRoot);
    const policy = await readFile(host.policyFile, 'utf8');
    const managementToken = await readFile(host.managementTokenFile, 'utf8');
    const peerRecord = await readFile(peerVault.resourceFile, 'utf8');

    await removeAssistant(paths, input.instance_id, dependencies);

    expect(provider.vaults.has(vault.vaultId)).toBe(false);
    expect(provider.vaults.has(peerVault.vaultId)).toBe(true);
    expect(provider.serviceAccounts.has(peerVault.runtimeId)).toBe(true);
    expect(provider.serviceAccounts.has(management)).toBe(true);
    expect(await readFile(peerVault.resourceFile, 'utf8')).toBe(peerRecord);
    expect(await exists(peerVault.tokenFile)).toBe(true);
    expect(await readFile(host.policyFile, 'utf8')).toBe(policy);
    expect(await readFile(host.managementTokenFile, 'utf8')).toBe(managementToken);
    expect(
      provider.calls.map((call) => call.args.join(' ')).filter((call) => call.includes(peerVault.vaultId)),
    ).toEqual([]);
  });

  it('keeps a useful receipt when 1Password fails after the host stopped, and resumes from it without instance files', async () => {
    const { paths, provider, input, vault, dependencies } = await setUp();
    provider.before = (args) =>
      args[0] === 'vault' && args[1] === 'delete'
        ? { exitCode: 1, stderr: "[ERROR] (429) Too Many Requests: You've reached the maximum number of requests" }
        : undefined;

    const paused = await removeAssistant(paths, input.instance_id, dependencies).catch((error: unknown) => error);

    expect(paused).toBeInstanceOf(RemovalPause);
    expect(paused).toMatchObject({ resource: 'onepassword' });
    expect(dependencies.uninstallNanoclaw).toHaveBeenCalledOnce();
    const receipt = await receiptOf(paths, input);
    expect(Object.keys(receipt.completed)).toEqual(['nanoclaw', 'chat-subscription']);
    expect(receipt.onepassword).toMatchObject({
      vault_id: vault.vaultId,
      runtime_service_account_ids: [vault.runtimeId],
      runtime_token: { outcome: 'deleted', at: expect.any(String) },
    });
    expect(await exists(vault.tokenFile)).toBe(false);
    expect(provider.vaults.has(vault.vaultId)).toBe(true);

    // The instance's files are lost; the receipt alone still names what to clean up.
    await rm(paths.instanceRoot(input.instance_id), { recursive: true, force: true });
    provider.before = undefined;
    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(dependencies.uninstallNanoclaw).toHaveBeenCalledOnce();
    expect(provider.vaults.has(vault.vaultId)).toBe(false);
    expect(outcome.onepassword).toMatchObject({ vault: 'deleted', revoke_service_account_ids: [vault.runtimeId] });
    expect((await receiptOf(paths, input)).onepassword).toMatchObject({
      runtime_service_account_ids: [vault.runtimeId],
    });
  });

  it('keeps the receipt when a later step fails after the vault was deleted, and never deletes it twice', async () => {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: [...STARTED, 'start_onecli'] });
    const vault = await assistantVault(paths, input, provider);
    const { dependencies } = world(input);
    const removeOnecli = vi
      .fn<NonNullable<RemovalDependencies['removeOnecli']>>()
      .mockRejectedValueOnce(new Error('docker unavailable'))
      .mockResolvedValueOnce(undefined);
    const options = { ...dependencies, removeOnecli, onePassword: provider.cli() };

    await expect(removeAssistant(paths, input.instance_id, options)).rejects.toThrow(/docker unavailable/u);
    const receipt = await receiptOf(paths, input);
    expect(receipt.onepassword).toMatchObject({
      vault: { outcome: 'deleted' },
      runtime_service_account_ids: [vault.runtimeId],
    });

    const outcome = await removeAssistant(paths, input.instance_id, options);
    expect(vaultDeletions(provider)).toHaveLength(1);
    expect(outcome.onepassword).toMatchObject({ vault: 'deleted', revoke_service_account_ids: [vault.runtimeId] });
  });

  it('keeps the vault and names the recovery when the management account expired, and pauses a chosen deletion first', async () => {
    const { paths, provider, management, input, vault, dependencies } = await setUp();
    provider.serviceAccounts.delete(management);
    const host = onePasswordHostPaths(paths.configRoot);

    // A chosen deletion needs the management account, so it pauses before anything changes.
    const paused = await removeAssistant(paths, input.instance_id, { ...dependencies, deleteVault: true }).catch(
      (error: unknown) => error,
    );
    expect(paused).toBeInstanceOf(RemovalPause);
    expect(paused).toMatchObject({ resource: 'onepassword' });
    const pause = paused as RemovalPause;
    expect([pause.message, ...pause.instructions].join('\n')).toContain(management);
    expect([pause.message, ...pause.instructions].join('\n')).toContain(host.managementTokenFile);
    expect(dependencies.uninstallNanoclaw).not.toHaveBeenCalled();
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
    expect(await exists(vault.tokenFile)).toBe(true);

    // By default the vault is kept: its item count cannot be read, and only the account that created it may delete it.
    const outcome = await removeAssistant(paths, input.instance_id, dependencies);
    expect(outcome.onepassword).toMatchObject({ vault: 'retained', item_count: null, runtime_token: 'deleted' });
    expect(outcome.onepassword?.reason).toContain(management);
    expect(provider.vaults.has(vault.vaultId)).toBe(true);
    // No retry ever mints a new management account to stand in for the one that created the vault.
    expect([...provider.serviceAccounts.values()].some((account) => account.access === 'create_vaults')).toBe(false);
    expect(provider.calls.some((call) => call.args[0] === 'service-account')).toBe(false);
  });

  it('leaves a chosen deletion behind on request when the management account cannot be restored', async () => {
    const { paths, provider, management, input, vault, dependencies } = await setUp({ items: 2 });
    provider.serviceAccounts.delete(management);

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      deleteVault: true,
      abandon: new Set(['onepassword']),
    });

    expect(provider.vaults.has(vault.vaultId)).toBe(true);
    expect(outcome.abandoned).toEqual([{ resource: 'onepassword', evidence: expect.stringContaining(vault.vaultId) }]);
    expect(outcome.abandoned[0]?.evidence).toContain(vault.runtimeId);
    // Leaving it behind ends the record: nothing more is tracked for the operator.
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it("closes the record of provider-only work only on the operator's word", async () => {
    const { paths, provider, input, vault, dependencies } = await setUp();
    await removeAssistant(paths, input.instance_id, dependencies);
    const calls = provider.calls.length;

    // Rerun, removal reports the same outstanding revocation and asks nothing of 1Password.
    const again = await removeAssistant(paths, input.instance_id, dependencies);
    expect(again.onepassword).toMatchObject({ vault: 'deleted', revoke_service_account_ids: [vault.runtimeId] });
    expect(provider.calls.length).toBe(calls);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(true);

    const closed = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['onepassword']),
    });
    expect(closed.abandoned).toEqual([{ resource: 'onepassword', evidence: expect.stringContaining(vault.runtimeId) }]);
    expect(closed.onepassword).toMatchObject({ receipt_file: null });
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it('names a vault whose creation was never proven, deletes nothing, and keeps the name until the operator closes it', async () => {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: STARTED });
    const stray = await unprovenVault(paths, input, provider);
    const scene = world(input);
    const dependencies = { ...scene.dependencies, onePassword: provider.cli() };
    const unproven = [{ kind: 'vault', name: stray.name }];

    const preview = await describeRemoval(paths, input.instance_id, { onePassword: provider.cli() });
    expect(preview.onepassword).toMatchObject({ vault_id: null, vault: 'unrecorded', unproven });
    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    expect(outcome.onepassword).toMatchObject({
      account_id: ONEPASSWORD_ACCOUNT,
      vault_id: null,
      vault: 'unrecorded',
      unproven,
      receipt_file: paths.removalFile(input.instance_id),
    });
    // Only its name finds it, so removal never looks for it or deletes it: that is the operator's.
    expect(provider.calls).toEqual([]);
    expect(provider.vaults.has(stray.vaultId)).toBe(true);
    // The intent went with the instance; the receipt outside it still names the vault.
    expect(await exists(paths.instanceRoot(input.instance_id))).toBe(false);
    const receipt = await receiptOf(paths, input);
    expect(receipt.onepassword).toMatchObject({ account_id: ONEPASSWORD_ACCOUNT, vault_id: null, unproven });
    expect(String(receipt.onepassword?.operator_action)).toContain(`"${stray.name}"`);

    const again = await removeAssistant(paths, input.instance_id, dependencies);
    expect(again.onepassword).toMatchObject({ unproven, receipt_file: paths.removalFile(input.instance_id) });
    const closed = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['onepassword']),
    });
    expect(closed.abandoned).toEqual([{ resource: 'onepassword', evidence: expect.stringContaining(stray.name) }]);
    expect(closed.onepassword).toMatchObject({ receipt_file: null });
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
    expect(provider.vaults.has(stray.vaultId)).toBe(true);
  });

  it.each([
    ['a runtime token it never verified', 'unverified'],
    ['a runtime account whose creation was never proven', 'unproven'],
  ] as const)('names %s, revokes nothing, and keeps the name until the operator closes it', async (_label, runtime) => {
    const { paths, provider, input, vault, dependencies } = await setUp({ runtime });
    const name = `GWS-EA ${input.instance_id.slice(0, 8)} ${input.exclusive_resource_claims.workspace_email}`;
    const unproven = [{ kind: 'service_account', name }];

    const outcome = await removeAssistant(paths, input.instance_id, dependencies);

    // The recorded vault settles as ever; the account 1Password may hold has no ID, so only its name is kept.
    expect(outcome.onepassword).toMatchObject({
      vault_id: vault.vaultId,
      vault: 'deleted',
      runtime_token: runtime === 'unverified' ? 'deleted' : 'absent',
      revoke_service_account_ids: [],
      unproven,
      receipt_file: paths.removalFile(input.instance_id),
    });
    expect(provider.serviceAccounts.has(vault.runtimeId)).toBe(true);
    expect(await exists(paths.instanceRoot(input.instance_id))).toBe(false);
    const receipt = await receiptOf(paths, input);
    expect(receipt.onepassword).toMatchObject({ runtime_service_account_ids: [], unproven });
    expect(String(receipt.onepassword?.operator_action)).toContain(`"${name}"`);
    expect(JSON.stringify(receipt)).not.toContain('ops_');

    const closed = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['onepassword']),
    });
    expect(closed.abandoned).toEqual([{ resource: 'onepassword', evidence: expect.stringContaining(name) }]);
    expect(closed.onepassword).toMatchObject({ receipt_file: null });
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it('pauses before any change on a 1Password record it cannot read, and leaves it behind only on request', async () => {
    const { paths, input, vault, dependencies } = await setUp();
    await writeFile(vault.resourceFile, '{"schemaVersion": 2,', { mode: 0o600 });

    const paused = await removeAssistant(paths, input.instance_id, dependencies).catch((error: unknown) => error);
    expect(paused).toBeInstanceOf(RemovalPause);
    expect(paused).toMatchObject({ resource: 'onepassword' });
    expect(dependencies.uninstallNanoclaw).not.toHaveBeenCalled();

    const outcome = await removeAssistant(paths, input.instance_id, {
      ...dependencies,
      abandon: new Set(['onepassword']),
    });
    expect(outcome.abandoned).toEqual([
      { resource: 'onepassword', evidence: expect.stringContaining(vault.resourceFile) },
    ]);
    await expectGone(paths, input);
  });
});

describe('removal command', () => {
  function cliRuntime(paths: ControlPlanePaths, output: string[], extra: Partial<CliRuntime> = {}): CliRuntime {
    return { paths, stdout: (line) => output.push(line), stderr: () => undefined, ...extra };
  }

  it('previews removal and defaults to leaving the assistant unchanged', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput());
    const output: string[] = [];
    const remove = vi.fn();

    const exitCode = await runCli(
      ['remove', '--id', input.instance_id],
      cliRuntime(paths, output, { removeAssistant: remove, confirmRemoval: async () => false }),
    );

    expect(exitCode).toBe(0);
    // Scope and consequences are visible before consent; a decline names read-only inspection.
    expect(output.slice(output.indexOf(`Assistant: ${input.instance_id}`))).toEqual([
      `Assistant: ${input.instance_id}`,
      `NanoClaw: ${paths.checkoutRoot(input.instance_id)}`,
      `OneCLI: ${input.exclusive_resource_claims.onecli_project}`,
      `Google Cloud project: ${input.exclusive_resource_claims.gcp_project_id} (${ACCOUNT})`,
      'Permanently tears down this assistant’s recorded local resources and requests project deletion; its subscription and credentials are removed within their existing ownership rules.',
      'Removal cancelled. Nothing was changed.',
      `Assistant: ${input.instance_id}`,
      `Next: gws-ea status --id ${input.instance_id}`,
    ]);
    expect(remove).not.toHaveBeenCalled();
  });

  it('supports an explicit non-interactive confirmation and names what was abandoned', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput());
    const output: string[] = [];
    const remove = vi.fn(async () => ({
      removed: ['instance-files' as const],
      abandoned: [{ resource: 'gcp-project' as const, evidence: 'denied' }],
    }));

    expect(
      await runCli(
        ['remove', '--id', input.instance_id, '--yes', '--abandon', 'gcp-project'],
        cliRuntime(paths, output, {
          removeAssistant: remove,
          confirmRemoval: async () => {
            throw new Error('confirmation must be skipped');
          },
        }),
      ),
    ).toBe(0);
    expect(remove).toHaveBeenCalledWith(
      paths,
      input.instance_id,
      expect.objectContaining({ abandon: new Set(['gcp-project']) }),
    );
    expect(output.join('\n')).toContain(
      `Left behind: Google Cloud project ${input.exclusive_resource_claims.gcp_project_id}`,
    );
  });

  it("previews the vault's items and token cleanup, takes a deletion choice in the same confirmation, and a decline changes nothing", async () => {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'start_nanoclaw'] });
    const vault = await assistantVault(paths, input, provider, { items: 3 });
    const confirmations: unknown[] = [];
    const remove = vi.fn();
    const run = async (args: readonly string[]) => {
      const output: string[] = [];
      const code = await runCli(
        ['remove', '--id', input.instance_id, ...args],
        cliRuntime(paths, output, {
          onePassword: provider.cli(),
          removeAssistant: remove,
          confirmRemoval: async (preview) => {
            confirmations.push(preview);
            return false;
          },
        }),
      );
      return { code, text: output.join('\n') };
    };

    const kept = await run([]);
    expect(kept.code).toBe(0);
    expect(kept.text).toContain(`1Password vault ${vault.vaultId} in account ${ONEPASSWORD_ACCOUNT}`);
    expect(kept.text).toContain('Kept in 1Password with its 3 items');
    expect(kept.text).toContain('--delete-vault');
    expect(kept.text).toContain(vault.runtimeId);
    expect(kept.text).toContain('Removal cancelled. Nothing was changed.');

    const deleting = await run(['--delete-vault']);
    expect(deleting.code).toBe(0);
    expect(deleting.text).toContain('Deleted with this removal, with its 3 items');
    expect(confirmations).toEqual([
      expect.objectContaining({ onepassword: expect.objectContaining({ vault: 'retain', item_count: 3 }) }),
      expect.objectContaining({ onepassword: expect.objectContaining({ vault: 'delete', item_count: 3 }) }),
    ]);
    expect(remove).not.toHaveBeenCalled();
    expect(provider.vaults.get(vault.vaultId)?.items).toBe(3);
    expect(vaultDeletions(provider)).toEqual([]);
    expect(await exists(vault.tokenFile)).toBe(true);
    expect(await exists(paths.removalFile(input.instance_id))).toBe(false);
  });

  it('says what removal deleted, kept and left to the operator, through the published contract, claiming no revocation', async () => {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'start_nanoclaw'] });
    const vault = await assistantVault(paths, input, provider, { items: 2 });
    const scene = world(input);
    const output: string[] = [];
    const removal = (args: readonly string[]) =>
      runCli(['remove', '--id', input.instance_id, '--yes', ...args], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        onePassword: provider.cli(),
        removeAssistant: (removalPaths, id, options) =>
          removeAssistant(removalPaths, id, { ...scene.dependencies, ...options, interaction: scene.interaction }),
      });

    expect(await removal(['--json'])).toBe(0);
    const result = JSON.parse(output.join('\n')) as {
      next_actions: unknown[];
      data: { removal: { onepassword: Record<string, unknown> } };
    };
    expectResultContract('remove', result);
    expect(result.data.removal.onepassword).toMatchObject({
      vault: 'retained',
      item_count: 2,
      runtime_token: 'deleted',
      revoke_service_account_ids: [vault.runtimeId],
    });
    expect(result.next_actions).toEqual([
      { kind: 'external', instruction: expect.stringContaining(vault.runtimeId) },
      { kind: 'command', argv: ['gws-ea', 'remove', '--id', input.instance_id, '--yes', '--abandon', 'onepassword'] },
    ]);

    output.length = 0;
    expect(await removal([])).toBe(0);
    const text = output.join('\n');
    expect(text).toContain(`1Password vault ${vault.vaultId}: kept in account ${ONEPASSWORD_ACCOUNT} with its 2 items`);
    expect(text).toContain('Runtime token: deleted from this host.');
    expect(text).toContain(`Not revoked: service account ${vault.runtimeId}`);
    expect(text).not.toMatch(/\brevoked (?:it|them|service)/iu);
    expect(text).not.toContain('ops_');
  });

  it('names a creation never proven in the preview, the published contract and the text, with the step that closes it', async () => {
    const paths = await testPaths();
    const provider = new FakeOnePassword();
    await onePasswordHost(paths, provider);
    const input = await reserve(paths, reservationInput(), { started: ['materialize_checkout', 'start_nanoclaw'] });
    const stray = await unprovenVault(paths, input, provider);
    const scene = world(input);
    const output: string[] = [];
    const removal = (args: readonly string[]) =>
      runCli(['remove', '--id', input.instance_id, '--yes', ...args], {
        paths,
        stdout: (line) => output.push(line),
        stderr: () => undefined,
        onePassword: provider.cli(),
        removeAssistant: (removalPaths, id, options) =>
          removeAssistant(removalPaths, id, { ...scene.dependencies, ...options, interaction: scene.interaction }),
      });

    expect(await removal(['--json'])).toBe(0);
    const result = JSON.parse(output.join('\n')) as {
      next_actions: unknown[];
      data: { preview: { onepassword: Record<string, unknown> }; removal: { onepassword: Record<string, unknown> } };
    };
    expectResultContract('remove', result);
    const unproven = [{ kind: 'vault', name: stray.name }];
    expect(result.data.preview.onepassword).toMatchObject({ vault_id: null, vault: 'unrecorded', unproven });
    expect(result.data.removal.onepassword).toMatchObject({ vault_id: null, vault: 'unrecorded', unproven });
    expect(result.next_actions).toEqual([
      { kind: 'external', instruction: expect.stringContaining(`"${stray.name}"`) },
      { kind: 'command', argv: ['gws-ea', 'remove', '--id', input.instance_id, '--yes', '--abandon', 'onepassword'] },
    ]);

    output.length = 0;
    expect(await removal([])).toBe(0);
    const text = output.join('\n');
    expect(text).toContain(`1Password account ${ONEPASSWORD_ACCOUNT}`);
    expect(text).toContain(`1Password vault: none recorded in account ${ONEPASSWORD_ACCOUNT}.`);
    expect(text).toContain(`Never proven: vault "${stray.name}" may exist`);
    expect(text).toContain(`gws-ea remove --id ${input.instance_id} --yes --abandon onepassword`);
    expect(provider.vaults.has(stray.vaultId)).toBe(true);
  });

  it('rejects an unknown resource to abandon before anything runs', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput());
    const errors: string[] = [];
    const remove = vi.fn();

    expect(
      await runCli(['remove', '--id', input.instance_id, '--yes', '--abandon', 'registry'], {
        paths,
        stdout: () => undefined,
        stderr: (line) => errors.push(line),
        removeAssistant: remove,
      }),
    ).toBe(2);
    expect(errors[0]).toBe(
      '--abandon: "registry" cannot be abandoned; choose from gcp-project, chat-subscription, onepassword',
    );
    expect(remove).not.toHaveBeenCalled();
  });
});

async function linkedWhatsApp(paths: ControlPlanePaths, input: InstanceReservationInput) {
  const directory = path.join(paths.instanceRoot(input.instance_id), 'secrets/whatsapp');
  await claimInstanceWhatsApp(paths, input.instance_id, '+15550000000');
  await writeWhatsAppLink(directory, {
    schema_version: 1,
    state: 'connected',
    number: '+15550000000',
    account: { lid: '999000', phoneJid: '15550000000@s.whatsapp.net' },
  });
  const auth = new WhatsAppAuthStore(directory);
  auth.saveCreds({ registered: true, me: { id: '15550000000:1@s.whatsapp.net', name: 'Aya' } });
  auth.close();
  const reserved = (await readRegistry(paths)).instances[input.instance_id]!;
  const onecli = createOnecliRuntimeLayout({
    instanceId: input.instance_id,
    instanceRoot: paths.instanceRoot(input.instance_id),
    project: input.exclusive_resource_claims.onecli_project,
    appPort: input.allocated_ports.onecli_app,
    gatewayPort: input.allocated_ports.onecli_gateway,
    dockerEndpoint: DOCKER,
  });
  await persistInstanceRuntime(
    createInstanceRuntimeConfig(paths, reserved, onecli, {
      nodePath: process.execPath,
      homeDirectory: paths.stateRoot,
      selectedProvider: 'claude',
      dockerEndpoint: DOCKER,
    }),
    () => undefined,
  );
  return directory;
}
describe('WhatsApp removal', () => {
  it('keeps the full reservation check when unlink is accompanied by an unrelated registry mutation', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw'] });
    await linkedWhatsApp(paths, input);
    const removal = world(input);
    await expect(
      removeAssistant(paths, input.instance_id, {
        ...removal.dependencies,
        ncl: async () => {
          await claimInstanceWhatsApp(paths, input.instance_id, undefined);
          await claimInstanceAlias(paths, input.instance_id, 'other-alias@example.test');
          return { state: 'unlinked' };
        },
      }),
    ).rejects.toMatchObject({ code: 'reservation_mismatch' });
    expect((await readRegistry(paths)).instances[input.instance_id]?.exclusive_resource_claims.alias_email).toBe(
      'other-alias@example.test',
    );
  });
  it('does not skip missing credentials while the known WhatsApp number claim is still owned', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw'] });
    const directory = await linkedWhatsApp(paths, input);
    await rm(path.join(directory, 'auth.sqlite'));
    const removal = world(input);
    await expect(
      removeAssistant(paths, input.instance_id, {
        ...removal.dependencies,
        ncl: async () => {
          throw new Error('Host unavailable');
        },
      }),
    ).rejects.toThrow('WhatsApp credentials are missing');
    expect(await exists(path.join(directory, 'link.json'))).toBe(true);
    expect((await readRegistry(paths)).instances[input.instance_id]?.exclusive_resource_claims.whatsapp_number).toBe(
      '+15550000000',
    );
  });
  it.each(['after-claim', 'lost-response'] as const)(
    'recovers actual native unlink interrupted %s without adopting other reservation changes',
    async (boundary) => {
      const paths = await testPaths();
      const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw'] });
      const directory = await linkedWhatsApp(paths, input);
      const removal = world(input);
      const owner = new WhatsAppLinking({ directory, paths, instanceId: input.instance_id });
      const socket = new FakeSocket();
      const unexpectedSocket = vi.fn(() => {
        throw new Error('A completed native logout must not reconnect');
      });
      const ncl = vi.fn(async () => {
        await logoutWhatsAppAccount({
          directory,
          resolveVersion: async () => [2, 3000, 123456],
          makeSocket: () => {
            queueMicrotask(() => {
              void socket.emit('connection.update', { connection: 'open' });
            });
            return socket;
          },
        });
        const nativeRm = privateFiles.rm;
        const injected = vi.spyOn(privateFiles, 'rm').mockImplementation(async (...args) => {
          if (boundary === 'after-claim' && String(args[0]) === path.join(directory, 'auth.sqlite'))
            throw new Error('Auth cleanup interrupted after claim release');
          await nativeRm(...args);
        });
        try {
          await owner.unlink();
        } finally {
          injected.mockRestore();
        }
        throw new Error('Native unlink finished but ncl response was lost');
      });
      try {
        await removeAssistant(paths, input.instance_id, {
          ...removal.dependencies,
          ncl,
          whatsapp: { makeSocket: unexpectedSocket },
        });
        expect(ncl).toHaveBeenCalledTimes(1);
        expect(unexpectedSocket).not.toHaveBeenCalled();
        expect(socket.loggedOut).toBe(true);
        expect(socket.ended).toBe(true);
        expect(removal.order).toEqual(['nanoclaw']);
        await expectGone(paths, input);
      } finally {
        owner.close();
      }
    },
  );
  it('unlinks through the running host before stopping it, deletes private state, and releases the number for another assistant', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw'] });
    const directory = await linkedWhatsApp(paths, input);
    const removal = world(input);
    const outcome = await removeAssistant(paths, input.instance_id, {
      ...removal.dependencies,
      ncl: async (_runtime, args) => {
        expect(args).toEqual(['gws-ea-whatsapp', 'unlink']);
        removal.order.push('whatsapp-unlink');
        await claimInstanceWhatsApp(paths, input.instance_id, undefined);
        return { state: 'unlinked' };
      },
    });
    expect(removal.order).toEqual(['whatsapp-unlink', 'nanoclaw']);
    expect(outcome.removed).toContain('whatsapp');
    expect(await exists(directory)).toBe(false);
    const peer = await reserve(paths, reservationInput({ label: 'peer', port: 39000 }));
    await expect(claimInstanceWhatsApp(paths, peer.instance_id, '+15550000000')).resolves.toMatchObject({
      exclusive_resource_claims: { whatsapp_number: '+15550000000' },
    });
  });
  it('signs out after verified offline teardown, and resumes a later failure from its durable receipt without a new socket', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw', 'start_onecli'] });
    const directory = await linkedWhatsApp(paths, input);
    const removal = world(input);
    let socket: FakeSocket | undefined;
    const ncl = vi.fn(async () => {
      throw new Error('Host socket is unavailable');
    });
    const makeSocket = vi.fn(() => {
      socket = new FakeSocket();
      return socket;
    });
    const removeOnecli = vi.fn(async () => {
      if (removeOnecli.mock.calls.length === 1) throw new Error('OneCLI teardown interrupted');
    });
    const dependencies = {
      ...removal.dependencies,
      ncl,
      removeOnecli,
      whatsapp: { makeSocket, resolveVersion: async (): Promise<[number, number, number]> => [2, 3000, 123456] },
    };
    const pending = removeAssistant(paths, input.instance_id, dependencies);
    const refusal = expect(pending).rejects.toThrow('OneCLI teardown interrupted');
    await vi.waitFor(() => expect(socket).toBeDefined());
    expect(removal.order).toEqual(['nanoclaw']);
    expect((await readRegistry(paths)).instances[input.instance_id]?.exclusive_resource_claims.whatsapp_number).toBe(
      '+15550000000',
    );
    await socket!.emit('connection.update', { connection: 'open' });
    await refusal;
    expect(socket!.loggedOut).toBe(true);
    expect(socket!.ended).toBe(true);
    const receipt = JSON.parse(await readFile(paths.removalFile(input.instance_id), 'utf8')) as {
      completed: Record<string, string>;
    };
    expect(Object.keys(receipt.completed)).toEqual(['nanoclaw', 'whatsapp', 'chat-subscription']);
    expect(await exists(directory)).toBe(true);
    await removeAssistant(paths, input.instance_id, dependencies);
    expect(ncl).toHaveBeenCalledTimes(1);
    expect(makeSocket).toHaveBeenCalledTimes(1);
    expect(removal.order).toEqual(['nanoclaw']);
    await expectGone(paths, input);
  });
  it('keeps registered state and the number claim after a failed native logout, with a peer assistant untouched', async () => {
    const paths = await testPaths();
    const input = await reserve(paths, reservationInput(), { started: ['start_nanoclaw'] });
    const directory = await linkedWhatsApp(paths, input);
    const removal = world(input);
    const peer = await reserve(paths, reservationInput({ label: 'peer', port: 39000 }));
    const peerFile = path.join(paths.instanceRoot(peer.instance_id), 'private-peer');
    await writeFile(peerFile, 'Peer must remain unchanged');
    const peerBefore = await readFile(peerFile);
    const peerRegistry = (await readRegistry(paths)).instances[peer.instance_id];
    let socket: FakeSocket | undefined;
    const pending = removeAssistant(paths, input.instance_id, {
      ...removal.dependencies,
      ncl: async () => {
        throw new Error('Host unavailable');
      },
      whatsapp: {
        resolveVersion: async (): Promise<[number, number, number]> => [2, 3000, 123456],
        makeSocket: () => {
          socket = new FakeSocket();
          vi.spyOn(socket, 'logout').mockRejectedValueOnce(new Error('Native logout refused'));
          return socket;
        },
      },
    });
    const refusal = expect(pending).rejects.toThrow('Native logout refused');
    await vi.waitFor(() => expect(socket).toBeDefined());
    await socket!.emit('connection.update', { connection: 'open' });
    await refusal;
    const retained = new WhatsAppAuthStore(directory);
    expect(retained.state.creds.registered).toBe(true);
    retained.close();
    expect(socket!.ended).toBe(true);
    expect(await exists(path.join(directory, 'link.json'))).toBe(true);
    expect((await readRegistry(paths)).instances[input.instance_id]?.exclusive_resource_claims.whatsapp_number).toBe(
      '+15550000000',
    );
    expect(await readFile(peerFile)).toEqual(peerBefore);
    expect((await readRegistry(paths)).instances[peer.instance_id]).toEqual(peerRegistry);
  });
});
