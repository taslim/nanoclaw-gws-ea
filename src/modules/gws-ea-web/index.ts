import type { RequestListener } from 'node:http';
import { register } from '../../cli/registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import type { WebIdentity } from './access.js';
import type { WebPolicyFile } from './policy.js';
import { WebRuntime, type WebReadiness } from './runtime.js';

/** Explicit composition: web knows only the artifact handler and its admission-email source. */
export function startWebOrigin(
  artifacts: (config: WebPolicyFile, identity: WebIdentity) => RequestListener,
  admissionEmails: () => Promise<readonly string[]>,
): WebReadiness {
  const runtime = new WebRuntime(artifacts, admissionEmails);
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
      handler: async () => (name === 'gws-ea-web-health' ? runtime.health() : { emails: await admissionEmails() }),
    });
  }
  return {
    verifyAdmission: (config) => runtime.verifyAdmission(config),
    publicationReady: (config) => runtime.publicationReady(config),
  };
}
