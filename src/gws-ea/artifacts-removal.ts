import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import {
  artifactsApi,
  artifactsOperatorFiles,
  parseArtifactsOperatorConfig,
  readArtifactsOperatorConfig,
  writeArtifactsOperatorConfig,
  type ArtifactsOperatorConfig,
} from './artifacts-cloudflare.js';
import { renderArtifactsConnectorService, setArtifactsIngress } from './artifacts-connector.js';
import type { ControlPlanePaths } from './paths.js';
import { runSanitizedCommandOutcome, buildToolEnvironment, type SanitizedCommandOutcomeRunner } from './process.js';
import { readRegistry, withMachineLock } from './registry.js';
import { readOwnerOnlyFile, removePrivateFile } from './secrets.js';
import { GwsEaError, type InstanceReservation } from './types.js';
import { isRecord } from './validation.js';

export interface ArtifactsCleanup {
  readonly schemaVersion: 1;
  /** This assistant's entry and the shared resources only; never a credential or content. */
  readonly ownership: ArtifactsOperatorConfig;
  readonly completed: readonly string[];
  readonly sharedRetained: boolean;
}
export interface ArtifactsCleanupBlock {
  readonly reason: string;
  readonly evidence: string;
}
export type ArtifactsCapture =
  | { readonly status: 'none' }
  | { readonly status: 'captured'; readonly cleanup: ArtifactsCleanup }
  | ({ readonly status: 'unreadable' } & ArtifactsCleanupBlock);

