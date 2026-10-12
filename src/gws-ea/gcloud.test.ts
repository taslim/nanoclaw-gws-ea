import { randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { SignInRequired, type RunEvent } from './events.js';
import { RECORDED_GCLOUD_REAUTHENTICATION_FAILED } from './fixtures/recordings.js';
import {
  assertGcloudSignedIn,
  classifyGcloudFailure,
  deleteOwnedGcpProject,
  googleCloudResources,
  isConsumerGoogleAccount,
  parseGchatServiceAccountCredential,
  restoreKeyCreationPolicyForRemoval,
  type GcloudCommandRunner,
  type GcloudFailureClass,
  type GcpProjectCoordinates,
  type GcpProjectInput,
  type GcpStepContext,
} from './gcloud.js';
import {
  deriveGchatEventsSubscription,
  deriveGchatEventsTopic,
  deriveGchatServiceAccountEmail,
  deriveGcpClaims,
  deriveGcpProjectId,
  GCHAT_EVENTS_SUBSCRIPTION_ID,
  GCHAT_EVENTS_TOPIC_ID,
} from './gcp-identity.js';
import { readProvisionJournal, reserveInstance, withInstanceOperation, type ProvisionJournal } from './journal.js';
import { resolveControlPlanePaths } from './paths.js';
import {
  OBSERVATION_WAITS_SECONDS,
  PRESENT,
  runProvisionSteps,
  type ProvisionHumanPause,
  type ProvisionResult,
  type ProvisionStep,
  type ProvisionSteps,
} from './phases.js';
import type { SanitizedCommandOutcome } from './process.js';

import { PROVISION_STEPS } from './types.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-gcloud-'));
  roots.push(root);
  return root;
}

const ACCOUNT = 'operator@example.com';
const FULL_WAIT = OBSERVATION_WAITS_SECONDS.map((seconds) => seconds * 1_000);
const KEY_CONSTRAINTS = ['iam.disableServiceAccountKeyCreation', 'iam.managed.disableServiceAccountKeyCreation'];
/** Domain restricted sharing: the legacy list constraint, then the managed one. */
const MEMBER_CONSTRAINTS = ['iam.allowedPolicyMemberDomains', 'iam.managed.allowedPolicyMembers'];
const CHAT_PUBLISHER = 'serviceAccount:chat-api-push@system.gserviceaccount.com';
const BILLING_ACCOUNT = '01A2B3-C4D5E6-F70819';
const SECOND_BILLING_ACCOUNT = '0F1E2D-3C4B5A-697887';
const CLOSED_BILLING_ACCOUNT = '00AA11-22BB33-44CC55';
const REQUIRED_APIS = [
  'chat.googleapis.com',
  'iam.googleapis.com',
  'orgpolicy.googleapis.com',
  'pubsub.googleapis.com',
  'workspaceevents.googleapis.com',
];
/** The pull subscription's settings, as its create flags set them. */
const SUBSCRIPTION_SETTINGS = {
  topic: GCHAT_EVENTS_TOPIC_ID,
  'ack-deadline': '60',
  'message-retention-duration': '7d',
  'expiration-period': 'never',
  'retain-acked-messages': false,
};

