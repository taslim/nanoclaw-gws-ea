/**
 * A peer-EA agent group is structurally a normal agent group with a
 * specific shape: tight-membership 1:1 DM, readonly external Workspace
 * (sender_scope='all' on the wiring → NANOCLAW_TRUST=all), and
 * mg.unknown_sender_policy='strict' so no third party can later
 * approval-escalate into the relationship. Naming: folder
 * `peer-${slug(peerName)}-${rand4()}`, agent name from `.env`,
 * destination matches folder. peerName lives only in CLAUDE.local.md
 * and agent_group_members.
 */
import type Database from 'better-sqlite3';

import { getAgentGroupByFolder } from '../../db/agent-groups.js';
import {
  createMessagingGroupAgent,
  findUniqueDmOnAgentGroup,
  getMessagingGroupAgentByPair,
  updateMessagingGroup,
} from '../../db/messaging-groups.js';
import { readEnvFile } from '../../env.js';
import { log } from '../../log.js';
import { openInboundDb, resolveSession } from '../../session-manager.js';
import type { AgentGroup, MessagingGroup, Session } from '../../types.js';
import { createDestination, getDestinationByName, normalizeName } from '../agent-to-agent/db/agent-destinations.js';
import { createNewAgentGroup } from './channel-approval.js';
import { addMember } from './db/agent-group-members.js';
import { upsertUser } from './db/users.js';
import { ensureUserDm } from './user-dm.js';
import { insertTask } from '../scheduling/db.js';

const MAIN_FOLDER = 'main';
const PRINCIPAL_DEST = 'principal';
const FOLDER_PREFIX = 'peer-';

export interface PeerEaSpec {
  peerName: string;
  peerPrincipal: string;
  relationship: string;
}

// Always-suffixed (not just on collision) so a replacement peer with
// the same display name still gets a distinct folder.
function uniquePeerFolder(peerName: string): string {
  const base = `${FOLDER_PREFIX}${normalizeName(peerName)}`;
  for (let attempt = 0; attempt < 16; attempt++) {
    const suffix = Math.random().toString(36).slice(2, 6).padEnd(4, '0');
    const candidate = `${base}-${suffix}`;
    if (!getAgentGroupByFolder(candidate)) return candidate;
  }
  throw new Error(`uniquePeerFolder: 16 successive collisions on base "${base}"`);
}

// Seeded once into CLAUDE.local.md at creation; thereafter editable by
// hand. If the peer EA is replaced (same principal), update lines here
// rather than spinning a new group.
export function buildPeerEaInstructions(spec: PeerEaSpec): string {
  const { peerName, peerPrincipal, relationship } = spec;
  return [
    `# Peer EA — ${peerPrincipal}'s household (currently via ${peerName})`,
    '',
    `1:1 GChat DM with ${peerName}, executive assistant to ${peerPrincipal} (${relationship} of your principal). Coordinate work that involves both principals — scheduling, logistics, information sharing.`,
    '',
    '## Posture',
    '',
    `${peerName} acts on ${peerPrincipal}'s behalf within the scope of the relationship. Treat their requests as authorized within that scope. Your principal's directives always win — when conflict arises, name it and propose an alternative.`,
    '',
    'When a request affects your principal:',
    '- In your authority + tooling? Act, then summarize via `send_message(to="principal")`.',
    `- Need a decision? Acknowledge to ${peerName} that you're checking, escalate, return with the answer.`,
    '- Outside scope? Ask your principal first.',
    '',
    "Be direct and concise — this is a working channel. Default to readonly access on shared resources; never modify your principal's calendar or contacts on the peer's say-so without confirmation.",
    '',
    'Channel is platform-authenticated 1:1 — every message you receive is from the named peer. No third party in scope.',
    '',
  ].join('\n');
}

