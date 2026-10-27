import path from 'node:path';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import { readRegularFileBounded } from '../../anchored-dir.js';
import { readEnvFile } from '../../env.js';
import { isRecord } from '../../gws-ea/validation.js';

export const WEB_POLICY_FILE_ENV = 'GWS_EA_WEB_POLICY_FILE';
export const WEB_POLICY_VERSIONS = [1] as const;

/** Host-only: author results carry none of it beyond the hostname in artifact URLs. */
export interface WebPolicyFile {
  readonly schemaVersion: 1;
  readonly enabled: boolean;
  readonly hostname: string;
  readonly listenPort: number;
  readonly accessIssuer: string;
  readonly accessAud: string;
  readonly cloudflare: {
    readonly accountId: string;
    readonly applicationId: string;
    readonly operatorConfigFile: string;
  };
}
export type WebPolicy =
  | { readonly status: 'enabled'; readonly enabled: true; readonly config: WebPolicyFile }
  | { readonly status: 'disabled'; readonly enabled: false; readonly config?: WebPolicyFile }
  | { readonly status: 'unavailable'; readonly enabled: false; readonly reason: 'invalid-web-policy' };

const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/u;
const ID = /^[a-zA-Z0-9_-]{1,256}$/u;
export function parseWebPolicyFile(value: unknown): WebPolicyFile | undefined {
  if (
    !isRecord(value) ||
    Object.keys(value).some(
      (key) =>
        !['schemaVersion', 'enabled', 'hostname', 'listenPort', 'accessIssuer', 'accessAud', 'cloudflare'].includes(
          key,
        ),
    )
  )
    return undefined;
  const cf = value.cloudflare;
  if (
    value.schemaVersion !== 1 ||
    typeof value.enabled !== 'boolean' ||
    typeof value.hostname !== 'string' ||
    !HOST.test(value.hostname) ||
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
    listenPort: value.listenPort,
    accessIssuer: value.accessIssuer,
    accessAud: value.accessAud,
    cloudflare: { accountId: cf.accountId, applicationId: cf.applicationId, operatorConfigFile: cf.operatorConfigFile },
  };
}
export function webPolicyFile(): string | undefined {
  return (
    process.env[WEB_POLICY_FILE_ENV]?.trim() ||
    readEnvFile([WEB_POLICY_FILE_ENV])[WEB_POLICY_FILE_ENV]?.trim() ||
    undefined
  );
}
export async function readWebPolicy(file = webPolicyFile()): Promise<WebPolicy> {
  if (!file) return { status: 'disabled', enabled: false };
  /* eslint-disable no-catch-all/no-catch-all -- invalid optional operator state closes this capability without breaking conversation */
  try {
    if (!path.isAbsolute(file)) return { status: 'unavailable', enabled: false, reason: 'invalid-web-policy' };
    const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
    let bytes: Buffer;
    try {
      const stat = fs.fstatSync(fd);
      if (
        stat.nlink !== 1 ||
        (stat.mode & 0o077) !== 0 ||
        (typeof process.getuid === 'function' && stat.uid !== process.getuid())
      )
        return { status: 'unavailable', enabled: false, reason: 'invalid-web-policy' };
      bytes = readRegularFileBounded(fd, 16 * 1024);
    } finally {
      fs.closeSync(fd);
    }
    const config = parseWebPolicyFile(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)));
    if (!config) return { status: 'unavailable', enabled: false, reason: 'invalid-web-policy' };
    return config.enabled
      ? { status: 'enabled', enabled: true, config }
      : { status: 'disabled', enabled: false, config };
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT')
      return { status: 'disabled', enabled: false };
    return { status: 'unavailable', enabled: false, reason: 'invalid-web-policy' };
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

/** Digest of the complete host policy, including ownership and admission coordinates. */
export function webPolicyDigest(value: WebPolicyFile | undefined): string {
  return createHash('sha256')
    .update(JSON.stringify(value) ?? '')
    .digest('hex');
}
