/** Published schemas for the managed wire contract and native result facts. */
import type { ResultSchema } from './command-definitions.js';
import { VOICE_CAPABILITY } from './capabilities.js';
import { OPERATION_PHASES } from './operation.js';
import { BROWSER_CAPABILITY } from './browser-capability.js';
import { ARTIFACTS_CAPABILITY } from './artifacts-capability.js';
import { ONEPASSWORD_CAPABILITY, ONEPASSWORD_PENDING_REASONS, ONEPASSWORD_SKIP_REASONS } from './onepassword.js';

const text = { type: 'string' } as const;
/** Native protocol text shares the published string shape, but retains its producer semantics. */
export const ERROR_CODE_SCHEMA = { type: 'string' } as const;
export const RESUME_FLAGS_SCHEMA = { type: 'string' } as const;
export const PROVISION_PHASE_SCHEMA = { type: 'string' } as const;
const bool = { type: 'boolean' } as const;
const count = { type: 'integer', minimum: 0 } as const;
const time = { type: 'string', format: 'date-time' } as const;
const nil = { type: 'null' } as const;
const nullable = (schema: ResultSchema): ResultSchema => ({ anyOf: [schema, nil] });
const array = (items: ResultSchema): ResultSchema => ({ type: 'array', items });
const choices = (...values: readonly string[]): ResultSchema => ({ type: 'string', enum: values });
const voiceModel = choices(...VOICE_CAPABILITY.models);
const object = (
  properties: Readonly<Record<string, ResultSchema>>,
  required = Object.keys(properties),
): ResultSchema => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});
const release = object({ source_remote: text, release_track: text, deployed_commit: text });
const effect = nullable(bool);
const phase = {
  oneOf: [
    object({ state: { const: 'live' }, release: text }),
    object({ state: { const: 'fenced' } }),
    object({ state: { const: 'unknown' }, reason: text }),
  ],
};
const serviceState = choices('running', 'stopped', 'not_installed', 'unmanaged', 'unknown');
const releaseView = object({
  deployed_commit: text,
  tool_commit: nullable(text),
  behind_tool_release: effect,
  reason: nullable(text),
});
const followUp = {
  oneOf: [
    object({ kind: { const: 'prune' } }),
    object({ kind: { const: 'rebuild_group_image' }, agent_group_id: text }),
    object({ kind: { const: 'reclaim_image' }, image_id: text }),
  ],
};
const operationFacts = {
  kind: choices('update', 'rollback'),
  phase: choices(...OPERATION_PHASES),
  from: release,
  to: release,
  started_at: time,
  updated_at: time,
};
const continuation = { continue_with: text, revert_with: nullable(text) };
const operation = {
  oneOf: [
    object({ state: { const: 'none' } }),
    object({ state: { const: 'unreadable' }, code: ERROR_CODE_SCHEMA, message: text }),
    object({ state: { const: 'open' }, ...operationFacts, ...continuation }),
    object({ state: { const: 'failed' }, ...operationFacts, ...continuation, outcome: text }),
    object({ state: { const: 'committed' }, ...operationFacts, follow_ups: array(followUp) }),
  ],
};
const probe = (facts: Readonly<Record<string, ResultSchema>> = {}): ResultSchema =>
  object({ status: choices('ok', 'degraded', 'unknown'), reason: nullable(text), ...facts });