// Recorded live (fixtures/README.md): an expired sign-in, behind the Python warning that gcloud prints first.
const REAUTHENTICATION_FAILED = RECORDED_GCLOUD_REAUTHENTICATION_FAILED.stderr;
const PYTHON_WARNING = REAUTHENTICATION_FAILED.slice(0, REAUTHENTICATION_FAILED.indexOf('ERROR:'));
// gcloud stderr in the Cloud SDK's wordings, not recorded live.
const TOKEN_REFRESH_FAILED = [
  `ERROR: (gcloud.projects.describe) There was a problem refreshing auth tokens for account ${ACCOUNT}: ('invalid_grant: Bad Request', {'error': 'invalid_grant', 'error_description': 'Bad Request'})`,
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');
const NO_ACTIVE_ACCOUNT = [
  'ERROR: (gcloud.projects.list) You do not currently have an active account selected.',
  'Please run:',
  '',
  '  $ gcloud auth login',
  '',
  'to obtain new credentials.',
].join('\n');
const CONNECTION_FAILED =
  'ERROR: (gcloud.auth.print-access-token) There was a problem connecting: [Errno 8] nodename nor servname provided, or not known';
const GCLOUD_CRASHED = [
  'ERROR: gcloud crashed (TypeError): unsupported operand type(s) for +: NoneType and str',
  '',
  'If you would like to report this issue, please run the following command:',
  '  gcloud feedback',
].join('\n');

// Google's documented answer when domain restricted sharing refuses a member (constraints/iam.allowedPolicyMemberDomains).
const DOMAIN_RESTRICTED =
  'ERROR: (gcloud.pubsub.topics.add-iam-policy-binding) FAILED_PRECONDITION: One or more users named in the policy do not belong to a permitted customer.';
// The same refusal naming its constraint, in the shape of Google's PreconditionFailure; not recorded live.
const MANAGED_MEMBERS_REFUSED = [
  'ERROR: (gcloud.pubsub.topics.add-iam-policy-binding) FAILED_PRECONDITION: One or more users named in the policy do not belong to a permitted customer.',
  "- '@type': type.googleapis.com/google.rpc.PreconditionFailure",
  '  violations:',
  `  - subject: orgpolicy:projects/p?configvalue=${encodeURIComponent(CHAT_PUBLISHER)}`,
  '    type: constraints/iam.managed.allowedPolicyMembers',
].join('\n');
/** What Google answers a grant to Google Chat's publisher that each member-domain constraint refuses. */
const MEMBER_REFUSALS: Readonly<Record<string, string>> = {
  'iam.allowedPolicyMemberDomains': DOMAIN_RESTRICTED,
  'iam.managed.allowedPolicyMembers': MANAGED_MEMBERS_REFUSED,
};

// gcloud's answer for a policy the project does not have of its own (describe recorded live, for both constraints).
function policyNotFound(verb: 'describe' | 'delete', constraint: string): string {
  return [
    `ERROR: (gcloud.org-policies.${verb}) NOT_FOUND: A Policy of constraint constraints/${constraint} on resource projects/472476071913 does not exist. This command is authenticated as ${ACCOUNT} which is the active account specified by the [core/account] property.`,
    "- '@type': type.googleapis.com/google.rpc.ErrorInfo",
    '  domain: orgpolicy.googleapis.com',
    '  reason: POLICY_NOT_FOUND',
  ].join('\n');
}

function policyChangeDenied(verb: 'set-policy' | 'delete', permission: string, projectId: string): string {
  return `ERROR: (gcloud.org-policies.${verb}) PERMISSION_DENIED: Permission '${permission}' denied on resource '//cloudresourcemanager.googleapis.com/projects/${projectId}' (or it may not exist).`;
}

/** The command that grants Google Chat's publisher the topic, as the fake records it. */
function publisherGrant(projectId: string): string {
  return `pubsub topics add-iam-policy-binding gws-ea-chat-events --member=${CHAT_PUBLISHER} --role=roles/pubsub.publisher --project=${projectId}`;
}

function projectNotVisible(projectId: string): string {
  return `ERROR: (gcloud.projects.describe) [${ACCOUNT}] does not have permission to access projects instance [${projectId}] (or it may not exist): The caller does not have permission. This command is authenticated as ${ACCOUNT} which is the active account specified by the [core/account] property.`;
}

function keyCreationRefused(projectId: string, email: string, constraint: string): string {
  return [
    'ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Key creation is not allowed on this service account.',
    "- '@type': type.googleapis.com/google.rpc.PreconditionFailure",
    '  violations:',
    '  - description: Key creation is not allowed on this service account.',
    `    subject: projects/${projectId}?configvalue=${email}`,
    `    type: constraints/${constraint}`,
  ].join('\n');
}

function ok(stdout = '', stderr = ''): SanitizedCommandOutcome {
  return { stdout, stderr, exitCode: 0 };
}

function failed(stderr: string): SanitizedCommandOutcome {
  return { stdout: '', stderr, exitCode: 1 };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

/** An IAM policy as `gcloud ... get-iam-policy --format=json` prints it; gcloud omits empty bindings. */
function iamPolicy(policy: ReadonlyMap<string, ReadonlySet<string>>): Record<string, unknown> {
  if (policy.size === 0) return { etag: 'ACAB' };
  return {
    bindings: [...policy].map(([role, members]) => ({ members: [...members].sort(), role })),
    etag: 'BwYlr1x3b2s=',
    version: 1,
  };
}

/** The member and role of `gcloud pubsub ... add-iam-policy-binding ID --member=M --role=R --project=P`. */
function binding(words: readonly string[]): { member: string; role: string } {
  const flag = (name: string): string => {
    const prefix = `--${name}=`;
    const word = words.find((candidate) => candidate.startsWith(prefix));
    if (!word) throw new Error(`Missing ${prefix}`);
    return word.slice(prefix.length);
  };
  return { member: flag('member'), role: flag('role') };
}

/** A service-account key file as `gcloud iam service-accounts keys create` writes it. */
function keyFile(projectId: string, email: string, keyId: string, extra: Record<string, unknown> = {}): string {
  return json({
    type: 'service_account',
    project_id: projectId,
    private_key_id: keyId,
    private_key:
      '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC7\n-----END PRIVATE KEY-----\n',
    client_email: email,
    client_id: '104285714592231180044',
    auth_uri: 'https://accounts.google.com/o/oauth2/auth',
    token_uri: 'https://oauth2.googleapis.com/token',
    auth_provider_x509_cert_url: 'https://www.googleapis.com/oauth2/v1/certs',
    client_x509_cert_url: `https://www.googleapis.com/robot/v1/metadata/x509/${encodeURIComponent(email)}`,
    universe_domain: 'googleapis.com',
    ...extra,
  });
}

/**
 * One Google Cloud organization as gcloud reports it. It answers only the
 * exact commands an operator could rerun from the log, run as the reserved
 * account and non-interactively, and holds the state those commands change.
 */
class FakeGoogleCloud {
  project: { labels: Record<string, string>; lifecycleState: string } | undefined;
  /** Describes that still answer 403 for a project that exists, while access propagates. */
  hiddenProjectReads = 0;
  readonly enabled = new Set([
    'bigquery.googleapis.com',
    'cloudapis.googleapis.com',
    'logging.googleapis.com',
    'monitoring.googleapis.com',
    'serviceusage.googleapis.com',
    'storage.googleapis.com',
  ]);
  /** The billing accounts the reserved account can see. */
  billingAccounts: { id: string; displayName: string; open: boolean }[] = [
    { id: BILLING_ACCOUNT, displayName: 'Ellery Household', open: true },
  ];
  linkedBillingAccount: string | undefined;
  topic = false;
  /** Lists that still omit the topic after it was created. */
  unlistedTopicReads = 0;
  /** Topic creations Google refuses while it sets up a new project's organization policy. */
  initializingPolicyCreates = 0;
  /** The pull subscription, as the flags it was created with set it. */
  subscription: Record<string, string | boolean> | undefined;
  readonly topicPolicy = new Map<string, Set<string>>();
  readonly subscriptionPolicy = new Map<string, Set<string>>();
  /** Subscriber grants Google still refuses after the account was created, until IAM knows it. */
  unknownMemberGrants = 0;
  serviceAccount: { displayName: string; description: string } | undefined;
  /** Lists that still omit the subscriber account after it was created. */
  unlistedServiceAccountReads = 0;
  /** Key lists that still answer NOT_FOUND after the subscriber account was created. */
  unresolvedKeyReads = 0;
  /** Key lists that still omit the key Google created last. */
  unlistedNewKeyReads = 0;
  readonly userKeys = new Set<string>();
  /** Key-creation and member-domain constraints the organization enforces. */
  readonly orgEnforced = new Set<string>();
  /** The project's own policies: whether each enforces its constraint. */
  readonly projectPolicies = new Map<string, boolean>();
  /** Key creations Google still refuses after a lift, while the change propagates. */
  policyLag = 0;
  /** Publisher grants Google still refuses after a member-domain constraint is relaxed, while the change propagates. */
  memberPolicyLag = 0;
  /** The reserved account may set and delete the project's own policies. */
  canSetPolicy = true;
  readonly commands: string[] = [];
  readonly mutations: string[] = [];
  #keys = 0;
  #newestKey: string | undefined;

  constructor(readonly gcp: GcpProjectInput) {}

  readonly run: GcloudCommandRunner = async (command) => {
    expect(command.command).toBe('gcloud');
    expect(command.args.slice(-2)).toEqual([`--account=${ACCOUNT}`, '--quiet']);
    const words = command.args.slice(0, -2);
    const line = words.join(' ');
    this.commands.push(line);
    const { projectId: project, serviceAccountEmail: email } = this.gcp;
    const scoped = `--project=${project}`;
    const topic = GCHAT_EVENTS_TOPIC_ID;
    const subscription = GCHAT_EVENTS_SUBSCRIPTION_ID;

    if (line === `projects describe ${project} --format=json`) return this.#describeProject();
    if (line.startsWith(`projects create ${project} `)) return this.#createProject(words);
    if (line === `projects delete ${project}`) return this.#deleteProject();
    if (line === 'billing accounts list --format=json') return this.#listBillingAccounts();
    if (!this.project) {
      return failed(
        `ERROR: (gcloud.${words.slice(0, 3).join('.')}) PERMISSION_DENIED: Permission denied on resource project ${project}.`,
      );
    }
    if (line === `billing projects describe ${project} --format=json`) return ok(json(this.billingInfo));
    if (words.length === 5 && line.startsWith(`billing projects link ${project} --billing-account=`)) {
      return this.#linkBilling(line, words[4]!.slice('--billing-account='.length));
    }
    if (line === `pubsub topics list ${scoped} --format=json`) return this.#listTopics();
    if (line === `pubsub topics create ${topic} ${scoped}`) return this.#createTopic(line);
    if (line === `pubsub subscriptions list ${scoped} --format=json`) {
      return ok(json(this.subscription ? [this.subscriptionDescription] : []));
    }
    if (line.startsWith(`pubsub subscriptions create ${subscription} `) && words.at(-1) === scoped) {
      return this.#createSubscription(words);
    }
    if (line === `pubsub topics get-iam-policy ${topic} ${scoped} --format=json`) {
      return ok(json(iamPolicy(this.topicPolicy)));
    }
    if (line === `pubsub subscriptions get-iam-policy ${subscription} ${scoped} --format=json`) {
      return ok(json(iamPolicy(this.subscriptionPolicy)));
    }
    if (
      words.length === 7 &&
      line.startsWith(`pubsub topics add-iam-policy-binding ${topic} `) &&
      words[6] === scoped
    ) {
      return this.#grantOnTopic(words);
    }
    if (
      words.length === 7 &&
      line.startsWith(`pubsub subscriptions add-iam-policy-binding ${subscription} `) &&
      words[6] === scoped
    ) {
      return this.#grantOnSubscription(words);
    }
    if (line === `services list --enabled ${scoped} --format=value(config.name)`) {
      return ok([...this.enabled].sort().join('\n') + '\n');
    }
    if (line.startsWith('services enable ') && words.at(-1) === scoped) {
      for (const api of words.slice(2, -1)) this.enabled.add(api);
      this.mutations.push(line);
      return ok(
        '',
        'Operation "operations/acf.p2-441811502258-2c1f3f6e-9a5d-4bde-8a57-0c1d5e6f7a8b" finished successfully.\n',
      );
    }
    if (line === `iam service-accounts list ${scoped} --format=json`) return this.#listServiceAccounts();
    if (line.startsWith('iam service-accounts create gws-ea-chat ') && words.includes(scoped)) {
      return this.#createServiceAccount(words);
    }
    if (line === `iam service-accounts keys list --iam-account=${email} ${scoped} --managed-by=user --format=json`) {
      return this.#listKeys();
    }
    if (line.startsWith('iam service-accounts keys delete ') && line.endsWith(` --iam-account=${email} ${scoped}`)) {
      return this.#deleteKey(words[4]!);
    }
    if (
      line.startsWith('iam service-accounts keys create ') &&
      line.endsWith(` --iam-account=${email} --key-file-type=json ${scoped}`)
    ) {
      return this.#createKey(words[4]!);
    }
    if (line.startsWith('org-policies set-policy ') && words.at(-1) === scoped) return this.#setPolicy(words[2]!);
    for (const constraint of MEMBER_CONSTRAINTS) {
      if (line === `org-policies describe ${constraint} ${scoped} --format=json`) {
        return this.#describePolicy(constraint);
      }
      if (line === `org-policies delete ${constraint} ${scoped}`) return this.#deletePolicy(constraint);
    }
    throw new Error(`Unexpected gcloud command: ${line}`);
  };

  get projectDescription(): Record<string, unknown> {
    return {
      createTime: '2026-09-20T17:02:11.442Z',
      labels: this.project?.labels,
      lifecycleState: this.project?.lifecycleState,
      name: 'GWS-EA assistant',
      parent: { id: '281734958812', type: 'organization' },
      projectId: this.gcp.projectId,
      projectNumber: '441811502258',
    };
  }

  #describeProject(): SanitizedCommandOutcome {
    if (!this.project || this.hiddenProjectReads > 0) {
      if (this.project) this.hiddenProjectReads -= 1;
      return failed(projectNotVisible(this.gcp.projectId));
    }
    return ok(json(this.projectDescription));
  }

  #createProject(words: readonly string[]): SanitizedCommandOutcome {
    if (this.project) {
      return failed(
        'ERROR: (gcloud.projects.create) Project creation failed. The project ID you specified is already in use by another project. Please try an alternative ID.',
      );
    }
    const labels = words.find((word) => word.startsWith('--labels='))!.slice('--labels='.length);
    this.project = {
      labels: Object.fromEntries(labels.split(',').map((pair) => pair.split('=') as [string, string])),
      lifecycleState: 'ACTIVE',
    };
    this.mutations.push(words.join(' '));
    return ok(
      '',
      `Create in progress for [https://cloudresourcemanager.googleapis.com/v1/projects/${this.gcp.projectId}].\nWaiting for [operations/cp.5821036364185440018] to finish...done.\n`,
    );
  }

  #deleteProject(): SanitizedCommandOutcome {
    this.project!.lifecycleState = 'DELETE_REQUESTED';
    this.mutations.push(`projects delete ${this.gcp.projectId}`);
    return ok('', `Deleted [https://cloudresourcemanager.googleapis.com/v1/projects/${this.gcp.projectId}].\n`);
  }

  #listBillingAccounts(): SanitizedCommandOutcome {
    return ok(
      json(
        this.billingAccounts.map(({ id, displayName, open }) => ({
          displayName,
          masterBillingAccount: '',
          name: `billingAccounts/${id}`,
          open,
        })),
      ),
    );
  }

  get billingInfo(): Record<string, unknown> {
    const { projectId } = this.gcp;
    return {
      billingAccountName: this.linkedBillingAccount ? `billingAccounts/${this.linkedBillingAccount}` : '',
      billingEnabled: this.linkedBillingAccount !== undefined,
      name: `projects/${projectId}/billingInfo`,
      projectId,
    };
  }

  #linkBilling(line: string, id: string): SanitizedCommandOutcome {
    if (!this.billingAccounts.some((account) => account.id === id && account.open)) {
      return failed(
        `ERROR: (gcloud.billing.projects.link) PERMISSION_DENIED: The caller does not have permission (or it may not exist).`,
      );
    }
    this.linkedBillingAccount = id;
    this.mutations.push(line);
    return ok(json(this.billingInfo));
  }

  #listTopics(): SanitizedCommandOutcome {
    if (!this.topic || this.unlistedTopicReads > 0) {
      if (this.topic) this.unlistedTopicReads -= 1;
      return ok('[]\n');
    }
    return ok(json([{ name: deriveGchatEventsTopic(this.gcp.projectId) }]));
  }

  #createTopic(line: string): SanitizedCommandOutcome {
    const name = deriveGchatEventsTopic(this.gcp.projectId);
    if (this.initializingPolicyCreates > 0) {
      this.initializingPolicyCreates -= 1;
      // Google's answer for a project created moments earlier, recorded live.
      return failed(
        [
          `ERROR: Failed to create topic [${name}]: The topic ${name} cannot be created or updated due to an organization policy specified at the project or organization level. The organization policy does not allow message storage in any GCP region where Cloud Pub/Sub is present. The organization policy may be updated by your project or organization administrator. See https://console.cloud.google.com/iam-admin/orgpolicies/gcp-resourceLocations?project=${this.gcp.projectId}. If the topic's project was recently created, you may need to wait a few minutes for the project's organization policy to be properly initialized, and then retry this operation.`,
          `ERROR: (gcloud.pubsub.topics.create) Failed to create the following: [${GCHAT_EVENTS_TOPIC_ID}].`,
        ].join('\n'),
      );
    }
    if (this.topic) {
      return failed(
        [
          `ERROR: Failed to create topic [${name}]: Resource already exists in the project (resource=${GCHAT_EVENTS_TOPIC_ID}).`,
          `ERROR: (gcloud.pubsub.topics.create) Failed to create the following: [${GCHAT_EVENTS_TOPIC_ID}].`,
        ].join('\n'),
      );
    }
    this.topic = true;
    this.mutations.push(line);
    return ok('', `Created topic [${name}].\n`);
  }

  get subscriptionDescription(): Record<string, unknown> {
    return {
      ackDeadlineSeconds: Number(this.subscription?.['ack-deadline']),
      expirationPolicy: {},
      messageRetentionDuration: '604800s',
      name: deriveGchatEventsSubscription(this.gcp.projectId),
      pushConfig: {},
      state: 'ACTIVE',
      topic: `projects/${this.gcp.projectId}/topics/${String(this.subscription?.topic)}`,
    };
  }

  #createSubscription(words: readonly string[]): SanitizedCommandOutcome {
    const flags = words.slice(4, -1).map((flag): [string, string | boolean] => {
      const [key, value] = flag.slice(2).split('=') as [string, string | undefined];
      if (value !== undefined) return [key, value];
      return key.startsWith('no-') ? [key.slice(3), false] : [key, true];
    });
    this.subscription = Object.fromEntries(flags);
    this.mutations.push(words.join(' '));
    return ok('', `Created subscription [${deriveGchatEventsSubscription(this.gcp.projectId)}].\n`);
  }

  #grantOnTopic(words: readonly string[]): SanitizedCommandOutcome {
    const { member, role } = binding(words);
    if (member === CHAT_PUBLISHER) {
      const enforced = MEMBER_CONSTRAINTS.find(
        (constraint) => this.projectPolicies.get(constraint) ?? this.orgEnforced.has(constraint),
      );
      const relaxed = MEMBER_CONSTRAINTS.find((constraint) => this.projectPolicies.get(constraint) === false);
      const refusing = enforced ?? (this.memberPolicyLag > 0 ? relaxed : undefined);
      if (refusing) {
        if (!enforced) this.memberPolicyLag -= 1;
        return failed(MEMBER_REFUSALS[refusing]);
      }
    }
    return this.#grant(this.topicPolicy, words, member, role);
  }

  #grantOnSubscription(words: readonly string[]): SanitizedCommandOutcome {
    const { member, role } = binding(words);
    const email = this.gcp.serviceAccountEmail;
    if (member === `serviceAccount:${email}` && this.unknownMemberGrants > 0) {
      this.unknownMemberGrants -= 1;
      return failed(
        `ERROR: (gcloud.pubsub.subscriptions.add-iam-policy-binding) INVALID_ARGUMENT: Service account ${email} does not exist.`,
      );
    }
    return this.#grant(this.subscriptionPolicy, words, member, role);
  }

  #grant(
    policy: Map<string, Set<string>>,
    words: readonly string[],
    member: string,
    role: string,
  ): SanitizedCommandOutcome {
    const members = policy.get(role) ?? new Set<string>();
    members.add(member);
    policy.set(role, members);
    this.mutations.push(words.join(' '));
    return ok(json(iamPolicy(policy)), `Updated IAM policy for ${words[1]!.slice(0, -1)} [${words[3]}].\n`);
  }

  get serviceAccountDescription(): Record<string, unknown> {
    const { projectId, serviceAccountEmail } = this.gcp;
    return {
      description: this.serviceAccount?.description,
      displayName: this.serviceAccount?.displayName,
      email: serviceAccountEmail,
      etag: 'MDEwMjE5MjA=',
      name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}`,
      oauth2ClientId: '104285714592231180044',
      projectId,
      uniqueId: '104285714592231180044',
    };
  }

  #listServiceAccounts(): SanitizedCommandOutcome {
    if (!this.serviceAccount || this.unlistedServiceAccountReads > 0) {
      if (this.serviceAccount) this.unlistedServiceAccountReads -= 1;
      return ok('[]\n');
    }
    return ok(json([this.serviceAccountDescription]));
  }

  #createServiceAccount(words: readonly string[]): SanitizedCommandOutcome {
    if (this.serviceAccount) {
      return failed(
        `ERROR: (gcloud.iam.service-accounts.create) Resource in projects [${this.gcp.projectId}] is the subject of a conflict: Service account gws-ea-chat already exists within project projects/${this.gcp.projectId}.`,
      );
    }
    const flag = (name: string): string => words.find((word) => word.startsWith(`--${name}=`))!.split('=')[1]!;
    this.serviceAccount = { displayName: flag('display-name'), description: flag('description') };
    this.mutations.push(words.join(' '));
    return ok(json(this.serviceAccountDescription), 'Created service account [gws-ea-chat].\n');
  }

  #listKeys(): SanitizedCommandOutcome {
    const { projectId, serviceAccountEmail } = this.gcp;
    if (!this.serviceAccount || this.unresolvedKeyReads > 0) {
      if (this.serviceAccount) this.unresolvedKeyReads -= 1;
      return failed(
        `ERROR: (gcloud.iam.service-accounts.keys.list) NOT_FOUND: Service account projects/${projectId}/serviceAccounts/${serviceAccountEmail} does not exist.`,
      );
    }
    let listed = [...this.userKeys];
    if (this.#newestKey && this.unlistedNewKeyReads > 0) {
      this.unlistedNewKeyReads -= 1;
      listed = listed.filter((id) => id !== this.#newestKey);
    }
    return ok(
      json(
        listed.map((id) => ({
          keyAlgorithm: 'KEY_ALG_RSA_2048',
          keyOrigin: 'GOOGLE_PROVIDED',
          keyType: 'USER_MANAGED',
          name: `projects/${projectId}/serviceAccounts/${serviceAccountEmail}/keys/${id}`,
          validAfterTime: '2026-09-20T17:04:00Z',
          validBeforeTime: '9999-12-31T23:59:59Z',
        })),
      ),
    );
  }

  #deleteKey(id: string): SanitizedCommandOutcome {
    if (!this.userKeys.delete(id)) {
      return failed(
        `ERROR: (gcloud.iam.service-accounts.keys.delete) NOT_FOUND: Service account key ${id} does not exist.`,
      );
    }
    this.mutations.push(`keys delete ${id}`);
    return ok('', `deleted key [${id}] for service account [${this.gcp.serviceAccountEmail}]\n`);
  }

  async #createKey(file: string): Promise<SanitizedCommandOutcome> {
    const { projectId, serviceAccountEmail } = this.gcp;
    const enforced = KEY_CONSTRAINTS.find(
      (constraint) => this.projectPolicies.get(constraint) ?? this.orgEnforced.has(constraint),
    );
    const refusing = enforced ?? (this.policyLag > 0 ? KEY_CONSTRAINTS[0] : undefined);
    if (refusing) {
      if (!enforced) this.policyLag -= 1;
      // gcloud opens the output file before Google refuses the request.
      await writeFile(file, '', { mode: 0o600 });
      return failed(keyCreationRefused(projectId, serviceAccountEmail, refusing));
    }
    this.#keys += 1;
    const id = `${String(this.#keys).padStart(2, '0')}${'5f0c3e1a9b7d2468ace0'.repeat(2)}`.slice(0, 40);
    this.userKeys.add(id);
    this.#newestKey = id;
    await writeFile(file, keyFile(projectId, serviceAccountEmail, id), { mode: 0o600 });
    this.mutations.push(`keys create ${id}`);
    return ok('', `created key [${id}] of type [json] as [${file}] for [${serviceAccountEmail}]\n`);
  }

  async #setPolicy(file: string): Promise<SanitizedCommandOutcome> {
    const policy = JSON.parse(await readFile(file, 'utf8')) as {
      name: string;
      spec: { rules: { enforce?: boolean; allowAll?: boolean }[] };
    };
    const [, project, , constraint] = policy.name.split('/');
    expect(project).toBe(this.gcp.projectId);
    expect([...KEY_CONSTRAINTS, ...MEMBER_CONSTRAINTS]).toContain(constraint);
    // The legacy member-domain constraint is a list constraint, which only allowing all relaxes.
    const listConstraint = constraint === MEMBER_CONSTRAINTS[0];
    expect(policy.spec.rules).toEqual([listConstraint ? { allowAll: true } : { enforce: expect.any(Boolean) }]);
    if (!this.canSetPolicy) {
      return failed(policyChangeDenied('set-policy', 'orgpolicy.policies.create', this.gcp.projectId));
    }
    const rule = listConstraint ? 'allowAll=true' : `enforce=${policy.spec.rules[0]!.enforce}`;
    this.projectPolicies.set(constraint!, policy.spec.rules[0]!.enforce === true);
    this.mutations.push(`set-policy ${constraint} ${rule}`);
    return ok('', `Updated policy [${policy.name}].\n`);
  }

  #describePolicy(constraint: string): SanitizedCommandOutcome {
    const enforced = this.projectPolicies.get(constraint);
    if (enforced === undefined) return failed(policyNotFound('describe', constraint));
    return ok(
      json({
        etag: 'CLWPsr4GEKDvzOcC',
        name: `projects/441811502258/policies/${constraint}`,
        spec: {
          etag: 'CLWPsr4GEKDvzOcC',
          rules: [constraint === MEMBER_CONSTRAINTS[0] ? { allowAll: true } : { enforce: enforced }],
          updateTime: '2026-09-20T17:03:41.118Z',
        },
      }),
    );
  }

  #deletePolicy(constraint: string): SanitizedCommandOutcome {
    if (!this.canSetPolicy) {
      return failed(policyChangeDenied('delete', 'orgpolicy.policies.delete', this.gcp.projectId));
    }
    if (!this.projectPolicies.delete(constraint)) return failed(policyNotFound('delete', constraint));
    this.mutations.push(`delete-policy ${constraint}`);
    return ok('{}\n', `Deleted policy [projects/${this.gcp.projectId}/policies/${constraint}].\n`);
  }

  /** Everything provisioning creates, as the owner left it. */
  ready(): this {
    this.project = {
      labels: { 'gws-ea-instance': this.gcp.instanceId, 'gws-ea-managed': 'true' },
      lifecycleState: 'ACTIVE',
    };
    this.linkedBillingAccount = BILLING_ACCOUNT;
    for (const api of REQUIRED_APIS) this.enabled.add(api);
    this.topic = true;
    this.subscription = { ...SUBSCRIPTION_SETTINGS };
    this.topicPolicy.set('roles/pubsub.publisher', new Set([CHAT_PUBLISHER]));
    this.serviceAccount = {
      displayName: 'GWS-EA Chat subscriber',
      description: `Owned by GWS-EA instance ${this.gcp.instanceId}`,
    };
    this.subscriptionPolicy.set('roles/pubsub.subscriber', new Set([`serviceAccount:${this.gcp.serviceAccountEmail}`]));
    return this;
  }
}

