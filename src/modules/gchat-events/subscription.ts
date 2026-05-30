/**
 * Wildcard Workspace Events subscription lifecycle.
 *
 * One subscription per project (`targetResource: //chat.googleapis.com/spaces/-`)
 * delivers chat-message events for every space the bot is in. Google's API
 * pins this choice: wildcard target resources only support `includeResource: false`,
 * so events arrive metadata-only and the inbound processor fetches the body
 * via `chat.spaces.messages.get` on receipt. The alternative (per-space +
 * `includeResource: true`) gives full payload but at the cost of N subscriptions,
 * 24h TTL, and explicit lifecycle for every space the bot joins/leaves —
 * which is what chat-sdk does and what was causing the inbound losses we
 * replaced. For an EA install spanning many spaces, the wildcard's O(1)
 * subscription count + 7-day TTL outweighs ~100ms per-message body fetch.
 *
 * Subscription names are persisted across restart so we resume an existing
 * subscription rather than recreating. That eliminates the post-restart
 * delivery window where chat-sdk's per-space recreation can drop events.
 */
import { google, type workspaceevents_v1 } from 'googleapis';

import { log } from '../../log.js';
import { getSubscription, upsertSubscription } from './db.js';

const CHAT_MESSAGE_CREATED = 'google.workspace.chat.message.v1.created';
const TTL = '604800s'; // 7 days — Workspace Events max for includeResource: false
const RENEW_AT_FRACTION = 0.8; // renew at 80% of TTL
const MIN_RENEW_DELAY_MS = 60_000;

interface EnsureSubscriptionArgs {
  auth: InstanceType<typeof google.auth.JWT>;
  projectId: string;
  topicShort: string;
}

export interface SubscriptionHandle {
  stop(): void;
}

export async function ensureWorkspaceSubscription(args: EnsureSubscriptionArgs): Promise<SubscriptionHandle> {
  const wsEvents = google.workspaceevents({ version: 'v1', auth: args.auth });
  const topicPath = `projects/${args.projectId}/topics/${args.topicShort}`;

  let active = await reuseIfActive(wsEvents, args.projectId);
  if (!active) {
    try {
      active = await createNew(wsEvents, args.projectId, topicPath);
    } catch (err) {
      // Workspace Events enforces one subscription per (auth-user, target).
      // If a prior install left a wildcard subscription behind without
      // persisting its name, create returns ALREADY_EXISTS — recover by
      // listing and adopting it.
      if (isAlreadyExists(err)) {
        active = await adoptExisting(wsEvents, args.projectId);
        if (!active) throw err;
      } else {
        throw err;
      }
    }
  }

  let renewalTimer: NodeJS.Timeout | null = null;
  const scheduleNext = (name: string, expireTime: string | null | undefined): void => {
    if (renewalTimer) clearTimeout(renewalTimer);
    let delayMs: number;
    if (expireTime) {
      const remaining = new Date(expireTime).getTime() - Date.now();
      // Past expiry → renew immediately; otherwise renew at 80% of remaining,
      // floored at MIN_RENEW_DELAY_MS so we don't thrash on near-expiry adopts.
      delayMs = remaining <= 0 ? 0 : Math.max(remaining * RENEW_AT_FRACTION, MIN_RENEW_DELAY_MS);
    } else {
      delayMs = 6 * 24 * 3600 * 1000;
    }
    log.info('GChat: scheduled Workspace Events renewal', {
      subscription: name,
      renewInHours: (delayMs / 3_600_000).toFixed(1),
    });
    renewalTimer = setTimeout(() => {
      void renew(wsEvents, args.projectId, name, topicPath).then((next) => scheduleNext(next.name, next.expireTime));
    }, delayMs);
  };
  scheduleNext(active.name, active.expireTime);

  return {
    stop() {
      if (renewalTimer) clearTimeout(renewalTimer);
      renewalTimer = null;
    },
  };
}

