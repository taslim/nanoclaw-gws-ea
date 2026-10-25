import path from 'node:path';
import fs from 'node:fs';
import { readRegularFileBounded } from '../../anchored-dir.js';
import { parseStoredCapabilities } from '../../capabilities.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getDb } from '../../db/connection.js';
import { getSession } from '../../db/sessions.js';
import { readEnvFile } from '../../env.js';
import { isRecord } from '../../gws-ea/validation.js';
import type { Session } from '../../types.js';
import {
  getBrowserAgentGroupId,
  getExternalChatAgentGroupId,
  getExternalEmailAgentGroupId,
  getMainAgentGroupId,
} from '../gws-ea-profile/db.js';
import type { ArtifactActor } from './db.js';

export const ARTIFACTS_POLICY_FILE_ENV = 'GWS_EA_ARTIFACTS_POLICY_FILE';
export const ARTIFACTS_POLICY_VERSIONS = [1] as const;
export const ARTIFACTS_CAPABILITY = 'artifacts';

/** Host-only: author results carry none of it beyond the hostname and path prefix in artifact URLs. */
export interface ArtifactsPolicyFile {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly hostname: string;
  readonly pathPrefix: string;
  readonly listenPort: number;
  readonly accessIssuer: string;
  readonly accessAud: string;
  readonly cloudflare: {
    readonly accountId: string;
    readonly applicationId: string;
    readonly operatorConfigFile: string;
  };
}
export type ArtifactsPolicy =
  | { readonly status: 'enabled'; readonly enabled: true; readonly config: ArtifactsPolicyFile }
  | { readonly status: 'disabled'; readonly enabled: false; readonly config?: ArtifactsPolicyFile }
  | { readonly status: 'unavailable'; readonly enabled: false; readonly reason: 'invalid-artifacts-policy' };

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const ID = /^[a-zA-Z0-9_-]{1,256}$/u;
const RESERVED = new Set(['public', 'private', 'guest', 'assets', 'api', 'cdn-cgi', 'health', 'login', 'logout']);

function validPrefix(value: string): boolean {
  if (value === '') return true;
  if (!value.startsWith('/')) return false;
  let decoded: string;
  try {
    decoded = decodeURIComponent(value.slice(1));
  } catch (error) {
    if (error instanceof URIError) return false;
    throw error;
  }
  if (
    !decoded ||
    decoded === '.' ||
    decoded === '..' ||
    /[\\/\p{Cc}]/u.test(decoded) ||
    RESERVED.has(decoded.toLowerCase())
  )
    return false;
  const canonical = decoded.normalize('NFKC').toLowerCase().replace(/\s+/gu, '-');
  return decoded === canonical && value === `/${encodeURIComponent(canonical)}`;
}

