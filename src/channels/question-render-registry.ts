/**
 * Question-card render resolver registry.
 *
 * Optional modules register compact-card metadata lookups at import time.
 * The host's existing DB lookup remains the final fallback for core question
 * and approval rows.
 */
import type { Adapter, ActionEvent } from 'chat';
import { getAskQuestionRender } from '../db/sessions.js';
import { log } from '../log.js';
import type { NormalizedOption } from './ask-question.js';

export interface QuestionRender {
  title: string;
  question?: string;
  options: NormalizedOption[];
  /** Optional channel presentation. Decision authorization always remains in core. */
  renderMessage?: (questionId: string) => Parameters<Adapter['postMessage']>[1];
  renderTerminal?: (resolution: string) => Parameters<Adapter['postMessage']>[1];
  /** The coordinator updates the card only after it authorizes and records the decision. */
  deferResolution?: boolean;
  /**
   * When it stops taking answers (ISO-8601 UTC): an agent's question at the
   * deadline its asker stops waiting, an approval at its expiry. Absent when
   * it has none.
   */
  expiresAt?: string;
  /** Its status is no longer pending: an answer to it resolves nothing. */
  resolved?: boolean;
  /**
   * Who asks: an agent's own question (ask_user_question), which in a DM may
   * take a plain answer, or an approval, which takes only a quote or a
   * reaction (src/channels/answers.ts). A render without one is taken as an
   * approval.
   */
  kind?: 'question' | 'approval';
}

export type QuestionRenderResolver = (
  questionId: string,
) => QuestionRender | undefined | Promise<QuestionRender | undefined>;

const resolvers: QuestionRenderResolver[] = [];

export function registerQuestionRenderResolver(resolver: QuestionRenderResolver): void {
  resolvers.push(resolver);
}

export async function resolveQuestionRender(questionId: string): Promise<QuestionRender | undefined> {
  for (const resolver of [...resolvers]) {
    /* eslint-disable no-catch-all/no-catch-all -- one optional resolver must not block later resolvers or the built-in fallback */
    try {
      const render = await resolver(questionId);
      if (render) return render;
    } catch (err) {
      log.error('Question render resolver threw', { err });
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  return getAskQuestionRender(questionId);
}

export type QuestionActionHandler = (event: ActionEvent, adapter: Adapter, instance: string) => Promise<boolean>;
const actionHandlers: QuestionActionHandler[] = [];
export function registerQuestionActionHandler(handler: QuestionActionHandler): void {
  actionHandlers.push(handler);
}
export async function dispatchQuestionAction(event: ActionEvent, adapter: Adapter, instance: string): Promise<boolean> {
  for (const handler of actionHandlers) if (await handler(event, adapter, instance)) return true;
  return false;
}
