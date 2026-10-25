/**
 * How a request reads where it is posted. Every request comes from the
 * assistant, so it speaks in the first person. What the host holds (the exact
 * packages or command, a sender's id) comes first; text someone else supplied
 * (a display name, a conversation's name, a reason an agent gave) appears only
 * as one quoted line. The quoting is upstream's (`quoteForCard`); a channel
 * escapes its own mention and link markup on every request it posts (Google
 * Chat: gws-ea-chat's `escapeCardText`).
 */
import { quoteForCard } from '../../card-text.js';
import { getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import type { MessagingGroup } from '../../types.js';
import { cap } from '../gws-ea-inbox/untrusted.js';
import type { RequestDetails } from './request-context.js';

export const NAME_LIMIT = 80;
export const REASON_LIMIT = 200;

/** Whitespace, control characters, and line and paragraph separators. */
const BREAKS = /[\s\p{Cc}\p{Zl}\p{Zp}]+/gu;

/**
 * Someone else's text as a request shows it: on one line, at most `limit`
 * characters, as `quoteForCard` quotes it, with invisible and direction
 * characters shown as \uXXXX escapes and no character reference or Markdown
 * link left to decode. Its own double quotes become single ones first:
 * Markdown, which a text request is posted as, turns the escaped quote back
 * into one that would close the quotes around it.
 */
export function quoted(text: string, limit: number): string {
  return quoteForCard(cap(text.replace(BREAKS, ' ').trim(), limit).replace(/["“”]/gu, "'"));
}

export function describeSender(
  id: string | null | undefined,
  name: string | null | undefined,
  unknown: string,
): string {
  const shown = name ? quoted(name, NAME_LIMIT) : undefined;
  if (!id) return shown ?? unknown;
  return shown ? `${id} (${shown})` : id;
}

function conversationKind(mg: MessagingGroup): string {
  return `a ${mg.is_group ? 'group conversation' : 'direct message'} on ${mg.channel_type}`;
}

function conversationName(mg: MessagingGroup): string {
  return mg.name ? `${quoted(mg.name, NAME_LIMIT)} on ${mg.channel_type}` : conversationKind(mg);
}

export interface RequestOrigin {
  /** The line the request ends with. */
  readonly line: string;
  /** The same, as fields of the request's context note. */
  readonly details: RequestDetails;
}

/**
 * Where a request comes from, when it is posted in a conversation the asking
 * agent does not work in. To the person answering, every request comes from
 * the same assistant: one from `main` lands in main's own DM and needs no
 * introduction, while one a group space's agent raises says which space it is
 * for. `from` is the conversation the asking session serves, if any.
 * Undefined when the request is posted in that conversation, or the asking
 * agent works there too (main's one session may have been started by an
 * email, yet main answers in the DM).
 */
export async function requestOrigin(
  agentGroupId: string,
  from: MessagingGroup | undefined,
  posted: MessagingGroup,
  originLine?: string,
): Promise<RequestOrigin | undefined> {
  if (originLine !== undefined) return { line: originLine, details: { facts: { asked_from: originLine } } };
  if (from?.id === posted.id || (await getMessagingGroupAgentByPair(posted.id, agentGroupId))) return undefined;
  if (!from) {
    return {
      line: "I'm asking for work of mine that isn't in any conversation.",
      details: { facts: { asked_from: 'outside any conversation' } },
    };
  }
  return {
    line: `I'm asking for my work in ${conversationName(from)}.`,
    details: {
      facts: { asked_from: conversationKind(from) },
      supplied: from.name ? { asked_from_name: { text: from.name, source: from.channel_type } } : undefined,
    },
  };
}
