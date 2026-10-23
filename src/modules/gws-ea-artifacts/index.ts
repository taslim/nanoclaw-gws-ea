import './capability.js';
import { registerDeliveryAction } from '../../delivery.js';
import { registerMigration } from '../../db/migrations/index.js';
import { ARTIFACT_ACTIONS } from './actions.js';
import { artifactsMigration } from './migration.js';

registerMigration(artifactsMigration);
for (const [action, handler, guard] of ARTIFACT_ACTIONS) registerDeliveryAction(action, handler, guard);
