import type { AuthenticatedSender } from './channels/adapter.js';
import type { MessagingGroup, Session } from './types.js';

/** Admission has already succeeded. Only serialized content may be replaced. */
export interface InboundPreparationRequest {
  readonly content: string;
  readonly channelType: string;
  readonly instance: string;
  readonly platformId: string;
  readonly messageId: string;
  readonly timestamp: string;
  readonly authenticatedSender?: Readonly<AuthenticatedSender>;
  readonly session: Readonly<Session>;
  readonly messagingGroup: Readonly<MessagingGroup>;
}

export type InboundPreparer = (request: InboundPreparationRequest) => string | Promise<string>;

const preparers: InboundPreparer[] = [];

/** Installed modules register once at host startup; an unextended host is inert. */
export function registerInboundPreparer(preparer: InboundPreparer): void {
  preparers.push(preparer);
}

export async function prepareInboundContent(request: InboundPreparationRequest): Promise<string> {
  let content = request.content;
  for (const prepare of preparers) content = await prepare({ ...request, content });
  return content;
}
