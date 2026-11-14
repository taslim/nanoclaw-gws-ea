import type { PrincipalPageMount } from '../gws-ea-web/mounts.js';
import { getLoginStore, LoginStoreError } from './login-store.js';
import { loginsPageGuard } from './logins-link.js';
import { createLoginsPageHandler } from './logins-page.js';

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
