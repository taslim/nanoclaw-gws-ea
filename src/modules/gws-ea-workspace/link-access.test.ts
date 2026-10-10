/**
 * The link check's decision (R4, KTD4, KTD5): for each Google link in what
 * the assistant wrote and each recipient who is not the principal, only a
 * signal Google gives exactly confirms they can open it. Drive answers
 * first; a signed-out visit only when Drive cannot. A refusal speaks to the
 * agent that wrote the message: `main` hears its choices, `external-email`
 * only who cannot open a link, and to tell main.
 *
 * Drive is in memory (`testing/fake-drive.ts`) and the visit is a stub,
 * except for the host's own check, whose Drive token is a mock and whose
 * signed-out visit goes through a stubbed `fetch`.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../gws-ea-google/index.js', () => ({ hostGoogleAccessToken: vi.fn() }));

import { closeDb, initTestDb } from '../../db/index.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { GoogleGrantRevokedError, GoogleScopeNotGrantedError, GoogleTokenError } from '../gws-ea-google/tokens.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import {
  checkLinksOpenable,
  createLinkAccess,
  LinkCheckUnavailableError,
  type LinkCheck,
  type LinkCheckRequest,
} from './link-access.js';
import type { ProbeTarget, ProbeVerdict } from './probe.js';
import { ProbeUnavailableError } from './probe.js';
import type { DriveApi } from './drive-api.js';
import { delegatingDriveApi, FakeDrive } from './testing/fake-drive.js';

const JUNO = 'juno@northwind.example';
const MORGAN = 'morgan.fixture@gmail.com';
const MORGAN_WORK = 'morgan@ellery.example';
const REMY = 'remy@vance.example';
const NOEL = 'noel@archer.example';
const NOEL_ALIAS = 'noel.archer@archer.example';
const SALES = 'sales@vance.example';
const DOC_TYPE = 'application/vnd.google-apps.document';
const DECK_TYPE = 'application/vnd.google-apps.presentation';
const RSVP = 'https://docs.google.com/forms/d/e/1FAIpQLSdRsvpSpring/viewform';
const OPERATOR = "the assistant's Google sign-in doesn't include Drive yet; the operator needs to reconnect it";

const docUrl = (id: string) => `https://docs.google.com/document/d/${id}/edit`;
const deckUrl = (id: string) => `https://docs.google.com/presentation/d/${id}/edit`;

/** A world with the assistant's Drive in memory; `reach` may stand between the check and it. */
function world(reach: (drive: FakeDrive) => DriveApi = (drive) => drive) {
  const drive = new FakeDrive(JUNO);
  drive.addAccount(MORGAN);
  drive.addAccount(REMY);
  drive.addAccount(NOEL, NOEL_ALIAS);
  const visits: ProbeTarget[] = [];
  /** What each visit answers, in turn; anything unlisted asks for a sign-in. */
  const answers = new Map<string, (ProbeVerdict | Error)[]>();
  const slept: number[] = [];
  const access = createLinkAccess({
    drive: reach(drive),
    probe: async (target) => {
      visits.push(target);
      const answer = answers.get(target.url)?.shift() ?? 'sign-in';
      if (answer instanceof Error) throw answer;
      return answer;
    },
    principalAddresses: async () => new Set([MORGAN, MORGAN_WORK]),
    sleep: async (ms) => {
      slept.push(ms);
    },
  });
  const check = (request: Partial<LinkCheckRequest> & Pick<LinkCheckRequest, 'texts'>): Promise<LinkCheck> =>
    access.check({ recipients: [REMY], writer: 'main', ...request });
  /** A file the assistant made, in its own Drive. */
  const owned = async (name = 'Trip plan'): Promise<string> =>
    (await drive.createFile({ name, mimeType: DOC_TYPE })).id;
  return { drive, visits, answers, slept, check, owned };
}

function refusal(result: LinkCheck): string {
  if (result.allowed) throw new Error('the check let it through');
  return result.reason;
}

