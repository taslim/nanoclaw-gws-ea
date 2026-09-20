import { readJson, writePrivate } from '../community-portal/private-file.js';
import { isErrno } from '../community-portal/errors.js';
import { assertPrivateStateFile } from './paths.js';
import type { ControlPlanePaths } from './paths.js';
import { assertRegistryMarkerAgreement, getInstanceReservation } from './registry.js';
import { GwsEaError } from './types.js';
import { isRecord } from './validation.js';

const CHAT_CONFIGURATION_SCHEMA_VERSION = 1 as const;

interface ChatConfigurationReceipt {
  readonly schema_version: typeof CHAT_CONFIGURATION_SCHEMA_VERSION;
  readonly instance_id: string;
  readonly gcp_project_id: string;
  readonly endpoint_url: string;
  readonly confirmed_at: string;
}

function validateReceipt(
  value: unknown,
  expected: { readonly instanceId: string; readonly projectId: string; readonly endpointUrl: string },
): ChatConfigurationReceipt {
  if (!isRecord(value)) throw new GwsEaError('invalid_chat_confirmation', 'Chat confirmation is invalid');
  const keys = Object.keys(value).sort();
  const expectedKeys = ['schema_version', 'instance_id', 'gcp_project_id', 'endpoint_url', 'confirmed_at'].sort();
  if (keys.length !== expectedKeys.length || keys.some((key, index) => key !== expectedKeys[index])) {
    throw new GwsEaError('invalid_chat_confirmation', 'Chat confirmation contains unknown or missing fields');
  }
  if (
    value.schema_version !== CHAT_CONFIGURATION_SCHEMA_VERSION ||
    value.instance_id !== expected.instanceId ||
    value.gcp_project_id !== expected.projectId ||
    value.endpoint_url !== expected.endpointUrl ||
    typeof value.confirmed_at !== 'string'
  ) {
    throw new GwsEaError('chat_confirmation_mismatch', 'Chat confirmation does not match the reserved instance');
  }
  const timestamp = new Date(value.confirmed_at);
  if (Number.isNaN(timestamp.valueOf()) || timestamp.toISOString() !== value.confirmed_at) {
    throw new GwsEaError('invalid_chat_confirmation', 'Chat confirmation timestamp is invalid');
  }
  return {
    schema_version: CHAT_CONFIGURATION_SCHEMA_VERSION,
    instance_id: expected.instanceId,
    gcp_project_id: expected.projectId,
    endpoint_url: expected.endpointUrl,
    confirmed_at: value.confirmed_at,
  };
}

export function googleChatConfigurationUrl(projectId: string): string {
  const url = new URL('https://console.developers.google.com/apis/api/chat.googleapis.com/hangouts-chat');
  url.searchParams.set('project', projectId);
  return url.href;
}

export async function confirmChatConfiguration(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  const reservation = await assertRegistryMarkerAgreement(paths, instanceId);
  const expected = {
    instanceId,
    projectId: reservation.exclusive_resource_claims.gcp_project_id,
    endpointUrl: reservation.exclusive_resource_claims.endpoint_url,
  };
  try {
    await assertPrivateStateFile(paths.chatConfigurationFile(instanceId));
    validateReceipt(await readJson<unknown>(paths.chatConfigurationFile(instanceId)), expected);
    return;
  } catch (error) {
    if (!isErrno(error, 'ENOENT')) throw error;
  }
  await writePrivate(paths.chatConfigurationFile(instanceId), {
    schema_version: CHAT_CONFIGURATION_SCHEMA_VERSION,
    instance_id: instanceId,
    gcp_project_id: expected.projectId,
    endpoint_url: expected.endpointUrl,
    confirmed_at: new Date().toISOString(),
  } satisfies ChatConfigurationReceipt);
}

export async function isChatConfigurationConfirmed(paths: ControlPlanePaths, instanceId: string): Promise<boolean> {
  const reservation = await getInstanceReservation(paths, instanceId);
  try {
    await assertPrivateStateFile(paths.chatConfigurationFile(instanceId));
    validateReceipt(await readJson<unknown>(paths.chatConfigurationFile(instanceId)), {
      instanceId,
      projectId: reservation.exclusive_resource_claims.gcp_project_id,
      endpointUrl: reservation.exclusive_resource_claims.endpoint_url,
    });
    return true;
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return false;
    throw error;
  }
}
