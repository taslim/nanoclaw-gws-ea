/**
 * Destination map — lives in inbound.db's `destinations` table.
 *
 * The host writes this table before every container wake AND on demand
 * (e.g. when a new child agent is created mid-session). The container
 * queries the table live on every lookup, so admin changes take effect
 * immediately — no restart required.
 *
 * This table is BOTH the routing map and the container-visible ACL.
 * The host re-validates on the delivery side against the central DB,
 * so even if this table is stale the host's enforcement is authoritative.
 */
import { getInboundDb } from './db/connection.js';
import { isPrincipalSurface } from './principal-surfaces.js';

export type DestinationKind = 'chat' | 'email';

export interface DestinationEntry {
  name: string;
  displayName: string;
  type: 'channel' | 'agent';
  kind: DestinationKind;
  channelType?: string;
  platformId?: string;
  agentGroupId?: string;
}

interface DestRow {
  name: string;
  display_name: string | null;
  type: 'channel' | 'agent';
  channel_type: string | null;
  platform_id: string | null;
  agent_group_id: string | null;
  kind: string | null;
}

function rowToEntry(row: DestRow): DestinationEntry {
  return {
    name: row.name,
    displayName: row.display_name ?? row.name,
    type: row.type,
    kind: row.kind === 'email' ? 'email' : 'chat',
    channelType: row.channel_type ?? undefined,
    platformId: row.platform_id ?? undefined,
    agentGroupId: row.agent_group_id ?? undefined,
  };
}

export function getAllDestinations(): DestinationEntry[] {
  const rows = getInboundDb().prepare('SELECT * FROM destinations ORDER BY name').all() as DestRow[];
  return rows.map(rowToEntry);
}

export function findByName(name: string): DestinationEntry | undefined {
  const row = getInboundDb().prepare('SELECT * FROM destinations WHERE name = ?').get(name) as DestRow | undefined;
  return row ? rowToEntry(row) : undefined;
}

/**
 * Reverse lookup: given routing fields from an inbound message, find
 * which destination they correspond to (what does this agent call the sender?).
 */
export function findByRouting(
  channelType: string | null | undefined,
  platformId: string | null | undefined,
): DestinationEntry | undefined {
  if (!channelType || !platformId) return undefined;
  const db = getInboundDb();
  const row =
    channelType === 'agent'
      ? (db
          .prepare("SELECT * FROM destinations WHERE type = 'agent' AND agent_group_id = ?")
          .get(platformId) as DestRow | undefined)
      : (db
          .prepare("SELECT * FROM destinations WHERE type = 'channel' AND channel_type = ? AND platform_id = ?")
          .get(channelType, platformId) as DestRow | undefined);
  return row ? rowToEntry(row) : undefined;
}

/**
 * Generate the system-prompt addendum: agent identity + destination map.
 *
 * Identity is injected here (not in the shared CLAUDE.md) because it's
 * per-agent-group and changes when the operator renames an agent, while
 * the shared base is identical across all agents.
 */
export function buildSystemPromptAddendum(assistantName?: string): string {
  const sections: string[] = [];

  if (assistantName) {
    sections.push(['# You are ' + assistantName, '', `Your name is **${assistantName}**. Use it when the channel asks who you are, when introducing yourself, and when signing any message that explicitly calls for a signature.`].join('\n'));
  }

  sections.push(buildDestinationsSection());

  return sections.join('\n\n');
}