describe('a file the assistant can share', () => {
  it('passes anyone with the link for an outside recipient, with no visit made', async () => {
    const { drive, visits, check, owned } = world();
    const id = await owned();
    drive.share(id, { id: 'anyoneWithLink', type: 'anyone', role: 'reader' });
    expect(await check({ texts: [`The plan: ${docUrl(id)}`], writer: 'external-email' })).toEqual({ allowed: true });
    expect(visits).toEqual([]);
    expect(drive.calls.filter((call) => call.op === 'permissionId')).toEqual([]);
  });

  it("matches a grant to an alias through the account's permission id, and reuses the id for the next message", async () => {
    const { drive, check, owned } = world();
    const plan = await owned('Trip plan');
    const budget = await owned('Budget');
    for (const id of [plan, budget]) await drive.createPermission(id, { emailAddress: NOEL, role: 'reader' });
    expect(await check({ texts: [docUrl(plan)], recipients: [NOEL_ALIAS] })).toEqual({ allowed: true });
    expect(await check({ texts: [docUrl(budget)], recipients: [NOEL_ALIAS] })).toEqual({ allowed: true });
    expect(drive.calls.filter((call) => call.op === 'permissionId')).toEqual([
      { op: 'permissionId', input: { emailAddress: NOEL_ALIAS } },
    ]);
  });

  it('passes a recipient on a domain the file is shared with', async () => {
    const { drive, check, owned } = world();
    const id = await owned();
    drive.share(id, { id: 'vance', type: 'domain', role: 'reader', domain: 'vance.example' });
    expect(await check({ texts: [docUrl(id)] })).toEqual({ allowed: true });
  });

  it('refuses a recipient only a group might let in, offering main to share with them directly', async () => {
    const { drive, visits, check, owned } = world();
    const id = await owned();
    drive.share(id, { id: 'team', type: 'group', role: 'reader', emailAddress: 'team@vance.example' });
    expect(refusal(await check({ texts: [docUrl(id)] }))).toBe(
      `${REMY} may not be able to open ${docUrl(id)}: it is shared with a group, and the host can't tell who is in it. Share it with them directly (view-only, unless they need more), leave them out, or send it without the link.`,
    );
    expect(visits).toEqual([]);
  });

  it('refuses someone it is not shared with, offering main its three choices', async () => {
    const { check, owned } = world();
    const id = await owned();
    expect(refusal(await check({ texts: [docUrl(id)] }))).toBe(
      `${REMY} can't open ${docUrl(id)}: it isn't shared with them. Share it with them (view-only, unless they need more), leave them out, or send it without the link.`,
    );
  });

  it('counts no grant that has expired, belongs to a deleted account, or opens only a published view', async () => {
    const { drive, check, owned } = world();
    const id = await owned();
    drive.share(id, {
      id: 'remy',
      type: 'user',
      role: 'reader',
      emailAddress: REMY,
      expirationTime: '2020-01-01T00:00:00.000Z',
    });
    drive.share(id, { id: 'gone', type: 'user', role: 'reader', emailAddress: REMY, deleted: true });
    drive.share(id, { id: 'anyoneWithLink', type: 'anyone', role: 'reader', view: 'published' });
    expect((await check({ texts: [docUrl(id)] })).allowed).toBe(false);
  });

  it('refuses a file in the trash', async () => {
    const { drive, check, owned } = world();
    const id = await owned();
    drive.share(id, { id: 'anyoneWithLink', type: 'anyone', role: 'reader' });
    drive.trash(id);
    expect(refusal(await check({ texts: [docUrl(id)] }))).toBe(
      `${REMY} can't open ${docUrl(id)}: it is in the trash. Restore it, or send it without the link.`,
    );
  });
});

describe('a file the assistant can only view (AE3)', () => {
  it('refuses an outside recipient, naming the owner to main and nothing of the file to external-email', async () => {
    const { drive, visits, check } = world();
    const id = drive.shareWithAssistant({ name: 'Board deck', owner: MORGAN, role: 'reader', mimeType: DECK_TYPE });
    expect(refusal(await check({ texts: [`Deck: ${deckUrl(id)}`] }))).toBe(
      `${REMY} may not be able to open ${deckUrl(id)}: it belongs to the principal (${MORGAN}), and the assistant can only view it, so it can't see who else may open it or share it. Ask the principal to share it with them, leave them out, or send it without the link.`,
    );
    // Drive cannot say who else may open it, so a signed-out visit was made, once.
    expect(visits).toEqual([{ url: deckUrl(id), form: false }]);
    expect(drive.calls.filter((call) => call.op === 'listPermissions')).toEqual([]);

    const told = refusal(await check({ texts: [`Deck: ${deckUrl(id)}`], writer: 'external-email' }));
    expect(told).toBe(`${REMY} can't open a Google link in it. Tell main which link, and who can't open it.`);
    expect(told).not.toContain(MORGAN);
    expect(told).not.toContain('Board deck');
  });

  it('passes its owner without a visit, and anyone when anyone with the link opens it', async () => {
    const { drive, visits, answers, check } = world();
    const id = drive.shareWithAssistant({ name: 'Notes', owner: NOEL, role: 'commenter' });
    expect(await check({ texts: [docUrl(id)], recipients: [NOEL] })).toEqual({ allowed: true });
    expect(visits).toEqual([]);
    answers.set(docUrl(id), ['opens']);
    expect(await check({ texts: [docUrl(id)] })).toEqual({ allowed: true });
  });
});

