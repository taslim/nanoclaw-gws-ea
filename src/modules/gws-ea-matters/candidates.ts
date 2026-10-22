/**
 * The open matters a new piece may belong to (KTD10, R10), found by the host
 * for `main` to decide: those that link the piece's sender, or someone at
 * the sender's organization, through the people store's records; a thread
 * the piece's reply chain answers; or, for an invitation, the thread that
 * booked it. Each comes with why.
 *
 * Only a sender Google names counts: the sender of mail Gmail
 * authenticated (`verifiedSender`), the account Drive names for a share or a
 * comment, or the organizer Calendar shows for an invitation. A piece from
 * anyone else gets no suggestions at all, so mail cannot claim a matter any
 * more than it can claim a level. An invitation's organizer is whoever the
 * invitation names, which one sent as a file in an email chooses freely, so a
 * note says so beside what it suggests from one (`main-note.ts`).
 *
 * An organization is its domain, never a free-mail domain or the principal's
 * or the assistant's own, which say nothing of how two pieces relate.
 */
import { identityMatchKey } from '../../gws-ea/validation.js';
import type { SenderVerdict } from '../gws-ea-inbox/authentication.js';
import { domainOf, normalizeAddress } from '../gws-ea-inbox/mime.js';
import { assistantAddresses } from '../gws-ea-inbox/runtime.js';
import { threadsWithMessageIds } from '../gws-ea-inbox/thread-map.js';
import { bookingThread } from '../gws-ea-meetings/thread-calendar.js';
import { getPerson } from '../gws-ea-people/db.js';
import { loadPrincipalRecognizer } from '../gws-ea-profile/db.js';
import { getMatter, listOpenMatterLinks, type Matter, type OpenMatterLink, type PieceKind } from './db.js';
import { chatMemberPeople } from './chat-links.js';

/** Why an open matter is suggested, strongest first. */
export const CANDIDATE_REASONS = ['reply chain', 'booking', 'same person', 'same organization'] as const;
export type CandidateReason = (typeof CANDIDATE_REASONS)[number];

/** A new piece of work, in no open matter. */
export interface NewPiece {
  readonly kind: PieceKind;
  readonly reference: string;
  /**
   * The address Google names it came from: for mail, `verifiedSender` of
   * Gmail's verdict; for a share or a comment, the account Drive names; for
   * an invitation, the organizer Calendar shows. Undefined when there is
   * none, and then nothing is suggested.
   */
  readonly from: string | undefined;
  /** The Message-IDs mail answers: its In-Reply-To and References. */
  readonly answers?: readonly string[];
}

export interface Candidate {
  readonly id: string;
  readonly title: string;
  /** The project it is a strand of. */
  readonly project: { readonly id: string; readonly title: string } | null;
  /** Why, strongest first. */
  readonly reasons: readonly CandidateReason[];
}

/** Domains anyone can hold an address at. */
const FREE_MAIL: ReadonlySet<string> = new Set([
  'aol.com',
  'fastmail.com',
  'gmail.com',
  'gmx.com',
  'gmx.net',
  'googlemail.com',
  'hey.com',
  'hotmail.com',
  'icloud.com',
  'live.com',
  'mac.com',
  'mail.com',
  'me.com',
  'msn.com',
  'outlook.com',
  'pm.me',
  'proton.me',
  'protonmail.com',
  'yahoo.com',
  'yandex.com',
  'ymail.com',
  'zoho.com',
]);

/**
 * The address Gmail's verdict verifies mail came from: the principal, or a
 * sender it authenticated. Undefined for anyone it could not verify, and for
 * Google's own notifications, whose person Calendar or Drive names.
 */
