import { type WatchRow, getBrowserWatch } from './watch-state.js';
import type { DbDriver } from '../../db/driver.js';
import { type PurchaseFacts } from './fingerprint.js';
import { loadRecipe, type BrowserRecipe } from './recipe-store.js';
import type { BrowserExecutionContext } from './actions.js';
import { withinTime } from './page-targets.js';

async function promoteWatchRecipe(
  db: DbDriver,
  watch: WatchRow,
  attemptId: string,
  active: () => boolean = () => true,
): Promise<void> {
  if (!watch.booking_recipe_id) return;
  const recipe = await loadRecipe(watch.booking_recipe_id, db);
  const authority = await db.get<{ commit_request_id: string | null }>(
    'SELECT commit_request_id FROM gws_ea_browser_authorities WHERE attempt_id = ?',
    attemptId,
  );
  const request = authority?.commit_request_id
    ? await db.get<{ accepted_at: string }>(
        'SELECT accepted_at FROM gws_ea_browser_requests WHERE id = ?',
        authority.commit_request_id,
      )
    : undefined;
  const traced = recipe
    ? await db.get<{ created_at: string }>(
        'SELECT created_at FROM gws_ea_browser_action_trace WHERE job_id = ? AND action_index = ?',
        watch.job_id,
        recipe.lastAction,
      )
    : undefined;
  const claim = await db.get<{ last_action_index: number | null }>(
    'SELECT last_action_index FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND watch_id = ? AND attempt_id = ?',
    watch.job_id,
    watch.id,
    attemptId,
  );
  const attempt = await db.get<{ facts_json: string }>(
    'SELECT facts_json FROM gws_ea_browser_purchase_attempts WHERE id = ?',
    attemptId,
  );
  const facts = attempt ? (JSON.parse(attempt.facts_json) as PurchaseFacts) : undefined;
  const lastStep = recipe?.steps.at(-1);
  if (
    !recipe ||
    recipe.sourceJobId !== watch.job_id ||
    recipe.version !== watch.booking_recipe_version ||
    !traced ||
    !request ||
    traced.created_at > request.accepted_at ||
    claim?.last_action_index !== recipe.lastAction ||
    !facts ||
    lastStep?.targets.at(-1)?.name !== facts.control.label ||
    new URL(lastStep.before.url).origin !== facts.origin
  )
    return;
  if (!active()) return;
  await db.run(
    `INSERT INTO gws_ea_browser_watch_recipe_links(check_recipe_id,check_recipe_version,booking_recipe_id,booking_recipe_version,source_watch_id,source_attempt_id,verified_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT DO NOTHING`,
    watch.check_recipe_id,
    watch.check_recipe_version,
    recipe.id,
    recipe.version,
    watch.id,
    attemptId,
    new Date().toISOString(),
  );
}
/** Called directly by save_recipe after its immutable source provenance has been persisted. */
export async function linkWatchBookingRecipe(context: BrowserExecutionContext, recipe: BrowserRecipe): Promise<void> {
  if (
    recipe.readOnly ||
    recipe.sourceJobId !== context.job.id ||
    recipe.steps.at(-1)?.stopReason !== 'purchase_control'
  )
    return;
  const watches = await context.store.db.all<WatchRow>(
    "SELECT * FROM gws_ea_browser_watches WHERE job_id = ? AND site = ? AND status IN ('armed','checking','preparing','booked')",
    context.job.id,
    recipe.site,
  );
  for (const watch of watches) {
    const parameters = JSON.parse(watch.parameters_json) as Record<string, string>;
    if (
      JSON.stringify(Object.keys(parameters).sort()) !==
        JSON.stringify(recipe.parameters.map((entry) => entry.name).sort()) ||
      recipe.parameters.some((entry) => parameters[entry.name] !== entry.recordedValue)
    )
      continue;
    await context.store.db.run(
      'UPDATE gws_ea_browser_watches SET booking_recipe_id = ?,booking_recipe_version = ? WHERE id = ?',
      recipe.id,
      recipe.version,
      watch.id,
    );
    if (watch.status === 'booked') {
      const claim = await context.store.db.get<{ attempt_id: string }>(
        "SELECT attempt_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND watch_id = ? AND state = 'booked'",
        watch.job_id,
        watch.id,
      );
      if (claim)
        await promoteWatchRecipe(
          context.store.db,
          { ...watch, booking_recipe_id: recipe.id, booking_recipe_version: recipe.version },
          claim.attempt_id,
        );
    }
  }
}

/** Optional recipe promotion follows a settled page-proved booking, outside its authority transaction. */
export async function promoteCommittedWatchRecipe(db: DbDriver, jobId: string, attemptId: string): Promise<void> {
  let active = true;
  try {
    await withinTime(
      (async () => {
        const claim = await db.get<{ watch_id: string | null }>(
          "SELECT watch_id FROM gws_ea_browser_watch_job_claims WHERE job_id = ? AND attempt_id = ? AND state = 'booked'",
          jobId,
          attemptId,
        );
        const watch = claim?.watch_id ? await getBrowserWatch(claim.watch_id, db) : undefined;
        if (watch && active) await promoteWatchRecipe(db, watch, attemptId, () => active);
      })(),
      250,
    ).catch(() => undefined);
  } finally {
    active = false;
  }
}
