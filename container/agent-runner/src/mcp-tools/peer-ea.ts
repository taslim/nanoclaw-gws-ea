// Thin envelope: emits a system action and returns synchronously. The
// host-side handler in src/modules/permissions/peer-ea.ts does the
// structural work; the new peer agent then sends the intro itself by
// waking on the seeded task. Trust gate (`availableToTrust: ['known']`)
// IS the authorization — the principal is in conversation when this
// fires, so no approval card.
import { writeMessageOut } from '../db/messages-out.js';
import { getSessionRouting } from '../db/session-routing.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

function ok(text: string) {
  return { content: [{ type: 'text' as const, text }] };
}

function err(text: string) {
  return { content: [{ type: 'text' as const, text: `Error: ${text}` }], isError: true };
}

function generateId(): string {
  return `setup-peer-ea-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

export const setupPeerEa: McpToolDefinition = {
  tool: {
    name: 'setup_peer_ea',
    description:
      `Set up a coordination relationship with another principal's executive assistant — a "peer EA." Use when the principal asks you to connect with someone else's EA. Creates a new peer-EA agent group on this NanoClaw, opens a 1:1 DM with the peer EA on the chosen channel, wires it with constrained tooling, and queues an introductory message that the new agent group sends itself.\n\nGather the four params from the principal conversationally — ask for whatever's missing before invoking. The peerPrincipal name and the relationship are in your principal's frame: if the principal says "X is my wife", pass peerPrincipal="X", relationship="wife".\n\nAfter the tool returns, the new peer agent group will reach out automatically. Confirm to the principal that the setup is in flight; they'll see the destination once it's registered.`,
    inputSchema: {
      type: 'object' as const,
      properties: {
        peerName: {
          type: 'string',
          description: 'Display name of the peer EA.',
        },
        peerHandle: {
          type: 'string',
          description:
            "Reachable handle on the channel. For GChat (default channel), this is the peer EA's email address — DWD impersonation resolves it through openDM. For other channels, the channel-native handle.",
        },
        peerPrincipal: {
          type: 'string',
          description: "Name of the peer EA's principal.",
        },
        relationship: {
          type: 'string',
          description:
            'Your principal\'s relationship to the peer\'s principal, in your principal\'s frame (e.g. "wife", "business partner", "sister"). Sentences like "X is my wife" become relationship="wife".',
        },
        channelType: {
          type: 'string',
          description: "Channel to open the DM on. Defaults to 'gchat' if omitted.",
        },
      },
      required: ['peerName', 'peerHandle', 'peerPrincipal', 'relationship'],
    },
  },
  availableToTrust: ['known'],
  async handler(args) {
    const peerName = typeof args.peerName === 'string' ? args.peerName.trim() : '';
    const peerHandle = typeof args.peerHandle === 'string' ? args.peerHandle.trim() : '';
    const peerPrincipal = typeof args.peerPrincipal === 'string' ? args.peerPrincipal.trim() : '';
    const relationship = typeof args.relationship === 'string' ? args.relationship.trim() : '';
    const channelType =
      typeof args.channelType === 'string' && args.channelType.trim() ? args.channelType.trim() : 'gchat';

    if (!peerName) return err('peerName is required');
    if (!peerHandle) return err('peerHandle is required');
    if (!peerPrincipal) return err('peerPrincipal is required');
    if (!relationship) return err('relationship is required');

    const id = generateId();
    const r = getSessionRouting();
    writeMessageOut({
      id,
      kind: 'system',
      platform_id: r.platform_id,
      channel_type: r.channel_type,
      thread_id: r.thread_id,
      content: JSON.stringify({
        action: 'setup_peer_ea',
        peerName,
        peerHandle,
        peerPrincipal,
        relationship,
        channelType,
      }),
    });

    log(`setup_peer_ea: ${peerName} (${peerHandle}) on ${channelType}, principal=${peerPrincipal}`);
    return ok(
      `Peer-EA setup submitted for ${peerName} on ${channelType}. The new peer agent group will be created and will send the introductory message to ${peerName} shortly.`,
    );
  },
};

registerTools([setupPeerEa]);
