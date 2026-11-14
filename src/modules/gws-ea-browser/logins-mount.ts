import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import type { PrincipalPageMount } from '../gws-ea-web/mounts.js';
import { hasBrowserAccess } from './access.js';
import { getLoginStore, LoginStoreError } from './login-store.js';
import { createLoginsPageHandler } from './logins-page.js';

export const loginsPageGuard = defineGuardedAction({
  action: 'gws_ea_browser.logins_page',
  async decide({ actor }) {
    return actor.kind === 'agent' && (await hasBrowserAccess(actor.agentGroupId))
      ? ALLOW("An agent with browser access asks for the principal's logins page.")
      : DENY("Only an agent with browser access may obtain the principal's logins page.");
  },
});

async function loginsStatus(): Promise<string> {
  try {
    const store = await getLoginStore();
    if (!(await store.availability()).available) return 'Unavailable';
    const count = (await store.all()).length;
    return count === 0 ? 'No saved logins' : count === 1 ? '1 saved login' : `${count} saved logins`;
  } catch (error) {
    if (error instanceof LoginStoreError) return 'Unavailable';
    throw error;
  }
}

export const loginsWebMount: PrincipalPageMount = {
  name: 'logins',
  audience: 'principal',
  path: '/logins',
  methods: ['GET', 'HEAD', 'POST'],
  title: 'Logins',
  status: loginsStatus,
  linkGuard: loginsPageGuard,
  handler: (config, identity) => createLoginsPageHandler({ hostname: config.hostname, identity }),
};
