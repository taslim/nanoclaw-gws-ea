import * as prompts from '@clack/prompts';

import { runCli } from '../src/gws-ea/cli.js';
import { createManagedIngressSetupSession } from '../src/gws-ea/cloudflare-api.js';
import { GwsEaError } from '../src/gws-ea/types.js';
import { authenticateGwsEaProvider, CLOUDFLARE_API_TOKEN_GUIDANCE, collectGwsEaCreateInput } from './gws-ea-input.js';
import { ensureGcloudReady } from './gws-ea-prerequisites.js';
import { listSetupProviders } from './providers/registry.js';
import './providers/index.js';

const providers = listSetupProviders();
const managedIngressSetup = createManagedIngressSetupSession();

async function requestCloudflareAccountToken(
  accountId: string,
  observation: string,
  onPromptComplete?: () => void,
): Promise<string> {
  prompts.log.warn(observation);
  prompts.note(CLOUDFLARE_API_TOKEN_GUIDANCE, 'Cloudflare access');
  const answer = await prompts.password({
    message: 'Cloudflare API token for managed ingress',
    validate: (value) => (value?.trim() ? undefined : 'Required'),
  });
  if (prompts.isCancel(answer) || typeof answer !== 'string' || !answer.trim()) {
    throw new GwsEaError('cancelled', 'Managed ingress repair was cancelled');
  }
  const token = answer.trim();
  onPromptComplete?.();
  const zones = await managedIngressSetup.discoverZones(token);
  if (!zones.some((zone) => zone.accountId === accountId)) {
    throw new GwsEaError(
      'cloudflare_capability_missing',
      'The Cloudflare token cannot access an active zone in the reserved account.',
    );
  }
  managedIngressSetup.retainAccountToken(token);
  return managedIngressSetup.requireAccountToken(accountId);
}

process.exitCode = await runCli(process.argv.slice(2), {
  collectCreateInputs: (context) => collectGwsEaCreateInput(context, { providers }),
  authenticateProvider: (provider) => authenticateGwsEaProvider(provider, providers),
  preflightGcloud: () => ensureGcloudReady(process.cwd()),
  managedIngressSetup,
  requestCloudflareAccountToken,
});