interface Harness {
  readonly cloud: FakeGoogleCloud;
  readonly gcp: GcpProjectInput;
  readonly staging: string;
  readonly sleeps: number[];
  readonly events: RunEvent[];
  readonly signIns: string[];
  /** Run `provision_gcp` through the step engine, as `create` and `resume` do, with any decisions made. */
  run(runCommand?: GcloudCommandRunner, decisions?: Pick<GcpProjectInput, 'billingAccount'>): Promise<ProvisionResult>;
  journal(): Promise<ProvisionJournal>;
}

async function harness(): Promise<Harness> {
  const root = await tempRoot();
  const paths = resolveControlPlanePaths({
    configRoot: path.join(root, 'config'),
    stateRoot: path.join(root, 'state'),
  });
  const instanceId = randomUUID();
  const projectId = deriveGcpProjectId(instanceId);
  const serviceAccountEmail = deriveGchatServiceAccountEmail(projectId);
  await reserveInstance(paths, {
    instance_id: instanceId,
    release_track: 'dogfood',
    source_remote: 'https://example.test/nanoclaw.git',
    deployed_commit: 'a'.repeat(40),
    allocated_ports: { onecli_app: 32_002, onecli_gateway: 32_003 },
    exclusive_resource_claims: {
      ...deriveGcpClaims(instanceId),
      gcp_account: ACCOUNT,
      workspace_email: 'assistant@example.test',
      onecli_project: `gws-ea-${instanceId.replaceAll('-', '')}`,
    },
  });
  const gcp: GcpProjectInput = {
    instanceId,
    projectId,
    account: ACCOUNT,
    serviceAccountEmail,
    credentialFile: path.join(root, 'secrets', 'gchat.json'),
    cwd: root,
  };
  const cloud = new FakeGoogleCloud(gcp);
  const sleeps: number[] = [];
  const events: RunEvent[] = [];
  const signIns: string[] = [];
  const sleep = async (milliseconds: number): Promise<void> => void sleeps.push(milliseconds);
  const emit = (event: RunEvent): void => void events.push(event);
  const satisfied: ProvisionStep<GcpStepContext> = {
    label: 'Already satisfied…',
    resources: [{ name: 'nothing', observe: async () => PRESENT, apply: async () => undefined }],
  };
  return {
    cloud,
    gcp,
    staging: `${gcp.credentialFile}.staging`,
    sleeps,
    events,
    signIns,
    run: async (runCommand = cloud.run, decisions = {}) => {
      const steps = {
        ...Object.fromEntries(PROVISION_STEPS.map((id) => [id, satisfied])),
        provision_gcp: {
          label: 'Configuring Google Cloud…',
          resources: googleCloudResources({
            runCommand,
            sleep,
            onWait: (reason) => emit({ type: 'step-waiting', step: 'provision_gcp', reason }),
          }),
        },
      } as ProvisionSteps<GcpStepContext>;
      const result = await withInstanceOperation(paths, instanceId, (operation) =>
        runProvisionSteps(operation, { operation, input: { gcp: { ...gcp, ...decisions } } }, steps, {
          sleep,
          emit,
          signIn: async () => void signIns.push(ACCOUNT),
        }),
      );
      if (!result) throw new Error('The instance operation was busy');
      return result;
    },
    journal: () => readProvisionJournal(paths, instanceId),
  };
}

