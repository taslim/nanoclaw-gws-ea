import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import {
  webApi,
  webOperatorFiles,
  parseWebOperatorConfig,
  readWebOperatorConfig,
  writeWebOperatorConfig,
  type WebOperatorConfig,
} from './web-cloudflare.js';
import { renderWebConnectorService, setWebIngress } from './web-connector.js';
import type { ControlPlanePaths } from './paths.js';
import { runSanitizedCommandOutcome, buildToolEnvironment, type SanitizedCommandOutcomeRunner } from './process.js';
import { readRegistry, withMachineLock } from './registry.js';
import { readOwnerOnlyFile, removePrivateFile } from './secrets.js';
import { GwsEaError, type InstanceReservation } from './types.js';
import { isRecord } from './validation.js';

export interface WebCleanup {
  readonly schemaVersion: 1;
  /** This assistant's entry and the shared resources only; never a credential or content. */
  readonly ownership: WebOperatorConfig;
  readonly completed: readonly string[];
  readonly sharedRetained: boolean;
}
export interface WebCleanupBlock {
  readonly reason: string;
  readonly evidence: string;
}
export type WebCapture =
  | { readonly status: 'none' }
  | { readonly status: 'captured'; readonly cleanup: WebCleanup }
  | ({ readonly status: 'unreadable' } & WebCleanupBlock);

