import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { closeDb, initTestDb } from '../db/connection.js';
import { runMigrations } from '../db/migrations/index.js';
import { SqliteStateAdapter } from '../state-sqlite.js';
import {
  createAnswers,
  indexPostedRequest,
  reactionAnswer,
  readAnswer,
  type Answer,
  type ReactionIn,
  type ReplyIn,
} from './answers.js';
import { normalizeOptions } from './ask-question.js';
import type { PostedRequest } from './chat-sdk-bridge.js';
import type { QuestionRender } from './question-render-registry.js';

const DM = 'fixture:spaces/AAAAjuno';
const ROOM = 'fixture:spaces/AAAAlaunch';
const JUNO = 'users/1001';
const T0 = Date.parse('2026-10-10T17:00:00.000Z');

/** A moment `seconds` after the first request of a scenario, by the platform's clock. */
function at(seconds: number): Date {
  return new Date(T0 + seconds * 1000);
}

const YES_NO = normalizeOptions(['Yes', 'No']);
const TIMES = normalizeOptions([
  { label: 'Tuesday 3pm', value: 'tue' },
  { label: 'Wednesday 10am', value: 'wed' },
  { label: 'Thursday 9am', value: 'thu' },
]);
const APPROVAL = normalizeOptions([
  { label: 'Approve', selectedLabel: '✅ Approved', value: 'approve' },
  { label: 'Reject', selectedLabel: '❌ Rejected', value: 'reject' },
  { label: 'Reject with reason…', selectedLabel: '📝 Rejected (awaiting reason)', value: 'reject_with_reason' },
]);
const PLAIN_APPROVAL = normalizeOptions([
  { label: 'Allow', selectedLabel: '✅ Allowed', value: 'approve' },
  { label: 'Deny', selectedLabel: '❌ Denied', value: 'reject' },
]);
const CHANNEL = normalizeOptions([
  { label: 'Choose existing agent', value: 'choose_existing' },
  { label: 'Connect new agent', value: 'new_agent' },
  { label: 'Reject', value: 'reject' },
]);
const ONE_AGENT_CHANNEL = normalizeOptions([
  { label: 'Connect to main', value: 'connect:ag-main' },
  { label: 'Connect new agent', value: 'new_agent' },
  { label: 'Reject', value: 'reject' },
]);

function question(options = YES_NO, extra: Partial<QuestionRender> = {}): QuestionRender {
  return { title: 'Book the room', kind: 'question', options, ...extra };
}

function approval(options = APPROVAL, extra: Partial<QuestionRender> = {}): QuestionRender {
  return { title: 'Install packages', kind: 'approval', options, ...extra };
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
});

afterEach(async () => {
  await closeDb();
});

