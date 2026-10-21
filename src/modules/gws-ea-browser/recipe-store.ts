import { browserSite } from './leases.js';
import { type BrowserRecipeStep } from './recording.js';
import { createHash } from 'node:crypto';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';

export interface BrowserRecipeParameter {
  name: string;
  step: number;
  recordedValue: string;
  kind: 'value' | 'target_name';
  inputName?: string;
  origin?: string;
}
export interface BrowserRecipe {
  id: string;
  site: string;
  name: string;
  version: number;
  sourceJobId: string;
  firstAction: number;
  lastAction: number;
  parameters: BrowserRecipeParameter[];
  steps: BrowserRecipeStep[];
  readOnly: boolean;
}
interface RecipeRow {
  id: string;
  site: string;
  name: string;
  version: number;
  parameters_json: string;
  steps_json: string;
  read_only: number;
  source_job_id: string;
  first_action: number;
  last_action: number;
}
export async function loadRecipe(id: string, db: DbDriver = getDb()): Promise<BrowserRecipe | undefined> {
  const row = await db.get<RecipeRow>('SELECT * FROM gws_ea_browser_recipes WHERE id = ?', id);
  if (!row) return undefined;
  return {
    id: row.id,
    site: row.site,
    name: row.name,
    version: row.version,
    sourceJobId: row.source_job_id,
    firstAction: row.first_action,
    lastAction: row.last_action,
    parameters: JSON.parse(row.parameters_json) as BrowserRecipe['parameters'],
    steps: JSON.parse(row.steps_json) as BrowserRecipeStep[],
    readOnly: row.read_only === 1,
  };
}
export function recipeCheckKey(
  recipe: Pick<BrowserRecipe, 'id' | 'version'>,
  parameters: Record<string, string>,
): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        recipe.id,
        recipe.version,
        Object.keys(parameters)
          .sort()
          .map((name) => [name, parameters[name]]),
      ]),
    )
    .digest('hex');
}

export async function readRecipeSiteInfo(origin: string): Promise<Record<string, unknown>> {
  const rows = await getDb().all<RecipeRow>(
    `SELECT r.* FROM gws_ea_browser_recipes r WHERE r.site = ? AND r.version = (SELECT MAX(latest.version) FROM gws_ea_browser_recipes latest WHERE latest.site = r.site AND latest.name = r.name) ORDER BY r.name`,
    browserSite(origin),
  );
  return {
    recipes: rows.map((row) => ({
      recipe_id: row.id,
      name: row.name,
      version: row.version,
      parameters: (JSON.parse(row.parameters_json) as BrowserRecipe['parameters']).map((parameter) => parameter.name),
      read_only: row.read_only === 1,
    })),
  };
}