/** A harness whose Google Cloud is ready and whose key is published, except for Google Chat's publisher grant. */
async function awaitingPublisher(): Promise<Harness> {
  const setup = await harness();
  setup.cloud.ready().topicPolicy.clear();
  setup.cloud.userKeys.add('k1');
  await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));
  return setup;
}

async function writeCredential(file: string, contents: string, mode = 0o600): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, contents, { mode });
  await chmod(file, mode);
}

function waited(sleeps: readonly number[]): number {
  return sleeps.reduce((total, milliseconds) => total + milliseconds, 0);
}

async function publishedKeyId(gcp: GcpProjectInput): Promise<string> {
  const credential = await readFile(gcp.credentialFile, 'utf8');
  expect((await stat(gcp.credentialFile)).mode & 0o777).toBe(0o600);
  return parseGchatServiceAccountCredential(credential, gcp).privateKeyId;
}

describe('gcloud failure classification', () => {
  const cases: ReadonlyArray<readonly [string, string, GcloudFailureClass]> = [
    ['a failed reauthentication, as recorded', REAUTHENTICATION_FAILED, 'auth-required'],
    ['a token that no longer refreshes', TOKEN_REFRESH_FAILED, 'auth-required'],
    ['no active account', NO_ACTIVE_ACCOUNT, 'auth-required'],
    [
      'an account without credentials',
      `ERROR: (gcloud.auth.print-access-token) Your current active account [${ACCOUNT}] does not have any valid credentials`,
      'auth-required',
    ],
    ['a reauthentication demand', 'ERROR: (gcloud.projects.describe) Reauthentication required.', 'auth-required'],
    [
      'rejected credentials',
      'ERROR: (gcloud.projects.describe) UNAUTHENTICATED: Request had invalid authentication credentials.',
      'auth-required',
    ],
    [
      'a project Google will not confirm exists',
      projectNotVisible('gws-ea-12345678123442348234'),
      'permission-or-missing',
    ],
    [
      'a denied permission on a resource that may not exist',
      "ERROR: (gcloud.iam.service-accounts.describe) PERMISSION_DENIED: Permission 'iam.serviceAccounts.get' denied on resource (or it may not exist).",
      'permission-or-missing',
    ],
    [
      'a missing resource',
      'ERROR: (gcloud.iam.service-accounts.keys.list) NOT_FOUND: Service account projects/p/serviceAccounts/a@p.iam.gserviceaccount.com does not exist.',
      'permission-or-missing',
    ],
    [
      'blocked key creation',
      keyCreationRefused('p', 'a@p.iam.gserviceaccount.com', 'iam.disableServiceAccountKeyCreation'),
      'precondition',
    ],
    ['a connection failure', CONNECTION_FAILED, 'anything-else'],
    ['exhausted quota', 'ERROR: (gcloud.projects.create) RESOURCE_EXHAUSTED: Quota exceeded.', 'anything-else'],
    ['a crash', GCLOUD_CRASHED, 'anything-else'],
    ['silence', '', 'anything-else'],
  ];

  it.each(cases)('classifies %s', (_case, stderr, expected) => {
    expect(classifyGcloudFailure({ stdout: '', stderr, exitCode: 1 })).toBe(expected);
  });

  it('keeps the recorded Python warning ahead of the error', () => {
    expect(PYTHON_WARNING).toMatch(/^WARNING: {2}Python 3\.9\.x is no longer officially supported/u);
  });

  it.each(cases)('classifies %s behind the recorded Python warning', (_case, stderr, expected) => {
    expect(classifyGcloudFailure({ stdout: '', stderr: `${PYTHON_WARNING}${stderr}`, exitCode: 1 })).toBe(expected);
  });
});

describe('Google account kind', () => {
  it.each([
    ['operator@gmail.com', true],
    ['Operator@GoogleMail.com', true],
    ['operator@example.com', false],
    ['gmail.com@example.com', false],
  ])('%s is a consumer account: %s', (email, consumer) => {
    expect(isConsumerGoogleAccount(email)).toBe(consumer);
  });
});

