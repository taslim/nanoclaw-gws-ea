/**
 * How a request reads where it is posted (R7, KTD14). Every request comes
 * from the assistant, so it speaks in the first person. What the host holds
 * (the exact packages or command, a sender's id) comes first; text someone
 * else supplied (a display name, a conversation's name, a reason an agent
 * gave) appears only as one quoted line that cannot mention anyone or carry a
 * link of its own. The rules are the same on every channel.
 */
import { getMessagingGroupAgentByPair } from '../../db/messaging-groups.js';
import type { MessagingGroup } from '../../types.js';
import { cap } from '../gws-ea-inbox/untrusted.js';
import type { RequestDetails } from './request-context.js';

/** The longest name (a person's, a conversation's) a request quotes. */
export const NAME_LIMIT = 80;
/** The longest reason a request quotes. */
export const REASON_LIMIT = 200;

/** Format characters (direction overrides, zero-width spaces), except the joiner emoji sequences are built with. */
const FORMAT_CHARACTERS = /(?!\u200d)\p{Cf}/gu;
/** Whitespace, control characters, and line and paragraph separators. */
const BREAKS = /[\s\p{Cc}\p{Zl}\p{Zp}]+/gu;
/** Markdown that would format the text or make a link of it, escaped so it shows as written. */
const MARKDOWN = /[\\`*_~[\]()]/gu;

/**
 * Someone else's text as a request shows it: on one line, at most `limit`
 * characters, in double quotes it cannot close. `<` and `>` become `‹` and
 * `›`, so it cannot mention anyone (`<users/…>`) or make a link
 * (`<url|text>`), and Markdown is escaped, so it cannot format itself or
 * link (`[text](url)`).
 */
export function quoted(text: string, limit: number): string {
  const line = text.replace(FORMAT_CHARACTERS, '').replace(BREAKS, ' ').trim();
  const shown = cap(line, limit)
    .replace(/["“”]/gu, "'")
    .replace(/</gu, '‹')
    .replace(/>/gu, '›')
    .replace(MARKDOWN, '\\$&');
  return `"${shown}"`;
}

/** Whoever wrote: their id, as the host holds it, first, then the name they go by, quoted; `unknown` with neither. */
export function describeSender(
  id: string | null | undefined,
  name: string | null | undefined,
  unknown: string,
): string {
  const shown = name ? quoted(name, NAME_LIMIT) : undefined;
  if (!id) return shown ?? unknown;
  return shown ? `${id} (${shown})` : id;
}

/**
 * Every control, format, invisible, and direction character, and the
 * backtick, as a visible \uXXXX escape: a value shown in a code span or
 * fence then adds no line and cannot close its fence. JSON.stringify already
 * escapes characters below 0x20; this covers the rest (Cf direction and
 * zero-width characters, U+2028/U+2029, private use, lone surrogates).
 */
export function escapeInvisibles(s: string): string {
  return s.replace(/[\p{Cc}\p{Cf}\p{Co}\p{Cs}\u2028\u2029`]/gu, (c) => {
    const cp = c.codePointAt(0) ?? 0;
    return cp > 0xffff ? `\\u{${cp.toString(16)}}` : `\\u${cp.toString(16).padStart(4, '0')}`;
  });
}

/** What kind of conversation it is, in words. */
function conversationKind(mg: MessagingGroup): string {
  return `a ${mg.is_group ? 'group conversation' : 'direct message'} on ${mg.channel_type}`;
}

/** A conversation as a request names it: by its name, quoted, when it has one, and its channel. */
function conversationName(mg: MessagingGroup): string {
  return mg.name ? `${quoted(mg.name, NAME_LIMIT)} on ${mg.channel_type}` : conversationKind(mg);
}

/** Where a request comes from, for a request posted outside the asking agent's own conversations. */
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
