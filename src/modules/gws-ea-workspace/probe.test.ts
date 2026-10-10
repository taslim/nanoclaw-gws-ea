/**
 * The signed-out visit (KTD5): the one Google call made without the host's
 * token, for a link Drive cannot answer for. It carries no credential,
 * follows no redirect but one forms.gle hop to a form's responder page,
 * reads a capped body only for a form, and gives up on time.
 */
import { describe, expect, it } from 'vitest';

import { probeLink, ProbeUnavailableError } from './probe.js';

const DOC = 'https://docs.google.com/document/d/1NoelArcherAgenda/edit';
const FORM = 'https://docs.google.com/forms/d/e/1FAIpQLSdRsvp/viewform';
const ACCEPTING =
  '<html><body><form action="https://docs.google.com/forms/u/0/d/e/1FAIpQLSdRsvp/formResponse" method="POST"></form></body></html>';

interface Visit {
  readonly url: string;
  readonly init: RequestInit | undefined;
}

/** A fetch that answers each URL as `answers` says, recording every visit. */
function fakeFetch(answers: Record<string, () => Response>): { fetch: typeof globalThis.fetch; visits: Visit[] } {
  const visits: Visit[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    visits.push({ url, init });
    const answer = answers[url];
    if (answer === undefined) throw new Error(`unexpected visit to ${url}`);
    return answer();
  };
  return { fetch, visits };
}

function redirect(location: string, status = 302): Response {
  return new Response(null, { status, headers: { location } });
}

