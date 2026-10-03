import type { ModuleMigration } from '../../db/migrations/index.js';

/**
 * Per-group capabilities on `container_configs`: `"all"` or a JSON list of
 * keys (see src/capabilities.ts). Every existing group keeps `"all"`, so it
 * holds exactly what it held before.
 */
export const capabilitiesMigration: ModuleMigration = {
  version: 1,
  name: 'module:capabilities:container-config-capabilities',
  async up(db) {
    await db.exec(`ALTER TABLE container_configs ADD COLUMN capabilities TEXT NOT NULL DEFAULT '"all"';`);
  },
};