describe('gcloud sign-in and installation', () => {
  it('asks for sign-in when the reserved account cannot refresh its token', async () => {
    const failure = await assertGcloudSignedIn(
      'reserved@example.com',
      async () => RECORDED_GCLOUD_REAUTHENTICATION_FAILED,
    ).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({
      code: 'gcloud_auth_required',
      message: expect.stringContaining('reserved@example.com'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('Reauthentication failed') },
    });
  });

  it('reports any other token failure as the failed command, not as a sign-in', async () => {
    const failure = await assertGcloudSignedIn('reserved@example.com', async () => failed(CONNECTION_FAILED)).catch(
      (error: unknown) => error,
    );

    expect(failure).not.toBeInstanceOf(SignInRequired);
    expect(failure).toMatchObject({
      code: 'command_failed',
      message: expect.stringContaining('gcloud auth print-access-token --account=reserved@example.com'),
      details: { exitCode: 1, stderrTail: expect.stringContaining('There was a problem connecting') },
    });
  });
});

describe("the assistant's Chat delivery names", () => {
  it("derives the topic, the subscription, and the subscriber account from the instance's project", () => {
    const projectId = deriveGcpProjectId('12345678-1234-4234-8234-123456789abc');

    expect(projectId).toBe('gws-ea-12345678123442348234');
    expect([
      deriveGchatEventsTopic(projectId),
      deriveGchatEventsSubscription(projectId),
      deriveGchatServiceAccountEmail(projectId),
    ]).toEqual([
      'projects/gws-ea-12345678123442348234/topics/gws-ea-chat-events',
      'projects/gws-ea-12345678123442348234/subscriptions/gws-ea-chat-events-pull',
      'gws-ea-chat@gws-ea-12345678123442348234.iam.gserviceaccount.com',
    ]);
  });

  it.each([
    ['topic', deriveGchatEventsTopic],
    ['subscription', deriveGchatEventsSubscription],
    ['subscriber account', deriveGchatServiceAccountEmail],
  ])('refuses to name a %s in an invalid project', (_name, derive) => {
    expect(() => derive('Not A Project')).toThrow(expect.objectContaining({ code: 'invalid_claim' }) as Error);
  });
});

describe('Chat subscriber key', () => {
  const projectId = 'gws-ea-12345678123442348234';
  const email = deriveGchatServiceAccountEmail(projectId);
  const expected = { projectId, serviceAccountEmail: email };

  it('reads the fields it uses and tolerates fields it does not', () => {
    const minimal = JSON.stringify({
      type: 'service_account',
      project_id: projectId,
      private_key_id: 'key-1',
      private_key: '-----BEGIN PRIVATE KEY-----\nMIIE\n-----END PRIVATE KEY-----\n',
      client_email: email,
    });

    expect(
      parseGchatServiceAccountCredential(keyFile(projectId, email, 'key-1', { future_field: { a: 1 } }), expected),
    ).toEqual({ projectId, privateKeyId: 'key-1', clientEmail: email });
    expect(parseGchatServiceAccountCredential(minimal, expected)).toMatchObject({ privateKeyId: 'key-1' });
  });

  it.each([
    ['not JSON', '{', 'invalid_gchat_credential'],
    [
      'another credential type',
      keyFile(projectId, email, 'key-1', { type: 'authorized_user' }),
      'invalid_gchat_credential',
    ],
    [
      'a malformed private key',
      keyFile(projectId, email, 'key-1', { private_key: 'MIIE' }),
      'invalid_gchat_credential',
    ],
    ['a missing key ID', keyFile(projectId, email, 'key-1', { private_key_id: '' }), 'invalid_gchat_credential'],
    ['another project', keyFile('gws-ea-other0000000000000000', email, 'key-1'), 'gchat_credential_mismatch'],
    [
      'another service account',
      keyFile(projectId, `other@${projectId}.iam.gserviceaccount.com`, 'key-1'),
      'gchat_credential_mismatch',
    ],
  ])('refuses %s', (_case, contents, code) => {
    expect(() => parseGchatServiceAccountCredential(contents, expected)).toThrow(
      expect.objectContaining({ code }) as Error,
    );
  });
});