describe('a signed-out visit', () => {
  it('carries no credential and follows no redirect on its own', async () => {
    const { fetch, visits } = fakeFetch({ [DOC]: () => new Response('<html>agenda</html>') });
    expect(await probeLink({ url: DOC, form: false }, { fetch })).toBe('opens');
    expect(visits).toHaveLength(1);
    const init = visits[0].init;
    expect(init?.redirect).toBe('manual');
    expect(init?.credentials).toBe('omit');
    const headers = new Headers(init?.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
  });

  it('reads a sign-in page as not public', async () => {
    const { fetch } = fakeFetch({
      [DOC]: () => redirect(`https://accounts.google.com/ServiceLogin?continue=${encodeURIComponent(DOC)}`),
    });
    expect(await probeLink({ url: DOC, form: false }, { fetch })).toBe('sign-in');
  });

  it('never follows a redirect off the page it asked for, on Google or off it', async () => {
    for (const elsewhere of [
      'https://northwind.example/agenda',
      'https://drive.google.com/file/d/1NoelArcherAgenda/view',
      FORM,
    ]) {
      const { fetch, visits } = fakeFetch({ [DOC]: () => redirect(elsewhere) });
      expect(await probeLink({ url: DOC, form: false }, { fetch })).toBe('unconfirmed');
      expect(visits.map((visit) => visit.url)).toEqual([DOC]);
    }
  });

  it('reads a missing page and a refusal as Google gives them', async () => {
    const missing = fakeFetch({ [DOC]: () => new Response('gone', { status: 404 }) });
    expect(await probeLink({ url: DOC, form: false }, { fetch: missing.fetch })).toBe('not-found');
    const refused = fakeFetch({ [DOC]: () => new Response('no', { status: 403 }) });
    expect(await probeLink({ url: DOC, form: false }, { fetch: refused.fetch })).toBe('sign-in');
  });

  it('never visits a URL off the checked hosts, over http, or with userinfo or a port', async () => {
    const { fetch, visits } = fakeFetch({});
    for (const url of [
      'https://northwind.example/document/d/1NoelArcherAgenda/edit',
      'http://docs.google.com/document/d/1NoelArcherAgenda/edit',
      'https://juno@docs.google.com/document/d/1NoelArcherAgenda/edit',
      'https://docs.google.com:8443/document/d/1NoelArcherAgenda/edit',
      'https://www.google.com/url?q=https://docs.google.com/document/d/1NoelArcherAgenda/edit',
    ]) {
      expect(await probeLink({ url, form: false }, { fetch })).toBe('unconfirmed');
    }
    expect(visits).toEqual([]);
  });
});

describe('a form', () => {
  it('passes when its responder page offers the form to answer, even with the form split across chunks', async () => {
    const { fetch } = fakeFetch({ [FORM]: () => new Response(ACCEPTING) });
    expect(await probeLink({ url: FORM, form: true }, { fetch })).toBe('opens');

    // Neither half alone holds the form's tag.
    const split = ACCEPTING.indexOf('formResponse') + 'form'.length;
    const halves = [ACCEPTING.slice(0, split), ACCEPTING.slice(split)].map((half) => new TextEncoder().encode(half));
    const streamed = fakeFetch({
      [FORM]: () =>
        new Response(
          new ReadableStream<Uint8Array>({
            start(controller) {
              for (const half of halves) controller.enqueue(half);
              controller.close();
            },
          }),
        ),
    });
    expect(await probeLink({ url: FORM, form: true }, { fetch: streamed.fetch })).toBe('opens');
  });

  it('is not accepting when its page offers no form, or Google moves it to its closed page', async () => {
    const unpublished = fakeFetch({ [FORM]: () => new Response('<html>This form is not accepting responses</html>') });
    expect(await probeLink({ url: FORM, form: true }, { fetch: unpublished.fetch })).toBe('not-accepting');
    const closed = fakeFetch({ [FORM]: () => redirect(FORM.replace('/viewform', '/closedform')) });
    expect(await probeLink({ url: FORM, form: true }, { fetch: closed.fetch })).toBe('not-accepting');
  });

  it('is restricted when only certain people may answer it: Google asks for a sign-in', async () => {
    const { fetch } = fakeFetch({ [FORM]: () => redirect('https://accounts.google.com/v3/signin/identifier') });
    expect(await probeLink({ url: FORM, form: true }, { fetch })).toBe('sign-in');
  });

  it('follows exactly one forms.gle hop, and only to a responder page', async () => {
    const short = 'https://forms.gle/Rsvp7NoelArcher';
    const hop = fakeFetch({
      [short]: () => redirect(`${FORM}?usp=send_form`),
      [`${FORM}?usp=send_form`]: () => new Response(ACCEPTING),
    });
    expect(await probeLink({ url: short, form: true }, { fetch: hop.fetch })).toBe('opens');
    expect(hop.visits.map((visit) => visit.url)).toEqual([short, `${FORM}?usp=send_form`]);
    expect(hop.visits[1].init?.redirect).toBe('manual');

    const second = fakeFetch({
      [short]: () => redirect(FORM),
      [FORM]: () => redirect('https://docs.google.com/forms/d/e/1FAIpQLSdOther/viewform'),
    });
    expect(await probeLink({ url: short, form: true }, { fetch: second.fetch })).toBe('unconfirmed');
    expect(second.visits).toHaveLength(2);

    for (const elsewhere of [
      'https://northwind.example/rsvp',
      'https://docs.google.com/document/d/1NoelArcherAgenda/edit',
      'http://docs.google.com/forms/d/e/1FAIpQLSdRsvp/viewform',
    ]) {
      const off = fakeFetch({ [short]: () => redirect(elsewhere) });
      expect(await probeLink({ url: short, form: true }, { fetch: off.fetch })).toBe('unconfirmed');
      expect(off.visits).toHaveLength(1);
    }
  });

  it('reads no more than its cap of a page, stopping there', async () => {
    let pulled = 0;
    const chunk = new TextEncoder().encode('x'.repeat(64 * 1024));
    const endless = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(chunk);
      },
    });
    const { fetch } = fakeFetch({ [FORM]: () => new Response(endless) });
    expect(await probeLink({ url: FORM, form: true }, { fetch, maxBodyBytes: 256 * 1024 })).toBe('not-accepting');
    expect(pulled).toBeLessThanOrEqual(6);
  });
});

describe('when Google cannot answer', () => {
  it('gives up on time', async () => {
    const fetch: typeof globalThis.fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    await expect(probeLink({ url: DOC, form: false }, { fetch, timeoutMs: 20 })).rejects.toBeInstanceOf(
      ProbeUnavailableError,
    );
  });

  it('treats a rate limit, a server error, an unreachable Google and its "sorry" page as brief', async () => {
    const answers: (() => Response)[] = [
      () => new Response('slow down', { status: 429 }),
      () => new Response('oops', { status: 503 }),
      () => redirect('https://www.google.com/sorry/index?continue=x'),
      () => {
        throw new TypeError('fetch failed');
      },
    ];
    for (const answer of answers) {
      const { fetch } = fakeFetch({ [DOC]: answer });
      await expect(probeLink({ url: DOC, form: false }, { fetch })).rejects.toBeInstanceOf(ProbeUnavailableError);
    }
  });
});
