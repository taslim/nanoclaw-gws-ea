/**
 * Answers in words to the requests a channel posts as text (KTD9; R8, R9, R11).
 *
 * On a channel whose account shows no cards (ChatSdkBridgeConfig.textRequests),
 * a question or approval request is answered, in the conversation it was
 * posted in, by:
 * - a reply quoting it whose text begins with an answer: a yes or no, or one
 *   of its options by number or name. For a request whose rejection takes a
 *   reason, the text after the no is the reason;
 * - 👍 or 👎 on it, when its options are approve and reject;
 * - in a DM, for an agent's own question only: a reply that is nothing but an
 *   answer, when that question is the newest open one there, posted after the
 *   person last wrote there and at least 5 seconds before the reply, by the
 *   platform's clock.
 *
 * Anything else is no answer: the bridge routes it as it routes any message,
 * and the request stays open. An approval never takes a plain answer, and the
 * assistant's own messages and reactions answer nothing. Whether a request is
 * open, what it offers, and whether an agent asked it come from its render
 * (resolveQuestionRender), never from a copy, and the handler an answer
 * reaches authorizes it.
 *
 * The records here are transport facts, kept in the bridge's state store:
 * the requests posted in each conversation, when each person last wrote in
 * each DM (the only place a plain answer counts), and the answers already
 * taken, so one delivered again is not taken twice.
 */
import type { StateAdapter } from 'chat';

import {
  APPROVE_OPTION,
  REJECT_OPTION,
  REJECT_WITH_REASON_OPTION,
  approveRejectRequest,
  type NormalizedOption,
} from './ask-question.js';
import type { PostedRequest } from './chat-sdk-bridge.js';
import type { QuestionRender } from './question-render-registry.js';

/**
 * How long the bridge remembers a request it posted: whether one is still
 * open comes from its pending row, but an answer can find it only while it
 * is remembered. When each person last wrote is kept as long, since a plain
 * answer reads it against the requests posted since.
 */
export const POSTED_REQUEST_KEPT_MS = 30 * 24 * 60 * 60 * 1000;

/** How long an answer taken is remembered: as long as Pub/Sub may deliver it again. */
const ANSWER_KEPT_MS = 7 * 24 * 60 * 60 * 1000;

/** A plain answer is for a question only this long after it at the least (AE3: a reply typed as it arrived is not). */
const PLAIN_ANSWER_AFTER_MS = 5_000;

/** How many of its newest requests a conversation's record holds. */
const REQUESTS_PER_CONVERSATION = 100;

// ---------------------------------------------------------------------------
// The words an answer may be
// ---------------------------------------------------------------------------

const YES_WORDS: ReadonlySet<string> = new Set(['yes', 'y', 'yeah', 'yep', 'yup', 'sure', 'ok', 'okay']);
const NO_WORDS: ReadonlySet<string> = new Set(['no', 'n', 'nope', 'nah']);

type Polarity = 'yes' | 'no';

function polarityOf(word: string): Polarity | undefined {
  if (YES_WORDS.has(word)) return 'yes';
  if (NO_WORDS.has(word)) return 'no';
  return undefined;
}

/** Text as an answer reads it: in lower case, its spaces single, without what surrounds its letters and digits. */
function bare(text: string): string {
  return text
    .replace(/\s+/gu, ' ')
    .toLowerCase()
    .replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}]+$/gu, '');
}

/** What may follow an answer that begins a reply: nothing, a space, or punctuation that does not run into a digit. */
function endsAnswer(rest: string): boolean {
  return rest === '' || /^\s/u.test(rest) || (/^[,.;:!?)\]}…—–-]/u.test(rest) && !/^[,.:]\d/u.test(rest));
}

/** An option as a reply can name it. */
interface NamedOption {
  readonly option: NormalizedOption;
  /** Its label, bare; empty when the label has no letters or digits to name it by. */
  readonly name: string;
  /** Its number, for a request that lists its options by number. */
  readonly number?: number;
  readonly polarity?: Polarity;
}

/**
 * The options a reply can choose, as the request asked for them
 * (chat-sdk-bridge howToAnswer). An approve/reject request is asked yes or
 * no: approve is the yes, reject the no, and a reason follows the no rather
 * than being an option of its own. Any other request lists its options by
 * number and name, and one named yes or no is chosen by that word too.
 */
