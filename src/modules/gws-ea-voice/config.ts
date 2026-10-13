import { readEnvFile } from '../../env.js';
import {
  readVoiceHostPolicy,
  verifyVoiceInstallation,
  VoiceAssetsError,
  type VerifiedVoiceInstallation,
} from '../../gws-ea/voice-assets.js';

export const VOICE_POLICY_FILE_ENV = 'GWS_EA_VOICE_POLICY_FILE';
export type VoiceReadiness =
  | { status: 'ready'; enabled: true; installation: VerifiedVoiceInstallation }
  | {
      status: 'unavailable';
      enabled: boolean;
      reason:
        | 'operator-setup-required'
        | 'operator-enablement-required'
        | 'operator-update-required'
        | 'voice-installation-unhealthy';
    };

export async function readVoiceReadiness(): Promise<VoiceReadiness> {
  const file =
    process.env[VOICE_POLICY_FILE_ENV]?.trim() || readEnvFile([VOICE_POLICY_FILE_ENV])[VOICE_POLICY_FILE_ENV]?.trim();
  if (!file) return { status: 'unavailable', enabled: false, reason: 'operator-setup-required' };
  let enabled = false;
  // Bad optional state must leave text service available and yield a terminal voice limitation.
  /* eslint-disable no-catch-all/no-catch-all -- optional capability failure is bounded content */
  try {
    const policy = await readVoiceHostPolicy(file);
    enabled = policy.enabled;
    if (!policy.enabled) return { status: 'unavailable', enabled: false, reason: 'operator-enablement-required' };
    if (!policy.installationDir) return { status: 'unavailable', enabled: true, reason: 'operator-setup-required' };
    return { status: 'ready', enabled: true, installation: await verifyVoiceInstallation(policy.installationDir) };
  } catch (error) {
    const reason =
      error instanceof VoiceAssetsError && error.code === 'unsupported'
        ? 'operator-update-required'
        : error instanceof Error && 'code' in error && error.code === 'ENOENT'
          ? 'operator-setup-required'
          : 'voice-installation-unhealthy';
    return { status: 'unavailable', enabled, reason };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