function buildDestinationsSection(): string {
  const all = getAllDestinations();

  if (all.length === 0) {
    return [
      '## Sending messages',
      '',
      'You currently have no configured destinations. You cannot send messages until an admin wires one up.',
    ].join('\n');
  }

  const hasEmail = all.some((d) => d.kind === 'email');
  const hasPrincipalSurface = all.some((d) => isPrincipalSurface(d.name));

  const lines = ['## Sending messages', ''];
  if (all.length === 1) {
    const d = all[0];
    const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
    const kindTag = hasEmail && d.kind === 'email' ? ' `[email]`' : '';
    lines.push(`Your destination is \`${d.name}\`${label}${kindTag}.`);
  } else {
    lines.push('You can send messages to the following destinations:', '');
    for (const d of all) {
      const label = d.displayName && d.displayName !== d.name ? ` (${d.displayName})` : '';
      const kindTag = hasEmail && d.kind === 'email' ? ' `[email]`' : '';
      lines.push(`- \`${d.name}\`${label}${kindTag}`);
    }
  }
  lines.push('');
  lines.push(
    'Wrap each delivered message in a `<message to="name">…</message>` block; include several blocks in one response to address several destinations. `<internal>…</internal>` marks thinking you don\'t want sent.',
  );
  if (hasEmail) {
    lines.push('');
    lines.push(
      '**Email destinations** (marked `[email]`): write proper emails to the recipient. No chat-style acknowledgments ("noted", "will do"), no narration, no third-person references to the recipient — if you\'re writing *about* the sender rather than *to* them, you have the wrong destination. Status updates belong on a chat destination (e.g. `principal`) or in `<internal>`, never as an email reply.',
    );
    lines.push('');
    lines.push(
      'For a plain reply on the inbound email thread (derived To/Cc/Subject), use a `<message to="…">` block — that\'s the simplest path. For structured email sends — composing a new thread, overriding the To/Cc/Subject on a reply, emailing from a non-email session — use the `send_email` MCP tool.',
    );
    lines.push('');
    lines.push(
      'Email destinations receive **one** message per turn. Don\'t call `send_email` mid-turn for an ack and then send substance later — combine into one substantive send at the end of your work.',
    );
  }
  lines.push('');
  lines.push(
    'When replying to an incoming message, default to addressing the destination it came `from` (every inbound `<message>` tag carries a `from="name"` attribute). Pick a different destination when the request asks for it (e.g., "tell Laura that…").',
  );
  lines.push('');
  lines.push(
    'The `send_message` MCP tool is for **chat-surface** mid-turn sends — a quick acknowledgment ("on it") before a slow tool call, or a heads-up while you keep working. Each `send_message` call and each final-response `<message>` block lands as its own message in the conversation, so they read as a sequence. Verbatim duplicates of a mid-turn send are dropped from the final response — don\'t repeat yourself across paths.',
  );
  if (hasPrincipalSurface) {
    lines.push('');
    lines.push(
      '**Notifying your principal across channels.** When you surface something from a session your principal didn\'t start by speaking to you on that surface — a sweep finding, a scheduled task, an escalation — you classify the *information* and the host owns *routing and loudness*. Emit a `<message priority="urgent|attention|awareness">…</message>` block. Don\'t pick a destination and don\'t decide whether it pings — the priority does:',
    );
    lines.push('');
    lines.push('- `priority="urgent"` — interrupt now (~within 2h): safety/reputation, time-critical logistics, a decision that genuinely can\'t wait. Lands as a DM ping.');
    lines.push('- `priority="attention"` — look soon, not now: e.g. a meeting-prep brief 30–60 min before a tier-1 meeting. Lands in the heartbeat space and pings.');
    lines.push('- `priority="awareness"` — passive log the principal reads on their terms: handled-autonomously actions, FYIs, "no action needed". Lands silently. **This is the default — if unsure, use it.** Under-notifying is recoverable; over-notifying is not.');
    lines.push('');
    lines.push(
      'A `priority` block carries no `to=` (the two are mutually exclusive). A decision that can *wait* is not a priority — escalate the matter instead, and the morning brief surfaces it. This applies *only* to cross-channel notifications: a direct reply inside the conversation you\'re already in (someone DMs you → you reply in that DM; an inbound email → you reply on the thread) is plain `<message to="…">` delivery, never priority.',
    );
  }
  return lines.join('\n');
}