function namedOptions(options: readonly NormalizedOption[]): NamedOption[] {
  if (approveRejectRequest(options)) {
    return options
      .filter((option) => option.value !== REJECT_WITH_REASON_OPTION)
      .map((option) => ({
        option,
        name: bare(option.label),
        polarity: option.value === APPROVE_OPTION ? 'yes' : 'no',
      }));
  }
  return options.map((option, index) => {
    const name = bare(option.label);
    const polarity = polarityOf(name);
    return { option, name, number: index + 1, ...(polarity === undefined ? {} : { polarity }) };
  });
}

/** The one option a reply that is nothing but an answer chooses: exactly, or by a prefix of one option's name only. */
function wholeAnswer(text: string, named: readonly NamedOption[]): NamedOption | undefined {
  const reply = bare(text);
  if (reply === '') return undefined;
  const number = /^\d+$/u.test(reply) ? Number(reply) : undefined;
  const polarity = polarityOf(reply);
  const exact = named.filter(
    (candidate) =>
      (number !== undefined && candidate.number === number) ||
      (polarity !== undefined && candidate.polarity === polarity) ||
      (candidate.name !== '' && candidate.name === reply),
  );
  if (exact.length > 0) return exact.length === 1 ? exact[0] : undefined;
  const prefixed = named.filter((candidate) => candidate.name.startsWith(reply));
  return prefixed.length === 1 ? prefixed[0] : undefined;
}

/**
 * The one option a reply begins with — a yes or no, a number, or an option's
 * whole name (the longest it begins with) — and the text after it. A prefix
 * chooses nothing here: "I think" must not choose Ignore.
 */
function leadingAnswer(text: string, named: readonly NamedOption[]): { chosen: NamedOption; rest: string } | undefined {
  const reply = text
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[^\p{L}\p{N}]+/u, '');
  const word = /^\p{L}+/u.exec(reply)?.[0];
  const polarity =
    word !== undefined && endsAnswer(reply.slice(word.length)) ? polarityOf(word.toLowerCase()) : undefined;
  const digits = /^\d+/u.exec(reply)?.[0];
  const number = digits !== undefined && endsAnswer(reply.slice(digits.length)) ? Number(digits) : undefined;
  const namedAt = named.filter(
    (candidate) =>
      candidate.name !== '' &&
      reply.slice(0, candidate.name.length).toLowerCase() === candidate.name &&
      endsAnswer(reply.slice(candidate.name.length)),
  );
  const longestName = Math.max(0, ...namedAt.map((candidate) => candidate.name.length));
  const matches = [
    ...named.flatMap((candidate) =>
      polarity !== undefined && candidate.polarity === polarity ? [{ candidate, length: word?.length ?? 0 }] : [],
    ),
    ...named.flatMap((candidate) =>
      number !== undefined && candidate.number === number ? [{ candidate, length: digits?.length ?? 0 }] : [],
    ),
    ...namedAt
      .filter((candidate) => candidate.name.length === longestName)
      .map((candidate) => ({ candidate, length: longestName })),
  ];
  const chosen = new Set(matches.map((match) => match.candidate));
  if (chosen.size !== 1) return undefined;
  const length = Math.max(...matches.map((match) => match.length));
  return {
    chosen: matches[0].candidate,
    rest: reply
      .slice(length)
      .replace(/^[\s,.;:!?)\]}…—–-]+/u, '')
      .trim(),
  };
}

/** An answer read from words: the option chosen, and the reason given with a rejection. */
export interface Choice {
  readonly value: string;
  readonly reason?: string;
}

/**
 * The answer some words give to a request with these options. `whole`: the
 * words are nothing but an answer, as a plain answer must be. `leading`: they
 * begin with one, as a quoted reply may, and for a request whose rejection
 * takes a reason, the text after a no is the reason.
 */
export function readAnswer(
  text: string,
  options: readonly NormalizedOption[],
  form: 'whole' | 'leading',
): Choice | undefined {
  const named = namedOptions(options);
  const whole = wholeAnswer(text, named);
  if (whole !== undefined) return { value: whole.option.value };
  if (form === 'whole') return undefined;
  const leading = leadingAnswer(text, named);
  if (leading === undefined) return undefined;
  const takesReason = approveRejectRequest(options)?.takesReason === true;
  const reason = takesReason && leading.chosen.option.value === REJECT_OPTION ? leading.rest : '';
  return { value: leading.chosen.option.value, ...(reason === '' ? {} : { reason }) };
}

