import { forbidden } from '../../cli/delivery-action.js';
import type { Session } from '../../types.js';
import { requireServingChat } from '../gws-ea-chats/bridge.js';
import { getMatter } from '../gws-ea-matters/db.js';
import { getExternalChatAgentGroupId, getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import type { BookingOwner } from './bookings-db.js';
import { chatSurface } from './chat-surface.js';
import { threadSurface } from './thread-surface.js';

export type BookingWriter = 'external-email' | 'external-chat' | 'job';

export interface BookingMatter {
  readonly id: string;
  readonly conversations: readonly BookingOwner[];
}

export interface InvitationPeople {
  readonly allowed: readonly string[];
  readonly defaults: readonly string[];
  readonly outside: (address: string) => string;
  readonly empty: string;
}

export interface BookingPrivacy {
  readonly chatId?: string;
}

export interface BookingSurface {
  readonly owner: BookingOwner;
  /** Who writes, so a refused link is explained in words fitted to them. */
  readonly writer: BookingWriter;
  readonly words: {
    readonly ownerLabel: string;
    readonly connectionStep: string;
  };
  calendarId(): Promise<string | null>;
  invitationPeople(): Promise<InvitationPeople>;
  /** Addresses whose relationship and history outward answers may state: people main named, and a thread's senders Gmail authenticated. */
  schedulingPeople(): Promise<string[]>;
  /** A chat's clearances apply only while every recipient is a current member with a known email. */
  privacyFor(recipients: readonly string[]): Promise<BookingPrivacy>;
  beforeWrite(): Promise<void>;
  inWrite<T>(work: () => Promise<T>): Promise<T>;
  stillServing(session: Session): Promise<boolean>;
  openMatters(): Promise<readonly BookingMatter[]>;
}

/** A session gone from its chat writes nothing more, so its writer then never reaches a privacy check. */
async function chatWriter(session: Session | undefined): Promise<'external-chat' | 'job'> {
  return session?.agent_group_id === (await getExternalChatAgentGroupId()) ? 'external-chat' : 'job';
}

/** Recovery reads belong to the durable owner even after its calling session has gone. */
export async function bookingSurfaceFor(owner: BookingOwner, session: Session | undefined): Promise<BookingSurface> {
  return owner.kind === 'thread' ? threadSurface(owner.key) : chatSurface(owner.key, await chatWriter(session));
}

/** Session authorization is separate from owner-bound reads needed to finish reporting. */
export async function resolveBookingSurface(session: Session): Promise<BookingSurface> {
  if (session.agent_group_id === (await getExternalEmailAgentGroupId()) && session.thread_id !== null) {
    const surface = threadSurface(session.thread_id);
    if (!(await surface.stillServing(session)))
      throw forbidden(
        'This conversation is not the active session of an email thread, so it has no times to offer or book.',
      );
    return surface;
  }
  const chat = await requireServingChat(session);
  return chatSurface(chat.messaging_group_id, await chatWriter(session));
}

export async function bookingMatters(ids: readonly string[], owner: BookingOwner): Promise<BookingMatter[]> {
  const matters = await Promise.all(ids.map((id) => getMatter(id)));
  return matters.flatMap((matter) =>
    matter?.open
      ? [
          {
            id: matter.id,
            conversations: matter.links.flatMap((link) =>
              (link.kind === 'thread' || link.kind === 'chat') &&
              !(link.kind === owner.kind && link.reference === owner.key)
                ? [{ kind: link.kind, key: link.reference }]
                : [],
            ),
          },
        ]
      : [],
  );
}
