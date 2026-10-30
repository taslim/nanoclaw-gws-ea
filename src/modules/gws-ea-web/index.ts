import { register } from '../../cli/registry.js';
import { onHostStart, onHostShutdown } from '../../host-lifecycle.js';
import type { WebPolicyFile } from './policy.js';
import { WebRuntime, type WebFeatureFactories, type WebReadiness } from './runtime.js';

let origin: WebRuntime | undefined;

export async function webPublicationReady(config: WebPolicyFile): Promise<boolean> {
  return origin ? origin.publicationReady(config) : false;
}

export function startWebOrigin(
  features: WebFeatureFactories,
  admissionEmails: () => Promise<readonly string[]>,
): WebReadiness {
  const runtime = new WebRuntime(features, admissionEmails);
  origin = runtime;
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
