/**
 * Preload for a hook script run as a real subprocess: it seeds the session's
 * inbound mailbox in memory, as the host would have written it, and does
 * nothing else. In particular it registers no mailbox, so the script under
 * test must compose its own, as it does in a container.
 *
 *   bun --preload <this file> <hook script>
 *
 * HOOK_FIXTURE_DESTINATIONS is a comma-separated list of destination names;
 * HOOK_FIXTURE_THREAD_ID, when set, is the session's bound thread.
 */
import { initTestSessionDb } from '../mailbox/sqlite/connection.js';

const { inbound } = initTestSessionDb();

for (const name of (process.env.HOOK_FIXTURE_DESTINATIONS ?? '').split(',').filter(Boolean)) {
  inbound
    .prepare(
      `INSERT INTO destinations (name, display_name, type, channel_type, platform_id, agent_group_id)
       VALUES (?, ?, 'channel', 'discord', ?, NULL)`,
    )
    .run(name, name, `channel-${name}`);
}

inbound.exec(
  'CREATE TABLE session_routing (id INTEGER PRIMARY KEY CHECK (id = 1), channel_type TEXT, platform_id TEXT, thread_id TEXT)',
);
inbound
  .prepare(
    "INSERT INTO session_routing (id, channel_type, platform_id, thread_id) VALUES (1, 'discord', 'channel-1', ?)",
  )
  .run(process.env.HOOK_FIXTURE_THREAD_ID ?? null);
