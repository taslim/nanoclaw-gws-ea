import type { RequestListener } from 'node:http';
import { getGwsEaProfile } from '../gws-ea-profile/db.js';
import { handle, refuse, sendPublicJson } from '../gws-ea-web/kit/index.js';
import { normalizeWebPathname } from '../gws-ea-web/mounts.js';
import { appClientDocumentUrl, appRedirectUri, CLIENT_DOCUMENT_PATH } from './oauth.js';
import {
  APP_ID_PATTERN,
  ConnectionsStoreError,
  getConnectionsStore,
  type ConnectionApp,
  type ConnectionsStore,
} from './store.js';

const DOCUMENT = new RegExp(`^${CLIENT_DOCUMENT_PATH}/(${APP_ID_PATTERN})$`, 'u');
const MAX_AGE_SECONDS = 3600;

interface ClientDocumentOptions {
  readonly hostname: string;
  readonly openStore?: () => Promise<ConnectionsStore>;
}

/**
 * An unreadable store answers unavailable rather than not-found, because an authorization server may end the
 * app's refresh tokens once its client document is gone.
 */
async function readApp(openStore: () => Promise<ConnectionsStore>, id: string): Promise<ConnectionApp | undefined> {
  try {
    return await (await openStore()).get(id);
  } catch (error) {
    if (error instanceof ConnectionsStoreError && error.reason === 'app_not_found') return undefined;
    throw error;
  }
}

/**
 * Serves each OAuth app's client metadata document to anyone. Nothing in it comes from the request, and the app's
 * sealed client is never read, so it is served while Keychain is unavailable.
 */
export function createClientDocumentHandler(options: ClientDocumentOptions): RequestListener {
  const openStore = options.openStore ?? getConnectionsStore;
  return (request, response) => {
    handle(response, async () => {
      const id = DOCUMENT.exec(normalizeWebPathname(request.url) ?? '')?.[1];
      if (!id || (request.method !== 'GET' && request.method !== 'HEAD')) return refuse(response);
      const app = await readApp(openStore, id);
      if (app?.auth !== 'oauth') return refuse(response);
      const { assistant_display_name: name } = await getGwsEaProfile();
      sendPublicJson(
        response,
        {
          client_id: appClientDocumentUrl(options.hostname, app.id),
          // Without a name, the consent screen shows the client ID, which still names the assistant's hostname.
          ...(name ? { client_name: name } : {}),
          redirect_uris: [appRedirectUri(options.hostname, app.host)],
          grant_types: ['authorization_code', 'refresh_token'],
          response_types: ['code'],
          // Some servers read only the singular field, others only the list.
          token_endpoint_auth_method: 'none',
          token_endpoint_auth_methods_supported: ['none'],
          application_type: 'web',
        },
        { head: request.method === 'HEAD', maxAgeSeconds: MAX_AGE_SECONDS },
      );
    });
  };
}