/** The option a 👍 or 👎 chooses: approve or reject. A skin tone counts as the same emoji. */
function thumbAnswer(emoji: string): string | undefined {
  const plain = emoji.replace(/[\u{1F3FB}-\u{1F3FF}]|\uFE0F/gu, '');
  if (plain === 'thumbs_up' || plain === '👍') return APPROVE_OPTION;
  if (plain === 'thumbs_down' || plain === '👎') return REJECT_OPTION;
  return undefined;
}

/** The answer a reaction gives to a request with these options: only 👍 or 👎, and only on an approve/reject request. */
export function reactionAnswer(emoji: string, options: readonly NormalizedOption[]): string | undefined {
  return approveRejectRequest(options) ? thumbAnswer(emoji) : undefined;
}

// ---------------------------------------------------------------------------
// The records
// ---------------------------------------------------------------------------

/** A request posted in a conversation, as its record of requests holds it. */
interface ConversationRequest {
  readonly messageId: string;
  /** When the platform recorded it, as ISO-8601; absent when the platform reported no time. */
  readonly postedAt?: string;
}

/** When a person last wrote in a DM: that message, and when they wrote the one before it. */
interface LastWritten {
  readonly id: string;
  readonly at: number;
  readonly before?: number;
}

/** An answer taken: the request it answered. */
interface TakenAnswer {
  readonly questionId: string;
}

function conversationKey(adapterName: string, platformId: string): string {
  return `text-request:${adapterName}:conversation:${platformId}`;
}

function lastWrittenKey(adapterName: string, platformId: string, userId: string): string {
  return `text-request:${adapterName}:wrote:${platformId}:${userId}`;
}

function answerKey(adapterName: string, answerId: string): string {
  return `text-request:${adapterName}:answer:${answerId}`;
}

/** Add a request the bridge posted to its conversation's record, so a plain answer there can find it. */
export async function indexPostedRequest(
  state: StateAdapter,
  adapterName: string,
  platformId: string,
  messageId: string,
  postedAt: string | undefined,
): Promise<void> {
  const request: ConversationRequest = { messageId, ...(postedAt === undefined ? {} : { postedAt }) };
  await state.appendToList(conversationKey(adapterName, platformId), request, {
    maxLength: REQUESTS_PER_CONVERSATION,
    ttlMs: POSTED_REQUEST_KEPT_MS,
  });
}

// ---------------------------------------------------------------------------
// Taking answers
// ---------------------------------------------------------------------------

/** Someone's message, as the check reads it. */
export interface ReplyIn {
  /** The message's own id, the same each time the platform delivers it: the answer's id. */
  readonly id: string;
  /** The conversation it was written in, as the bridge's platform id. */
  readonly platformId: string;
  readonly userId: string;
  /** The assistant's own message. */
  readonly isMe: boolean;
  readonly isDM: boolean;
  /** When the platform recorded it. */
  readonly at: Date;
  readonly text: string;
  /** The message it quotes, when it quotes one. A quote that names no message replied to (a forward) has none. */
  readonly quote?: { readonly messageId?: string };
}

/** Someone's reaction, as the check reads it. */
export interface ReactionIn {
  /** The reaction's own id, the same each time the platform delivers it: the answer's id. */
  readonly id: string;
  /** The conversation of the message reacted to, as the bridge's platform id. */
  readonly platformId: string;
  readonly userId: string;
  /** The assistant's own reaction. */
  readonly isMe: boolean;
  /** The emoji's name. */
  readonly emoji: string;
  /** The message reacted to. */
  readonly messageId: string;
}

/** An answer to hand to the request's handler (ChannelSetup.onAction). */
export interface Answer {
  readonly questionId: string;
  readonly value: string;
  readonly reason?: string;
  /** Who answered. */
  readonly userId: string;
  /** The request's message. */
  readonly messageId: string;
  /** The conversation the answer was given in. */
  readonly platformId: string;
}

