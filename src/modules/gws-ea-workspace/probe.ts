/**
 * The signed-out visit (KTD5): what someone holding only a link sees when
 * they open it. The link check makes it only when Drive cannot answer, such
 * as for a form's responder link, or a file the assistant can only view or
 * cannot see.
 *
 * It is the one Google call made without the host's token, so it never goes
 * through `googleJson`: no Authorization header, no cookies, and no redirect
 * followed but one, from a `forms.gle` short link to a form's responder page
 * on docs.google.com. It visits only an https URL on docs.google.com,
 * drive.google.com or forms.gle, with no userinfo or port, gives up after a
 * few seconds, and reads a page only for a form, no further than a cap.
 *
 * - A page that opens passes: anyone with the link can open the file.
 * - A form passes only when its page offers the form to answer; a closed or
 *   unpublished one does not.
 * - Google asking for a sign-in means not public: a file shared with named
 *   people, or a form only certain people may answer.
 * - A rate limit, a server error, Google's "sorry" page, no answer, or no
 *   answer in time are brief, and thrown as `ProbeUnavailableError`.
 */

export type ProbeVerdict =
  /** Anyone with the link opens it: a file, or a form that takes responses. */
  | 'opens'
  /** Google asks for a sign-in first. */
  | 'sign-in'
  /** A form that is closed, or offers nothing to answer. */
  | 'not-accepting'
  /** Nothing is there for someone signed out. */
  | 'not-found'
  /** Anything else Google answered, such as a redirect elsewhere. */
  | 'unconfirmed';

/** What to visit: the page for someone holding only the link, and whether it is a form's. */
export interface ProbeTarget {
  readonly url: string;
  readonly form: boolean;
}

export interface ProbeOptions {
  readonly fetch?: typeof globalThis.fetch;
  readonly timeoutMs?: number;
  readonly maxBodyBytes?: number;
}

/** Google could not answer just now: worth asking again shortly. */
export class ProbeUnavailableError extends Error {
  constructor(message: string, options?: { readonly cause?: unknown }) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = 'ProbeUnavailableError';
  }
}

const PROBE_TIMEOUT_MS = 8_000;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const VISITED_HOSTS: ReadonlySet<string> = new Set(['docs.google.com', 'drive.google.com', 'forms.gle']);
/** The one page a forms.gle link may lead to. */
const RESPONDER_PAGE = /^\/forms\/d\/e\/[A-Za-z0-9_-]+\/viewform$/u;
/** A responder page that takes responses carries the form that posts them. */
const RESPONSE_FORM = /<form\b[^>]*\baction="[^"]*\/formResponse"/u;
/** Enough of the page before a chunk to find the form's tag across the chunks it was split between. */
const CARRIED_CHARACTERS = 4_096;

function parsed(value: string, base?: URL): URL | undefined {
  return URL.parse(value, base?.href) ?? undefined;
}

function visitable(url: URL): boolean {
  return (
    url.protocol === 'https:' &&
    VISITED_HOSTS.has(url.hostname) &&
    url.username === '' &&
    url.password === '' &&
    url.port === ''
  );
}

function isRedirect(status: number): boolean {
  return status >= 300 && status < 400;
}

async function visit(url: URL, signal: AbortSignal, fetchImpl: typeof globalThis.fetch): Promise<Response> {
  try {
    return await fetchImpl(url.href, {
      method: 'GET',
      redirect: 'manual',
      credentials: 'omit',
      headers: { accept: 'text/html' },
      signal,
    });
  } catch (error) {
    throw new ProbeUnavailableError(`Google could not be reached (${url.hostname})`, { cause: error });
  }
}

async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** Where a redirect leads, as Google wrote it: undefined when it names nowhere readable. */
function destination(response: Response, from: URL): URL | undefined {
  const location = response.headers.get('location');
  return location === null ? undefined : parsed(location, from);
}

/** A redirect that is not the forms.gle hop is never followed: only where it leads is read. */
function redirectVerdict(to: URL | undefined): ProbeVerdict {
  if (to === undefined) return 'unconfirmed';
  if (to.hostname === 'accounts.google.com') return 'sign-in';
  if ((to.hostname === 'www.google.com' || to.hostname === 'google.com') && to.pathname.startsWith('/sorry')) {
    throw new ProbeUnavailableError('Google asked the host to slow down');
  }
  if (to.hostname === 'docs.google.com' && to.pathname.endsWith('/closedform')) return 'not-accepting';
  return 'unconfirmed';
}

/** Whether a form's page offers the form to answer, read no further than `maxBytes`. */
async function offersForm(response: Response, maxBytes: number): Promise<boolean> {
  const reader = response.body?.getReader();
  if (reader === undefined) return false;
  const decoder = new TextDecoder();
  let read = 0;
  let carried = '';
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return false;
      read += value.byteLength;
      const text = carried + decoder.decode(value, { stream: true });
      if (RESPONSE_FORM.test(text)) return true;
      if (read >= maxBytes) return false;
      carried = text.slice(-CARRIED_CHARACTERS);
    }
  } catch (error) {
    throw new ProbeUnavailableError('Google stopped answering mid-page', { cause: error });
  } finally {
    await reader.cancel().catch(() => undefined);
  }
}

async function answerVerdict(response: Response, form: boolean, maxBytes: number): Promise<ProbeVerdict> {
  const { status } = response;
  if (status >= 200 && status < 300) {
    if (form) return (await offersForm(response, maxBytes)) ? 'opens' : 'not-accepting';
    await discard(response);
    return 'opens';
  }
  await discard(response);
  if (status === 429 || status >= 500) throw new ProbeUnavailableError(`Google answered ${status}`);
  if (status === 401 || status === 403) return 'sign-in';
  if (status === 404 || status === 410) return 'not-found';
  return 'unconfirmed';
}

/** What someone signed out sees at `target`. Throws `ProbeUnavailableError` when Google cannot answer just now. */
export async function probeLink(target: ProbeTarget, options: ProbeOptions = {}): Promise<ProbeVerdict> {
  const url = parsed(target.url);
  if (url === undefined || !visitable(url)) return 'unconfirmed';
  const fetchImpl = options.fetch ?? globalThis.fetch;
  const maxBytes = options.maxBodyBytes ?? MAX_BODY_BYTES;
  const signal = AbortSignal.timeout(options.timeoutMs ?? PROBE_TIMEOUT_MS);
  const first = await visit(url, signal, fetchImpl);
  if (!isRedirect(first.status)) return answerVerdict(first, target.form, maxBytes);
  const next = destination(first, url);
  await discard(first);
  if (url.hostname !== 'forms.gle' || next === undefined || !visitable(next) || next.hostname !== 'docs.google.com') {
    return redirectVerdict(next);
  }
  if (!RESPONDER_PAGE.test(next.pathname)) return redirectVerdict(next);
  const responder = await visit(next, signal, fetchImpl);
  if (!isRedirect(responder.status)) return answerVerdict(responder, true, maxBytes);
  const beyond = destination(responder, next);
  await discard(responder);
  return redirectVerdict(beyond);
}