export function verifiedSender(verdict: SenderVerdict): string | undefined {
  switch (verdict.kind) {
    case 'principal':
    case 'authenticated':
      return verdict.address;
    case 'calendar-notification':
    case 'workspace-notification':
    case 'unauthenticated':
      return undefined;
    default: {
      const unreachable: never = verdict;
      throw new Error(`Unknown sender verdict: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** The principal's addresses, then the assistant's: their domains say nothing of how two pieces relate. */
export async function ownAddresses(): Promise<string[]> {
  return [...(await loadPrincipalRecognizer()).listed, ...(await assistantAddresses())];
}

/**
 * What `candidatesFor` reads for every piece, which a caller suggesting for
 * several pieces reads once: every link of every open matter, and the
 * principal's and the assistant's addresses, read on first use.
 */
export interface CandidateReads {
  readonly links: readonly OpenMatterLink[];
  readonly ownAddresses: () => Promise<readonly string[]>;
}

/** The sender's organization, or undefined when their domain says nothing of one. */
async function organizationOf(sender: string, own: () => Promise<readonly string[]>): Promise<string | undefined> {
  const domain = domainOf(sender);
  if (FREE_MAIL.has(domain)) return undefined;
  return (await own()).some((address) => domainOf(address.toLowerCase()) === domain) ? undefined : domain;
}

/** A person's email addresses, as their record holds them. */
async function addressesOf(personId: string): Promise<string[]> {
  return ((await getPerson(personId))?.identities ?? []).flatMap(({ handle }) => {
    const address = handle.toLowerCase().startsWith('email:')
      ? normalizeAddress(handle.slice('email:'.length))
      : undefined;
    return address === undefined ? [] : [address];
  });
}

function personReason(
  addresses: readonly string[],
  senderKey: string,
  organization: string | undefined,
): CandidateReason | undefined {
  if (addresses.some((address) => identityMatchKey(`email:${address}`) === senderKey)) return 'same person';
  if (organization !== undefined && addresses.some((address) => domainOf(address) === organization))
    return 'same organization';
  return undefined;
}

async function candidate(matter: Matter, reasons: ReadonlySet<CandidateReason>): Promise<Candidate> {
  const project = matter.parent_id === null ? undefined : await getMatter(matter.parent_id);
  return {
    id: matter.id,
    title: matter.title,
    project: project === undefined ? null : { id: project.id, title: project.title },
    reasons: CANDIDATE_REASONS.filter((reason) => reasons.has(reason)),
  };
}

/**
 * The open matters `piece` may belong to, strongest reason first, then most
 * recently changed. `reads` is what a caller suggesting for several pieces
 * read once for all of them.
 */
export async function candidatesFor(piece: NewPiece, reads?: CandidateReads): Promise<Candidate[]> {
  const sender = piece.from === undefined ? undefined : normalizeAddress(piece.from);
  if (sender === undefined) return [];
  const { links, ownAddresses: own } = reads ?? { links: await listOpenMatterLinks(), ownAddresses };
  const found = new Map<string, Set<CandidateReason>>();
  const suggest = (matterId: string, reason: CandidateReason): void => {
    found.set(matterId, (found.get(matterId) ?? new Set<CandidateReason>()).add(reason));
  };

  const organization = await organizationOf(sender, own);
  const senderKey = identityMatchKey(`email:${sender}`);
  const people = new Map<string, CandidateReason | undefined>();
  const rosters = new Map<string, readonly string[]>();
  for (const link of links.filter((held) => held.kind === 'person' || held.kind === 'chat')) {
    let personIds: readonly string[] = [link.reference];
    if (link.kind === 'chat') {
      const cached = rosters.get(link.reference);
      personIds = cached ?? (await chatMemberPeople(link.reference));
      if (cached === undefined) rosters.set(link.reference, personIds);
    }
    for (const personId of personIds) {
      if (!people.has(personId)) {
        people.set(personId, personReason(await addressesOf(personId), senderKey, organization));
      }
      const reason = people.get(personId);
      if (reason !== undefined) suggest(link.matter_id, reason);
    }
  }

  const answered = new Set(await threadsWithMessageIds(piece.answers ?? []));
  const slash = piece.reference.indexOf('/');
  const booker =
    piece.kind === 'event'
      ? await bookingThread(piece.reference.slice(0, slash), piece.reference.slice(slash + 1))
      : undefined;
  for (const link of links.filter((held) => held.kind === 'thread')) {
    if (answered.has(link.reference)) suggest(link.matter_id, 'reply chain');
    if (link.reference === booker) suggest(link.matter_id, 'booking');
  }

  const matters = await Promise.all(
    [...found.keys()].map(async (id) => {
      const matter = await getMatter(id);
      if (matter === undefined) throw new Error(`No matter ${id} exists`);
      return matter;
    }),
  );
  const rank = (matter: Matter): number => CANDIDATE_REASONS.findIndex((reason) => found.get(matter.id)?.has(reason));
  const ranked = matters.sort(
    (left, right) =>
      rank(left) - rank(right) || right.updated_at.localeCompare(left.updated_at) || left.id.localeCompare(right.id),
  );
  return Promise.all(ranked.map((matter) => candidate(matter, found.get(matter.id) ?? new Set())));
}

/** The suggestions as `main` reads them beside a new piece: each open matter with why. */
export function renderCandidates(candidates: readonly Candidate[]): string {
  const heading = 'Open matters it may belong to:';
  if (candidates.length === 0) {
    return `${heading} none shares a person, an organization, a reply chain or a booking with it.`;
  }
  return [
    heading,
    ...candidates.map((suggested) => {
      const project =
        suggested.project === null ? '' : `, a strand of ${suggested.project.id}: ${suggested.project.title}`;
      return `- ${suggested.id}: ${suggested.title}${project} (${suggested.reasons.join(', ')})`;
    }),
  ].join('\n');
}
