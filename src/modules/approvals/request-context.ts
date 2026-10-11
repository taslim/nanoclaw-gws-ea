/**
 * Requests in the agent's context (R10, KTD10). A request the host posts into
 * a conversation (an approval, a new sender, a new channel) is a message there
 * from the assistant's own account, which the agent working in that
 * conversation would otherwise never see. So when one is posted, and when it
 * is answered or ends, a note goes into the session that conversation already
 * has, as context (trigger=0): it wakes nothing, and with no session there is
 * no note and no session is made.
 *
 * A note holds the request as fields: what the host holds as it is, and text
 * someone else supplied (a display name, a conversation's name, a reason an
 * agent gave) marked untrusted. Never the request as shown, whose quoted
 * names are not marked, and never its payload, which may hold secrets.
 *
 * Notes are written, not routed: a note has no sender, and the router's quiet
 * path admits only a sender with access. A note that cannot be written is
 * logged, and the request stands.
 */
import { randomUUID } from 'node:crypto';

import type { NormalizedOption } from '../../channels/ask-question.js';
import { resolveThreadPolicy } from '../../channels/channel-defaults.js';
import { getChannelAdapter, getChannelDefaults } from '../../channels/channel-registry.js';
import { getMessagingGroupAgents, getMessagingGroupByPlatform } from '../../db/messaging-groups.js';
import { log } from '../../log.js';
import { findSession, writeSessionMessage } from '../../session-manager.js';
import type { MessagingGroup, MessagingGroupAgent, Session } from '../../types.js';
import { untrustedLine } from '../gws-ea-inbox/untrusted.js';

/** The longest text someone else supplied that a note keeps. */
const SUPPLIED_LIMIT = 200;

/** The conversation a request was posted in, as its delivery addressed it. */
export interface RequestConversation {
  readonly channelType: string;
  readonly platformId: string;
  /** The adapter instance it went through; absent or null is the channel's default. */
  readonly instance?: string | null;
  readonly threadId: string | null;
}

/** Text someone other than the host supplied, and where it came from. */
export interface SuppliedText {
  readonly text: string;
  /** Named in its untrusted marker: the channel a name came from, or `agent` for an agent's words. */
  readonly source: string;
}

/** What a note says about a request beyond its title and answers. */
export interface RequestDetails {
  /** What the host holds: the exact packages or command, the gateway request, a sender's id. */
  readonly facts?: Readonly<Record<string, string | readonly string[]>>;
  /** Text someone else supplied, by what it is, each marked untrusted. */
  readonly supplied?: Readonly<Record<string, SuppliedText>>;
}

/** Details from several sources (the request, where it came from), as one. */
export function combineDetails(...parts: ReadonlyArray<RequestDetails | undefined>): RequestDetails {
  const facts: Record<string, string | readonly string[]> = {};
  const supplied: Record<string, SuppliedText> = {};
  for (const part of parts) {
    Object.assign(facts, part?.facts);
    Object.assign(supplied, part?.supplied);
  }
  return { facts, supplied };
}

export interface PostedRequest {
  /** The question id it was posted under. */
  readonly id: string;
  /** What it is about: an approval's action, or the flow that raised it. */
  readonly about: string;
  readonly title: string;
  readonly options: readonly NormalizedOption[];
  /** Who answers it. */
  readonly answerFrom: string;
  readonly details?: RequestDetails;
}

export interface RequestOutcome {
  readonly id: string;
  readonly about: string;
  readonly title: string;
  /** As the request shows it: the option chosen, or how it ended. */
  readonly outcome: string;
  /** The reason the answer gave. */
  readonly reason?: string;
}

/** Note a request posted in `conversation`, in that conversation's session. */
export function recordRequestPosted(conversation: RequestConversation, request: PostedRequest): Promise<void> {
  return writeNote(
    conversation,
    request.id,
    'A request was posted in this conversation as your message, and waits for an answer:',
    {
      request: request.id,
      about: request.about,
      title: request.title,
      answer_from: request.answerFrom,
      answers: request.options.map((option) => option.label),
      details: detailFields(request.details),
    },
  );
}

/** Note how a request posted in `conversation` was answered or ended, in that conversation's session. */
export function recordRequestOutcome(conversation: RequestConversation, outcome: RequestOutcome): Promise<void> {
  return writeNote(conversation, outcome.id, 'A request posted in this conversation as your message has its outcome:', {
    request: outcome.id,
    about: outcome.about,
    title: outcome.title,
    outcome: outcome.outcome,
    ...(outcome.reason ? { reason: outcome.reason } : {}),
  });
}

function detailFields(details: RequestDetails | undefined): Record<string, string | readonly string[]> {
  const fields: Record<string, string | readonly string[]> = { ...details?.facts };
  for (const [name, supplied] of Object.entries(details?.supplied ?? {})) {
    fields[name] = untrustedLine(supplied.text, SUPPLIED_LIMIT, supplied.source);
  }
  return fields;
}

async function writeNote(
  conversation: RequestConversation,
  requestId: string,
  lead: string,
  fields: Record<string, unknown>,
): Promise<void> {
  try {
    const mg = await getMessagingGroupByPlatform(
      conversation.channelType,
      conversation.platformId,
      conversation.instance ?? undefined,
    );
    if (!mg) return;
    const text = `${lead}\n${JSON.stringify(fields)}`;
    for (const wiring of await getMessagingGroupAgents(mg.id)) {
      const found = await conversationSession(mg, wiring, conversation.threadId);
      if (!found) continue;
      await writeSessionMessage(found.session.agent_group_id, found.session.id, {
        id: `request-note-${randomUUID()}`,
        kind: 'chat',
        timestamp: new Date().toISOString(),
        platformId: mg.platform_id,
        channelType: mg.channel_type,
        threadId: found.threadId,
        content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
        trigger: false,
      });
    }
    // eslint-disable-next-line no-catch-all/no-catch-all -- a note is the agent's context; the request stands without it
  } catch (err) {
    log.warn('A request could not be noted in its conversation', { requestId, err });
  }
}

/**
 * The session a wired agent already has for this conversation, found as the
 * router finds the session a message there would reach: the wiring's thread
 * policy decides the thread, and an agent-shared wiring has one session for
 * the agent, whichever conversation started it.
 */
async function conversationSession(
  mg: MessagingGroup,
  wiring: MessagingGroupAgent,
  threadId: string | null,
): Promise<{ session: Session; threadId: string | null } | undefined> {
  const key = mg.instance ?? mg.channel_type;
  const threads = resolveThreadPolicy(
    wiring.threads ?? null,
    getChannelDefaults(key, mg.channel_type),
    mg.is_group === 1,
    getChannelAdapter(key)?.supportsThreads === true,
  );
  const thread = threads ? threadId : null;
  const mode =
    threads && wiring.session_mode !== 'agent-shared' && mg.is_group !== 0 ? 'per-thread' : wiring.session_mode;
  const session = await findSession(wiring.agent_group_id, mg.id, thread, mode);
  return session ? { session, threadId: thread } : undefined;
}
