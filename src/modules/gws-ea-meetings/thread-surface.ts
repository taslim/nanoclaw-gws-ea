import { getSession } from '../../db/sessions.js';
import { getThread, threadAddresses, threadSchedulingPeople } from '../gws-ea-inbox/thread-map.js';
import { openMatterOfThread } from '../gws-ea-matters/db.js';
import { getExternalEmailAgentGroupId } from '../gws-ea-profile/db.js';
import { bookingMatters, type BookingSurface } from './booking-surface.js';
import { getThreadBookingCalendar } from './thread-calendar.js';

export function threadSurface(threadKey: string): BookingSurface {
  const owner = { kind: 'thread', key: threadKey } as const;
  return {
    owner,
    writer: 'external-email',
    /** to: external-email */
    words: {
      ownerLabel: 'this thread',
      connectionStep: "Wake main with tell_main, saying what you couldn't do on this thread, and wait for main.",
    },
    calendarId: () => getThreadBookingCalendar(threadKey),
    async invitationPeople() {
      const addresses = await threadAddresses(threadKey);
      return {
        allowed: addresses.map((entry) => entry.address),
        defaults: addresses.flatMap((entry) => (entry.source === 'written' ? [] : [entry.address])),
        /** to: external-email */
        outside: (address) =>
          `${address} is not on this thread: invite only people who wrote or were written to in it, or whom main named.`,
        /** to: external-email */
        empty: 'Name someone on the thread to invite: the booking invites nobody else.',
      };
    },
    schedulingPeople: () => threadSchedulingPeople(threadKey),
    async privacyFor() {
      return {};
    },
    async beforeWrite() {},
    inWrite: (work) => work(),
    async stillServing(session) {
      const current = await getSession(session.id);
      return (
        current !== undefined &&
        current.status === 'active' &&
        session.status === 'active' &&
        current.agent_group_id === session.agent_group_id &&
        current.agent_group_id === (await getExternalEmailAgentGroupId()) &&
        current.messaging_group_id === session.messaging_group_id &&
        current.thread_id === threadKey &&
        session.thread_id === threadKey &&
        (await getThread(threadKey)) !== undefined
      );
    },
    async openMatters() {
      const matter = await openMatterOfThread(threadKey);
      return bookingMatters(matter === undefined ? [] : [matter.matterId], owner);
    },
  };
}