export function parseArtifactsCleanup(value: unknown): ArtifactsCleanup | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.completed) ||
    !value.completed.every(
      (entry): entry is string =>
        typeof entry === 'string' &&
        /^(?:ingress|application|connector|tunnel|pin|remote|tunnel-token|management-token|dns:[a-zA-Z0-9_-]{1,256})$/u.test(
          entry,
        ),
    ) ||
    typeof value.sharedRetained !== 'boolean'
  )
    return undefined;
  try {
    return {
      schemaVersion: 1,
      ownership: parseArtifactsOperatorConfig(value.ownership),
      completed: value.completed,
      sharedRetained: value.sharedRetained,
    };
  } catch (cause) {
    if (cause instanceof GwsEaError) return undefined;
    throw cause;
  }
}
function refusal(paths: ControlPlanePaths, message: string, cleanup?: ArtifactsCleanup): ArtifactsCleanupBlock {
  const config = cleanup?.ownership;
  return {
    reason: 'Artifacts cleanup could not be verified. Its ownership record and credentials remain for retry.',
    evidence: [
      message,
      `Ownership record: ${artifactsOperatorFiles(paths).configFile}`,
      ...(config
        ? [
            `Cloudflare account: ${config.accountId}`,
            ...Object.entries(config.assistants).map(
              ([id, assistant]) =>
                `Assistant ${id}: Access application ${assistant.applicationId ?? 'unrecorded'}, policy ${assistant.policyId ?? 'unrecorded'}`,
            ),
            `Tunnel: ${config.tunnelId ?? 'unrecorded'}; PIN: ${config.pin?.id ?? 'unrecorded'} (${config.pin?.owned ? 'owned' : 'external'})`,
            ...Object.entries(config.dns).map(
              ([hostname, dns]) => `DNS ${hostname}: zone ${dns.zoneId}, record ${dns.id}`,
            ),
            ...(config.connector
              ? [`Connector: ${config.connector.manager} ${config.connector.label}, ${config.connector.definitionFile}`]
              : []),
            ...(config.pending
              ? [
                  `Unproven ${config.pending.kind}: attempt ${config.pending.key}, target ${config.pending.target}, resource ${config.pending.resource}, started ${config.pending.startedAt}${config.pending.name ? `, name ${config.pending.name}` : ''}`,
                ]
              : []),
          ]
        : []),
    ].join('\n'),
  };
}
export async function captureArtifactsCleanup(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<ArtifactsCapture> {
  const claim = reservation.exclusive_resource_claims.artifacts;
  if (!claim) return { status: 'none' };
  try {
    const config = await readArtifactsOperatorConfig(artifactsOperatorFiles(paths).configFile);
    if (!config)
      return {
        status: 'unreadable',
        ...refusal(paths, 'The claimed artifacts namespace has no readable ownership record.'),
      };
    const own = config.assistants[reservation.instance_id];
    if (own && JSON.stringify(own.claim) !== JSON.stringify(claim))
      return {
        status: 'unreadable',
        ...refusal(paths, 'The artifact ownership record does not match the reserved namespace.'),
      };
    return {
      status: 'captured',
      cleanup: {
        schemaVersion: 1,
        ownership: { ...config, assistants: own ? { [reservation.instance_id]: own } : {} },
        completed: [],
        sharedRetained: false,
      },
    };
  } catch (cause) {
    if (!(cause instanceof GwsEaError)) throw cause;
    return { status: 'unreadable', ...refusal(paths, cause.message) };
  }
}

async function stopConnector(
  paths: ControlPlanePaths,
  config: ArtifactsOperatorConfig,
  run: SanitizedCommandOutcomeRunner,
): Promise<void> {
  const connector = config.connector;
  if (!connector) return;
  const files = artifactsOperatorFiles(paths);
  const expected = renderArtifactsConnectorService(files, config.cloudflaredPath, connector);
  const stored = await readOwnerOnlyFile(connector.definitionFile).catch((cause: unknown) => {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  });
  if (stored !== undefined && stored !== expected)
    throw new GwsEaError(
      'artifacts_connector_conflict',
      'The recorded connector definition was changed; it was left untouched.',
    );
  const invoke = (command: string, args: readonly string[]) =>
    run({
      command,
      args,
      cwd: files.root,
      env: buildToolEnvironment(
        { HOME: connector.homeDirectory, PATH: '/usr/local/bin:/usr/bin:/bin' },
        {
          ...(connector.manager === 'systemd-user' && process.getuid
            ? {
                XDG_RUNTIME_DIR: `/run/user/${process.getuid()}`,
                DBUS_SESSION_BUS_ADDRESS: `unix:path=/run/user/${process.getuid()}/bus`,
              }
            : {}),
        },
      ),
      timeoutMs: 10000,
      outputLimitBytes: 4096,
    });
  if (connector.manager === 'launchd') {
    const uid = process.getuid?.();
    if (uid === undefined)
      throw new GwsEaError('artifacts_connector_unavailable', 'Cannot identify the connector service user.');
    const service = `gui/${uid}/${connector.label}`;
    const absent = (result: { readonly exitCode: number }) => result.exitCode === 113;
    const observed = await invoke('launchctl', ['print', service]);
    if (!absent(observed)) {
      if (
        observed.exitCode !== 0 ||
        (await invoke('launchctl', ['bootout', service])).exitCode !== 0 ||
        !absent(await invoke('launchctl', ['print', service]))
      )
        throw new GwsEaError(
          'artifacts_connector_unavailable',
          'The recorded connector service could not be stopped and verified absent.',
        );
    }
  } else {
    const prefix = connector.manager === 'systemd-user' ? ['--user'] : [];
    const unit = `${connector.label}.service`;
    const stopped = await invoke('systemctl', [...prefix, 'disable', '--now', unit]);
    const observed = await invoke('systemctl', [
      ...prefix,
      'show',
      unit,
      '--property=LoadState',
      '--property=ActiveState',
    ]);
    if (
      observed.exitCode !== 0 ||
      !/^ActiveState=(?:inactive|failed)$/mu.test(observed.stdout) ||
      (stopped.exitCode !== 0 && !/^LoadState=not-found$/mu.test(observed.stdout))
    )
      throw new GwsEaError(
        'artifacts_connector_unavailable',
        'The recorded connector service could not be stopped and verified inactive.',
      );
  }
  await removePrivateFile(connector.definitionFile);
  if (connector.manager !== 'launchd') {
    const prefix = connector.manager === 'systemd-user' ? ['--user'] : [];
    if ((await invoke('systemctl', [...prefix, 'daemon-reload'])).exitCode !== 0)
      throw new GwsEaError(
        'artifacts_connector_unavailable',
        'The connector definition was removed but systemd could not reload.',
      );
  }
}

export async function settleArtifactsCleanup(
  paths: ControlPlanePaths,
  instanceId: string | null,
  initial: ArtifactsCleanup,
  options: {
    readonly fetch?: typeof fetch;
    readonly runCommand?: SanitizedCommandOutcomeRunner;
    readonly record: (cleanup: ArtifactsCleanup) => Promise<void>;
  },
): Promise<ArtifactsCleanupBlock | undefined> {
  let cleanup = initial;
  try {
    await withMachineLock(paths, async () => {
      const files = artifactsOperatorFiles(paths);
      const live = await readArtifactsOperatorConfig(files.configFile);
      let recorded = cleanup.ownership;
      if (
        recorded.credentialFile !== path.join(files.root, 'management-token') ||
        Object.keys(recorded.assistants).some((id) => id !== instanceId)
      )
        throw new GwsEaError(
          'artifacts_owner_mismatch',
          'The receipt does not name this operator and assistant ownership.',
        );
      if (!live && !cleanup.completed.includes('remote'))
        throw new GwsEaError('artifacts_owner_missing', 'The exact artifact ownership record is missing.');
      if (
        live &&
        (live.accountId !== recorded.accountId ||
          live.credentialFile !== recorded.credentialFile ||
          live.tunnelId !== recorded.tunnelId ||
          JSON.stringify(live.pin) !== JSON.stringify(recorded.pin) ||
          JSON.stringify(live.connector) !== JSON.stringify(recorded.connector))
      )
        throw new GwsEaError('artifacts_owner_mismatch', 'Artifact shared ownership changed during removal.');
      if (live) {
        for (const [hostname, dns] of Object.entries(recorded.dns)) {
          const current = live.dns[hostname];
          if (current && (current.id !== dns.id || current.zoneId !== dns.zoneId))
            throw new GwsEaError('artifacts_owner_mismatch', 'The recorded DNS ownership changed during removal.');
        }
        const previous = recorded.pending;
        if (
          previous &&
          live.pending?.key !== previous.key &&
          !live.resolvedAttempts?.some(
            (attempt) =>
              attempt.key === previous.key &&
              attempt.fingerprint === previous.fingerprint &&
              attempt.resource === previous.resource &&
              attempt.target === previous.target,
          )
        )
          throw new GwsEaError(
            'artifacts_create_unproven',
            'The receipt still names an unproven creation without an explicit recorded resolution.',
          );
        const { pending: _pending, resolvedAttempts: _resolved, ...owned } = recorded;
        recorded = {
          ...owned,
          dns: { ...recorded.dns, ...live.dns },
          ...(live.pending ? { pending: live.pending } : {}),
          ...(live.resolvedAttempts ? { resolvedAttempts: live.resolvedAttempts } : {}),
        };
        cleanup = { ...cleanup, ownership: recorded };
      }
      const own = instanceId === null ? undefined : recorded.assistants[instanceId];
      const currentOwn = instanceId === null ? undefined : live?.assistants[instanceId];
      if (
        currentOwn &&
        (currentOwn.applicationId !== own?.applicationId ||
          currentOwn.policyId !== own?.policyId ||
          JSON.stringify(currentOwn.claim) !== JSON.stringify(own?.claim))
      )
        throw new GwsEaError('artifacts_owner_mismatch', 'The assistant Access ownership changed during removal.');
      const registry = await readRegistry(paths);
      const peers = [
        ...Object.values(live?.assistants ?? {})
          .filter((candidate) => candidate !== currentOwn)
          .map(({ claim }) => claim),
        ...Object.values(registry.instances)
          .filter((candidate) => candidate.instance_id !== instanceId)
          .flatMap((candidate) =>
            candidate.exclusive_resource_claims.artifacts ? [candidate.exclusive_resource_claims.artifacts] : [],
          ),
      ];
      const shared = peers.length > 0;
      if (instanceId === null && shared)
        throw new GwsEaError('artifacts_shared_in_use', 'Assistant namespace claims still need to be settled.');
      cleanup = {
        ...cleanup,
        completed:
          cleanup.sharedRetained && !shared ? cleanup.completed.filter((key) => key !== 'remote') : cleanup.completed,
        sharedRetained: shared,
      };
      await options.record(cleanup);
      const step = async (key: string, action: () => Promise<void>): Promise<void> => {
        if (cleanup.completed.includes(key)) return;
        await action();
        cleanup = { ...cleanup, completed: [...cleanup.completed, key] };
        await options.record(cleanup);
      };
      if (!cleanup.completed.includes('remote')) {
        if (!live) throw new GwsEaError('artifacts_owner_missing', 'The exact artifact ownership record is missing.');
        const config = live;
        const api = await artifactsApi(config, { fetch: options.fetch });
        const absent = async (resource: string): Promise<boolean> => {
          try {
            const result = await api.request('GET', resource);
            return isRecord(result) && typeof result.deleted_at === 'string';
          } catch (cause) {
            if (cause instanceof GwsEaError && cause.details?.status === 404) return true;
            throw cause;
          }
        };
        const remove = async (key: string, resource: string) =>
          step(key, async () => {
            if (await absent(resource)) return;
            await api.request('DELETE', resource);
            if (!(await absent(resource)))
              throw new GwsEaError('artifacts_cleanup_unverified', `Cloudflare resource is still present: ${resource}`);
          });
        const account = `/accounts/${recorded.accountId}`;
        await step('ingress', async () => {
          if (config.tunnelId && !(await absent(`${account}/cfd_tunnel/${config.tunnelId}`))) {
            const claim =
              own?.claim ??
              (instanceId === null ? undefined : registry.instances[instanceId]?.exclusive_resource_claims.artifacts);
            if (claim) await setArtifactsIngress(api, config, claim, false);
          }
        });
        if (own?.applicationId) await remove('application', `${account}/access/apps/${own.applicationId}`);
        const pending = recorded.pending;
        if (pending && (pending.target === instanceId || pending.target === own?.claim.hostname || !shared))
          throw new GwsEaError(
            'artifacts_create_unproven',
            `Unproven ${pending.kind} creation ${pending.key} must be resolved or explicitly abandoned.`,
          );
        for (const [hostname, dns] of Object.entries(recorded.dns)) {
          if (!peers.some((claim) => claim.hostname === hostname))
            await remove(`dns:${dns.id}`, `/zones/${dns.zoneId}/dns_records/${dns.id}`);
        }
        if (!shared) {
          if (recorded.tunnelId && !(await absent(`${account}/cfd_tunnel/${recorded.tunnelId}`))) {
            const remaining = await api.request('GET', `${account}/cfd_tunnel/${recorded.tunnelId}/configurations`);
            if (
              !isRecord(remaining) ||
              !isRecord(remaining.config) ||
              !Array.isArray(remaining.config.ingress) ||
              remaining.config.ingress.some(
                (route) =>
                  !isRecord(route) ||
                  route.hostname !== undefined ||
                  route.path !== undefined ||
                  route.service !== 'http_status:404',
              )
            )
              throw new GwsEaError(
                'artifacts_tunnel_conflict',
                'The owned tunnel still routes an unrelated service; shared resources were left untouched.',
              );
          }
          if (recorded.tunnelId)
            await step('connector', () =>
              stopConnector(paths, recorded, options.runCommand ?? runSanitizedCommandOutcome),
            );
          if (recorded.tunnelId) await remove('tunnel', `${account}/cfd_tunnel/${recorded.tunnelId}`);
          if (recorded.pin?.owned) await remove('pin', `${account}/access/identity_providers/${recorded.pin.id}`);
        }
        await step('remote', async () => undefined);
      }
      if (shared) {
        if (!live) throw new GwsEaError('artifacts_owner_missing', 'Shared ownership record is missing.');
        const assistants = { ...live.assistants };
        if (instanceId !== null) delete assistants[instanceId];
        const dns = Object.fromEntries(
          Object.entries(live.dns).filter(([, record]) => !cleanup.completed.includes(`dns:${record.id}`)),
        );
        await writeArtifactsOperatorConfig(files.configFile, { ...live, assistants, dns });
      } else {
        await step('connector', () => stopConnector(paths, recorded, options.runCommand ?? runSanitizedCommandOutcome));
        await step('tunnel-token', () => removePrivateFile(files.tokenFile));
        await step('management-token', () => removePrivateFile(recorded.credentialFile));
        await removePrivateFile(files.configFile);
      }
    });
    return undefined;
  } catch (cause) {
    if (!(cause instanceof Error)) throw cause;
    return refusal(
      paths,
      cause instanceof GwsEaError ? cause.message : 'A remote or local artifact cleanup boundary failed.',
      cleanup,
    );
  }
}
