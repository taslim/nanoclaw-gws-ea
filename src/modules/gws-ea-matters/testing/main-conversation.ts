/**
 * Main's conversation as the matters tests need it: main, the principal
 * bound to their direct message, and the session's real mailbox, read and
 * answered as the container would. A test file mocks `config.js` to a data
 * directory of its own before it imports this.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import Database from 'better-sqlite3';

import type { ResponseFrame } from '../../../cli/frame.js';
import { ensureContainerConfig, updateContainerConfigScalars } from '../../../db/container-configs.js';
import { createAgentGroup, createMessagingGroup, getDb } from '../../../db/index.js';
import { runMigrations } from '../../../db/migrations/index.js';
import { inboundDbPath, outboundDbPath } from '../../../mailbox/sqlite/paths.js';
import { reconcileSession } from '../../../reconcile-session.js';
import { resolveSession, withExistingMailboxSession } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { bindVerifiedPrincipalUser } from '../../gws-ea-profile/db.js';
import { gwsEaPrincipalDmRoutingMigration } from '../../gws-ea-profile/migration.js';
import { upsertUserDm } from '../../permissions/db/user-dms.js';
import { upsertUser } from '../../permissions/db/users.js';

export const MAIN = 'ag-main';
const PRINCIPAL = 'gchat:users/morgan';
const DIRECT_MESSAGE = 'mg-dm';

/** Main in `timezone`, named by the profile, and the principal's direct message: what a look comes back to. */
export async function seedMain(timezone: string): Promise<void> {
  await runMigrations(getDb(), [gwsEaPrincipalDmRoutingMigration]);
  const now = new Date().toISOString();
  await createAgentGroup({ id: MAIN, name: 'main', folder: MAIN, agent_provider: null, created_at: now });
  await ensureContainerConfig(MAIN);
  await updateContainerConfigScalars(MAIN, { cli_scope: 'global', timezone });
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    MAIN,
  );
  await createMessagingGroup({
    id: DIRECT_MESSAGE,
    channel_type: 'gchat',
    platform_id: 'gchat:spaces/morgan',
    name: 'Morgan Ellery',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan Ellery', created_at: now });
  await bindVerifiedPrincipalUser(PRINCIPAL, now);
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: DIRECT_MESSAGE,
    resolved_at: now,
  });
}

/** Main's one shared conversation, as `writeNoteForMain` resolves it. */
export async function mainSession(): Promise<Session> {
  return (await resolveSession(MAIN, DIRECT_MESSAGE, null, 'agent-shared')).session;
}

/** A task occurrence as the session's inbound mailbox holds it. */
export interface TaskRow {
  readonly id: string;
  readonly series_id: string;
  readonly status: string;
  readonly process_after: string;
  readonly recurrence: string | null;
  readonly content: string;
}

function withDb<T>(file: string, read: (db: Database.Database) => T): T {
  const db = new Database(file);
  try {
    return read(db);
  } finally {
    db.close();
  }
}

/** Every task occurrence in the session, oldest first. */
export function taskRows(session: Session): TaskRow[] {
  return withDb(
    inboundDbPath(session.agent_group_id, session.id),
    (db) =>
      db
        .prepare(
          "SELECT id, series_id, status, process_after, recurrence, content FROM messages_in WHERE kind = 'task' ORDER BY seq",
        )
        .all() as TaskRow[],
  );
}

/** The occurrences still to run: pending or paused. */
export function liveTaskRows(session: Session): TaskRow[] {
  return taskRows(session).filter((row) => row.status === 'pending' || row.status === 'paused');
}

/** The task's prompt and script as stored. */
export function taskContent(row: TaskRow): { readonly prompt: string; readonly script: string | null } {
  return JSON.parse(row.content) as { prompt: string; script: string | null };
}

/**
 * Answer one occurrence: its time comes, the container answers it as the
 * runner does (`completed`, or `script-skip:error` for a script that
 * failed), and the host's sweep reads the answer, which settles the
 * occurrence, and stops there: what repeats is not armed yet. A sweep that
 * wakes main for other mail leaves the session so while it waits on the
 * wake. SQLite's `now`, which decides what is due, is the real clock, so the
 * occurrence's time moves to just past.
 */
export async function answerOccurrence(
  session: Session,
  rowId: string,
  answer: 'completed' | 'script-skip:error',
): Promise<void> {
  withDb(inboundDbPath(session.agent_group_id, session.id), (db) =>
    db
      .prepare('UPDATE messages_in SET process_after = ? WHERE id = ?')
      .run(new Date(Date.now() - 1_000).toISOString(), rowId),
  );
  withDb(outboundDbPath(session.agent_group_id, session.id), (db) =>
    db
      .prepare('INSERT INTO processing_ack (message_id, status, status_changed) VALUES (?, ?, ?)')
      .run(rowId, answer, new Date().toISOString()),
  );
  await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.applyProcessingAcks(mailbox.getTerminalProcessingAcks()),
  );
}

/** Run one occurrence: answer it, and the host's sweep goes on to re-arm what repeats. */
export async function runOccurrence(
  session: Session,
  rowId: string,
  answer: 'completed' | 'script-skip:error',
): Promise<void> {
  await answerOccurrence(session, rowId, answer);
  await reconcileSession(session.id);
}

/**
 * What the container's `ncl` prints for an answer that carries its own
 * rendering (`container/agent-runner/src/cli/ncl.ts`): that rendering, and a
 * newline.
 */
export function printed(frame: ResponseFrame): string {
  if (!frame.ok) throw new Error(`Command failed: ${JSON.stringify(frame.error)}`);
  if (frame.human === undefined) throw new Error('The answer carries no rendering of its own');
  return `${frame.human}\n`;
}

/** The runner's verdict on a pre-task script: null for one it reads as broken. */
export type RunnerVerdict = { readonly wakeAgent: boolean; readonly data?: unknown } | null;

/** The runner's pre-task script module: plain Node, so a host test can run it. */
interface TaskScriptModule {
  runScript(script: string, taskId: string): Promise<RunnerVerdict>;
}

const TASK_SCRIPT = fileURLToPath(
  new URL('../../../../container/agent-runner/src/scheduling/task-script.ts', import.meta.url),
);

/**
 * The runner's own reading of a pre-task script that prints `stdout`: the
 * script runs under bash, and its last line must be the JSON verdict.
 */
export async function runnerReads(stdout: string, scratch: string): Promise<RunnerVerdict> {
  const runner = (await import(TASK_SCRIPT)) as TaskScriptModule;
  const file = path.join(scratch, 'script-output');
  fs.writeFileSync(file, stdout);
  // The runner writes the script to a file named for the task, so each test's is its own.
  return runner.runScript(`cat '${file}'`, path.basename(scratch));
}
