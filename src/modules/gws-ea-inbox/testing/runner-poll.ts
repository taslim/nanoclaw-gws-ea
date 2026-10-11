/**
 * What the agent runner's next poll hands its agent, for host tests: the
 * runner's own due-row query, run by Bun as in the container, over a
 * session's inbound rows and the runner's claims.
 */
import { execFileSync } from 'node:child_process';
import path from 'node:path';

import { inboundDbPath, outboundDbPath } from '../../../mailbox/sqlite/paths.js';
import type { Session } from '../../../types.js';

const RUNNER_MAILBOX = path.join(process.cwd(), 'container/agent-runner/src/mailbox/sqlite');
const RUNNER_COLUMNS =
  'id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, "trigger", platform_id, channel_type, thread_id, content, on_wake';

/** The ids of the rows the runner's next poll hands the session's agent, in its order. */
export function runnerPoll(session: Session): string[] {
  const script = [
    `import { initTestSessionDb } from ${JSON.stringify(path.join(RUNNER_MAILBOX, 'connection.ts'))};`,
    `import { sqliteGetPendingMessages } from ${JSON.stringify(path.join(RUNNER_MAILBOX, 'operations.ts'))};`,
    'const { inbound, outbound } = initTestSessionDb();',
    "inbound.prepare('ATTACH DATABASE ? AS host').run(process.env.RUNNER_INBOUND_DB);",
    `inbound.exec('INSERT INTO messages_in (${RUNNER_COLUMNS}) SELECT ${RUNNER_COLUMNS} FROM host.messages_in');`,
    "outbound.prepare('ATTACH DATABASE ? AS host').run(process.env.RUNNER_OUTBOUND_DB);",
    "outbound.exec('INSERT INTO processing_ack SELECT message_id, status, status_changed FROM host.processing_ack');",
    'console.log(JSON.stringify(sqliteGetPendingMessages(false, 10).map(({ id }) => id)));',
  ].join('\n');
  const output = execFileSync('bun', ['-e', script], {
    encoding: 'utf8',
    env: {
      ...process.env,
      RUNNER_INBOUND_DB: inboundDbPath(session.agent_group_id, session.id),
      RUNNER_OUTBOUND_DB: outboundDbPath(session.agent_group_id, session.id),
    },
  });
  return JSON.parse(output) as string[];
}