describe('a file the assistant cannot see', () => {
  it('passes only when anyone with the link opens it, visiting the page Google serves it on, never the link as written', async () => {
    const { visits, answers, check } = world();
    const unseen = 'https://drive.google.com/open?id=1RemyVanceOwnDocument';
    const page = 'https://drive.google.com/file/d/1RemyVanceOwnDocument/view';
    expect(refusal(await check({ texts: [unseen] }))).toBe(
      `${REMY} may not be able to open ${unseen}: the assistant can't open it either, so it can't tell who can. Leave them out, or send it without the link.`,
    );
    answers.set(page, ['opens']);
    expect(await check({ texts: [unseen] })).toEqual({ allowed: true });
    expect(visits).toEqual([
      { url: page, form: false },
      { url: page, form: false },
    ]);
  });
});

describe('a file published to the web', () => {
  it('passes while it opens for anyone signed out, visited as a page rather than a form, and is refused once it does not', async () => {
    const { drive, visits, answers, check } = world();
    const published = 'https://docs.google.com/document/d/e/2PACX-1vRemyVanceMinutes/pub';
    answers.set(published, ['opens', 'not-found']);
    expect(await check({ texts: [published] })).toEqual({ allowed: true });
    expect(refusal(await check({ texts: [published] }))).toBe(
      `${published} doesn't open for anyone signed out: it may not be published, or may no longer exist. Check the link, or send it without it.`,
    );
    expect(visits).toEqual([
      { url: published, form: false },
      { url: published, form: false },
    ]);
    expect(drive.calls).toEqual([]);
  });
});

describe('a form', () => {
  it('passes a responder link when the form is published and taking responses, with no Drive call', async () => {
    const { drive, visits, answers, check } = world();
    answers.set(RSVP, ['opens']);
    expect(await check({ texts: [RSVP] })).toEqual({ allowed: true });
    expect(visits).toEqual([{ url: RSVP, form: true }]);
    expect(drive.calls).toEqual([]);
  });

  it('refuses a closed or unpublished form, and one only certain people may answer, saying which', async () => {
    const { answers, check } = world();
    answers.set(RSVP, ['not-accepting', 'sign-in', 'not-found']);
    expect(refusal(await check({ texts: [RSVP] }))).toBe(
      `${RSVP} is a form that isn't published or isn't taking responses, so ${REMY} can't answer it. Publish it and open it to responses, if it is yours to change, or send it without the link.`,
    );
    expect(refusal(await check({ texts: [RSVP] }))).toBe(
      `${REMY} may not be able to answer ${RSVP}: only certain people may respond to it. Let anyone with the link respond, if it is yours to change, leave them out, or send it without the link.`,
    );
    expect(refusal(await check({ texts: [RSVP] }))).toBe(
      `${RSVP} doesn't open for anyone signed out: it may not be published, or may no longer exist. Check the link, or send it without it.`,
    );
  });

  it('visits a short form link at its own address', async () => {
    const { visits, answers, check } = world();
    answers.set('https://forms.gle/Rsvp7NoelArcher', ['opens']);
    expect(await check({ texts: ['RSVP here: https://forms.gle/Rsvp7NoelArcher'] })).toEqual({ allowed: true });
    expect(visits).toEqual([{ url: 'https://forms.gle/Rsvp7NoelArcher', form: true }]);
  });
});