describe('Google Cloud setup through the step engine', () => {
  it('creates a never-created project Google will not confirm, then its billing, APIs, Chat delivery, subscriber, and one published key', async () => {
    const setup = await harness();

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const { projectId, instanceId, serviceAccountEmail } = setup.gcp;
    const keyId = await publishedKeyId(setup.gcp);
    // Least privilege: only Google Chat may publish to the topic, and the subscriber may only pull the one
    // subscription; the fake refuses any other grant, a project-wide one included, as an unexpected command.
    expect(setup.cloud.mutations).toEqual([
      `projects create ${projectId} --name=GWS-EA assistant --labels=gws-ea-instance=${instanceId},gws-ea-managed=true --format=json`,
      `billing projects link ${projectId} --billing-account=${BILLING_ACCOUNT}`,
      `services enable ${REQUIRED_APIS.join(' ')} --project=${projectId}`,
      `pubsub topics create gws-ea-chat-events --project=${projectId}`,
      `pubsub subscriptions create gws-ea-chat-events-pull --topic=gws-ea-chat-events --ack-deadline=60 --message-retention-duration=7d --expiration-period=never --no-retain-acked-messages --project=${projectId}`,
      `pubsub topics add-iam-policy-binding gws-ea-chat-events --member=${CHAT_PUBLISHER} --role=roles/pubsub.publisher --project=${projectId}`,
      `iam service-accounts create gws-ea-chat --display-name=GWS-EA Chat subscriber --description=Owned by GWS-EA instance ${instanceId} --project=${projectId} --format=json`,
      `pubsub subscriptions add-iam-policy-binding gws-ea-chat-events-pull --member=serviceAccount:${serviceAccountEmail} --role=roles/pubsub.subscriber --project=${projectId}`,
      `keys create ${keyId}`,
    ]);
    expect(setup.cloud.commands[0]).toBe(`projects describe ${projectId} --format=json`);
    // Without domain restricted sharing, the member-domain policy is only read.
    expect(setup.cloud.commands.filter((command) => command.startsWith('org-policies '))).toEqual(
      MEMBER_CONSTRAINTS.map(
        (constraint) => `org-policies describe ${constraint} --project=${projectId} --format=json`,
      ),
    );
    expect(setup.cloud.userKeys).toEqual(new Set([keyId]));
    expect(serviceAccountEmail).toBe(`gws-ea-chat@${projectId}.iam.gserviceaccount.com`);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
    const journal = await setup.journal();
    expect(journal.steps.provision_gcp?.completed_at).toBeDefined();
    expect(journal.key_policy_lifted).toBe(false);
    expect(setup.sleeps).toEqual([]);
  });

  it('grants Google Chat publishing and the subscriber pulling while each holds only another role there, and someone else already pulls', async () => {
    const setup = await harness();
    const { projectId, serviceAccountEmail } = setup.gcp;
    const subscriber = `serviceAccount:${serviceAccountEmail}`;
    setup.cloud.ready().userKeys.add('k1');
    await writeCredential(setup.gcp.credentialFile, keyFile(projectId, serviceAccountEmail, 'k1'));
    // A grant is there only when its own member holds its own role.
    setup.cloud.topicPolicy.clear();
    setup.cloud.topicPolicy.set('roles/pubsub.viewer', new Set([CHAT_PUBLISHER]));
    setup.cloud.subscriptionPolicy.clear();
    setup.cloud.subscriptionPolicy.set('roles/pubsub.viewer', new Set([subscriber]));
    setup.cloud.subscriptionPolicy.set('roles/pubsub.subscriber', new Set([`user:${ACCOUNT}`]));

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([
      `pubsub topics add-iam-policy-binding gws-ea-chat-events --member=${CHAT_PUBLISHER} --role=roles/pubsub.publisher --project=${projectId}`,
      `pubsub subscriptions add-iam-policy-binding gws-ea-chat-events-pull --member=${subscriber} --role=roles/pubsub.subscriber --project=${projectId}`,
    ]);
  });

  it('pauses with each open billing account as a choice when there are several, then links the one chosen', async () => {
    const setup = await harness();
    setup.cloud.billingAccounts.push(
      { id: SECOND_BILLING_ACCOUNT, displayName: 'Hale Studio', open: true },
      { id: CLOSED_BILLING_ACCOUNT, displayName: 'Vance Expired Card', open: false },
    );

    const result = await setup.run();

    expect(result).toEqual({
      status: 'paused',
      pause: {
        kind: 'human-action',
        phase: 'provision_gcp',
        code: 'gcp_billing_account_choice_required',
        message: expect.stringContaining(setup.gcp.projectId),
        choices: [
          { id: BILLING_ACCOUNT, label: `Ellery Household (${BILLING_ACCOUNT})` },
          { id: SECOND_BILLING_ACCOUNT, label: `Hale Studio (${SECOND_BILLING_ACCOUNT})` },
        ],
        resumeFlag: '--billing-account',
      },
    });
    expect(setup.cloud.mutations).toEqual([expect.stringMatching(/^projects create /u)]);
    expect(setup.cloud.linkedBillingAccount).toBeUndefined();

    await expect(setup.run(undefined, { billingAccount: SECOND_BILLING_ACCOUNT })).resolves.toEqual({
      status: 'ready',
    });
    expect(setup.cloud.linkedBillingAccount).toBe(SECOND_BILLING_ACCOUNT);
    expect(setup.cloud.mutations.filter((entry) => entry.startsWith('billing '))).toEqual([
      `billing projects link ${setup.gcp.projectId} --billing-account=${SECOND_BILLING_ACCOUNT}`,
    ]);
  });

  it('pauses, naming the billing account it needs, when the account has no open one, until one is open', async () => {
    const setup = await harness();
    setup.cloud.billingAccounts = [{ id: CLOSED_BILLING_ACCOUNT, displayName: 'Vance Expired Card', open: false }];

    const result = await setup.run();

    expect(result).toMatchObject({
      status: 'paused',
      pause: {
        phase: 'provision_gcp',
        code: 'gcp_billing_account_required',
        message: expect.stringMatching(new RegExp(`${setup.gcp.projectId} needs a billing account.*${ACCOUNT}`, 'u')),
        details: [expect.stringContaining('Billing Account User (roles/billing.user)')],
        actionUrl: 'https://console.cloud.google.com/billing/create',
      },
    });
    expect(setup.cloud.mutations).toEqual([expect.stringMatching(/^projects create /u)]);
    const { settled } = (result as { readonly pause: ProvisionHumanPause }).pause;
    await expect(settled?.()).resolves.toBe(false);

    setup.cloud.billingAccounts.push({ id: BILLING_ACCOUNT, displayName: 'Ellery Household', open: true });
    await expect(settled?.()).resolves.toBe(true);
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });
    expect(setup.cloud.linkedBillingAccount).toBe(BILLING_ACCOUNT);
  });

  it('stops with Google’s answer, linking nothing, when the chosen billing account cannot be linked', async () => {
    const setup = await harness();

    await expect(setup.run(undefined, { billingAccount: CLOSED_BILLING_ACCOUNT })).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining(`could not link billing account ${CLOSED_BILLING_ACCOUNT}`),
      details: { stderrTail: expect.stringContaining('PERMISSION_DENIED') },
    });
    expect(setup.cloud.linkedBillingAccount).toBeUndefined();
  });

  it('refuses a chosen billing account that is not a billing account ID, running nothing', async () => {
    const setup = await harness();

    await expect(setup.run(undefined, { billingAccount: 'billingAccounts/01A2B3' })).rejects.toMatchObject({
      code: 'invalid_billing_account',
    });
    expect(setup.cloud.commands).toEqual([]);
  });

  it.each([
    // Google refuses for the legacy constraint in its documented wording, and names the managed one.
    ['legacy', 'iam.allowedPolicyMemberDomains', 'allowAll=true'],
    ['managed', 'iam.managed.allowedPolicyMembers', 'enforce=false'],
  ])(
    'when the %s member-domain constraint refuses Google Chat, relaxes it on this project only until Google grants publishing, then restores it',
    async (_case, constraint, relaxed) => {
      const setup = await awaitingPublisher();
      setup.cloud.orgEnforced.add(constraint);
      setup.cloud.memberPolicyLag = 3;

      await expect(setup.run()).resolves.toEqual({ status: 'ready' });

      expect(setup.cloud.mutations).toEqual([
        `set-policy ${constraint} ${relaxed}`,
        publisherGrant(setup.gcp.projectId),
        `delete-policy ${constraint}`,
      ]);
      expect(setup.cloud.projectPolicies).toEqual(new Map());
      expect(setup.sleeps).toEqual([1_000, 2_000, 4_000]);
      expect(setup.events).toContainEqual({
        type: 'step-waiting',
        step: 'provision_gcp',
        reason: 'Waiting for Google Cloud to let Google Chat publish to the topic; it can take up to 15 minutes…',
      });
    },
  );

  it('relaxes each constraint in turn when the organization enforces both, then restores both', async () => {
    const setup = await awaitingPublisher();
    for (const constraint of MEMBER_CONSTRAINTS) setup.cloud.orgEnforced.add(constraint);

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([
      'set-policy iam.allowedPolicyMemberDomains allowAll=true',
      'set-policy iam.managed.allowedPolicyMembers enforce=false',
      publisherGrant(setup.gcp.projectId),
      'delete-policy iam.allowedPolicyMemberDomains',
      'delete-policy iam.managed.allowedPolicyMembers',
    ]);
    expect(setup.cloud.projectPolicies).toEqual(new Map());
    expect(setup.sleeps).toEqual([]);
  });

  it('pauses, naming the member-domain policy, the policy role, and the project, when it cannot be relaxed', async () => {
    const setup = await awaitingPublisher();
    setup.cloud.orgEnforced.add('iam.managed.allowedPolicyMembers');
    setup.cloud.canSetPolicy = false;
    const { projectId } = setup.gcp;

    await expect(setup.run()).resolves.toEqual({
      status: 'paused',
      pause: {
        kind: 'human-action',
        phase: 'provision_gcp',
        code: 'gcp_policy_permission_required',
        message: `Google Cloud refused to change the member-domain policy (constraints/iam.managed.allowedPolicyMembers) on project ${projectId}.`,
        details: [
          `Grant ${ACCOUNT} Organization Policy Administrator (roles/orgpolicy.policyAdmin) on the organization that contains project ${projectId}, then resume.`,
        ],
      },
    });
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('keeps the override and stops with Google’s answer when Google Chat is still refused 15 minutes after it, then a resume grants and restores', async () => {
    const setup = await awaitingPublisher();
    setup.cloud.orgEnforced.add('iam.allowedPolicyMemberDomains');
    setup.cloud.memberPolicyLag = 999;

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringMatching(
        /still refused.*15 minutes after constraints\/iam\.allowedPolicyMemberDomains was relaxed.*override stays until the grant exists/su,
      ),
      details: { stderrTail: expect.stringContaining('FAILED_PRECONDITION') },
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(15 * 60_000);
    const relax = 'set-policy iam.allowedPolicyMemberDomains allowAll=true';
    expect(setup.cloud.mutations).toEqual([relax]);

    setup.cloud.memberPolicyLag = 0;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });
    expect(setup.cloud.mutations).toEqual([
      relax,
      publisherGrant(setup.gcp.projectId),
      'delete-policy iam.allowedPolicyMemberDomains',
    ]);
    expect(setup.cloud.projectPolicies).toEqual(new Map());
  });

  it('restores an override left by a run that died once Google Chat was granted, granting nothing again', async () => {
    const setup = await awaitingPublisher();
    setup.cloud.orgEnforced.add('iam.managed.allowedPolicyMembers');
    // The first read of the member-domain policy follows the grant.
    const dying: GcloudCommandRunner = async (command) => {
      if (command.args.slice(0, 2).join(' ') === 'org-policies describe') throw new Error('The process died');
      return setup.cloud.run(command);
    };

    await expect(setup.run(dying)).rejects.toThrow('The process died');
    expect(setup.cloud.topicPolicy.get('roles/pubsub.publisher')).toEqual(new Set([CHAT_PUBLISHER]));
    expect(setup.cloud.projectPolicies).toEqual(new Map([['iam.managed.allowedPolicyMembers', false]]));

    const before = setup.cloud.mutations.length;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations.slice(before)).toEqual(['delete-policy iam.managed.allowedPolicyMembers']);
    expect(setup.cloud.projectPolicies).toEqual(new Map());
  });

  it('stops with evidence, deleting nothing, when the member-domain policy cannot be read in an unrecognized way', async () => {
    const setup = await harness();
    // The legacy constraint answers that the project has no policy of its own; the managed one cannot be read.
    setup.cloud.ready().projectPolicies.set('iam.managed.allowedPolicyMembers', false);
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 3).join(' ') === 'org-policies describe iam.managed.allowedPolicyMembers'
        ? failed(GCLOUD_CRASHED)
        : setup.cloud.run(command);

    const failure = await setup.run(runCommand).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'observation_unknown',
      message: expect.stringContaining('the member-domain policy'),
      details: { evidence: expect.stringContaining('gcloud crashed (TypeError)') },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.projectPolicies).toEqual(new Map([['iam.managed.allowedPolicyMembers', false]]));
  });

  it('pauses, keeping the override, when Google refuses to delete it for want of permission, and stops on any other refusal', async () => {
    const setup = await awaitingPublisher();
    const constraint = 'iam.allowedPolicyMemberDomains';
    setup.cloud.orgEnforced.add(constraint);
    const { projectId } = setup.gcp;
    let refusal = policyChangeDenied('delete', 'orgpolicy.policies.delete', projectId);
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 2).join(' ') === 'org-policies delete' ? failed(refusal) : setup.cloud.run(command);

    await expect(setup.run(runCommand)).resolves.toMatchObject({
      status: 'paused',
      pause: {
        code: 'gcp_policy_permission_required',
        message: `Google Cloud refused to change the member-domain policy (constraints/${constraint}) on project ${projectId}.`,
      },
    });
    const override = new Map([[constraint, false]]);
    expect(setup.cloud.mutations).toEqual([`set-policy ${constraint} allowAll=true`, publisherGrant(projectId)]);
    expect(setup.cloud.projectPolicies).toEqual(override);

    refusal = GCLOUD_CRASHED;
    await expect(setup.run(runCommand)).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: `Google Cloud could not restore ${constraint} on project ${projectId}`,
      details: { stderrTail: expect.stringContaining('gcloud crashed (TypeError)') },
    });
    expect(setup.cloud.projectPolicies).toEqual(override);
  });

  it('stops, naming the constraint and relaxing nothing, when another organization policy refuses Google Chat as the topic publisher', async () => {
    const setup = await harness();
    setup.cloud.ready().topicPolicy.clear();
    setup.cloud.serviceAccount = undefined;
    // In the shape of Google's PreconditionFailure; not recorded live.
    const refusal = [
      'ERROR: (gcloud.pubsub.topics.add-iam-policy-binding) FAILED_PRECONDITION: Operation denied by org policy.',
      "- '@type': type.googleapis.com/google.rpc.PreconditionFailure",
      '  violations:',
      `  - subject: orgpolicy:projects/${setup.gcp.projectId}`,
      '    type: constraints/custom.restrictTopicPublishers',
    ].join('\n');
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 3).join(' ') === 'pubsub topics add-iam-policy-binding'
        ? failed(refusal)
        : setup.cloud.run(command);

    await expect(setup.run(runCommand)).rejects.toMatchObject({
      code: 'gcp_publisher_grant_refused',
      message: expect.stringMatching(
        /constraints\/custom\.restrictTopicPublishers.*chat-api-push@system\.gserviceaccount\.com/u,
      ),
      details: { stderrTail: expect.stringContaining('FAILED_PRECONDITION') },
    });
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.serviceAccount).toBeUndefined();
  });

  it('treats a topic Google already holds but does not yet list as created', async () => {
    const setup = await harness();
    setup.cloud.ready().unlistedTopicReads = 1;
    await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));
    setup.cloud.userKeys.add('k1');

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.commands).toContain(`pubsub topics create gws-ea-chat-events --project=${setup.gcp.projectId}`);
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('waits for Google to set up a new project’s organization policy before creating the topic', async () => {
    const setup = await harness();
    setup.cloud.initializingPolicyCreates = 2;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.topic).toBe(true);
    expect(setup.sleeps).toEqual([1_000, 2_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: "Waiting for Google Cloud to set up the new project's organization policy; it can take up to 15 minutes…",
    });
  });

  it('stops naming the location policy when the project still refuses the topic after 15 minutes', async () => {
    const setup = await harness();
    setup.cloud.initializingPolicyCreates = 999;

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining('constraints/gcp.resourceLocations'),
      details: { stderrTail: expect.stringContaining('organization policy to be properly initialized') },
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(15 * 60_000);
    expect(setup.cloud.topic).toBe(false);
  });

  it('waits for Google to know a subscriber account it just created before granting it the subscription', async () => {
    const setup = await harness();
    setup.cloud.unknownMemberGrants = 2;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.sleeps).toEqual([1_000, 2_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for Google Cloud to make the new service account usable…',
    });
  });

  it('stops with Google’s answer when the new subscriber account is still unknown after 7 minutes', async () => {
    const setup = await harness();
    setup.cloud.unknownMemberGrants = 999;

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining(`could not let ${setup.gcp.serviceAccountEmail} pull`),
      details: { stderrTail: expect.stringContaining('does not exist') },
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(7 * 60_000);
  });

  it('adopts a project whose creation reports it already exists when its labels name this assistant', async () => {
    const setup = await harness();
    setup.cloud.ready().hiddenProjectReads = 1;
    await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));
    setup.cloud.userKeys.add('k1');

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.commands.slice(0, 3)).toEqual([
      `projects describe ${setup.gcp.projectId} --format=json`,
      expect.stringMatching(/^projects create /u),
      `projects describe ${setup.gcp.projectId} --format=json`,
    ]);
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('refuses, by name, a project whose creation reports it already exists under other labels', async () => {
    const setup = await harness();
    setup.cloud.ready().hiddenProjectReads = 1;
    setup.cloud.project!.labels = { 'gws-ea-instance': randomUUID(), 'gws-ea-managed': 'true' };

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'gcp_project_owner_mismatch',
      message: expect.stringContaining(setup.gcp.projectId),
    });
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.commands.some((command) => !command.startsWith('projects '))).toBe(false);
  });

  it('waits for a created service account to be listed, then continues', async () => {
    const setup = await harness();
    setup.cloud.ready().serviceAccount = undefined;
    setup.cloud.unlistedServiceAccountReads = 2;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations.filter((entry) => entry.startsWith('iam service-accounts create '))).toHaveLength(1);
    expect(setup.sleeps).toEqual([1_000, 2_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for the Chat subscriber account…',
    });
    await publishedKeyId(setup.gcp);
  });

  it('keeps a valid local credential whose key is listed, changing nothing', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('k1');
    await writeCredential(setup.gcp.credentialFile, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1'));

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([]);
    expect(await publishedKeyId(setup.gcp)).toBe('k1');
  });

  it('replaces an orphan key when there is no local credential, leaving Google-managed keys alone', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('orphan');

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations).toEqual(['keys delete orphan', `keys create ${keyId}`]);
    expect(setup.cloud.userKeys).toEqual(new Set([keyId]));
  });

  it('waits for a service account Google just created to become usable before replacing its keys', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('orphan');
    setup.cloud.unresolvedKeyReads = 2;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.sleeps).toEqual([1_000, 2_000]);
    expect(setup.cloud.mutations).toEqual(['keys delete orphan', `keys create ${await publishedKeyId(setup.gcp)}`]);
  });

  it('stops with Google’s answer when the service account is still not usable after 7 minutes', async () => {
    const setup = await harness();
    setup.cloud.ready();
    setup.cloud.unresolvedKeyReads = 999;

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringMatching(
        new RegExp(`could not list the keys of ${setup.gcp.serviceAccountEmail} within 7 minutes`, 'u'),
      ),
      details: { stderrTail: expect.stringContaining('NOT_FOUND') },
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(7 * 60_000);
    expect(Math.max(...setup.sleeps)).toBe(30_000);
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('waits for Google to list a key it just created before publishing it', async () => {
    const setup = await harness();
    setup.cloud.ready().unlistedNewKeyReads = 3;

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([`keys create ${await publishedKeyId(setup.gcp)}`]);
    expect(setup.sleeps).toEqual([1_000, 2_000, 4_000]);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for Google Cloud to list the new subscriber key…',
    });
  });

  it('keeps waiting for a new key through a listing that answers NOT_FOUND, then publishes it once', async () => {
    const setup = await harness();
    setup.cloud.ready();
    const runCommand: GcloudCommandRunner = async (command) => {
      const outcome = await setup.cloud.run(command);
      // Google's reads can lag again right after one answered.
      if (command.args.slice(0, 4).join(' ') === 'iam service-accounts keys create') setup.cloud.unresolvedKeyReads = 1;
      return outcome;
    };

    await expect(setup.run(runCommand)).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([`keys create ${await publishedKeyId(setup.gcp)}`]);
    expect(setup.sleeps).toEqual([1_000]);
  });

  it('keeps an unlisted new key staged after 7 minutes, and publishes it on the next run without another', async () => {
    const setup = await harness();
    setup.cloud.ready().unlistedNewKeyReads = 999;

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcp_key_unlisted',
      message: expect.stringContaining('within 7 minutes'),
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(7 * 60_000);
    await expect(stat(setup.gcp.credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(setup.staging)).resolves.toBeDefined();

    setup.cloud.unlistedNewKeyReads = 0;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations).toEqual([`keys create ${await publishedKeyId(setup.gcp)}`]);
  });

  it('fails at once, lifting nothing, when Google refuses a key for a reason other than the key policy', async () => {
    const setup = await harness();
    setup.cloud.ready();
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 4).join(' ') === 'iam service-accounts keys create'
        ? failed('ERROR: (gcloud.iam.service-accounts.keys.create) FAILED_PRECONDITION: Precondition check failed.')
        : setup.cloud.run(command);

    await expect(setup.run(runCommand)).rejects.toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringContaining(`could not create a key for ${setup.gcp.serviceAccountEmail}`),
    });
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.sleeps).toEqual([]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('replaces a valid local credential whose key Google no longer lists', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('other');
    await writeCredential(
      setup.gcp.credentialFile,
      keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'gone'),
    );

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(keyId).not.toBe('gone');
    expect(setup.cloud.mutations).toEqual(['keys delete other', `keys create ${keyId}`]);
  });

  it('publishes a valid staged key left by a crash without creating another', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('staged');
    await writeCredential(setup.staging, keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'staged'));

    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(await publishedKeyId(setup.gcp)).toBe('staged');
    expect(setup.cloud.mutations).toEqual([]);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  const unusableKeyFiles: ReadonlyArray<readonly [string, number, string]> = [
    ['at the wrong mode', 0o644, 'readable only by its owner'],
    ['not a key', 0o600, 'Chat subscriber key'],
    // The owner can read any file when running as root.
    ...(process.getuid?.() === 0 ? [] : [['unreadable', 0o200, 'EACCES'] as const]),
  ];

  it.each(unusableKeyFiles)('stops, deleting nothing, when the local key file is %s', async (_case, mode, evidence) => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('k1');
    const contents =
      evidence === 'Chat subscriber key'
        ? '{"type":"authorized_user"}'
        : keyFile(setup.gcp.projectId, setup.gcp.serviceAccountEmail, 'k1');
    await writeCredential(setup.gcp.credentialFile, contents, mode);

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'observation_unknown',
      message: expect.stringContaining(setup.gcp.credentialFile),
      details: { evidence: expect.stringContaining(evidence) },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.userKeys).toEqual(new Set(['k1']));
    await expect(stat(setup.gcp.credentialFile)).resolves.toMatchObject({ size: Buffer.byteLength(contents) });
  });

  it('lifts a blocking key policy only after recording the lift, waits as long as Google takes, then restores it once the key exists', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    // Refused for about 8 minutes after the lift, as a slow organization can.
    setup.cloud.policyLag = 20;
    const liftedWhenLifting: boolean[] = [];
    const runCommand: GcloudCommandRunner = async (command) => {
      if (command.args[1] === 'set-policy') liftedWhenLifting.push((await setup.journal()).key_policy_lifted);
      return setup.cloud.run(command);
    };

    await expect(setup.run(runCommand)).resolves.toEqual({ status: 'ready' });

    const keyId = await publishedKeyId(setup.gcp);
    expect(setup.cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`),
      `keys create ${keyId}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect(liftedWhenLifting).toEqual([true, true, true, true]);
    expect(waited(setup.sleeps)).toBeGreaterThan(61_000);
    expect(waited(setup.sleeps)).toBeLessThan(15 * 60_000);
    expect(setup.events).toContainEqual({
      type: 'step-waiting',
      step: 'provision_gcp',
      reason: 'Waiting for Google Cloud to allow service-account key creation; it can take up to 15 minutes…',
    });
    const journal = await setup.journal();
    expect(journal.key_policy_lifted).toBe(false);
    expect(journal.steps.provision_gcp?.completed_at).toBeDefined();
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps the lift and stops with Google’s answer when key creation is still refused 15 minutes after it', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    setup.cloud.policyLag = 999;

    const failure = await setup.run().catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'gcloud_failed',
      message: expect.stringMatching(/15 minutes.*stays lifted until the key exists.*gws-ea remove/su),
      details: { stderrTail: expect.stringContaining('FAILED_PRECONDITION') },
    });
    expect(waited(setup.sleeps)).toBeGreaterThanOrEqual(15 * 60_000);
    const lift = KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`);
    expect(setup.cloud.mutations).toEqual(lift);
    expect((await setup.journal()).key_policy_lifted).toBe(true);
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });

    // Once Google applies the lift, the next run restores nothing before the key exists.
    setup.cloud.policyLag = 0;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });
    expect(setup.cloud.mutations).toEqual([
      ...lift,
      `keys create ${await publishedKeyId(setup.gcp)}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('stops on a project pending deletion, naming how to restore it', async () => {
    const setup = await harness();
    setup.cloud.ready().project!.lifecycleState = 'DELETE_REQUESTED';

    await expect(setup.run()).rejects.toMatchObject({
      code: 'gcp_project_unavailable',
      message: expect.stringContaining(`gcloud projects undelete ${setup.gcp.projectId}`),
    });
    expect(setup.cloud.mutations).toEqual([]);
  });

  it('keeps a policy lifted before a crash until the next run has created the key', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.managed.disableServiceAccountKeyCreation');
    let lifted = 0;
    const dying: GcloudCommandRunner = async (command) => {
      if (lifted === KEY_CONSTRAINTS.length) throw new Error('The process died');
      const outcome = await setup.cloud.run(command);
      if (command.args[1] === 'set-policy') lifted += 1;
      return outcome;
    };

    await expect(setup.run(dying)).rejects.toThrow('The process died');
    expect((await setup.journal()).key_policy_lifted).toBe(true);
    expect([...setup.cloud.projectPolicies.values()]).toEqual([false, false]);

    const before = setup.cloud.mutations.length;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations.slice(before)).toEqual([
      `keys create ${await publishedKeyId(setup.gcp)}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('resumed after the key was published, restores the lifted policy and creates nothing', async () => {
    const setup = await harness();
    setup.cloud.orgEnforced.add('iam.disableServiceAccountKeyCreation');
    let policyChanges = 0;
    const dying: GcloudCommandRunner = async (command) => {
      if (command.args[1] === 'set-policy' && ++policyChanges > KEY_CONSTRAINTS.length) {
        throw new Error('The process died');
      }
      return setup.cloud.run(command);
    };

    await expect(setup.run(dying)).rejects.toThrow('The process died');
    const keyId = await publishedKeyId(setup.gcp);
    expect((await setup.journal()).key_policy_lifted).toBe(true);

    const before = setup.cloud.mutations.length;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });

    expect(setup.cloud.mutations.slice(before)).toEqual(
      KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    );
    expect(await publishedKeyId(setup.gcp)).toBe(keyId);
    expect(setup.cloud.userKeys).toEqual(new Set([keyId]));
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('pauses, naming the policy role and the project, when the policy cannot be changed', async () => {
    const setup = await harness();
    setup.cloud.ready().orgEnforced.add('iam.disableServiceAccountKeyCreation');
    setup.cloud.canSetPolicy = false;

    const result = await setup.run();

    expect(result).toMatchObject({
      status: 'paused',
      pause: {
        phase: 'provision_gcp',
        code: 'gcp_policy_permission_required',
        message: expect.stringContaining(setup.gcp.projectId),
        details: [expect.stringContaining('roles/orgpolicy.policyAdmin')],
      },
    });
    expect(setup.cloud.mutations).toEqual([]);
    await expect(stat(setup.gcp.credentialFile)).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(stat(setup.staging)).rejects.toMatchObject({ code: 'ENOENT' });

    setup.cloud.canSetPolicy = true;
    await expect(setup.run()).resolves.toEqual({ status: 'ready' });
    expect(setup.cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=false`),
      `keys create ${await publishedKeyId(setup.gcp)}`,
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
    ]);
    expect((await setup.journal()).key_policy_lifted).toBe(false);
  });

  it('stops with evidence and changes nothing when a read fails in an unrecognized way', async () => {
    const setup = await harness();
    setup.cloud.ready().userKeys.add('orphan');
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args.slice(0, 3).join(' ') === 'iam service-accounts list'
        ? failed(GCLOUD_CRASHED)
        : setup.cloud.run(command);

    const failure = await setup.run(runCommand).catch((error: unknown) => error);

    expect(failure).toMatchObject({
      code: 'observation_unknown',
      message: expect.stringContaining('the Chat subscriber account'),
      details: { evidence: expect.stringContaining('gcloud crashed (TypeError)') },
    });
    expect(setup.sleeps).toEqual(FULL_WAIT);
    expect(setup.cloud.mutations).toEqual([]);
    expect(setup.cloud.userKeys).toEqual(new Set(['orphan']));
  });

  it('signs in when the sign-in expired mid-step, then continues without repeating a change', async () => {
    const setup = await harness();
    let expired = true;
    const runCommand: GcloudCommandRunner = async (command) => {
      if (expired && command.args[0] === 'services') {
        expired = false;
        return failed(TOKEN_REFRESH_FAILED);
      }
      return setup.cloud.run(command);
    };

    await expect(setup.run(runCommand)).resolves.toEqual({ status: 'ready' });

    expect(setup.signIns).toEqual([ACCOUNT]);
    expect(setup.cloud.mutations.filter((entry) => entry.startsWith('projects create '))).toHaveLength(1);
  });
});

