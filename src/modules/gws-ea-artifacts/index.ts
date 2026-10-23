import './capability.js';
import { registerDeliveryAction, registerOutboundGuard } from '../../delivery.js';
import { registerMigration } from '../../db/migrations/index.js';
import { ARTIFACT_ACTIONS } from './actions.js';
import { artifactsMigration } from './migration.js';
import { judgeArtifactSend } from './links.js';
import { register } from '../../cli/registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { ArtifactsRuntime } from './runtime.js';
import { artifactAdmissionEmails } from './sharing.js';

registerMigration(artifactsMigration);
registerOutboundGuard('gws-ea-artifacts:link-access', judgeArtifactSend);
for (const [action, handler, guard] of ARTIFACT_ACTIONS) registerDeliveryAction(action, handler, guard);

const runtime = new ArtifactsRuntime();
registerDeliveryAction('artifact_share', runtime.sharing.handler, runtime.sharing.deliveryGuard);
runtime.sharing.registerApprovals();
onHostStart(({ signal }) => runtime.start(signal));
onHostShutdown(() => runtime.stop());
for (const name of ['gws-ea-artifacts-health', 'gws-ea-artifacts-admission-emails'] as const) {
  register({
    name,
    description:
      name === 'gws-ea-artifacts-health'
        ? 'Observe local artifact origin availability.'
        : 'Read authoritative artifact admission intent.',
    access: 'hidden',
    hostOnly: true,
    parseArgs(raw) {
      if (Object.keys(raw).length) throw new Error('This artifact host command takes no arguments.');
      return undefined;
    },
    handler: async () =>
      name === 'gws-ea-artifacts-health' ? runtime.health() : { emails: await artifactAdmissionEmails() },
  });
}
