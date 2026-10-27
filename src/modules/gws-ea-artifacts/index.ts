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
import { getAllAgentGroups } from '../../db/agent-groups.js';
import { hasArtifactsAccess } from './policy.js';

registerMigration(artifactsMigration);
registerOutboundGuard('gws-ea-artifacts:link-access', judgeArtifactSend);
for (const [action, handler, guard] of ARTIFACT_ACTIONS) registerDeliveryAction(action, handler, guard);

const runtime = new ArtifactsRuntime();
registerDeliveryAction('artifact_share', runtime.sharing.handler, runtime.sharing.deliveryGuard);
runtime.sharing.registerApprovals();
onHostStart(({ signal }) => runtime.start(signal));
onHostShutdown(() => runtime.stop());
for (const name of ['gws-ea-web-health', 'gws-ea-web-admission-emails'] as const) {
  register({
    name,
    description:
      name === 'gws-ea-web-health'
        ? 'Observe local artifact origin availability.'
        : 'Read authoritative artifact admission intent.',
    access: 'hidden',
    hostOnly: true,
    parseArgs(raw) {
      if (Object.keys(raw).length) throw new Error('This artifact host command takes no arguments.');
      return undefined;
    },
    handler: async () =>
      name === 'gws-ea-web-health' ? runtime.health() : { emails: await artifactAdmissionEmails() },
  });
}

register({
  name: 'gws-ea-artifacts-author-groups',
  description: 'Read current eligible artifact author group IDs for native container refresh.',
  access: 'hidden',
  hostOnly: true,
  parseArgs(raw) {
    if (Object.keys(raw).length) throw new Error('This artifact host command takes no arguments.');
    return undefined;
  },
  async handler() {
    const group_ids: string[] = [];
    for (const group of await getAllAgentGroups()) {
      if (await hasArtifactsAccess(group.id)) group_ids.push(group.id);
    }
    return { group_ids };
  },
});