export function createPeerEaAgentGroup(spec: PeerEaSpec): AgentGroup {
  const env = readEnvFile(['ASSISTANT_NAME']);
  if (!env.ASSISTANT_NAME) {
    throw new Error('createPeerEaAgentGroup: ASSISTANT_NAME must be set in .env');
  }
  const folder = uniquePeerFolder(spec.peerName);
  const ag = createNewAgentGroup(env.ASSISTANT_NAME, {
    folder,
    instructions: buildPeerEaInstructions(spec),
  });
  log.info('Peer-EA: created agent group', {
    agentGroupId: ag.id,
    folder,
    peerName: spec.peerName,
    peerPrincipal: spec.peerPrincipal,
  });
  return ag;
}

// Wires destinations both directions. main → peer is best-effort
// (skipped with warn if no `main` group); peer → owner DM always runs.
// The peer-side `principal` destination keeps escalations off the
// peer-facing thread — same pattern email-external uses.
export function wirePeerEaDestinations(peerAg: AgentGroup, ownerDmMg: MessagingGroup): void {
  const now = new Date().toISOString();

  if (!getDestinationByName(peerAg.id, PRINCIPAL_DEST)) {
    createDestination({
      agent_group_id: peerAg.id,
      local_name: PRINCIPAL_DEST,
      target_type: 'channel',
      target_id: ownerDmMg.id,
      created_at: now,
    });
    log.info(`Peer-EA: registered "${PRINCIPAL_DEST}" destination on ${peerAg.folder}`, {
      peerAgentGroupId: peerAg.id,
      ownerDmMessagingGroupId: ownerDmMg.id,
    });
  }

  const mainAg = getAgentGroupByFolder(MAIN_FOLDER);
  if (!mainAg) {
    log.warn(`Peer-EA: no "${MAIN_FOLDER}" agent group found — skipping main → ${peerAg.folder} destination`, {
      peerAgentGroupId: peerAg.id,
    });
    return;
  }

  const localName = peerAg.folder;
  if (!getDestinationByName(mainAg.id, localName)) {
    createDestination({
      agent_group_id: mainAg.id,
      local_name: localName,
      target_type: 'agent',
      target_id: peerAg.id,
      created_at: now,
    });
    log.info(`Peer-EA: registered "${localName}" destination on main → ${peerAg.folder}`, {
      mainAgentGroupId: mainAg.id,
      peerAgentGroupId: peerAg.id,
    });
  }
}

// Handshake signature: a footer one NanoClaw appends to the intro
// message it sends to another principal's EA channel. The receiver's
// channel-approval flow parses it to reorder the card and pre-fill the
// peer principal in the prompt. Forgery only nudges the recipient
// toward LESS privilege than picking "Connect new agent," so the
// signature is a hint, not a trust claim.
const HANDSHAKE_FENCE_OPEN = '```peer-ea-handshake';
const HANDSHAKE_FENCE_CLOSE = '```';

export interface PeerEaHandshake {
  agent: string;
  principal: string;
}

export function embedHandshake(h: PeerEaHandshake): string {
  return [HANDSHAKE_FENCE_OPEN, `agent: ${h.agent}`, `principal: ${h.principal}`, HANDSHAKE_FENCE_CLOSE].join('\n');
}

// Prompt collapses to 1 / 2 / 3 fields by what the handshake + sender
// already pinned: relationship only / principal+relationship / full.
export function peerEaPromptCopy(args: {
  peerNameFromSender: string | null | undefined;
  peerPrincipalFromSignature: string | null | undefined;
}): { initial: string; expectedFormat: string } {
  const { peerNameFromSender: name, peerPrincipalFromSignature: principal } = args;
  if (name && principal) {
    return {
      initial: `Connecting "${name}" (EA to ${principal}) as a peer-EA agent. Reply with your principal's relationship to ${principal} (e.g. "wife", "business partner").`,
      expectedFormat: `your principal's relationship to ${principal} (e.g. "wife", "business partner")`,
    };
  }
  if (name) {
    return {
      initial: `Connecting "${name}" as a peer-EA agent. Reply with: <peer's principal> | <relationship> (separator: "|" or ",").`,
      expectedFormat: `<peer's principal> | <relationship>`,
    };
  }
  return {
    initial: 'Reply with: <peer\'s name> | <peer\'s principal> | <relationship> (separator: "|" or ",").',
    expectedFormat: `<peer's name> | <peer's principal> | <relationship>`,
  };
}