export function parseWebCleanup(value: unknown): WebCleanup | undefined {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !Array.isArray(value.completed) ||
    !value.completed.every(
      (entry: unknown): entry is string =>
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
      ownership: parseWebOperatorConfig(value.ownership),
      completed: value.completed,
      sharedRetained: value.sharedRetained,
    };
  } catch (cause) {
    if (cause instanceof GwsEaError) return undefined;
    throw cause;
  }
}
function refusal(paths: ControlPlanePaths, message: string, cleanup?: WebCleanup): WebCleanupBlock {
  const config = cleanup?.ownership;
  return {
    reason: 'Web cleanup could not be verified. Its ownership record and credentials remain for retry.',
    evidence: [
      message,
      `Ownership record: ${webOperatorFiles(paths).configFile}`,
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
export async function captureWebCleanup(
  paths: ControlPlanePaths,
  reservation: InstanceReservation,
): Promise<WebCapture> {
  const claim = reservation.exclusive_resource_claims.web;
  if (!claim) return { status: 'none' };
  try {
    const config = await readWebOperatorConfig(webOperatorFiles(paths).configFile);
    if (!config)
      return {
        status: 'unreadable',
        ...refusal(paths, 'The claimed web namespace has no readable ownership record.'),
      };
    const own = config.assistants[reservation.instance_id];
    if (own && JSON.stringify(own.claim) !== JSON.stringify(claim))
      return {
        status: 'unreadable',
        ...refusal(paths, 'The web ownership record does not match the reserved namespace.'),
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
  config: WebOperatorConfig,
  run: SanitizedCommandOutcomeRunner,
): Promise<void> {
  const connector = config.connector;
  if (!connector) return;
  const files = webOperatorFiles(paths);
  const expected = renderWebConnectorService(files, config.cloudflaredPath, connector);
  const stored = await readOwnerOnlyFile(connector.definitionFile).catch((cause: unknown) => {
    if (isErrno(cause, 'ENOENT')) return undefined;
    throw cause;
  });
  if (stored !== undefined && stored !== expected)
    throw new GwsEaError(
      'web_connector_conflict',
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
      throw new GwsEaError('web_connector_unavailable', 'Cannot identify the connector service user.');
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
          'web_connector_unavailable',
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
        'web_connector_unavailable',
        'The recorded connector service could not be stopped and verified inactive.',
      );
  }
  await removePrivateFile(connector.definitionFile);
  if (connector.manager !== 'launchd') {
    const prefix = connector.manager === 'systemd-user' ? ['--user'] : [];
    if ((await invoke('systemctl', [...prefix, 'daemon-reload'])).exitCode !== 0)
      throw new GwsEaError(
        'web_connector_unavailable',
        'The connector definition was removed but systemd could not reload.',
      );
  }
}

export async function settleWebCleanup(
  paths: ControlPlanePaths,
  instanceId: string | null,
  initial: WebCleanup,
  options: {
    readonly fetch?: typeof fetch;
    readonly runCommand?: SanitizedCommandOutcomeRunner;
    readonly record: (cleanup: WebCleanup) => Promise<void>;
  },
): Promise<WebCleanupBlock | undefined> {
  let cleanup = initial;
  try {
    await withMachineLock(paths, async () => {
      const files = webOperatorFiles(paths);
      const live = await readWebOperatorConfig(files.configFile);
      let recorded = cleanup.ownership;
      if (
        recorded.credentialFile !== path.join(files.root, 'management-token') ||
        Object.keys(recorded.assistants).some((id) => id !== instanceId)
      )
        throw new GwsEaError('web_owner_mismatch', 'The receipt does not name this operator and assistant ownership.');
      if (!live && !cleanup.completed.includes('remote'))
        throw new GwsEaError('web_owner_missing', 'The exact web ownership record is missing.');
      if (
        live &&
        (live.accountId !== recorded.accountId ||
          live.credentialFile !== recorded.credentialFile ||
          live.tunnelId !== recorded.tunnelId ||
          JSON.stringify(live.pin) !== JSON.stringify(recorded.pin) ||
          JSON.stringify(live.connector) !== JSON.stringify(recorded.connector))
      )
        throw new GwsEaError('web_owner_mismatch', 'Web shared ownership changed during removal.');
      if (live) {
        for (const [hostname, dns] of Object.entries(recorded.dns)) {
          const current = live.dns[hostname];
          if (current && (current.id !== dns.id || current.zoneId !== dns.zoneId))
            throw new GwsEaError('web_owner_mismatch', 'The recorded DNS ownership changed during removal.');
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
            'web_create_unproven',
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
        throw new GwsEaError('web_owner_mismatch', 'The assistant Access ownership changed during removal.');
      const registry = await readRegistry(paths);
      const peers = [
        ...Object.values(live?.assistants ?? {})
          .filter((candidate) => candidate !== currentOwn)
          .map(({ claim }) => claim),
        ...Object.values(registry.instances)
          .filter((candidate) => candidate.instance_id !== instanceId)
          .flatMap((candidate) =>
            candidate.exclusive_resource_claims.web ? [candidate.exclusive_resource_claims.web] : [],
          ),
      ];
      const retainShared = instanceId !== null;
      if (!retainShared && peers.length > 0)
        throw new GwsEaError('web_shared_in_use', 'Assistant namespace claims still need to be settled.');
      cleanup = {
        ...cleanup,
        sharedRetained: retainShared,
      };
      await options.record(cleanup);
      const step = async (key: string, action: () => Promise<void>): Promise<void> => {
        if (cleanup.completed.includes(key)) return;
        await action();
        cleanup = { ...cleanup, completed: [...cleanup.completed, key] };
        await options.record(cleanup);
      };
      if (!cleanup.completed.includes('remote')) {
        if (!live) throw new GwsEaError('web_owner_missing', 'The exact web ownership record is missing.');
        const config = live;
        const api = await webApi(config, { fetch: options.fetch });
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
              throw new GwsEaError('web_cleanup_unverified', `Cloudflare resource is still present: ${resource}`);
          });
        const account = `/accounts/${recorded.accountId}`;
        await step('ingress', async () => {
          if (config.tunnelId && !(await absent(`${account}/cfd_tunnel/${config.tunnelId}`))) {
            const claim =
              own?.claim ??
              (instanceId === null ? undefined : registry.instances[instanceId]?.exclusive_resource_claims.web);
            if (claim) await setWebIngress(api, config, claim, false);
          }
        });
        if (own?.applicationId) await remove('application', `${account}/access/apps/${own.applicationId}`);
        const claim =
          own?.claim ??
          (instanceId === null ? undefined : registry.instances[instanceId]?.exclusive_resource_claims.web);
        const pending = recorded.pending;
        if (pending && (pending.target === instanceId || pending.target === claim?.hostname || !retainShared))
          throw new GwsEaError(
            'web_create_unproven',
            `Unproven ${pending.kind} creation ${pending.key} must be resolved or explicitly abandoned.`,
          );
        for (const [hostname, dns] of Object.entries(recorded.dns)) {
          if ((!retainShared || hostname === claim?.hostname) && !peers.some((peer) => peer.hostname === hostname))
            await remove(`dns:${dns.id}`, `/zones/${dns.zoneId}/dns_records/${dns.id}`);
        }
        if (!retainShared) {
          if (recorded.tunnelId && !(await absent(`${account}/cfd_tunnel/${recorded.tunnelId}`))) {
            const remaining = await api.request('GET', `${account}/cfd_tunnel/${recorded.tunnelId}/configurations`);
            if (
              !isRecord(remaining) ||
              !isRecord(remaining.config) ||
              !Array.isArray(remaining.config.ingress) ||
              remaining.config.ingress.some(
                (route: unknown) =>
                  !isRecord(route) ||
                  route.hostname !== undefined ||
                  route.path !== undefined ||
                  route.service !== 'http_status:404',
              )
            )
              throw new GwsEaError(
                'web_tunnel_conflict',
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
      if (retainShared) {
        if (!live) throw new GwsEaError('web_owner_missing', 'Shared ownership record is missing.');
        const assistants = { ...live.assistants };
        if (instanceId !== null) delete assistants[instanceId];
        const dns = Object.fromEntries(
          Object.entries(live.dns).filter(([, record]) => !cleanup.completed.includes(`dns:${record.id}`)),
        );
        await writeWebOperatorConfig(files.configFile, { ...live, assistants, dns });
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
      cause instanceof GwsEaError ? cause.message : 'A remote or local web cleanup boundary failed.',
      cleanup,
    );
  }
}