export function parseArtifactsPolicyFile(value: unknown): ArtifactsPolicyFile | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          'schemaVersion',
          'enabled',
          'hostname',
          'pathPrefix',
          'listenPort',
          'accessIssuer',
          'accessAud',
          'cloudflare',
        ].includes(key),
    )
  )
    return undefined;
  const cf = value.cloudflare;
  if (
    value.schemaVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    typeof value.hostname !== 'string' ||
    !HOST.test(value.hostname) ||
    typeof value.pathPrefix !== 'string' ||
    !validPrefix(value.pathPrefix) ||
    typeof value.listenPort !== 'number' ||
    !Number.isSafeInteger(value.listenPort) ||
    value.listenPort < 1 ||
    value.listenPort > 65535 ||
    typeof value.accessIssuer !== 'string' ||
    !/^https:\/\/[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.cloudflareaccess\.com$/u.test(value.accessIssuer) ||
    typeof value.accessAud !== 'string' ||
    !ID.test(value.accessAud) ||
    !isRecord(cf) ||
    Object.keys(cf).some((key) => !['accountId', 'applicationId', 'operatorConfigFile'].includes(key)) ||
    typeof cf.accountId !== 'string' ||
    !ID.test(cf.accountId) ||
    typeof cf.applicationId !== 'string' ||
    !ID.test(cf.applicationId) ||
    typeof cf.operatorConfigFile !== 'string' ||
    !path.isAbsolute(cf.operatorConfigFile)
  )
    return undefined;
  return {
    schemaVersion: 1,
    enabled: value.enabled,
    hostname: value.hostname,
    pathPrefix: value.pathPrefix,
    listenPort: value.listenPort,
    accessIssuer: value.accessIssuer,
    accessAud: value.accessAud,
    cloudflare: { accountId: cf.accountId, applicationId: cf.applicationId, operatorConfigFile: cf.operatorConfigFile },
  };
}
export function artifactsPolicyFile(): string | undefined {
  return (
    process.env[ARTIFACTS_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([ARTIFACTS_POLICY_FILE_ENV])[ARTIFACTS_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}
export async function readArtifactsPolicy(file = artifactsPolicyFile()): Promise<ArtifactsPolicy> {
  if (!file) return { status: 'disabled', enabled: false };
  /* eslint-disable no-catch-all/no-catch-all -- invalid optional operator state closes this capability without breaking conversation */
  try {
    if (!path.isAbsolute(file)) return { status: 'unavailable', enabled: false, reason: 'invalid-artifacts-policy' };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      )
        return { status: 'unavailable', enabled: false, reason: 'invalid-artifacts-policy' };
      bytes = readRegularFileBounded(fd, 16 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const config = parseArtifactsPolicyFile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!config) return { status: 'unavailable', enabled: false, reason: 'invalid-artifacts-policy' };
    return config.enabled
      ? { status: 'enabled', enabled: true, config }
      : { status: 'disabled', enabled: false, config };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { status: 'disabled', enabled: false };
    return { status: 'unavailable', enabled: false, reason: 'invalid-artifacts-policy' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Reads the stored selection, not resolved capabilities: this is the capability's own `grantedTo`. */
export async function hasArtifactsAccess(agentGroupId: string, policy?: ArtifactsPolicy): Promise<boolean> {
  if (
    !(policy ?? (await readArtifactsPolicy())).enabled ||
    !(await getDb().hasTable('gws_ea_profile')) ||
    !(await getAgentGroup(agentGroupId))
  )
    return false;
  const sealed = [
    await getBrowserAgentGroupId(),
    await getExternalEmailAgentGroupId(),
    await getExternalChatAgentGroupId(),
  ];
  if (sealed.includes(agentGroupId)) return false;
  if (await getDb().hasTable('gws_ea_job_agents')) {
    const job = await getDb().get<{ state: string }>(
      'SELECT state FROM gws_ea_job_agents WHERE agent_group_id=?',
      agentGroupId,
    );
    if (job && job.state !== 'active') return false;
  }
  if (agentGroupId === (await getMainAgentGroupId())) return true;
  const selection = parseStoredCapabilities((await getContainerConfig(agentGroupId))?.capabilities, agentGroupId);
  return selection !== 'all' && selection.includes(ARTIFACTS_CAPABILITY);
}

/** Identity comes from the freshly read host session, never from tool fields. */
export async function artifactActor(session: Session, policy?: ArtifactsPolicy): Promise<ArtifactActor | undefined> {
  const current = await getSession(session.id);
  if (
    !current ||
    current.status !== 'active' ||
    current.agent_group_id !== session.agent_group_id ||
    !(await hasArtifactsAccess(current.agent_group_id, policy))
  )
    return undefined;
  return {
    agentGroupId: current.agent_group_id,
    sessionId: current.id,
    isMain: current.agent_group_id === (await getMainAgentGroupId()),
  };
}
export function artifactPrivateUrl(config: ArtifactsPolicyFile, artifactId: string): string {
  return `https://${config.hostname}${config.pathPrefix}/${encodeURIComponent(artifactId)}`;
}