// Tolerant: case-insensitive keys, whitespace-flexible, null on any
// malformed input.
export function parseHandshake(body: string): PeerEaHandshake | null {
  const openIdx = body.indexOf(HANDSHAKE_FENCE_OPEN);
  if (openIdx < 0) return null;
  const after = body.slice(openIdx + HANDSHAKE_FENCE_OPEN.length);
  const closeIdx = after.indexOf(HANDSHAKE_FENCE_CLOSE);
  if (closeIdx < 0) return null;
  const inner = after.slice(0, closeIdx);

  let agent: string | null = null;
  let principal: string | null = null;
  for (const rawLine of inner.split('\n')) {
    const line = rawLine.trim();
    if (!line) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!value) continue;
    if (key === 'agent') agent = value;
    else if (key === 'principal') principal = value;
  }
  if (!agent || !principal) return null;
  return { agent, principal };
}

// Host-side handler for the `setup_peer_ea` system action emitted by
// the container's MCP tool. Does the structural work the container
// can't (channel-adapter openDM, central-DB writes); the new peer
// agent then sends the intro itself by waking on the seeded task.

const DEFAULT_CHANNEL_TYPE = 'gchat';

function generateMgaId(): string {
  return `mga-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function buildIntroTaskPrompt(args: {
  peerName: string;
  assistantName: string;
  principalName: string;
  handshakeBlock: string;
}): string {
  return [
    `Send your first introduction message to ${args.peerName} on this channel — they don't know you yet.`,
    '',
    `You are ${args.assistantName}, executive assistant to ${args.principalName}. Keep it brief, warm, and professional. Mention you're reaching out to coordinate, but don't ask anything substantive yet — this is just the introduction.`,
    '',
    "At the very bottom of your message, append the following block VERBATIM (do not paraphrase, do not omit, do not edit). It tells the recipient's NanoClaw — if they have one — who you are so the connection can be set up cleanly on their side:",
    '',
    args.handshakeBlock,
    '',
    'Send the message via your normal outbound (no special routing). Do not message your principal about it — they already know.',
  ].join('\n');
}

