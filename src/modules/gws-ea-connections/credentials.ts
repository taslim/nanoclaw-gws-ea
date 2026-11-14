import type {
  GatewayCredentialTarget,
  GatewayRuntimeCredentialConnection,
} from '../../gateway-providers/credential-connection.js';
import { getGatewayProvider } from '../../gateway-providers/index.js';
import { appCredentialName } from './admit.js';

/** What a connected app's tools send in place of a token; the gateway replaces it on the app's host and path. */
export const APP_TOKEN_PLACEHOLDER = 'gateway-managed';

export interface CredentialApp {
  readonly id: string;
  readonly url: string;
}

export type AppConnection = (target: GatewayCredentialTarget) => GatewayRuntimeCredentialConnection;

export class AppCredentialsUnavailableError extends Error {
  constructor() {
    super('app_credentials_unavailable');
  }
}

/** The path scopes the token to the app's endpoint, so main's other requests to the host never carry it. */
export function appCredentialTarget(app: CredentialApp): GatewayCredentialTarget {
  const url = new URL(app.url);
  return {
    kind: 'api-key',
    name: appCredentialName(app.id),
    host: url.hostname,
    path: url.pathname,
    proxyValue: APP_TOKEN_PLACEHOLDER,
    injection: { headerName: 'Authorization', valueFormat: 'Bearer {value}' },
  };
}

/** Without a runtime credential store the gateway cannot hold app tokens, so connecting apps is unavailable. */
export function gatewayAppConnection(): AppConnection {
  const credentials = getGatewayProvider().credentials;
  if (!credentials) throw new AppCredentialsUnavailableError();
  return (target) => credentials.connection(target);
}

export async function publishAppCredential(
  app: CredentialApp,
  token: string,
  connection: AppConnection = gatewayAppConnection(),
): Promise<void> {
  const entry = connection(appCredentialTarget(app));
  await entry.find();
  await entry.save(token);
}

export async function removeAppCredential(
  app: CredentialApp,
  connection: AppConnection = gatewayAppConnection(),
): Promise<void> {
  const entry = connection(appCredentialTarget(app));
  if (await entry.find()) await entry.remove();
}