const probes = object({
  checkout: probe({ commit: nullable(text) }),
  image: probe({ tag: nullable(text) }),
  service: probe({ state: serviceState }),
  host: probe(),
  onecli: probe(),
  principal: probe(),
  main_identity: probe({ agent_group_id: nullable(text) }),
  external_email: probe({ agent_group_id: nullable(text) }),
  whatsapp: probe({
    state: nullable(choices('unlinked', 'linking', 'connected', 'needs-relink')),
    number: nullable(text),
  }),
  external_chat: probe({ agent_group_id: nullable(text) }),
  job_agents: probe({
    count: nullable(count),
    jobs: nullable(
      array(
        probe({
          agent_group_id: nullable(text),
          messaging_group_id: nullable(text),
          state: nullable(text),
        }),
      ),
    ),
  }),
  workspace: probe({ account: nullable(text) }),
  chat: probe({
    consumer_connected: effect,
    last_pull_at: nullable(time),
    subscription_state: nullable(choices('unknown', 'active', 'suspended', 'expired')),
    subscription_expire_time: nullable(time),
    sign_in_needed: effect,
  }),
  inbox: probe({
    state: nullable(choices('healthy', 'unhealthy')),
    since: nullable(time),
    last_success_at: nullable(time),
    calendar_notifications: nullable(object({ state: choices('unknown', 'ok', 'failing'), reason: nullable(text) })),
    calendar_access: nullable(
      array(
        object({
          address: text,
          access: choices('unchecked', 'bookable', 'readable', 'free-busy', 'none'),
          checked_at: nullable(time),
        }),
      ),
    ),
  }),
  delivery: probe({
    last: nullable(object({ status: text, message_out_id: text, at: time })),
    retrying: nullable(count),
  }),
  web_alias: probe({
    state: nullable(choices('not_needed', 'pending', 'verified')),
    address: nullable(text),
    probe_sent: effect,
  }),
  voice: probe({
    enabled: effect,
    assets: choices('verified', 'absent', 'invalid', 'unknown'),
    compatibility: choices('compatible', 'unsupported', 'unknown'),
    readiness: choices('ready', 'unavailable', 'unknown'),
    queued: nullable(count),
    inflight: nullable(count),
    last_outcome: nullable(object({ status: choices('recognized', 'no-speech', 'unavailable', 'failed'), at: time })),
    last_failure: nullable(object({ reason: text, at: time })),
  }),
});
export const LIST_DATA_SCHEMA = object({
  observed_at: time,
  assistants: array(
    object({
      instance_id: text,
      account: text,
      track: text,
      deployed_commit: text,
      phase,
      release: releaseView,
      service: object({ state: serviceState, reason: nullable(text) }),
      operation,
      removal_in_progress: bool,
    }),
  ),
});
export const STATUS_DATA_SCHEMA = object({
  instance_id: text,
  observed_at: time,
  phase,
  registry: object({ account: text, track: text, source_remote: text, deployed_commit: text }),
  operation,
  removal_in_progress: bool,
  release: releaseView,
  rollback: object({ available: bool, previous_commit: nullable(text), schema_moved: effect, reason: nullable(text) }),
  schema: object({
    central_fingerprint: nullable(text),
    session_fingerprint: nullable(text),
    latest_migration: nullable(text),
    reason: nullable(text),
  }),
  probes,
});
const artifactReceipt = object({ file: text, size: count, sha256: text });
const voiceReceipt = object({
  schemaVersion: { const: 1 },
  recipe: text,
  platform: choices('darwin', 'linux'),
  architecture: choices('arm64', 'x64'),
  model: voiceModel,
  builtAt: time,
  artifacts: object({
    ffmpeg: artifactReceipt,
    whisperCli: artifactReceipt,
    model: artifactReceipt,
    vad: artifactReceipt,
  }),
});
const source = { url: text, sha256: text };
export const VOICE_CAPABILITY_SCHEMA = object({
  observed_at: time,
  name: { const: 'voice' },
  actions: array(choices(...VOICE_CAPABILITY.actions)),
  scope: { const: 'host' },
  summary: text,
  availability: object({ status: choices('supported', 'unsupported'), platform: text, architecture: text }),
  activation: object({ status: choices('enabled', 'disabled', 'unknown'), enabled: effect, reason: nullable(text) }),
  assets: object({
    status: choices('verified', 'absent', 'invalid', 'unknown'),
    reason: nullable(text),
    selected_directory: nullable(text),
    selected_model: nullable(voiceModel),
    installations: array(
      object({
        model: voiceModel,
        directory: text,
        status: choices('verified', 'absent', 'invalid', 'unknown'),
        reason: nullable(text),
        receipt: nullable(voiceReceipt),
      }),
    ),
    provenance: nullable(voiceReceipt),
  }),
  default_model: voiceModel,
  models: array(voiceModel),
  prerequisites: array(text),
  readiness_limits: array(text),
  recipe: text,
  sources: object({
    whisper: object(source),
    ffmpeg: object(source),
    vad: object({ ...source, filename: text, size: count }),
  }),
  assistants: array(
    object({
      instance_id: text,
      compatibility: choices('compatible', 'unsupported', 'unknown'),
      readiness: choices('ready', 'unavailable', 'unknown'),
      reason: nullable(text),
      consumer: object({
        status: choices('observed', 'unknown', 'not-applicable'),
        enabled: effect,
        queued: nullable(count),
        inflight: nullable(count),
      }),
      last_outcome: nullable(object({ status: choices('recognized', 'no-speech', 'unavailable', 'failed'), at: time })),
      last_failure: nullable(object({ reason: text, at: time })),
    }),
  ),
  compatible_assistant_ids: array(text),
  unsupported_assistant_ids: array(text),
  unknown_assistant_ids: array(text),
  future_compatible_assistants: { const: true },
});
const pause = object(
  {
    phase: PROVISION_PHASE_SCHEMA,
    code: ERROR_CODE_SCHEMA,
    message: text,
    details: array(text),
    actionUrl: text,
    resumeFlag: RESUME_FLAGS_SCHEMA,
    choices: array(object({ id: text, label: text })),
  },
  ['phase', 'code', 'message'],
);
const browserMetadata = {
  name: { const: 'browser' },
  scope: { const: 'assistant' },
  actions: array(choices(...BROWSER_CAPABILITY.actions)),
  summary: text,
};
const browserAccess = {
  oneOf: [object({ version: { const: 1 } }), object({ version: { const: 2 }, agent_group_ids: array(text) })],
};
const browserIsolationCheck = { status: choices('not_run', 'passed', 'failed', 'unknown'), reason: nullable(text) };
export const BROWSER_CAPABILITY_SCHEMA = object({
  ...browserMetadata,
  instance_id: text,
  observed_at: time,
  activation: choices('enabled', 'disabled', 'unavailable'),
  policy_file: text,
  chrome: object({
    path: text,
    status: choices('not_checked', 'available', 'unavailable'),
    version: nullable(text),
    reason: nullable(text),
  }),
  isolation: object({
    ...browserIsolationCheck,
    proxy: object(browserIsolationCheck),
    debugger: object(browserIsolationCheck),
  }),
  ready: bool,
  access: nullable(browserAccess),
});
export const BROWSER_OPERATION_SCHEMA = object(
  { ...browserMetadata, instance_id: text, enabled: bool, changed: bool, access: browserAccess, pause },
  [...Object.keys(browserMetadata), 'instance_id', 'enabled', 'changed', 'access'],
);
const onePasswordMetadata = {
  name: { const: 'onepassword' },
  scope: { const: 'host' },
  actions: array(choices(...ONEPASSWORD_CAPABILITY.actions)),
  summary: text,
};
const artifactsMetadata = {
  name: { const: 'artifacts' },
  scope: { const: 'assistant' },
  actions: array(choices(...ARTIFACTS_CAPABILITY.actions)),
  summary: text,
};
export const ARTIFACTS_CAPABILITY_SCHEMA = object({
  ...artifactsMetadata,
  instance_id: text,
  observed_at: time,
  activation: choices('enabled', 'disabled', 'unavailable'),
  hostname: nullable(text),
  path_prefix: nullable(text),
  policy_file: text,
  remote: choices('not_checked', 'verified', 'unavailable'),
  listener: choices('not_checked', 'listening', 'unavailable'),
  ready: bool,
  reason: nullable(text),
  operator: object({
    status: choices('configured', 'missing', 'unavailable'),
    account_id: nullable(text),
    team_name: nullable(text),
    zone_id: nullable(text),
    hostname: nullable(text),
    pending: nullable(object({ kind: text, attempt: text, started_at: time })),
  }),
});
export const ARTIFACTS_OPERATION_SCHEMA = object({
  ...artifactsMetadata,
  instance_id: text,
  enabled: bool,
  changed: bool,
  hostname: nullable(text),
  path_prefix: nullable(text),
});
const onePasswordCheck = choices('not_checked', 'verified', 'failed');
const onePasswordToken = choices('present', 'absent', 'invalid');
export const ONEPASSWORD_CAPABILITY_SCHEMA = object({
  ...onePasswordMetadata,
  observed_at: time,
  activation: object({ status: choices('enabled', 'disabled', 'unknown'), reason: nullable(text) }),
  account_id: nullable(text),
  cli: object({
    path: nullable(text),
    status: choices('not_checked', 'available', 'unavailable'),
    version: nullable(text),
    reason: nullable(text),
  }),
  management: object({
    service_account_id: nullable(text),
    token: onePasswordToken,
    status: onePasswordCheck,
    reason: nullable(text),
  }),
  quota: object({
    status: choices('not_checked', 'observed', 'unknown'),
    account_type: nullable(choices('individual', 'families', 'teams', 'business')),
    sharing_assistant_ids: array(text),
    daily: nullable(object({ limit: count, used: count, remaining: count })),
    hourly_per_token: nullable(object({ read: nullable(count), write: nullable(count) })),
    reason: nullable(text),
  }),
  assistants: array(
    object({
      instance_id: text,
      compatibility: choices('compatible', 'unsupported', 'unknown'),
      provisioning: choices('ready', 'incomplete', 'absent', 'invalid', 'not_applicable'),
      vault_id: nullable(text),
      runtime_service_account_id: nullable(text),
      retired_service_account_ids: array(text),
      recorded_grants: object({
        operator: nullable(object({ user_id: text, permissions: array(text) })),
        runtime: nullable(array(text)),
      }),
      runtime_token: onePasswordToken,
      unproven_creation: nullable(choices('vault', 'service_account')),
      access: object({ status: onePasswordCheck, reason: nullable(text) }),
      write: { const: 'untested' },
      reason: nullable(text),
    }),
  ),
  prerequisites: array(text),
  readiness_limits: array(text),
  future_compatible_assistants: { const: true },
});
export const ONEPASSWORD_OPERATION_SCHEMA = object({
  name: { const: 'onepassword' },
  scope: { const: 'host' },
  enabled: { const: true },
  account_id: text,
  management_service_account_id: text,
  assistants: array(
    object({
      instance_id: text,
      outcome: choices('ready', 'pending', 'skipped'),
      reason: nullable(choices(...ONEPASSWORD_PENDING_REASONS, ...ONEPASSWORD_SKIP_REASONS)),
      message: nullable(text),
      changed: effect,
      vault_id: nullable(text),
      runtime_service_account_id: nullable(text),
      retired_service_account_ids: array(text),
    }),
  ),
  future_compatible_assistants: { const: true },
});
export const ONEPASSWORD_DISABLE_SCHEMA = object({
  name: { const: 'onepassword' },
  scope: { const: 'host' },
  enabled: { const: false },
  account_id: nullable(text),
  management_service_account_id: nullable(text),
  assistants: array(
    object({
      instance_id: text,
      outcome: choices('disabled', 'pending'),
      reason: nullable(text),
      changed: effect,
      vault_id: nullable(text),
      runtime_token: choices('deleted', 'absent', 'kept'),
      revoke_service_account_ids: array(text),
      unproven_service_account: nullable(text),
    }),
  ),
});
export const CAPABILITY_LIST_SCHEMA = object({
  capabilities: array({
    oneOf: [
      VOICE_CAPABILITY_SCHEMA,
      object({ ...browserMetadata, assistant_ids: array(text) }),
      object({ ...artifactsMetadata, assistant_ids: array(text) }),
      object({ ...onePasswordMetadata, activation: choices('enabled', 'disabled', 'unknown') }),
    ],
  }),
});
export const VOICE_OPERATION_SCHEMA = object(
  {
    name: { const: 'voice' },
    scope: { const: 'host' },
    enabled: bool,
    installation_dir: text,
    compatible_assistant_ids: array(text),
    unsupported_assistant_ids: array(text),
    unknown_assistant_ids: array(text),
    future_compatible_assistants: { const: true },
  },
  ['name', 'scope'],
);
const cleanup = object(
  { checkout: text, removed: array(text), incomplete: bool, error: object({ code: ERROR_CODE_SCHEMA, message: text }) },
  ['checkout', 'removed'],
);
const vaultOutcome = ['deleted', 'retained', 'gone'] as const;
const unprovenCreations = array(object({ kind: choices('vault', 'service_account'), name: text }));
const removalPreview = object({
  instanceId: text,
  checkout: text,
  gcpProject: text,
  gcpAccount: text,
  onecliProject: text,
  onepassword: nullable(
    object({
      account_id: text,
      vault_id: nullable(text),
      owned: bool,
      item_count: nullable(count),
      vault: choices('delete', 'retain', ...vaultOutcome, 'unrecorded'),
      reason: text,
      runtime_service_account_ids: array(text),
      unproven: unprovenCreations,
    }),
  ),
});
const removal = object(
  {
    removed: array(choices('whatsapp', 'nanoclaw', 'chat-subscription', 'gcp-project', 'onecli', 'instance-files')),
    abandoned: array(object({ resource: choices('gcp-project', 'chat-subscription', 'onepassword'), evidence: text })),
    keyPolicyUnrestored: text,
    memberPolicyUnrestored: text,
    onepassword: object({
      account_id: text,
      vault_id: nullable(text),
      vault: choices(...vaultOutcome, 'left_behind', 'unrecorded'),
      item_count: nullable(count),
      reason: text,
      runtime_token: choices('deleted', 'absent'),
      revoke_service_account_ids: array(text),
      unproven: unprovenCreations,
      receipt_file: nullable(text),
    }),
  },
  ['removed', 'abandoned'],
);
const updatePreview = object({
  instanceId: text,
  from: release,
  to: release,
  migrations: array(text),
  gateway: object({ current: text, release: text }),
  groupImages: array(object({ id: text, name: text })),
  agentRunnerLockChanged: bool,
  sessionSchemaChanged: bool,
});
const updated = object({ from: release, to: release, rollbackTarget: bool, signInNeeded: nullable(text) });
const assistantUpdate = {
  oneOf: [object({ kind: { const: 'updated' }, updated }), object({ kind: { const: 'completed' }, release })],
};
const turn = {
  oneOf: [
    object({ kind: { const: 'follow_ups' }, release }),
    object({ kind: { const: 'update' }, from: release, to: release, migrations: array(text) }, ['kind', 'from', 'to']),
  ],
};
const candidate = {
  oneOf: [
    object({ instanceId: text, eligible: { const: true }, turn }),
    object({ instanceId: text, eligible: { const: false }, reason: text }),
  ],
};
const plan = object({ toolCommit: text, candidates: array(candidate) });
const targets = array({
  oneOf: [
    object({ instance_id: text, outcome: { const: 'completed' }, update: assistantUpdate }),
    object({ instance_id: text, outcome: { const: 'skipped' }, reason: text }),
    object({ instance_id: text, outcome: choices('busy', 'failed', 'unattempted') }),
  ],
});
const discardedRows = object({ count, ids: array(text) });
const rollbackPreview = object({
  instanceId: text,
  from: release,
  to: release,
  snapshotAt: time,
  reason: choices('central_schema', 'session_schema', 'requested'),
  keptAt: text,
  discarded: object({
    inbound: discardedRows,
    rerun: discardedRows,
    taskFirings: discardedRows,
    redelivered: discardedRows,
    centralRows: array(object({ table: text, count })),
    files: object({ count, paths: array(text) }),
    orphanedAgents: array(text),
    jobAgents: array(object({ agent_group_id: text, messaging_group_id: text, state: text })),
  }),
});
const rollbackFacts = {
  kind: { const: 'rolled_back' },
  from: release,
  to: release,
  snapshotAt: time,
  signInNeeded: nullable(text),
};
const rollback = {
  oneOf: [
    object({ ...rollbackFacts, mode: { const: 'code_only' } }),
    object({ ...rollbackFacts, mode: { const: 'snapshot' }, keptAt: text }),
    object({ kind: { const: 'update_discarded' }, release, discarded: release }),
    object({ kind: choices('follow_ups_finished', 'declined'), release }),
  ],
};
const identity = { instance_id: text };
const common = {
  ...identity,
  cleanup,
  preparation: object({ bootstrap_manifest: choices('retained', 'unknown'), reservation: { const: 'unknown' } }),
};
export function operationDataSchema(command: string): ResultSchema {
  switch (command) {
    case 'create':
    case 'resume':
    case 'connect-google':
      return object({ ...common, pause }, []);
    case 'start':
    case 'stop':
    case 'restart':
      return object(
        {
          ...identity,
          service: object({
            action: { const: command },
            result:
              command === 'start'
                ? choices('started', 'already-running')
                : command === 'stop'
                  ? choices('stopped', 'already-stopped')
                  : choices('restarted', 'started'),
          }),
        },
        [],
      );
    case 'update':
      return object(
        {
          ...common,
          preview: updatePreview,
          staging: object({ retained: { const: true }, release }),
          update: assistantUpdate,
          plan,
          targets,
        },
        [],
      );
    case 'rollback':
      return object({ ...identity, preview: rollbackPreview, rollback }, []);
    case 'remove':
      return object({ ...identity, preview: removalPreview, removal }, []);
    case 'cleanup':
      return object({ cleanup }, []);
    default:
      throw new Error(`No operation data schema for ${command}`);
  }
}
/** Each command publishes its whole result, including normally handled error/pause paths. */
export function managedResultSchema(data: ResultSchema): ResultSchema {
  return object({
    schema_version: { const: 1 },
    command: text,
    outcome: choices('succeeded', 'paused', 'failed', 'busy', 'cancelled'),
    changed: effect,
    data: nullable(data),
    error: nullable(object({ code: ERROR_CODE_SCHEMA, message: text })),
    next_actions: array({
      oneOf: [
        object({ kind: { const: 'command' }, argv: array(text) }),
        object({ kind: { const: 'external' }, instruction: text, url: text }, ['kind', 'instruction']),
      ],
    }),
    diagnostics: object({ run_log: text, step_log: text }, []),
  });
}
