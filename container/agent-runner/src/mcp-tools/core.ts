/**
 * Core MCP tools: send_message, send_file, edit_message, add_reaction.
 *
 * All outbound tools resolve destinations via the local destination map
 * (see destinations.ts). Agents reference destinations by name; the map
 * translates name → routing tuple. Permission enforcement happens on
 * the host side in delivery.ts via the agent_destinations table.
 */
import fs from 'fs';
import path from 'path';

import { getCurrentInReplyTo } from '../current-batch.js';
import { findByName, getAllDestinations } from '../destinations.js';
import { isPrincipalSurface, PRINCIPAL_SURFACE, type Priority } from '../principal-surfaces.js';
import { getMessageIdBySeq, getRoutingBySeq, writeMessageOut } from '../db/messages-out.js';
import { recordTurnSentPayload } from '../db/session-state.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

export function generateId(): string {
  return `msg-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

export function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function destinationList(): string {
  const all = getAllDestinations();
  if (all.length === 0) return '(none)';
  return all.map((d) => d.name).join(', ');
}

/**
 * Resolve a destination name to routing fields.
 *
 * If `to` is omitted, use the session's default reply routing (channel +
 * thread the conversation is in) — the agent replies in place.
 *
 * If `to` is specified, look up the named destination. If it resolves to
 * the same channel the session is bound to, the session's thread_id is
 * preserved so replies land in the correct thread. Otherwise thread_id
 * is null (a cross-destination send starts a new conversation).
 */
export function resolveRouting(
  to: string | undefined,
): { channel_type: string; platform_id: string; thread_id: string | null; resolvedName: string } | { error: string } {
  if (!to) {
    // Default: reply to whatever thread/channel this session is bound to.
    const session = getSessionRouting();
    if (session.channel_type && session.platform_id) {
      return {
        channel_type: session.channel_type,
        platform_id: session.platform_id,
        thread_id: session.thread_id,
        resolvedName: '(current conversation)',
      };
    }
    // No session routing (e.g., agent-shared or internal-only agent) —
    // fall back to the legacy single-destination shortcut.
    const all = getAllDestinations();
    if (all.length === 0) return { error: 'No destinations configured.' };
    if (all.length > 1) {
      return {
        error: `You have multiple destinations — specify "to". Options: ${all.map((d) => d.name).join(', ')}`,
      };
    }
    to = all[0].name;
  }
  const dest = findByName(to);
  if (!dest) return { error: `Unknown destination "${to}". Known: ${destinationList()}` };
  if (dest.type === 'channel') {
    // If the destination is the same channel the session is bound to,
    // preserve the thread_id so replies land in the correct thread.
    const session = getSessionRouting();
    const threadId =
      session.channel_type === dest.channelType && session.platform_id === dest.platformId ? session.thread_id : null;
    return {
      channel_type: dest.channelType!,
      platform_id: dest.platformId!,
      thread_id: threadId,
      resolvedName: to,
    };
  }
  return { channel_type: 'agent', platform_id: dest.agentGroupId!, thread_id: null, resolvedName: to };
}

export function asStringArray(value: unknown): string[] | undefined {
  if (value == null) return undefined;
  if (Array.isArray(value)) {
    const out = value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0);
    return out.length > 0 ? out : undefined;
  }
  if (typeof value === 'string' && value.trim().length > 0) return [value];
  return undefined;
}

export function stageOutboxFile(
  messageId: string,
  srcPath: string,
  displayName?: string,
): { filename: string } | { error: string } {
  const resolved = path.isAbsolute(srcPath) ? srcPath : path.resolve('/workspace/agent', srcPath);
  const filename = displayName ?? path.basename(resolved);
  const outboxDir = path.join('/workspace/outbox', messageId);
  fs.mkdirSync(outboxDir, { recursive: true });
  try {
    fs.copyFileSync(resolved, path.join(outboxDir, filename));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      return { error: `File not found: ${srcPath}` };
    }
    throw e;
  }
  return { filename };
}

export const sendMessage: McpToolDefinition = {
  tool: {
    name: 'send_message',
    description:
      'Send a message to a named chat destination. If you have only one destination, you can omit `to`. The body goes in `text` and is treated as markdown — formatted per platform. Mid-turn use only (a quick ack before a slow tool call, or a heads-up while you keep working). For email, use a `<message to="…">` block (plain reply) or the `send_email` tool (compose / overrides); `send_message` does not deliver to email destinations.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: {
          type: 'string',
          description: 'Destination name (e.g., "principal", "email-external"). Optional if you have only one destination.',
        },
        text: {
          type: 'string',
          description: 'Message body. Markdown is supported.',
        },
        files: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths (relative to /workspace/agent/ or absolute) to attach.',
        },
      },
    },
  },
  async handler(args) {
    const text = typeof args.text === 'string' ? args.text : undefined;
    if (!text) return err('text is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    if (routing.channel_type === 'email') {
      return err(
        'send_message does not deliver to email destinations. Use a `<message to="…">` block for plain replies on the inbound thread, or `send_email` for compose/overrides.',
      );
    }

    // Cross-channel principal notifications flow through `<message priority>`
    // blocks (where the host classifies loudness), not this mid-turn tool.
    // Guard only fires on an explicit principal target; implicit replies and
    // non-principal destinations pass through. Shim until prompts are rewritten,
    // then flip to a hard reject.
    const explicitTo = typeof args.to === 'string' ? args.to : undefined;
    let shimPriority: Priority | null = null;
    if (explicitTo && isPrincipalSurface(explicitTo)) {
      shimPriority = explicitTo === PRINCIPAL_SURFACE ? 'urgent' : 'awareness';
      log(
        `send_message(to="${explicitTo}") targets a principal surface — shimming to priority="${shimPriority}". Prefer <message priority="...">.`,
      );
    }

    const filePaths = asStringArray(args.files);
    const id = generateId();

    let stagedFilenames: string[] | undefined;
    if (filePaths) {
      stagedFilenames = [];
      for (const p of filePaths) {
        const staged = stageOutboxFile(id, p);
        if ('error' in staged) return err(staged.error);
        stagedFilenames.push(staged.filename);
      }
    }

    const content: Record<string, unknown> = { text };
    if (stagedFilenames) content.files = stagedFilenames;

    const seq = writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify(content),
      priority: shimPriority,
    });

    recordTurnSentPayload(text);
    log(`send_message: #${seq} → ${routing.resolvedName}`);
    return ok(`Message sent to ${routing.resolvedName} (id: ${seq})`);
  },
};

