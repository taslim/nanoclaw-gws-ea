import { answeredGuard, answeringAction, invalidArgs } from '../../cli/delivery-action.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { webReadiness } from '../gws-ea-web/index.js';
import { readWebPolicy } from '../gws-ea-web/policy.js';
import { hasBrowserAccess } from './access.js';
import { browserVault, type BrowserVault } from './onepassword.js';

interface LoginsPageDependencies {
  readonly vault: Pick<BrowserVault, 'availability'>;
  readonly publicationReady: typeof webReadiness.publicationReady;
}

export const loginsPageGuard = defineGuardedAction({
  action: 'gws_ea_browser.logins_page',
  async decide({ actor }) {
    return actor.kind === 'agent' && (await hasBrowserAccess(actor.agentGroupId))
      ? ALLOW("An agent with browser access asks for the principal's logins page.")
      : DENY("Only an agent with browser access may obtain the principal's logins page.");
  },
});

export function registerLoginsPageDelivery(
  dependencies: LoginsPageDependencies = { vault: browserVault, publicationReady: webReadiness.publicationReady },
): void {
  registerDeliveryAction(
    'logins_page',
    answeringAction('logins_page', async (content) => {
      if (Object.keys(content).some((key) => !['action', 'requestId'].includes(key)))
        throw invalidArgs('The logins page request takes no arguments.');
      const web = await readWebPolicy();
      if (web.status !== 'enabled' || (await dependencies.vault.availability()).status !== 'available')
        return { status: 'operator_needed' };
      if (!(await dependencies.publicationReady(web.config))) return { status: 'unavailable' };
      return { status: 'available', url: `https://${web.config.hostname}/logins` };
    }),
    answeredGuard(loginsPageGuard),
  );
}