export interface AnswersOptions {
  readonly state: StateAdapter;
  readonly adapterName: string;
  /** The request the bridge posted as this message, while it takes answers (readPostedRequest). */
  readonly postedRequest: (messageId: string) => Promise<PostedRequest | undefined>;
  readonly render: (questionId: string) => Promise<QuestionRender | undefined>;
  /** Hand an answer to its handler: resolves once the handler has finished, rejects when it fails. */
  readonly dispatch: (answer: Answer) => Promise<void>;
  /** How a message mentioning the assistant writes it, as `@name`: a reply may begin with it. */
  readonly selfMention?: string;
}

export interface Answers {
  /** Take a message as an answer when it is one: true once its answer is handled, or was already; false otherwise. */
  takeMessage(reply: ReplyIn): Promise<boolean>;
  /** Take a reaction as an answer when it is one: true once its answer is handled, or was already; false otherwise. */
  takeReaction(reaction: ReactionIn): Promise<boolean>;
}

/** When a person wrote before a message: at a time, not on record, or not known because they have written since. */
type Before = { readonly kind: 'at'; readonly at: number } | { readonly kind: 'none' } | { readonly kind: 'unknown' };

/** The request an inbound may answer, and the answer it gives, read once earlier answers to it have settled. */
interface Candidate {
  readonly questionId: string;
  readonly answer: () => Promise<Answer | undefined>;
}

function isOpen(render: QuestionRender | undefined, now: number): render is QuestionRender {
  return (
    render !== undefined &&
    render.resolved !== true &&
    (render.expiresAt === undefined || Date.parse(render.expiresAt) > now)
  );
}

