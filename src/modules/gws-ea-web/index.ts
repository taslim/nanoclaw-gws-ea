import { register } from '../../cli/registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import { homeWebMount } from './home.js';
import { registerWebMount, webAdmissionEmails, webMounts } from './mounts.js';
import { WebRuntime, type WebReadiness } from './runtime.js';

registerWebMount(homeWebMount);
const runtime = new WebRuntime(webMounts);
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
    handler: async () => (name === 'gws-ea-web-health' ? runtime.health() : { emails: await webAdmissionEmails() }),
  });
}