describe('Google Cloud project removal', () => {
  async function removal(): Promise<{ cloud: FakeGoogleCloud; coordinates: GcpProjectCoordinates }> {
    const root = await tempRoot();
    const instanceId = randomUUID();
    const projectId = deriveGcpProjectId(instanceId);
    const coordinates = { instanceId, projectId, account: ACCOUNT, cwd: root };
    const cloud = new FakeGoogleCloud({
      ...coordinates,
      serviceAccountEmail: deriveGchatServiceAccountEmail(projectId),
      credentialFile: path.join(root, 'gchat.json'),
    });
    return { cloud, coordinates };
  }

  it('requests deletion only after ownership verification and treats a repeated delete as complete', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();

    const options = { restoreKeyPolicy: false };
    await expect(deleteOwnedGcpProject(coordinates, options, { runCommand: cloud.run })).resolves.toEqual({
      status: 'deleted',
    });
    await expect(deleteOwnedGcpProject(coordinates, options, { runCommand: cloud.run })).resolves.toEqual({
      status: 'deleted',
    });

    expect(cloud.project?.lifecycleState).toBe('DELETE_REQUESTED');
    expect(cloud.mutations).toEqual([`projects delete ${coordinates.projectId}`]);
  });

  it('reports a project Google will not show as unknown, with evidence, and changes nothing', async () => {
    const { cloud, coordinates } = await removal();

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({
      status: 'unknown',
      reason: expect.stringContaining(coordinates.projectId),
      evidence: expect.stringContaining('(or it may not exist)'),
    });
    expect(cloud.mutations).toEqual([]);
  });

  it('restores a lifted key-creation policy and a relaxed member-domain policy before it requests deletion', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();
    for (const constraint of KEY_CONSTRAINTS) cloud.projectPolicies.set(constraint, false);
    cloud.projectPolicies.set('iam.managed.allowedPolicyMembers', false);

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({ status: 'deleted' });

    expect(cloud.mutations).toEqual([
      ...KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`),
      'delete-policy iam.managed.allowedPolicyMembers',
      `projects delete ${coordinates.projectId}`,
    ]);
  });

  it('still deletes the project, reporting each policy unrestored, when Google refuses its restore', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready().canSetPolicy = false;
    cloud.projectPolicies.set('iam.allowedPolicyMemberDomains', false);

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).resolves.toEqual({
      status: 'deleted',
      keyPolicyUnrestored: expect.stringContaining('PERMISSION_DENIED'),
      memberPolicyUnrestored: expect.stringMatching(/^iam\.allowedPolicyMemberDomains: .*PERMISSION_DENIED/su),
    });
    expect(cloud.mutations).toEqual([`projects delete ${coordinates.projectId}`]);
    expect(cloud.projectPolicies).toEqual(new Map([['iam.allowedPolicyMemberDomains', false]]));
  });

  it('reports a restore Google refuses as evidence rather than a pause', async () => {
    const { cloud, coordinates } = await removal();

    await expect(restoreKeyCreationPolicyForRemoval(coordinates, { runCommand: cloud.run })).resolves.toEqual(
      expect.stringContaining('PERMISSION_DENIED'),
    );
    cloud.ready();
    await expect(restoreKeyCreationPolicyForRemoval(coordinates, { runCommand: cloud.run })).resolves.toBeUndefined();
    expect(cloud.mutations).toEqual(KEY_CONSTRAINTS.map((constraint) => `set-policy ${constraint} enforce=true`));
  });

  it('refuses project deletion when the instance ownership label differs', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready().project!.labels['gws-ea-instance'] = randomUUID();

    await expect(
      deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: true }, { runCommand: cloud.run }),
    ).rejects.toMatchObject({
      code: 'gcp_project_owner_mismatch',
      message: expect.stringContaining(coordinates.projectId),
    });
    expect(cloud.mutations).toEqual([]);
  });

  it('does not complete removal when Google Cloud leaves the project active after delete', async () => {
    const { cloud, coordinates } = await removal();
    cloud.ready();
    const runCommand: GcloudCommandRunner = async (command) =>
      command.args[1] === 'delete' ? ok() : cloud.run(command);

    await expect(deleteOwnedGcpProject(coordinates, { restoreKeyPolicy: false }, { runCommand })).rejects.toMatchObject(
      {
        code: 'gcp_delete_unconfirmed',
      },
    );
    expect(cloud.project?.lifecycleState).toBe('ACTIVE');
  });
});