/** A handler's database work: it lets other answers run before it records its decision. */
function handlerWork(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

/** One bridge's answers over its state store, with requests posted and handled as the host would. */
async function startDesk() {
  const state = new SqliteStateAdapter();
  await state.connect();
  const posted = new Map<string, PostedRequest>();
  const renders = new Map<string, QuestionRender>();
  const answered: Answer[] = [];
  // The handler resolves the request it answers, as every response handler does, once its work is done.
  let handle = async (answer: Answer): Promise<void> => {
    answered.push(answer);
    await handlerWork();
    const render = renders.get(answer.questionId);
    if (render) renders.set(answer.questionId, { ...render, resolved: true });
  };
  const answers = createAnswers({
    state,
    adapterName: 'fixture',
    postedRequest: async (messageId) => posted.get(messageId),
    render: async (questionId) => renders.get(questionId),
    dispatch: (answer) => handle(answer),
    selfMention: '@robin',
  });
  let requests = 0;
  let messages = 0;
  return {
    answered,
    renders,
    /** The handler edits a request to its outcome: the bridge no longer holds its message as a request. */
    showOutcome(messageId: string) {
      posted.delete(messageId);
    },
    handleWith(next: (answer: Answer) => Promise<void>) {
      handle = next;
    },
    /** The assistant posts a request in a conversation, `seconds` into the scenario. */
    async post(platformId: string, questionId: string, render: QuestionRender, seconds: number): Promise<string> {
      const messageId = `spaces/AAAA/messages/request.${++requests}`;
      const postedAt = at(seconds).toISOString();
      posted.set(messageId, { questionId, platformId, postedAt });
      renders.set(questionId, render);
      await indexPostedRequest(state, 'fixture', platformId, messageId, postedAt);
      return messageId;
    },
    /** Someone writes in a conversation (Juno in the DM unless told otherwise); true when it answered a request. */
    write(text: string, seconds: number, options: Partial<ReplyIn> = {}): Promise<boolean> {
      return answers.takeMessage({
        id: options.id ?? `spaces/AAAA/messages/juno.${++messages}`,
        platformId: DM,
        userId: JUNO,
        isMe: false,
        isDM: (options.platformId ?? DM) === DM,
        at: at(seconds),
        text,
        ...options,
      });
    },
    react(messageId: string, emoji: string, options: Partial<ReactionIn> = {}): Promise<boolean> {
      return answers.takeReaction({
        id: options.id ?? `${messageId}/reactions/${emoji}`,
        platformId: DM,
        userId: JUNO,
        isMe: false,
        emoji,
        messageId,
        ...options,
      });
    },
  };
}

describe('readAnswer — the words an answer may be', () => {
  it('takes "2" and "connect" alike as the second option of a channel approval', () => {
    expect(readAnswer('2', CHANNEL, 'whole')).toEqual({ value: 'new_agent' });
    expect(readAnswer('connect', CHANNEL, 'whole')).toEqual({ value: 'new_agent' });
    expect(readAnswer('Connect new agent', CHANNEL, 'whole')).toEqual({ value: 'new_agent' });
  });

  it('takes no prefix two options start with', () => {
    expect(readAnswer('co', ONE_AGENT_CHANNEL, 'whole')).toBeUndefined();
    expect(readAnswer('connect', ONE_AGENT_CHANNEL, 'whole')).toBeUndefined();
    expect(readAnswer('co', ONE_AGENT_CHANNEL, 'leading')).toBeUndefined();
  });

  it('reads yes and no, and an option by its name, case and surrounding punctuation aside', () => {
    expect(readAnswer('Yes!', YES_NO, 'whole')).toEqual({ value: 'Yes' });
    expect(readAnswer('nope', YES_NO, 'whole')).toEqual({ value: 'No' });
    expect(readAnswer('wednesday', TIMES, 'whole')).toEqual({ value: 'wed' });
    expect(readAnswer('(3)', TIMES, 'whole')).toEqual({ value: 'thu' });
  });

  it('asks an approval yes or no: no numbers, and a reason only after the no', () => {
    expect(readAnswer('yes', APPROVAL, 'whole')).toEqual({ value: 'approve' });
    expect(readAnswer('no', APPROVAL, 'whole')).toEqual({ value: 'reject' });
    expect(readAnswer('Allow', PLAIN_APPROVAL, 'whole')).toEqual({ value: 'approve' });
    expect(readAnswer('1', APPROVAL, 'whole')).toBeUndefined();
    expect(readAnswer('no, too expensive', APPROVAL, 'leading')).toEqual({ value: 'reject', reason: 'too expensive' });
    expect(readAnswer('No. Too expensive this month.', APPROVAL, 'leading')).toEqual({
      value: 'reject',
      reason: 'Too expensive this month.',
    });
    expect(readAnswer('yes, go ahead', APPROVAL, 'leading')).toEqual({ value: 'approve' });
  });

  it('gives a plain approval no reason, whatever follows the no', () => {
    expect(readAnswer('no, not this one', PLAIN_APPROVAL, 'leading')).toEqual({ value: 'reject' });
  });

  it('takes a whole reply that is only an answer, and a leading answer only when more follows it', () => {
    expect(readAnswer('yes, book it', YES_NO, 'whole')).toBeUndefined();
    expect(readAnswer('yes, book it', YES_NO, 'leading')).toEqual({ value: 'Yes' });
    expect(readAnswer('2 please', TIMES, 'leading')).toEqual({ value: 'wed' });
    expect(readAnswer('Wednesday 10am works', TIMES, 'leading')).toEqual({ value: 'wed' });
  });

  it('finds no answer in a word or number that only starts like one', () => {
    expect(readAnswer('yesterday was better', YES_NO, 'leading')).toBeUndefined();
    expect(readAnswer('2.5 hours', TIMES, 'leading')).toBeUndefined();
    expect(readAnswer('I think so', CHANNEL, 'leading')).toBeUndefined();
    expect(readAnswer('7', TIMES, 'whole')).toBeUndefined();
    expect(readAnswer('', TIMES, 'leading')).toBeUndefined();
  });

  it('prefers the longest option name a reply begins with', () => {
    const options = normalizeOptions([
      { label: 'Connect', value: 'connect' },
      { label: 'Connect new agent', value: 'new_agent' },
    ]);
    expect(readAnswer('Connect new agent please', options, 'leading')).toEqual({ value: 'new_agent' });
    expect(readAnswer('connect', options, 'whole')).toEqual({ value: 'connect' });
  });
});

describe('reactionAnswer — 👍 and 👎', () => {
  it('approves with 👍 and rejects with 👎, with or without a skin tone', () => {
    expect(reactionAnswer('thumbs_up', APPROVAL)).toBe('approve');
    expect(reactionAnswer('👍🏽', APPROVAL)).toBe('approve');
    expect(reactionAnswer('thumbs_down', PLAIN_APPROVAL)).toBe('reject');
  });

  it('answers nothing but an approve/reject request, and no other emoji', () => {
    expect(reactionAnswer('thumbs_up', CHANNEL)).toBeUndefined();
    expect(reactionAnswer('thumbs_up', YES_NO)).toBeUndefined();
    expect(reactionAnswer('heart', APPROVAL)).toBeUndefined();
  });
});

describe('createAnswers — the rule', () => {
  it('covers AE1: a plain "yes" after an approval is no answer; 👍 on the request approves it', async () => {
    const desk = await startDesk();
    await desk.write('Can you help me cut this video?', -60);
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);
    await desk.write("I've asked to add ffmpeg.", 1, { isMe: true });

    expect(await desk.write('yes', 30)).toBe(false);
    expect(desk.answered).toEqual([]);

    expect(await desk.react(request, 'thumbs_up')).toBe(true);
    expect(desk.answered).toEqual([
      { questionId: 'appr-ffmpeg', value: 'approve', userId: JUNO, messageId: request, platformId: DM },
    ]);
  });

  it('covers AE2: "2" after writing about something else is no answer; quoting the question with "2" is', async () => {
    const desk = await startDesk();
    await desk.write('Can you find a time with Remy?', -60);
    const request = await desk.post(DM, 'q-times', question(TIMES), 0);
    await desk.write('Also, move my dentist appointment.', 20);

    expect(await desk.write('2', 40)).toBe(false);
    expect(desk.answered).toEqual([]);

    expect(await desk.write('2', 60, { quote: { messageId: request } })).toBe(true);
    expect(desk.answered).toEqual([
      { questionId: 'q-times', value: 'wed', userId: JUNO, messageId: request, platformId: DM },
    ]);
  });

  it('covers AE3: a "yes" 2 seconds after a question is no answer, to it or to the earlier one being answered', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    await desk.post(DM, 'q-room', question(), 0);
    // While the principal types "yes" to the room, main asks something else.
    await desk.post(DM, 'q-projector', question(), 28);

    expect(await desk.write('yes', 30)).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('takes a plain answer 5 seconds after the newest question posted since the person last wrote', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    const request = await desk.post(DM, 'q-room', question(), 0);

    expect(await desk.write('yes', 5)).toBe(true);
    expect(desk.answered).toEqual([
      { questionId: 'q-room', value: 'Yes', userId: JUNO, messageId: request, platformId: DM },
    ]);
  });

  it('covers AE9: a plain "yes" answers the open question and never the approval posted after it', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    const asked = await desk.post(DM, 'q-room', question(), 0);
    await desk.post(DM, 'nsa-remy', approval(PLAIN_APPROVAL), 20);

    expect(await desk.write('yes', 40)).toBe(true);
    expect(desk.answered).toEqual([
      { questionId: 'q-room', value: 'Yes', userId: JUNO, messageId: asked, platformId: DM },
    ]);
    expect(desk.renders.get('nsa-remy')?.resolved).toBeUndefined();
  });

  it('takes a plain answer only for the newest open question, not an older one it passed', async () => {
    const desk = await startDesk();
    await desk.write('Book the room and find a time.', -60);
    await desk.post(DM, 'q-room', question(), 0);
    await desk.post(DM, 'q-times', question(TIMES), 10);

    expect(await desk.write('yes', 40)).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('covers AE11: a member\'s plain "2" in a group is no answer; a quoted "2" is', async () => {
    const desk = await startDesk();
    const request = await desk.post(ROOM, 'q-launch', question(TIMES), 0);

    expect(await desk.write('2', 30, { platformId: ROOM, userId: 'users/2002' })).toBe(false);
    expect(await desk.write('2', 40, { platformId: ROOM, userId: 'users/2002', quote: { messageId: request } })).toBe(
      true,
    );
    expect(desk.answered).toEqual([
      { questionId: 'q-launch', value: 'wed', userId: 'users/2002', messageId: request, platformId: ROOM },
    ]);
  });

  it('takes "yes, book it" as more than an answer when it does not quote the question', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    await desk.post(DM, 'q-room', question(), 0);

    expect(await desk.write('yes, book it', 30)).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('covers AE5: 👍 on a three-option request is no answer', async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'mg-launch', approval(CHANNEL), 0);

    expect(await desk.react(request, 'thumbs_up')).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('covers AE8: a quoted reply to a question past its deadline is no answer', async () => {
    const desk = await startDesk();
    const request = await desk.post(
      DM,
      'q-late',
      question(YES_NO, { expiresAt: new Date(Date.now() - 1000).toISOString() }),
      0,
    );

    expect(await desk.write('yes', 30, { quote: { messageId: request } })).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('answers a request within its deadline, and none already resolved', async () => {
    const desk = await startDesk();
    const open = await desk.post(
      DM,
      'q-open',
      question(YES_NO, { expiresAt: new Date(Date.now() + 60_000).toISOString() }),
      0,
    );
    const decided = await desk.post(DM, 'appr-decided', approval(APPROVAL, { resolved: true }), 0);

    expect(await desk.write('yes', 30, { quote: { messageId: open } })).toBe(true);
    expect(await desk.react(decided, 'thumbs_up')).toBe(false);
    expect(desk.answered.map((answer) => answer.questionId)).toEqual(['q-open']);
  });

  it('rejects with the reason a quoted "no" gives; unquoted, the same words are no answer; 👎 gives none', async () => {
    const desk = await startDesk();
    await desk.write('Please cut the video.', -60);
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);

    expect(await desk.write('no, too expensive', 30)).toBe(false);
    expect(await desk.write('no, too expensive', 40, { quote: { messageId: request } })).toBe(true);
    expect(desk.answered).toEqual([
      {
        questionId: 'appr-ffmpeg',
        value: 'reject',
        reason: 'too expensive',
        userId: JUNO,
        messageId: request,
        platformId: DM,
      },
    ]);

    const second = await desk.post(DM, 'appr-imagemagick', approval(), 50);
    expect(await desk.react(second, 'thumbs_down')).toBe(true);
    expect(desk.answered[1]).toEqual({
      questionId: 'appr-imagemagick',
      value: 'reject',
      userId: JUNO,
      messageId: second,
      platformId: DM,
    });
  });

  it("reads past a leading mention of the assistant in a group's quoted answer", async () => {
    const desk = await startDesk();
    const request = await desk.post(ROOM, 'q-launch', question(TIMES), 0);

    expect(await desk.write('@Robin 3', 30, { platformId: ROOM, quote: { messageId: request } })).toBe(true);
    expect(desk.answered.map((answer) => answer.value)).toEqual(['thu']);
  });
});

describe('createAnswers — binding to its conversation and person', () => {
  it('takes no quote of a DM request written in a group space', async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);

    expect(await desk.write('yes', 30, { platformId: ROOM, quote: { messageId: request } })).toBe(false);
    expect(await desk.react(request, 'thumbs_up', { platformId: ROOM })).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it("never takes the assistant's own yes or 👍", async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);

    expect(await desk.write('yes', 30, { isMe: true, quote: { messageId: request } })).toBe(false);
    expect(await desk.react(request, 'thumbs_up', { isMe: true })).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('takes no forward of a request, which names no message it replies to', async () => {
    const desk = await startDesk();
    await desk.post(DM, 'q-room', question(), 0);

    expect(await desk.write('yes', 30, { quote: {} })).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('takes a plain answer from a person only after a question posted since they last wrote', async () => {
    const desk = await startDesk();
    await desk.post(DM, 'q-room', question(), 0);
    await desk.write('Morning!', 10);

    expect(await desk.write('yes', 30)).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('counts a quoted reply as the person writing: a plain answer after it is not for a question posted before it', async () => {
    const desk = await startDesk();
    await desk.post(DM, 'q-room', question(), 0);
    await desk.write('Thanks, Thursday works.', 10, { quote: { messageId: 'spaces/AAAA/messages/morgan.earlier' } });

    expect(await desk.write('yes', 30)).toBe(false);
    expect(desk.answered).toEqual([]);
  });

  it('takes no plain answer from a message older than one the person already wrote', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    await desk.post(DM, 'q-room', question(), 0);
    await desk.write('Also, the projector.', 40);

    expect(await desk.write('yes', 30)).toBe(false);
    expect(desk.answered).toEqual([]);
  });
});

describe('createAnswers — once', () => {
  it('drops a redelivered answer', async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);

    expect(await desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes', quote: { messageId: request } })).toBe(
      true,
    );
    expect(await desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes', quote: { messageId: request } })).toBe(
      true,
    );
    expect(await desk.react(request, 'thumbs_up', { id: 'reaction-1' })).toBe(false);
    expect(desk.answered).toHaveLength(1);
  });

  it('drops a redelivered plain answer though its question is answered', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    await desk.post(DM, 'q-room', question(), 0);

    expect(await desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes' })).toBe(true);
    expect(await desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes' })).toBe(true);
    expect(desk.answered).toHaveLength(1);
  });

  it('resolves the request on redelivery when its handler failed once', async () => {
    const desk = await startDesk();
    await desk.write('Should we book the room?', -60);
    const request = await desk.post(DM, 'q-room', question(), 0);
    const handled: Answer[] = [];
    let failures = 1;
    desk.handleWith(async (answer) => {
      if (failures-- > 0) throw new Error('database is locked');
      handled.push(answer);
    });

    await expect(desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes' })).rejects.toThrow(/database is locked/u);
    expect(await desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes' })).toBe(true);
    expect(handled).toEqual([{ questionId: 'q-room', value: 'Yes', userId: JUNO, messageId: request, platformId: DM }]);
  });

  it('resolves a request once when a quoted "yes" and a 👍 arrive together', async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);

    const [quoted, reacted] = await Promise.all([
      desk.write('yes', 30, { quote: { messageId: request } }),
      desk.react(request, 'thumbs_up'),
    ]);

    expect(desk.answered).toHaveLength(1);
    expect([quoted, reacted].sort()).toEqual([false, true]);
  });

  it('takes an answer quoting a request only while it is the request, though its question asks again', async () => {
    const desk = await startDesk();
    const first = await desk.post(DM, 'mg-launch', approval(CHANNEL), 0);
    let second: string | undefined;
    // Choosing an existing agent shows this request's outcome and asks which agent, under the same question.
    desk.handleWith(async (answer) => {
      desk.answered.push(answer);
      await handlerWork();
      desk.showOutcome(answer.messageId);
      if (answer.messageId === first) {
        second = await desk.post(DM, 'mg-launch', approval(normalizeOptions(['main', 'research'])), 40);
      }
    });

    const [chosen, late] = await Promise.all([
      desk.write('1', 30, { quote: { messageId: first } }),
      desk.write('2', 31, { quote: { messageId: first } }),
    ]);
    expect([chosen, late]).toEqual([true, false]);
    expect(await desk.write('2', 60, { quote: { messageId: second } })).toBe(true);
    expect(desk.answered.map((answer) => [answer.value, answer.messageId])).toEqual([
      ['choose_existing', first],
      ['research', second],
    ]);
  });

  it('runs a slow handler once when the answer is delivered again meanwhile, and takes the copy as answered', async () => {
    const desk = await startDesk();
    const request = await desk.post(DM, 'appr-ffmpeg', approval(), 0);
    let finish!: () => void;
    const slow = new Promise<void>((resolve) => {
      finish = resolve;
    });
    let calls = 0;
    desk.handleWith(async () => {
      calls += 1;
      await slow;
    });

    const first = desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes', quote: { messageId: request } });
    // Pub/Sub hands the same message out again at 61 seconds, while the first is still being handled.
    const copy = desk.write('yes', 30, { id: 'spaces/AAAA/messages/juno.yes', quote: { messageId: request } });
    await new Promise((resolve) => setTimeout(resolve, 20));
    finish();

    expect(await Promise.all([first, copy])).toEqual([true, true]);
    expect(calls).toBe(1);
  });
});