describe('a message with many links and recipients', () => {
  it('checks every one of twelve links, and lets it through when every recipient can open them', async () => {
    const { drive, check, owned } = world();
    const ids: string[] = [];
    for (let index = 0; index < 12; index += 1) {
      const id = await owned(`Day ${index + 1}`);
      await drive.createPermission(id, { emailAddress: REMY, role: 'reader' });
      ids.push(id);
    }
    expect(await check({ texts: [ids.map((id) => `- ${docUrl(id)}`).join('\n')] })).toEqual({ allowed: true });
    expect(drive.calls.filter((call) => call.op === 'getFile').map((call) => call.fileId)).toEqual(ids);
  });

  it('names to external-email only the one recipient of three who cannot open it', async () => {
    const { drive, check, owned } = world();
    const id = await owned();
    for (const person of [REMY, NOEL]) await drive.createPermission(id, { emailAddress: person, role: 'reader' });
    expect(
      refusal(await check({ texts: [docUrl(id)], recipients: [REMY, NOEL, SALES], writer: 'external-email' })),
    ).toBe(`${SALES} can't open a Google link in it. Tell main which link, and who can't open it.`);
  });

  it('names to main, in one sentence, every recipient who cannot open a link for the same reason', async () => {
    const { check, owned } = world();
    const id = await owned();
    expect(refusal(await check({ texts: [docUrl(id)], recipients: [REMY, NOEL] }))).toBe(
      `${REMY} and ${NOEL} can't open ${docUrl(id)}: it isn't shared with them. Share it with them (view-only, unless they need more), leave them out, or send it without the link.`,
    );
  });
});

describe('the principal', () => {
  it('is never checked: a message to their addresses alone makes no Drive call', async () => {
    const { drive, visits, check, owned } = world();
    const id = await owned();
    expect(await check({ texts: [docUrl(id), RSVP], recipients: [MORGAN, 'Morgan@Ellery.example'] })).toEqual({
      allowed: true,
    });
    expect(drive.calls.filter((call) => call.op !== 'createFile')).toEqual([]);
    expect(visits).toEqual([]);
  });

  it('is left out of who a refusal names when others share the message', async () => {
    const { check, owned } = world();
    const id = await owned();
    const reason = refusal(await check({ texts: [docUrl(id)], recipients: [MORGAN, REMY] }));
    expect(reason.startsWith(`${REMY} can't open`)).toBe(true);
    expect(reason).not.toContain(MORGAN);
  });
});

describe('what the check reads', () => {
  it('makes no Drive call or visit for a message with no checked link', async () => {
    const { drive, visits, check } = world();
    const texts = ['Join at https://meet.google.com/abc-defg-hij', 'https://calendar.google.com/calendar/event?eid=x'];
    expect(await check({ texts })).toEqual({ allowed: true });
    expect(drive.calls).toEqual([]);
    expect(visits).toEqual([]);
  });
});

describe('when Google is briefly unavailable', () => {
  it('asks again briefly, and passes when Drive answers', async () => {
    const { drive, slept, check, owned } = world();
    const id = await owned();
    drive.share(id, { id: 'anyoneWithLink', type: 'anyone', role: 'reader' });
    drive.failNext('getFile', new GoogleApiError(503, 'Google refused /drive/v3/files: Backend Error'));
    drive.failNext(
      'getFile',
      new GoogleApiError(403, 'Google refused: Rate Limit', { reason: 'userRateLimitExceeded' }),
    );
    expect(await check({ texts: [docUrl(id)] })).toEqual({ allowed: true });
    expect(slept).toHaveLength(2);
  });

  it('throws for a retry once its brief retries are spent, from Drive, the token endpoint, or a visit', async () => {
    const failures: {
      readonly fail: (setup: ReturnType<typeof world>) => void;
      readonly texts: (id: string) => string[];
    }[] = [
      {
        fail: ({ drive }) => {
          for (let attempt = 0; attempt < 3; attempt += 1)
            drive.failNext('getFile', new GoogleApiError(503, 'Backend Error'));
        },
        texts: (id) => [docUrl(id)],
      },
      {
        fail: ({ drive }) => {
          for (let attempt = 0; attempt < 3; attempt += 1) {
            drive.failNext(
              'getFile',
              new GoogleTokenError('Google refused a drive-host token (HTTP 503)', 'HTTP 503', false),
            );
          }
        },
        texts: (id) => [docUrl(id)],
      },
      {
        fail: ({ answers }) =>
          answers.set(
            RSVP,
            [0, 1, 2].map(() => new ProbeUnavailableError('Google answered 503')),
          ),
        texts: () => [RSVP],
      },
    ];
    for (const { fail, texts } of failures) {
      const setup = world();
      const id = await setup.owned();
      fail(setup);
      await expect(setup.check({ texts: texts(id) })).rejects.toBeInstanceOf(LinkCheckUnavailableError);
      expect(setup.slept).toHaveLength(2);
    }
  });

  it('throws for a retry when the permission id it needs cannot be read', async () => {
    const { drive, check, owned } = world();
    const id = await owned();
    await drive.createPermission(id, { emailAddress: NOEL, role: 'reader' });
    for (let attempt = 0; attempt < 3; attempt += 1)
      drive.failNext('permissionId', new GoogleApiError(500, 'Backend Error'));
    await expect(check({ texts: [docUrl(id)], recipients: [NOEL_ALIAS] })).rejects.toBeInstanceOf(
      LinkCheckUnavailableError,
    );
  });

  it('still refuses what it could decide, rather than waiting on what it could not', async () => {
    let unreachable = '';
    const { check, owned } = world((drive) => ({
      ...delegatingDriveApi(() => drive),
      getFile: async (fileId) => {
        if (fileId === unreachable) throw new GoogleApiError(503, 'Backend Error');
        return drive.getFile(fileId);
      },
    }));
    unreachable = await owned('Itinerary');
    const unshared = await owned('Budget');
    expect(refusal(await check({ texts: [docUrl(unreachable), docUrl(unshared)] }))).toContain(
      `${REMY} can't open ${docUrl(unshared)}`,
    );
  });
});