export function createAnswers(options: AnswersOptions): Answers {
  const { state, adapterName } = options;
  const queues = new Map<string, Promise<void>>();

  /** Run work after the work already queued under its key, one at a time. */
  function serialized<T>(key: string, work: () => Promise<T>): Promise<T> {
    const run = (queues.get(key) ?? Promise.resolve()).then(work);
    const settled = run.then(
      () => undefined,
      () => undefined,
    );
    queues.set(key, settled);
    void settled.then(() => {
      if (queues.get(key) === settled) queues.delete(key);
    });
    return run;
  }

  function withoutSelfMention(text: string): string {
    const mention = options.selfMention;
    const trimmed = text.trim();
    if (mention === undefined || trimmed.slice(0, mention.length).toLowerCase() !== mention.toLowerCase()) {
      return trimmed;
    }
    const rest = trimmed.slice(mention.length);
    return endsAnswer(rest) ? rest.replace(/^[\s,:]+/u, '') : trimmed;
  }

  /** The request posted as this message in this conversation, while it takes answers. */
  async function requestIn(platformId: string, messageId: string): Promise<PostedRequest | undefined> {
    const posted = await options.postedRequest(messageId);
    return posted?.platformId === platformId ? posted : undefined;
  }

  /**
   * Note that a person wrote in a DM, and return when they wrote before. A
   * message delivered again reads what it read the first time; one older than
   * a message already noted cannot tell what came before it.
   */
  function noteWritten(reply: ReplyIn): Promise<Before> {
    const key = lastWrittenKey(adapterName, reply.platformId, reply.userId);
    return serialized(`wrote:${key}`, async (): Promise<Before> => {
      const at = reply.at.getTime();
      const last = await state.get<LastWritten>(key);
      if (last?.id === reply.id) return last.before === undefined ? { kind: 'none' } : { kind: 'at', at: last.before };
      if (last !== null && last.at >= at) return { kind: 'unknown' };
      const written: LastWritten = { id: reply.id, at, ...(last === null ? {} : { before: last.at }) };
      await state.set(key, written, POSTED_REQUEST_KEPT_MS);
      return last === null ? { kind: 'none' } : { kind: 'at', at: last.at };
    });
  }

  /**
   * The answer an inbound gives to the request posted as `messageId`, read
   * when its turn comes: only while that message is still the request, and
   * the request is open. An earlier answer may have resolved it, or posted
   * the next request under the same question.
   */
  function candidate(
    inbound: { readonly platformId: string; readonly userId: string },
    messageId: string,
    questionId: string,
    choose: (render: QuestionRender) => Choice | undefined,
  ): Candidate {
    return {
      questionId,
      answer: async () => {
        if ((await requestIn(inbound.platformId, messageId))?.questionId !== questionId) return undefined;
        const render = await options.render(questionId);
        if (!isOpen(render, Date.now())) return undefined;
        const choice = choose(render);
        if (choice === undefined) return undefined;
        return {
          questionId,
          value: choice.value,
          ...(choice.reason === undefined ? {} : { reason: choice.reason }),
          userId: inbound.userId,
          messageId,
          platformId: inbound.platformId,
        };
      },
    };
  }

  /**
   * Take an inbound as the answer `find` names, once. Its id is reserved
   * before its handler runs and kept once the handler succeeds; a handler
   * that fails releases it, so the platform's next delivery tries again.
   * Answers to one request run one at a time, so a later one reads whether
   * an earlier one resolved it.
   */
  async function take(answerId: string, find: () => Promise<Candidate | undefined>): Promise<boolean> {
    const key = answerKey(adapterName, answerId);
    const earlier = await state.get<TakenAnswer>(key);
    if (earlier !== null) {
      // Taken, or being taken: once that settles it stands, or its handler failed and released it for this delivery.
      await serialized(`request:${earlier.questionId}`, async () => undefined);
      if ((await state.get<TakenAnswer>(key)) !== null) return true;
    }
    const found = await find();
    if (found === undefined) return false;
    return serialized(`request:${found.questionId}`, async () => {
      if ((await state.get<TakenAnswer>(key)) !== null) return true;
      const answer = await found.answer();
      if (answer === undefined) return false;
      const taken: TakenAnswer = { questionId: found.questionId };
      if (!(await state.setIfNotExists(key, taken, ANSWER_KEPT_MS))) return true;
      let handled = false;
      try {
        await options.dispatch(answer);
        handled = true;
      } finally {
        if (!handled) await state.delete(key);
      }
      return true;
    });
  }

  /**
   * The newest open question in a DM, when it was posted after the person
   * last wrote there and at least 5 seconds before their reply. Approvals
   * never take a plain answer, so they are passed over.
   */
  async function plainCandidate(reply: ReplyIn, before: Before, text: string): Promise<Candidate | undefined> {
    if (before.kind === 'unknown') return undefined;
    const since = before.kind === 'at' ? before.at : -Infinity;
    const recorded = await state.getList<ConversationRequest>(conversationKey(adapterName, reply.platformId));
    const newestFirst = recorded
      .map((request, order) => {
        const postedAt = request.postedAt === undefined ? Number.NaN : Date.parse(request.postedAt);
        // A request the platform gave no time for may be the newest, and no plain answer can be timed against it.
        return { request, order, at: Number.isNaN(postedAt) ? Infinity : postedAt };
      })
      .filter(({ at }) => at > since)
      .sort((a, b) => b.at - a.at || b.order - a.order);
    for (const { request, at } of newestFirst) {
      const posted = await requestIn(reply.platformId, request.messageId);
      if (posted === undefined) continue;
      const render = await options.render(posted.questionId);
      if (!isOpen(render, Date.now()) || render.kind !== 'question') continue;
      if (!(reply.at.getTime() - at >= PLAIN_ANSWER_AFTER_MS)) return undefined;
      return candidate(reply, request.messageId, posted.questionId, (current) =>
        current.kind === 'question' ? readAnswer(text, current.options, 'whole') : undefined,
      );
    }
    return undefined;
  }

  return {
    async takeMessage(reply) {
      if (reply.isMe) return false;
      const before = reply.isDM ? await noteWritten(reply) : undefined;
      const text = withoutSelfMention(reply.text);
      if (reply.quote !== undefined) {
        const quoted = reply.quote.messageId;
        if (quoted === undefined) return false;
        return take(reply.id, async () => {
          const posted = await requestIn(reply.platformId, quoted);
          return (
            posted &&
            candidate(reply, quoted, posted.questionId, (render) => readAnswer(text, render.options, 'leading'))
          );
        });
      }
      if (before === undefined) return false;
      return take(reply.id, () => plainCandidate(reply, before, text));
    },

    async takeReaction(reaction) {
      if (reaction.isMe || thumbAnswer(reaction.emoji) === undefined) return false;
      return take(reaction.id, async () => {
        const posted = await requestIn(reaction.platformId, reaction.messageId);
        return (
          posted &&
          candidate(reaction, reaction.messageId, posted.questionId, (render) => {
            const value = reactionAnswer(reaction.emoji, render.options);
            return value === undefined ? undefined : { value };
          })
        );
      });
    },
  };
}
