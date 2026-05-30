/**
 * Wire the heartbeat GChat space to `main`, register a `principal` destination
 * pointing at the owner's DM, and seed three recurring ticks (sweep,
 * morning-briefing, weekly-review) on the heartbeat-space session.
 *
 * Hard-fails if `main` or the owner's DM mg isn't wired (both bootstrapped by
 * `/init-first-agent` — v2's design is that no agent or destination is
 * configurable before the first agent).
 *
 * Tick prompts are just the path to the procedure file; the markdown is the
 * prompt. The pre-task `script` (sweep only) runs before the agent wakes and
 * injects its output as `scriptOutput`.
 *
 * Routing: sweep posts to the heartbeat space (session's wired channel);
 * morning-briefing/weekly-review use `send_message(to="principal")` and leave
 * session output empty. The destinations row registered here IS the
 * permission per v2's "ACL = row existence" rule (docs/db.md:91).
 *
 * Idempotent. Usage: `pnpm exec tsx scripts/init-heartbeat.ts`.
 */
import path from 'path';
import { promises as fs } from 'fs';

import { CronExpressionParser } from 'cron-parser';

import { DATA_DIR, GROUPS_DIR, TIMEZONE } from '../src/config.js';
import { getAgentGroupByFolder } from '../src/db/agent-groups.js';
import { initDb } from '../src/db/connection.js';
import {
  createMessagingGroup,
  createMessagingGroupAgent,
  findUniqueDmOnAgentGroup,
  getMessagingGroupAgentByPair,
  getMessagingGroupByPlatform,
} from '../src/db/messaging-groups.js';
import { runMigrations } from '../src/db/migrations/index.js';
import { readEnvFile } from '../src/env.js';
import { initGroupFilesystem } from '../src/group-init.js';
import { log } from '../src/log.js';
import {
  createDestination,
  getDestinationByName,
} from '../src/modules/agent-to-agent/db/agent-destinations.js';
import { insertTask } from '../src/modules/scheduling/db.js';
import { namespacedPlatformId } from '../src/platform-id.js';
import { openInboundDb, resolveSession } from '../src/session-manager.js';

const MAIN_FOLDER = 'main';
const PRINCIPAL_DEST = 'principal';

interface Heartbeat {
  name: string;
  cron: string;
  prompt: string;
  script?: string;
}

const HEARTBEATS: readonly Heartbeat[] = [
  {
    name: 'sweep',
    cron: '0 7-23 * * *',
    prompt: '/workspace/agent/heartbeats/sweep.md',
    script: 'exec bun run /app/src/scripts/heartbeat-sweep.ts',
  },
  {
    name: 'morning-briefing',
    cron: '30 6 * * *',
    prompt: '/workspace/agent/heartbeats/morning-briefing.md',
  },
  {
    name: 'weekly-review',
    cron: '0 18 * * 5',
    prompt: '/workspace/agent/heartbeats/weekly-review.md',
  },
] as const;

function generateId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

async function main(): Promise<void> {
  const env = readEnvFile(['ASSISTANT_EMAIL', 'HEARTBEAT_SPACE_ID']);
  const assistantEmail = env.ASSISTANT_EMAIL;
  const heartbeatSpaceId = env.HEARTBEAT_SPACE_ID;
  if (!assistantEmail || !heartbeatSpaceId) {
    throw new Error('ASSISTANT_EMAIL and HEARTBEAT_SPACE_ID must be set in .env');
  }

  const db = initDb(path.join(DATA_DIR, 'v2.db'));
  runMigrations(db);

  const now = new Date().toISOString();

  const mainAg = getAgentGroupByFolder(MAIN_FOLDER);
  if (!mainAg) {
    throw new Error(
      `Agent group "${MAIN_FOLDER}" not found. Run /init-first-agent (gchat) before init-heartbeat — v2 bootstraps everything from the first agent.`,
    );
  }

  const ownerDm = findUniqueDmOnAgentGroup(mainAg.id, 'gchat');
  if (!ownerDm) {
    throw new Error(
      `Owner DM messaging group not wired to "${MAIN_FOLDER}". Run /init-first-agent --channel gchat first — every other wiring depends on it.`,
    );
  }

  initGroupFilesystem(mainAg);
  const groupDir = path.resolve(GROUPS_DIR, MAIN_FOLDER);

  await fs.writeFile(
    path.join(groupDir, 'heartbeat.json'),
    JSON.stringify({ assistantEmail }, null, 2) + '\n',
  );

  // Heartbeat space mg
  const platformId = namespacedPlatformId('gchat', heartbeatSpaceId);
  let messagingGroup = getMessagingGroupByPlatform('gchat', platformId);
  if (!messagingGroup) {
    const id = generateId('mg');
    const row = {
      id,
      channel_type: 'gchat',
      platform_id: platformId,
      name: 'Heartbeat',
      is_group: 1,
      unknown_sender_policy: 'strict',
      created_at: now,
    } as const;
    createMessagingGroup(row);
    messagingGroup = row;
    log.info('Created messaging group', { id, platformId });
  }

  if (!getMessagingGroupAgentByPair(messagingGroup.id, mainAg.id)) {
    createMessagingGroupAgent({
      id: generateId('mga'),
      messaging_group_id: messagingGroup.id,
      agent_group_id: mainAg.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'known',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    log.info('Wired heartbeat space → main');
  }

  if (!getDestinationByName(mainAg.id, PRINCIPAL_DEST)) {
    createDestination({
      agent_group_id: mainAg.id,
      local_name: PRINCIPAL_DEST,
      target_type: 'channel',
      target_id: ownerDm.id,
      created_at: now,
    });
    log.info(`Registered destination "${PRINCIPAL_DEST}" → ${ownerDm.id}`);
  }

  const { session, created } = resolveSession(mainAg.id, messagingGroup.id, null, 'shared');
  if (created) log.info('Created heartbeat session on main', { sessionId: session.id });

  const inbound = openInboundDb(mainAg.id, session.id);
  try {
    for (const h of HEARTBEATS) {
      const existing = inbound
        .prepare(
          "SELECT id FROM messages_in WHERE kind = 'task' AND status IN ('pending', 'paused') AND recurrence = ? LIMIT 1",
        )
        .get(h.cron) as { id: string } | undefined;
      if (existing) {
        log.info(`${h.name} heartbeat already seeded`, { id: existing.id, cron: h.cron });
        continue;
      }
      const nextRun = CronExpressionParser.parse(h.cron, { tz: TIMEZONE }).next().toDate().toISOString();
      const taskId = generateId('task');
      const content: { prompt: string; script?: string } = { prompt: h.prompt };
      if (h.script) content.script = h.script;
      insertTask(inbound, {
        id: taskId,
        processAfter: nextRun,
        recurrence: h.cron,
        platformId: messagingGroup.platform_id,
        channelType: messagingGroup.channel_type,
        threadId: null,
        content: JSON.stringify(content),
      });
      log.info(`Seeded ${h.name} heartbeat`, { taskId, nextRun, cron: h.cron });
    }
  } finally {
    inbound.close();
  }

  console.log('');
  console.log('Heartbeat init complete.');
  console.log(`  agent group:       ${mainAg.id} @ groups/${MAIN_FOLDER}`);
  console.log(`  heartbeat mg:      ${messagingGroup.id} (${platformId})`);
  console.log(`  owner mg:        ${ownerDm.id} (${ownerDm.platform_id})`);
  console.log(`  session:           ${session.id}`);
  for (const h of HEARTBEATS) console.log(`  ${h.name.padEnd(18)} ${h.cron} (${TIMEZONE})`);
  console.log('');
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
