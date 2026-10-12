/**
 * Google Chat's direct-message setup, faked at the `fetch` boundary as it
 * answers the assistant under user authentication: `spaces.setup` opens (or
 * returns the existing) DM with the person an address names, and
 * `spaces.members.list` lists who is in it by numeric user ID only. As Google
 * does, it lists the person as invited until they join the DM, which needs a
 * message in it (and, for someone outside the organization, their accepting
 * it as a request).
 *
 * Every request is recorded. A test makes the next requests fail with
 * `failures`, answered in order.
 */
import {
  ASSISTANT,
  CHAT_TOKEN,
  NOT_FOUND,
  UNAUTHENTICATED,
  json,
  refusal,
  requestUrl,
  type ChatFailure,
} from './fake-chat-api.js';

/** Someone Google Chat can resolve by address. */
export interface FakeChatPerson {
  /** Their numeric Google ID: Chat names them `users/{id}`. */
  readonly id: string;
  /** How Chat lists them; a person unless a test says otherwise. */
  readonly type?: 'HUMAN' | 'BOT';
}

export interface FakeChatDmRequest {
  readonly method: string;
  readonly path: string;
  readonly body: unknown;
}

interface FakeMembership {
  readonly name: string;
  readonly state: string;
  readonly member: { readonly name: string; readonly type: string };
}

export class FakeChatDirectMessages {
  readonly requests: FakeChatDmRequest[] = [];
  /** People Chat resolves, by lowercased address. */
  readonly people = new Map<string, FakeChatPerson>();
  /** Answers the next requests get instead, in order. */
  readonly failures: ChatFailure[] = [];
  /** People who have joined their DM with the assistant, by numeric ID; everyone else is listed as invited. */
  readonly joined = new Set<string>();
  /** What `spaces.setup` reports the space as; a real DM unless a test says otherwise. */
  space: { readonly spaceType: string; readonly singleUserBotDm?: boolean } = { spaceType: 'DIRECT_MESSAGE' };
  /** Members the space lists beyond the assistant and the person. */
  readonly extraMembers: FakeMembership[] = [];

  readonly fetch: typeof globalThis.fetch = async (input, init) => {
    const url = requestUrl(input);
    const method = (init?.method ?? 'GET').toUpperCase();
    const body: unknown = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = decodeURIComponent(url.pathname.replace(/^\/v1\//u, ''));
    this.requests.push({ method, path, body });
    if (url.host !== 'chat.googleapis.com') throw new TypeError(`fetch failed: no fake for ${url.host}`);
    if (new Headers(init?.headers).get('authorization') !== `Bearer ${CHAT_TOKEN}`) return refusal(UNAUTHENTICATED);
    const failure = this.failures.shift();
    if (failure) return refusal(failure);
    if (method === 'POST' && path === 'spaces:setup') return this.setup(body);
    const members = /^(spaces\/[^/]+)\/members$/u.exec(path)?.[1];
    if (method === 'GET' && members !== undefined) return this.members(members, url);
    return refusal(NOT_FOUND);
  };

  /** The `spaces.setup` calls, each with the member address it named. */
  setups(): string[] {
    return this.requests.flatMap((request) => {
      if (request.path !== 'spaces:setup') return [];
      const body = request.body as { memberships: Array<{ member: { name: string } }> };
      return body.memberships.map((membership) => membership.member.name);
    });
  }

  private personAt(member: string): FakeChatPerson | undefined {
    const address = /^users\/(.+@.+)$/u.exec(member)?.[1]?.toLowerCase();
    return address === undefined ? undefined : this.people.get(address);
  }

  private setup(body: unknown): Response {
    const request = body as {
      space?: { spaceType?: string; singleUserBotDm?: boolean };
      memberships?: Array<{ member?: { name?: string; type?: string } }>;
    };
    const [membership, ...others] = request.memberships ?? [];
    if (
      request.space?.spaceType !== 'DIRECT_MESSAGE' ||
      request.space.singleUserBotDm !== false ||
      others.length > 0 ||
      membership?.member?.type !== 'HUMAN'
    ) {
      return refusal({ status: 400, message: 'Invalid direct message setup.' });
    }
    const person = this.personAt(membership.member.name ?? '');
    if (!person) return refusal(NOT_FOUND);
    return json(200, { name: `spaces/dm-${person.id}`, ...this.space });
  }

  private members(space: string, url: URL): Response {
    const id = /^spaces\/dm-(\d+)$/u.exec(space)?.[1];
    const person = [...this.people.values()].find((candidate) => candidate.id === id);
    if (!person) return refusal(NOT_FOUND);
    const invited = !this.joined.has(person.id);
    const memberships: FakeMembership[] = [
      { name: `${space}/members/assistant`, state: 'JOINED', member: { name: ASSISTANT, type: 'HUMAN' } },
      {
        name: `${space}/members/${person.id}`,
        state: invited ? 'INVITED' : 'JOINED',
        member: { name: `users/${person.id}`, type: person.type ?? 'HUMAN' },
      },
      ...this.extraMembers,
    ];
    // Invited members are listed only when asked for.
    const shown =
      url.searchParams.get('showInvited') === 'true'
        ? memberships
        : memberships.filter((membership) => membership.state !== 'INVITED');
    return json(200, { memberships: shown });
  }
}