async function reuseIfActive(
  wsEvents: workspaceevents_v1.Workspaceevents,
  projectId: string,
): Promise<{ name: string; expireTime: string | null | undefined } | null> {
  const saved = getSubscription(projectId);
  if (!saved) return null;
  try {
    const res = await wsEvents.subscriptions.get({ name: saved.name });
    if (res.data.state === 'ACTIVE') {
      log.info('GChat: reusing existing Workspace Events subscription', {
        subscription: saved.name,
        expireTime: res.data.expireTime,
      });
      return { name: saved.name, expireTime: res.data.expireTime };
    }
    log.info('GChat: saved subscription not ACTIVE, recreating', {
      subscription: saved.name,
      state: res.data.state,
    });
    return null;
  } catch (err) {
    log.debug('GChat: saved subscription not found, recreating', {
      subscription: saved.name,
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function createNew(
  wsEvents: workspaceevents_v1.Workspaceevents,
  projectId: string,
  topicPath: string,
): Promise<{ name: string; expireTime: string | null | undefined }> {
  log.info('GChat: creating Workspace Events subscription', { topicPath });
  const op = await wsEvents.subscriptions.create({
    requestBody: {
      targetResource: '//chat.googleapis.com/spaces/-',
      eventTypes: [CHAT_MESSAGE_CREATED],
      notificationEndpoint: { pubsubTopic: topicPath },
      payloadOptions: { includeResource: false },
      ttl: TTL,
    },
  });
  const sub = await waitForOperation(wsEvents, op.data);
  if (!sub.name) throw new Error('Workspace Events subscription created without a name');
  upsertSubscription({ project_id: projectId, name: sub.name, expire_time: sub.expireTime ?? null });
  log.info('GChat: Workspace Events subscription created', {
    subscription: sub.name,
    expireTime: sub.expireTime,
  });
  return { name: sub.name, expireTime: sub.expireTime };
}

async function renew(
  wsEvents: workspaceevents_v1.Workspaceevents,
  projectId: string,
  name: string,
  topicPath: string,
): Promise<{ name: string; expireTime: string | null | undefined }> {
  try {
    const op = await wsEvents.subscriptions.patch({
      name,
      updateMask: 'ttl',
      requestBody: { ttl: TTL },
    });
    const sub = await waitForOperation(wsEvents, op.data);
    upsertSubscription({ project_id: projectId, name: sub.name ?? name, expire_time: sub.expireTime ?? null });
    log.info('GChat: Workspace Events subscription renewed', { subscription: name, expireTime: sub.expireTime });
    return { name: sub.name ?? name, expireTime: sub.expireTime };
  } catch (err) {
    log.warn('GChat: renewal failed, recreating', { name, err: err instanceof Error ? err.message : String(err) });
    return createNew(wsEvents, projectId, topicPath);
  }
}

function isAlreadyExists(err: unknown): boolean {
  const e = err as { code?: number; status?: number };
  return e?.code === 409 || e?.status === 409;
}

async function adoptExisting(
  wsEvents: workspaceevents_v1.Workspaceevents,
  projectId: string,
): Promise<{ name: string; expireTime: string | null | undefined } | null> {
  try {
    const res = await wsEvents.subscriptions.list({
      filter: 'target_resource="//chat.googleapis.com/spaces/-" AND event_types:"' + CHAT_MESSAGE_CREATED + '"',
    });
    const found = (res.data.subscriptions ?? []).find((s) => s.state === 'ACTIVE') ?? res.data.subscriptions?.[0];
    if (!found?.name) return null;
    upsertSubscription({ project_id: projectId, name: found.name, expire_time: found.expireTime ?? null });
    log.info('GChat: adopted existing wildcard Workspace Events subscription', {
      subscription: found.name,
      state: found.state,
      expireTime: found.expireTime,
    });
    return { name: found.name, expireTime: found.expireTime };
  } catch (err) {
    log.warn('GChat: failed to list existing subscriptions for adoption', {
      err: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

async function waitForOperation(
  wsEvents: workspaceevents_v1.Workspaceevents,
  operation: workspaceevents_v1.Schema$Operation,
): Promise<workspaceevents_v1.Schema$Subscription> {
  let op = operation;
  while (!op.done) {
    await new Promise((resolve) => setTimeout(resolve, 2000));
    const res = await wsEvents.operations.get({ name: op.name! });
    op = res.data;
  }
  if (op.error) {
    throw new Error(`Workspace Events operation failed: ${op.error.message ?? JSON.stringify(op.error)}`);
  }
  return op.response as workspaceevents_v1.Schema$Subscription;
}
