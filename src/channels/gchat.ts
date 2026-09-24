/**
 * Google Chat channel adapter (v2) — uses the standard Chat SDK bridge.
 * Self-registers on import.
 */
import { createGoogleChatAdapter } from '@chat-adapter/gchat';

import { readEnvFile } from '../env.js';
import type { ChannelDefaults } from './adapter.js';
import { createChatSdkBridge } from './chat-sdk-bridge.js';
import { registerChannelAdapter } from './channel-registry.js';

const GCHAT_ENV_KEYS = [
  'GCHAT_CREDENTIALS',
  'GCHAT_ENDPOINT_URL',
  'GCHAT_BOT_USER_ID',
  'GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL',
] as const;
const GCHAT_BOT_USER_ID_RE = /^users\/[^/\s]+$/;
const GCHAT_ADDON_IDENTITY_RE = /^service-[1-9]\d*@gcp-sa-gsuiteaddons\.iam\.gserviceaccount\.com$/;
const ALTERNATE_VERIFIER_ENV_KEYS = [
  'GOOGLE_CHAT_PROJECT_NUMBER',
  'GOOGLE_CHAT_PUBSUB_AUDIENCE',
  'GOOGLE_CHAT_PUBSUB_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL',
  'GOOGLE_CHAT_DISABLE_SIGNATURE_VERIFICATION',
] as const;

interface GoogleChatCredentials {
  client_email: string;
  private_key: string;
  project_id?: string;
}

function configuredValue(processValue: string | undefined, fileValue: string | undefined): string | undefined {
  if (processValue?.trim()) return processValue;
  if (fileValue?.trim()) return fileValue;
  return undefined;
}

function parseCredentials(raw: string): GoogleChatCredentials {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error('GCHAT_CREDENTIALS must contain valid JSON', { cause });
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new Error('GCHAT_CREDENTIALS must be a service-account JSON object');
  }

  const value = parsed as Record<string, unknown>;
  if (typeof value.client_email !== 'string' || !value.client_email.trim()) {
    throw new Error('GCHAT_CREDENTIALS must contain a non-empty client_email');
  }
  if (typeof value.private_key !== 'string' || !value.private_key.trim()) {
    throw new Error('GCHAT_CREDENTIALS must contain a non-empty private_key');
  }
  if (value.project_id !== undefined && typeof value.project_id !== 'string') {
    throw new Error('GCHAT_CREDENTIALS project_id must be a string when present');
  }

  return {
    client_email: value.client_email,
    private_key: value.private_key,
    ...(value.project_id !== undefined ? { project_id: value.project_id } : {}),
  };
}

function validateEndpointUrl(endpointUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(endpointUrl);
  } catch (cause) {
    throw new Error('GCHAT_ENDPOINT_URL must be a valid absolute URL', { cause });
  }
  if (parsed.protocol !== 'https:') {
    throw new Error('GCHAT_ENDPOINT_URL must use https');
  }
}

function validateBotUserId(botUserId: string): void {
  if (!GCHAT_BOT_USER_ID_RE.test(botUserId)) {
    throw new Error('GCHAT_BOT_USER_ID must be a canonical Google Chat user resource name (users/<id>)');
  }
}

function rejectAlternateVerifierConfiguration(): void {
  const configuredKeys = ALTERNATE_VERIFIER_ENV_KEYS.filter((key) => process.env[key]?.trim());
  if (configuredKeys.length === 0) return;

  throw new Error(
    `Google Chat exact endpoint verification cannot be combined with alternate verifier settings: ${configuredKeys.join(', ')}`,
  );
}

/**
 * Dedicated bot app on a threaded platform. `mention` (not sticky) is the
 * conservative group default; operators upgrade per wiring.
 */
const GCHAT_DEFAULTS: ChannelDefaults = {
  dm: { engageMode: 'pattern', engagePattern: '.', threads: false, unknownSenderPolicy: 'request_approval' },
  group: { engageMode: 'mention', threads: true, unknownSenderPolicy: 'request_approval' },
  mentions: 'platform',
};

registerChannelAdapter('gchat', {
  factory: () => {
    const fileEnv = readEnvFile([...GCHAT_ENV_KEYS]);
    const credentialsRaw = configuredValue(process.env.GCHAT_CREDENTIALS, fileEnv.GCHAT_CREDENTIALS);
    const endpointUrl = configuredValue(process.env.GCHAT_ENDPOINT_URL, fileEnv.GCHAT_ENDPOINT_URL);
    const botUserId = configuredValue(process.env.GCHAT_BOT_USER_ID, fileEnv.GCHAT_BOT_USER_ID);
    const addOnIdentity = configuredValue(
      process.env.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL,
      fileEnv.GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL,
    );

    if (!credentialsRaw && !endpointUrl && !botUserId && !addOnIdentity) return null;
    if (!credentialsRaw) {
      throw new Error('Google Chat configuration requires GCHAT_CREDENTIALS');
    }
    if (!endpointUrl) {
      throw new Error('Google Chat configuration requires GCHAT_ENDPOINT_URL');
    }
    const credentials = parseCredentials(credentialsRaw);
    validateEndpointUrl(endpointUrl);
    if (botUserId) validateBotUserId(botUserId);
    if (addOnIdentity && !GCHAT_ADDON_IDENTITY_RE.test(addOnIdentity)) {
      throw new Error('GCHAT_WORKSPACE_ADDON_SERVICE_ACCOUNT_EMAIL must be a Workspace Add-on service identity');
    }
    rejectAlternateVerifierConfiguration();

    const gchatAdapter = createGoogleChatAdapter({
      credentials,
      endpointUrl,
      ...(botUserId ? { botUserId } : {}),
      ...(addOnIdentity ? { workspaceAddOnServiceAccountEmail: addOnIdentity } : {}),
    });
    return createChatSdkBridge({
      adapter: gchatAdapter,
      concurrency: 'concurrent',
      supportsThreads: true,
      defaults: GCHAT_DEFAULTS,
    });
  },
  defaults: GCHAT_DEFAULTS,
});
