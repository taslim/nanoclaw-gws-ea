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
import { startWebOrigin } from '../gws-ea-web/index.js';
import { createLoginsPageHandler } from '../gws-ea-browser/logins-page.js';
import { createArtifactViewHandler } from './server.js';
import { createArtifactViewResolver } from './access.js';

registerMigration(artifactsMigration);
registerOutboundGuard('gws-ea-artifacts:link-access', judgeArtifactSend);
for (const [action, handler, guard] of ARTIFACT_ACTIONS) registerDeliveryAction(action, handler, guard);

const web = startWebOrigin(
  {
    artifacts: (config, identity) =>
      createArtifactViewHandler({ hostname: config.hostname, resolve: createArtifactViewResolver(config, identity) }),
    logins: (config, identity) => createLoginsPageHandler({ hostname: config.hostname, identity }),
  },
  artifactAdmissionEmails,
);
const runtime = new ArtifactsRuntime(web);
registerDeliveryAction('artifact_share', runtime.sharing.handler, runtime.sharing.deliveryGuard);
runtime.sharing.registerApprovals();
onHostStart(({ signal }) => runtime.start(signal));
onHostShutdown(() => runtime.stop());
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
