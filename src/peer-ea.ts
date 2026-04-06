/**
 * Peer EA group configuration for NanoClaw
 *
 * Defines container defaults for peer EA groups — privileged 1:1 channels
 * between two NanoClaw instances for cross-principal coordination.
 */
import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';

import { ASSISTANT_NAME } from './config.js';
import { resolveGroupIpcPath } from './group-folder.js';
import { logger } from './logger.js';

export const PEER_EA_DEFAULTS = {
  trigger: `@${ASSISTANT_NAME}`,
  requiresTrigger: false,
  containerConfig: {
    builtins: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'ToolSearch',
      'TodoWrite',
      'Skill',
      'NotebookEdit',
    ],
    mcpConfig: {
      calendar: true as const,
      workspace: ['gmail', 'contacts', 'chat'],
    },
  },
};

export const PEER_EA_STATUSES = [
  'outbound-pending',
  'inbound-pending',
  'approved',
  'rejected',
  'disconnected',
  'blocked',
] as const;
export type PeerEAStatus = (typeof PEER_EA_STATUSES)[number];

/** Protocol message prefixes for peer EA handshake */
export const PEER_PROTOCOL = {
  REQUEST: '[NANOCLAW-PEER-REQUEST]',
  ACCEPT: '[NANOCLAW-PEER-ACCEPT]',
  REJECT: '[NANOCLAW-PEER-REJECT]',
  DISCONNECT: '[NANOCLAW-PEER-DISCONNECT]',
} as const;

/** Check if a message is a peer protocol message */
export function isPeerProtocolMessage(content: string): boolean {
  const trimmed = content.trim();
  return (
    trimmed.startsWith(PEER_PROTOCOL.REQUEST) ||
    trimmed.startsWith(PEER_PROTOCOL.ACCEPT) ||
    trimmed.startsWith(PEER_PROTOCOL.REJECT) ||
    trimmed.startsWith(PEER_PROTOCOL.DISCONNECT)
  );
}

/** Parse structured fields from a peer protocol message */
export function parsePeerProtocolFields(
  content: string,
): Record<string, string> {
  const fields: Record<string, string> = {};
  const lines = content.split('\n');
  for (const line of lines) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) {
      fields[match[1].toLowerCase()] = match[2].trim();
    }
  }
  return fields;
}

/** Build a peer protocol message */
export function buildPeerProtocolMessage(
  type: keyof typeof PEER_PROTOCOL,
  fields: Record<string, string>,
): string {
  const lines: string[] = [PEER_PROTOCOL[type]];
  for (const [key, value] of Object.entries(fields)) {
    lines.push(`${key}: ${value}`);
  }
  return lines.join('\n');
}

/**
 * Pipe a result message to the container agent via the IPC input directory.
 * The container's drainIpcInput() poller picks it up and injects it as a
 * follow-up user message in the active query.
 */
export function pipeToAgent(sourceGroup: string, text: string): void {
  try {
    const inputDir = path.join(resolveGroupIpcPath(sourceGroup), 'input');
    fs.mkdirSync(inputDir, { recursive: true });
    const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
    const tempPath = path.join(inputDir, `${filename}.tmp`);
    const filepath = path.join(inputDir, filename);
    fs.writeFileSync(tempPath, JSON.stringify({ type: 'message', text }));
    fs.renameSync(tempPath, filepath);
  } catch (err) {
    logger.warn(
      { sourceGroup, err: err instanceof Error ? err.message : String(err) },
      'Failed to pipe result to agent',
    );
  }
}

/** Derive peer group folder name from email (collision-resistant) */
export function peerFolderFromEmail(email: string): string {
  const localPart = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, '-');
  const fingerprint = createHash('sha1')
    .update(email.toLowerCase())
    .digest('hex')
    .slice(0, 8);
  return `peer-${localPart}-${fingerprint}`;
}
