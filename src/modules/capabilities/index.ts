/**
 * Capabilities module: the schema for per-group capability lists. The
 * registry and every capability decision live in core (src/capabilities.ts);
 * without this module no column exists and every group holds `all`.
 */
import { registerMigration } from '../../db/migrations/index.js';
import { capabilitiesMigration } from './migration.js';

registerMigration(capabilitiesMigration);
