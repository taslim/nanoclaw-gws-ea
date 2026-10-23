import './capability.js';
import { registerDeliveryAction, registerOutboundGuard } from '../../delivery.js';
import { registerMigration } from '../../db/migrations/index.js';
import { ARTIFACT_ACTIONS } from './actions.js';
import { artifactsMigration } from './migration.js';
import { judgeArtifactSend } from './links.js';

registerMigration(artifactsMigration);
registerOutboundGuard('gws-ea-artifacts:link-access', judgeArtifactSend);
for (const [action, handler, guard] of ARTIFACT_ACTIONS) registerDeliveryAction(action, handler, guard);
