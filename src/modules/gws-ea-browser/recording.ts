import { withinTime } from './page-targets.js';
import type { DbDriver } from '../../db/driver.js';
import type { BrowserAction } from './actions.js';
import type { BrowserStructure } from './observe.js';
import { ariaNodes, flatten, checkpointUrl, type StructuredBrowserLocator } from './locators.js';

export interface RecipeCheckpoint {
  url: string;
  heading?: string;
}
export interface BrowserRecipeStep {
  action: BrowserAction;
  targets: StructuredBrowserLocator[];
  before: RecipeCheckpoint;
  after?: RecipeCheckpoint;
  readOnly: boolean;
  stopReason?: string;
  saveError?: string;
  inputs?: Array<{ name: string; origin: string }>;
  getSubmissionFields?: string[];
  clickHref?: string;
}

export function checkpoint(
  snapshot: Pick<BrowserStructure, 'tree' | 'replayUrl'>,
  nodes?: ReturnType<typeof flatten>,
): RecipeCheckpoint {
  // Display strings never become executable checkpoint state.
  if (!snapshot.replayUrl) throw new Error('Checkpoint unavailable');
  const heading = (nodes ?? flatten(ariaNodes(snapshot.tree))).find((node) => node.role === 'heading')?.name;
  return { url: checkpointUrl(snapshot.replayUrl), ...(heading ? { heading } : {}) };
}

export interface BrowserActionTrace {
  readonly index: number;
  finish(step: BrowserRecipeStep | undefined, after: BrowserStructure | undefined, reason?: string): Promise<boolean>;
}

/** Optional work gets a small fixed allowance and leaves time to return the required result. */
export async function withinBrowserRecordingBudget<T>(
  remaining: number,
  work: () => Promise<T>,
): Promise<T | undefined> {
  const budget = Math.min(250, Math.max(0, remaining - 1_000));
  if (budget === 0) return undefined;
  return withinTime(work(), budget).catch(() => undefined);
}

/** No page read and no executable invented checkpoint. The committed incomplete row survives a crash. */
export async function reserveBrowserActionTrace(
  db: DbDriver,
  jobId: string,
  requestId: string,
): Promise<BrowserActionTrace | undefined> {
  try {
    const row = await db.get<{ action_index: number }>(
      `INSERT INTO gws_ea_browser_action_trace(job_id,action_index,request_id,step_json,created_at)
       SELECT ?, COALESCE(MAX(action_index), -1) + 1, ?, ?, ? FROM gws_ea_browser_action_trace WHERE job_id = ?
       RETURNING action_index`,
      jobId,
      requestId,
      JSON.stringify({ action: { kind: 'observe' }, targets: [], readOnly: false, saveError: 'Recording incomplete.' }),
      new Date().toISOString(),
      jobId,
    );
    if (!row) return undefined;
    const index = row.action_index;
    return {
      index,
      async finish(step, after, reason) {
        if (!step || !after) return false;
        try {
          const completed = { ...step, after: checkpoint(after), ...(reason ? { stopReason: reason } : {}) };
          await db.run(
            'UPDATE gws_ea_browser_action_trace SET step_json = ? WHERE job_id = ? AND action_index = ?',
            JSON.stringify(completed),
            jobId,
            index,
          );
          return true;
        } catch {
          return false;
        }
      },
    };
  } catch {
    return undefined;
  }
}
