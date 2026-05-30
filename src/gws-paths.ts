import fs from 'fs';
import os from 'os';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';

export const GWS_DIRNAME = '.gws';
export const SA_FILENAME = 'service-account.json';
export const CALENDARS_FILENAME = 'calendars.json';

/** Where the GWS service-account key + calendars config land inside agent
 * containers. Top-level under /home/node/ (not nested under /workspace/) so
 * Docker for Mac's virtiofs accepts the file binds. Mirrors v1's container
 * paths, and is the single source of truth shared by host mount setup
 * (src/container-runner.ts) and the agent-runner readers
 * (container/agent-runner/src/gws-capability.ts and heartbeat-sweep.ts).
 * The agent-runner is a separate process tree and can't import this module,
 * so those constants are duplicated there — keep them in sync if changed. */
export const CONTAINER_GWS_DIR = '/home/node/.gws';
export const CONTAINER_SA_PATH = `${CONTAINER_GWS_DIR}/${SA_FILENAME}`;
export const CONTAINER_CALENDARS_PATH = `${CONTAINER_GWS_DIR}/${CALENDARS_FILENAME}`;

export interface ServiceAccountKey {
  client_email: string;
  private_key: string;
  project_id: string;
}

export function getBotDir(): string {
  return path.join(os.homedir(), GWS_DIRNAME, ASSISTANT_NAME.toLowerCase());
}

export function getSaKeyPath(): string {
  return path.join(getBotDir(), SA_FILENAME);
}

export function getCalendarsHostPath(): string {
  return path.join(getBotDir(), CALENDARS_FILENAME);
}

/** Read and parse a GWS service-account JSON. Returns null when the file is
 * missing — callers use that to decide whether to disable a channel. Other
 * read/parse errors throw (configuration is broken; don't paper over). */
export function loadServiceAccount(saKeyPath: string): ServiceAccountKey | null {
  let raw: string;
  try {
    raw = fs.readFileSync(saKeyPath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw err;
  }
  return JSON.parse(raw) as ServiceAccountKey;
}

/** Strip `gchat:` prefix from a v2 GChat platform_id / channel id. Returns
 * the bare Chat API resource name (`spaces/<id>`) the API expects, or null
 * if the input doesn't look like one. */
export function gchatSpaceName(channelId: string): string | null {
  const stripped = channelId.startsWith('gchat:') ? channelId.slice('gchat:'.length) : channelId;
  return stripped.startsWith('spaces/') ? stripped : null;
}

/** True when a Chat API space resource represents a 1:1 DM (with a human
 * via DWD impersonation, or with the bot itself). Mirrors the upstream
 * chat-adapter's `fetchChannelInfo.isDM` derivation. */
export function isDmSpace(space: { spaceType?: string | null; singleUserBotDm?: boolean | null }): boolean {
  return space.spaceType === 'DIRECT_MESSAGE' || space.singleUserBotDm === true;
}