describe('when the host has no Drive access', () => {
  it.each([
    ['a sign-in without Drive', new GoogleScopeNotGrantedError('drive-host')],
    ['a revoked sign-in', new GoogleGrantRevokedError("Google no longer accepts the assistant's sign-in")],
    [
      'a refused token',
      new GoogleTokenError('Google refused a drive-host token (admin_policy_enforced)', 'admin_policy_enforced', true),
    ],
  ])('refuses a link that is not public with the operator reason, after %s', async (_name, error) => {
    const { drive, check, owned } = world();
    const id = await owned();
    drive.failNext('getFile', error);
    const reason = refusal(await check({ texts: [docUrl(id)] }));
    expect(reason).toContain(OPERATOR);
    expect(reason).toContain(docUrl(id));
  });

  it('still lets a public link through, and tells external-email only to tell main otherwise', async () => {
    const { drive, answers, check, owned } = world();
    const id = await owned();
    drive.failNext('getFile', new GoogleScopeNotGrantedError('drive-host'));
    answers.set(docUrl(id), ['opens']);
    expect(await check({ texts: [docUrl(id)] })).toEqual({ allowed: true });

    drive.failNext('getFile', new GoogleScopeNotGrantedError('drive-host'));
    expect(refusal(await check({ texts: [docUrl(id)], writer: 'external-email' }))).toBe(
      `a Google link in it can't be checked, because ${OPERATOR}. Tell main.`,
    );
  });
});

describe("the host's own check", () => {
  /** Every request made with `fetch`: a signed-out visit, or a Drive call. */
  let requests: string[];

  beforeEach(async () => {
    await initTestDb();
    requests = [];
    // Google asks anyone signed out to sign in first.
    vi.stubGlobal('fetch', async (input: string | URL | Request) => {
      requests.push(input instanceof Request ? input.url : String(input));
      return new Response(null, { status: 302, headers: { location: 'https://accounts.google.com/ServiceLogin' } });
    });
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    vi.mocked(hostGoogleAccessToken).mockReset();
    await closeDb();
  });

  it('refuses a link that is not public with the operator reason when the host has no Google sign-in', async () => {
    vi.mocked(hostGoogleAccessToken).mockRejectedValue(new Error('The assistant is not signed in to Google yet'));
    const link = docUrl('1MorganTripPlan');
    expect(refusal(await checkLinksOpenable({ texts: [link], recipients: [REMY], writer: 'main' }))).toBe(
      `the host can't check who may open ${link}, because ${OPERATOR}. Until then, send it without the link.`,
    );
    // No Drive call went out: only the signed-out visit.
    expect(requests).toEqual([link]);
  });

  it('throws for a retry when the token endpoint is out of reach, rather than blaming the sign-in', async () => {
    vi.mocked(hostGoogleAccessToken).mockRejectedValue(new TypeError('fetch failed'));
    await expect(
      checkLinksOpenable({ texts: [docUrl('1MorganBudget')], recipients: [REMY], writer: 'main' }),
    ).rejects.toBeInstanceOf(LinkCheckUnavailableError);
    // Asked again briefly, then left to the caller's retry.
    expect(hostGoogleAccessToken).toHaveBeenCalledTimes(3);
    expect(requests).toEqual([]);
  });
});