export const sendFile: McpToolDefinition = {
  tool: {
    name: 'send_file',
    description: 'Send a file to a named destination. If you have only one destination, you can omit `to`.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        to: { type: 'string', description: 'Destination name. Optional if you have only one destination.' },
        path: { type: 'string', description: 'File path (relative to /workspace/agent/ or absolute)' },
        text: { type: 'string', description: 'Optional accompanying message' },
        filename: { type: 'string', description: 'Display name (default: basename of path)' },
      },
      required: ['path'],
    },
  },
  async handler(args) {
    const filePath = args.path as string;
    if (!filePath) return err('path is required');

    const routing = resolveRouting(args.to as string | undefined);
    if ('error' in routing) return err(routing.error);

    const id = generateId();
    const staged = stageOutboxFile(id, filePath, args.filename as string | undefined);
    if ('error' in staged) return err(staged.error);

    writeMessageOut({
      id,
      in_reply_to: getCurrentInReplyTo(),
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ text: (args.text as string) || '', files: [staged.filename] }),
    });

    // send_file's text is optional and often just a caption; record only when present.
    // The duplicate we're trying to suppress is the text-blob mirror, not the file itself.
    const fileText = (args.text as string) || '';
    if (fileText) recordTurnSentPayload(fileText);
    log(`send_file: ${id} → ${routing.resolvedName} (${staged.filename})`);
    return ok(`File sent to ${routing.resolvedName} (id: ${id}, filename: ${staged.filename})`);
  },
};

export const editMessage: McpToolDefinition = {
  tool: {
    name: 'edit_message',
    description: 'Edit a previously sent message. Targets the same destination the original message was sent to.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        text: { type: 'string', description: 'New message content' },
      },
      required: ['messageId', 'text'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const text = args.text as string;
    if (!seq || !text) return err('messageId and text are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'edit', messageId: platformId, text }),
    });

    log(`edit_message: #${seq} → ${platformId}`);
    return ok(`Message edit queued for #${seq}`);
  },
};

export const addReaction: McpToolDefinition = {
  tool: {
    name: 'add_reaction',
    description: 'Add an emoji reaction to a message.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: { type: 'integer', description: 'Message ID (the numeric id shown in messages)' },
        emoji: { type: 'string', description: 'Emoji name (e.g., thumbs_up, heart, check)' },
      },
      required: ['messageId', 'emoji'],
    },
  },
  async handler(args) {
    const seq = Number(args.messageId);
    const emoji = args.emoji as string;
    if (!seq || !emoji) return err('messageId and emoji are required');

    const platformId = getMessageIdBySeq(seq);
    if (!platformId) return err(`Message #${seq} not found`);

    const routing = getRoutingBySeq(seq);
    if (!routing || !routing.channel_type || !routing.platform_id) {
      return err(`Cannot determine destination for message #${seq}`);
    }

    const id = generateId();
    writeMessageOut({
      id,
      kind: 'chat',
      platform_id: routing.platform_id,
      channel_type: routing.channel_type,
      thread_id: routing.thread_id,
      content: JSON.stringify({ operation: 'reaction', messageId: platformId, emoji }),
    });

    log(`add_reaction: #${seq} → ${emoji} on ${platformId}`);
    return ok(`Reaction queued for #${seq}`);
  },
};

registerTools([sendMessage, sendFile, editMessage, addReaction]);
