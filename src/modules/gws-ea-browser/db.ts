import { createHash } from 'node:crypto';

import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import type { Session } from '../../types.js';

export interface BrowserJob {
  id: string;
  thread_id: string;
  browser_session_id: string;
  source_agent_group_id: string;
  cancelled: number;
  created_at: string;
  updated_at: string;
}

export interface BrowserRequest {
  id: string;
  job_id: string;
  session_id: string;
  request_id: string;
  action: string;
  payload_json: string;
  budget_ms: number;
  accepted_at: string;
  started_at: string | null;
  commit_started_at: string | null;
  answered_at: string | null;
  answer_json: string | null;
  delivered_at: string | null;
}

export function browserRequestId(sessionId: string, requestId: string): string {
  return `browser-${createHash('sha256').update(`${sessionId}\0${requestId}`).digest('hex')}`;
}

/** May join the purchase authority transaction. The caller commits before pressing. */
export async function markBrowserRequestCommitStarted(
  db: DbDriver,
  id: string,
  at = new Date().toISOString(),
): Promise<void> {
  const changed = await db.run(
    'UPDATE gws_ea_browser_requests SET commit_started_at = ? WHERE id = ? AND answered_at IS NULL AND commit_started_at IS NULL',
    at,
    id,
  );
  if (!changed.changes) throw new Error('Browser request cannot begin another commit');
}

export class BrowserStore {
  constructor(readonly db: DbDriver = getDb()) {}

  getJob(id: string): Promise<BrowserJob | undefined> {
    return this.db.get<BrowserJob>('SELECT * FROM gws_ea_browser_jobs WHERE id = ?', id);
  }

  async jobForSession(session: Session, create = true): Promise<BrowserJob | undefined> {
    const profile = await this.db.get<{ main_agent_group_id: string | null; browser_agent_group_id: string | null }>(
      'SELECT main_agent_group_id, browser_agent_group_id FROM gws_ea_profile WHERE singleton = 1',
    );
    const main = profile?.main_agent_group_id;
    if (
      !main ||
      session.agent_group_id !== profile.browser_agent_group_id ||
      session.status !== 'active' ||
      session.messaging_group_id !== null ||
      !session.thread_id?.startsWith(`system:a2a:${main}:`)
    )
      return undefined;
    const current = await this.db.get<Session>('SELECT * FROM sessions WHERE id = ?', session.id);
    if (
      !current ||
      current.status !== 'active' ||
      current.agent_group_id !== session.agent_group_id ||
      current.thread_id !== session.thread_id ||
      current.messaging_group_id !== null
    )
      return undefined;
    if (create) {
      const now = new Date().toISOString();
      await this.db.run(
        `INSERT INTO gws_ea_browser_jobs(id,thread_id,browser_session_id,source_agent_group_id,created_at,updated_at)
         VALUES(?,?,?,?,?,?) ON CONFLICT(thread_id) DO NOTHING`,
        session.thread_id,
        session.thread_id,
        session.id,
        main,
        now,
        now,
      );
    }
    const job = await this.getJob(session.thread_id);
    return job?.browser_session_id === session.id && job.cancelled === 0 ? job : undefined;
  }

  async accept(
    job: BrowserJob,
    session: Session,
    requestId: string,
    action: string,
    payload: Record<string, unknown>,
    budgetMs: number,
  ): Promise<boolean> {
    return this.db.transaction(async () => {
      const current = await this.getJob(job.id);
      if (!current || current.cancelled) throw new Error('Browser job is cancelled');
      const at = new Date().toISOString();
      const result = await this.db.run(
        `INSERT INTO gws_ea_browser_requests(id,job_id,session_id,request_id,action,payload_json,budget_ms,accepted_at)
         VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(session_id,request_id) DO NOTHING`,
        browserRequestId(session.id, requestId),
        job.id,
        session.id,
        requestId,
        action,
        JSON.stringify(payload),
        budgetMs,
        at,
      );
      if (result.changes) await this.db.run('UPDATE gws_ea_browser_jobs SET updated_at = ? WHERE id = ?', at, job.id);
      return result.changes > 0;
    });
  }

  request(id: string): Promise<BrowserRequest | undefined> {
    return this.db.get<BrowserRequest>('SELECT * FROM gws_ea_browser_requests WHERE id = ?', id);
  }

  pending(jobId?: string): Promise<BrowserRequest[]> {
    return jobId === undefined
      ? this.db.all<BrowserRequest>(
          'SELECT * FROM gws_ea_browser_requests WHERE answered_at IS NULL ORDER BY accepted_at,id',
        )
      : this.db.all<BrowserRequest>(
          'SELECT * FROM gws_ea_browser_requests WHERE job_id = ? AND answered_at IS NULL ORDER BY accepted_at,id',
          jobId,
        );
  }

  async start(id: string): Promise<BrowserRequest | undefined> {
    const changed = await this.db.run(
      'UPDATE gws_ea_browser_requests SET started_at = ? WHERE id = ? AND started_at IS NULL AND answered_at IS NULL',
      new Date().toISOString(),
      id,
    );
    return changed.changes ? this.request(id) : undefined;
  }

  async answer(id: string, frame: ResponseFrame, answeredAt: string): Promise<void> {
    await this.db.run(
      'UPDATE gws_ea_browser_requests SET answered_at = ?, answer_json = ? WHERE id = ? AND answered_at IS NULL',
      answeredAt,
      JSON.stringify(frame),
      id,
    );
  }

  undelivered(): Promise<BrowserRequest[]> {
    return this.db.all<BrowserRequest>(
      'SELECT * FROM gws_ea_browser_requests WHERE answer_json IS NOT NULL AND delivered_at IS NULL ORDER BY answered_at,id',
    );
  }

  async delivered(id: string): Promise<void> {
    await this.db.run(
      'UPDATE gws_ea_browser_requests SET delivered_at = ? WHERE id = ? AND delivered_at IS NULL',
      new Date().toISOString(),
      id,
    );
  }
}