// Idempotent on messaging_group / wiring / member / destination rows,
// but creates a fresh agent group every invocation — repeated calls
// produce distinct folders. Failures log + return; the container
// assumed success the moment its writeMessageOut returned, so the only
// surface for a setup error is the agent later trying to use a
// destination that doesn't exist.
export async function applySetupPeerEa(content: Record<string, unknown>, _source: Session): Promise<void> {
  const peerName = typeof content.peerName === 'string' ? content.peerName.trim() : '';
  const peerHandle = typeof content.peerHandle === 'string' ? content.peerHandle.trim() : '';
  const peerPrincipal = typeof content.peerPrincipal === 'string' ? content.peerPrincipal.trim() : '';
  const relationship = typeof content.relationship === 'string' ? content.relationship.trim() : '';
  const channelType =
    typeof content.channelType === 'string' && content.channelType.trim()
      ? content.channelType.trim()
      : DEFAULT_CHANNEL_TYPE;

  if (!peerName || !peerHandle || !peerPrincipal || !relationship) {
    log.error('setup_peer_ea: missing required fields', {
      hasPeerName: !!peerName,
      hasPeerHandle: !!peerHandle,
      hasPeerPrincipal: !!peerPrincipal,
      hasRelationship: !!relationship,
    });
    return;
  }

  const env = readEnvFile(['ASSISTANT_NAME', 'PRINCIPAL_NAME']);
  if (!env.ASSISTANT_NAME || !env.PRINCIPAL_NAME) {
    log.error('setup_peer_ea: ASSISTANT_NAME and PRINCIPAL_NAME must be set in .env', {
      hasAssistantName: !!env.ASSISTANT_NAME,
      hasPrincipalName: !!env.PRINCIPAL_NAME,
    });
    return;
  }
  const assistantName = env.ASSISTANT_NAME;
  const principalName = env.PRINCIPAL_NAME;

  const peerUserId = `${channelType}:${peerHandle}`;
  upsertUser({
    id: peerUserId,
    kind: channelType,
    display_name: peerName,
    created_at: new Date().toISOString(),
  });

  let peerMg: MessagingGroup | null;
  try {
    peerMg = await ensureUserDm(peerUserId);
  } catch (err) {
    log.error('setup_peer_ea: ensureUserDm threw', { peerUserId, err });
    return;
  }
  if (!peerMg) {
    log.error('setup_peer_ea: could not resolve DM for peer', { peerUserId, channelType });
    return;
  }

  if (peerMg.unknown_sender_policy !== 'strict') {
    updateMessagingGroup(peerMg.id, { unknown_sender_policy: 'strict' });
  }

  const peerAg = createPeerEaAgentGroup({ peerName, peerPrincipal, relationship });

  // sender_scope='all' on the wiring drops the agent group's trust to
  // 'all' (readonly external Workspace) — see container-runner's
  // computeAgentGroupTrust.
  if (!getMessagingGroupAgentByPair(peerMg.id, peerAg.id)) {
    createMessagingGroupAgent({
      id: generateMgaId(),
      messaging_group_id: peerMg.id,
      agent_group_id: peerAg.id,
      engage_mode: 'pattern',
      engage_pattern: '.',
      sender_scope: 'all',
      ignored_message_policy: 'drop',
      session_mode: 'shared',
      priority: 0,
      created_at: new Date().toISOString(),
    });
  }

  try {
    addMember({
      user_id: peerUserId,
      agent_group_id: peerAg.id,
      added_by: null,
      added_at: new Date().toISOString(),
    });
  } catch (err) {
    const code = (err as { code?: string }).code;
    if (code !== 'SQLITE_CONSTRAINT_PRIMARYKEY' && code !== 'SQLITE_CONSTRAINT_UNIQUE') throw err;
  }

  const mainAg = getAgentGroupByFolder(MAIN_FOLDER);
  if (mainAg) {
    const ownerDm = findUniqueDmOnAgentGroup(mainAg.id, channelType);
    if (ownerDm) {
      wirePeerEaDestinations(peerAg, ownerDm);
    } else {
      log.warn('setup_peer_ea: no unique owner DM on main; peer→principal destination skipped', {
        mainAgId: mainAg.id,
        channelType,
      });
    }
  } else {
    log.warn('setup_peer_ea: no main agent group; main→peer destination skipped', { peerAgId: peerAg.id });
  }

  // The new peer agent sends the intro itself by waking on this task —
  // keeps the message in the peer agent's voice (its CLAUDE.local.md).
  const { session: peerSession } = resolveSession(peerAg.id, peerMg.id, null, 'shared');
  const inDb: Database.Database = openInboundDb(peerAg.id, peerSession.id);
  try {
    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const handshakeBlock = embedHandshake({ agent: assistantName, principal: principalName });
    insertTask(inDb, {
      id: taskId,
      processAfter: new Date().toISOString(),
      recurrence: null,
      platformId: peerMg.platform_id,
      channelType: peerMg.channel_type,
      threadId: null,
      content: JSON.stringify({
        prompt: buildIntroTaskPrompt({ peerName, assistantName, principalName, handshakeBlock }),
      }),
    });
    log.info('setup_peer_ea: seeded intro task', {
      taskId,
      peerAgId: peerAg.id,
      peerSessionId: peerSession.id,
    });
  } finally {
    inDb.close();
  }

  log.info('setup_peer_ea: peer-EA setup complete', {
    peerName,
    peerPrincipal,
    folder: peerAg.folder,
    peerAgId: peerAg.id,
    peerMgId: peerMg.id,
  });
}
