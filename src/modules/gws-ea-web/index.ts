import { register } from '../../cli/registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { createArtifactViewResolver } from '../gws-ea-artifacts/access.js';
import { createArtifactViewHandler } from '../gws-ea-artifacts/server.js';
import { artifactAdmissionEmails } from '../gws-ea-artifacts/sharing.js';
import { createLoginsPageHandler } from '../gws-ea-browser/logins-page.js';
import { WebRuntime, type WebReadiness } from './runtime.js';

const runtime = new WebRuntime(
  {
    artifacts: (config, identity) =>
      createArtifactViewHandler({ hostname: config.hostname, resolve: createArtifactViewResolver(config, identity) }),
    logins: (config, identity) => createLoginsPageHandler({ hostname: config.hostname, identity }),
  },
  artifactAdmissionEmails,
);
export const webReadiness: WebReadiness = {
  verifyAdmission: (config) => runtime.verifyAdmission(config),
  publicationReady: (config) => runtime.publicationReady(config),
};
onHostStart(({ signal }) => runtime.start(signal));
onHostShutdown(() => runtime.stop());
for (const name of ['gws-ea-web-health', 'gws-ea-web-admission-emails'] as const) {
  register({
    name,
    description:
      name === 'gws-ea-web-health'
        ? 'Observe local web origin availability.'
        : 'Read authoritative web admission intent.',
    access: 'hidden',
    hostOnly: true,
    parseArgs(raw) {
      if (Object.keys(raw).length) throw new Error('This web host command takes no arguments.');
      return undefined;
    },
    handler: async () =>
      name === 'gws-ea-web-health' ? runtime.health() : { emails: await artifactAdmissionEmails() },
  });
}
