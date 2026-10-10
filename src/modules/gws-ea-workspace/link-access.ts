/**
 * The link check (R4, R18; KTD4, KTD5): no message goes to someone other
 * than the principal carrying a Google link they cannot open, and the agent
 * that wrote it learns why.
 *
 * One function over the texts a message carries and the people it reaches,
 * called where a message reaches someone other than the principal:
 * `sendToOutside` on an outside email's final recipients, the bridge's
 * handoff admission, and `assertInvitationShareable`. It reads only what
 * the assistant wrote, and never checks the principal's addresses, so
 * nothing `main` sends the principal is checked.
 *
 * "Confirmed" means a signal Google gives exactly, per link and recipient:
 *
 * - Drive first, with the host's own Drive token, one read of each file,
 *   files read in parallel with short timeouts: an `anyone` grant passes
 *   everyone; then the recipient owns the file, holds a grant by address or
 *   by the permission id Drive gives their address (cached per address, so
 *   an alias matches its account), or is on a domain the file is shared
 *   with (best-effort, accepted). A group grant never confirms anyone: the
 *   host cannot see who is in a group. A grant that has expired, belongs to
 *   a deleted account, or opens only a published view does not count.
 * - A signed-out visit (`probe.ts`) only when Drive cannot answer: a form's
 *   responder link, a file published to the web, a file the assistant can
 *   only view (Drive shows only its owner), one it cannot see, or any link
 *   while the host has no Drive access. A file that opens, or a published
 *   form taking responses, passes everyone.
 *
 * Every checked link in a message is confirmed, a few at a time; a message
 * is never refused for carrying many links.
 *
 * Three kinds of failure:
 *
 * 1. Google is briefly unavailable (a Drive or token-endpoint server error,
 *    a rate limit, no answer, Google's "sorry" page): the check asks again
 *    briefly, then throws `LinkCheckUnavailableError`. A polled send throws
 *    it for delivery's own retry; an answering action answers
 *    `LINKS_UNCHECKED`. A link it could decide is refused all the same.
 * 2. The host has no Drive access (not signed in, revoked, or a sign-in
 *    without Drive): a link that is not public is refused, telling the
 *    operator to reconnect.
 * 3. A definitive answer: refused, with a reason fitted to who wrote it.
 *    `main` hears who cannot open which link and its choices: share it with
 *    them (view-only by default), leave them out, or send it without the
 *    link; or, for a file it cannot share, whom to ask. `external-email`
 *    hears only which of its recipients cannot open a link, nothing of the
 *    file, and to tell main.
 *
 * A leaf (KTD4): it imports only the shared Google helpers, the profile's
 * addresses, the privacy module's link reading (`links.ts`), Drive, and the
 * visit.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { getDb } from '../../db/connection.js';
import { normalizePrincipalEmail } from '../../gws-ea/validation.js';
import { hostGoogleAccessToken } from '../gws-ea-google/index.js';
import { GoogleGrantRevokedError, GoogleScopeNotGrantedError, GoogleTokenError } from '../gws-ea-google/tokens.js';
import { GoogleApiError } from '../gws-ea-inbox/gmail-api.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import { createDriveApi, isDriveRateLimit, type DriveApi, type DriveFile, type DrivePermission } from './drive-api.js';
import { fileProbeUrl, googleLinksIn, type GoogleLink } from './links.js';
import { probeLink, ProbeUnavailableError, type ProbeTarget, type ProbeVerdict } from './probe.js';

/** Names the link check as the refuser of an outside email it stopped. */
export const LINK_ACCESS_REFUSER = 'gws-ea-workspace:link-access';

/** What an answering action answers when Google was too briefly unavailable to check its links. */
export const LINKS_UNCHECKED = "I couldn't check the links in it just now; try again shortly.";

/** Who wrote a message, so its refusal speaks to them. */
export type LinkWriter = 'main' | 'external-email';

export interface LinkCheckRequest {
  /** What the assistant wrote; never text it quotes from someone else. */
  readonly texts: readonly string[];
  /** Everyone the message reaches. The principal's addresses are never checked. */
  readonly recipients: readonly string[];
  readonly writer: LinkWriter;
}

export type LinkCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      /** For the writer, fitted to who they are. */
      readonly reason: string;
    };

/** Google was briefly unavailable, so the links could not be checked: worth trying again shortly. */
export class LinkCheckUnavailableError extends Error {
  constructor(options?: { readonly cause?: unknown }) {
    super(
      'Google did not answer the link check, so the message was not sent',
      options?.cause === undefined ? undefined : { cause: options.cause },
    );
    this.name = 'LinkCheckUnavailableError';
  }
}

/** The host holds no Google sign-in to read Drive with: none is configured, or none was made. */
export class NoGoogleSignInError extends Error {
  constructor(cause: unknown) {
    super('The host has no Google sign-in to read Drive with', { cause });
    this.name = 'NoGoogleSignInError';
  }
}

export interface LinkAccessOptions {
  /** Drive, as the host's own Drive token reaches it. */
  readonly drive: DriveApi;
  /** The signed-out visit. */
  readonly probe: (target: ProbeTarget) => Promise<ProbeVerdict>;
  /** The principal's addresses, as the profile holds them. */
  readonly principalAddresses?: () => Promise<ReadonlySet<string>>;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => Date;
}

export interface LinkAccess {
  /** Throws `LinkCheckUnavailableError` when Google was too briefly unavailable to decide every link it could not refuse. */
  check(request: LinkCheckRequest): Promise<LinkCheck>;
}

/** The waits before each brief retry of a read Google could not answer. */
const RETRY_DELAYS_MS: readonly number[] = [250, 1_000];
/** How many addresses' permission ids the check keeps between messages. */
const MAX_CACHED_PERMISSION_IDS = 1000;
/** Files read at once. */
const READS_AT_ONCE = 4;
const OPERATOR_REASON = "the assistant's Google sign-in doesn't include Drive yet; the operator needs to reconnect it";

// ---------------------------------------------------------------------------
// Failure classes
// ---------------------------------------------------------------------------

type FailureClass = 'unavailable' | 'no-drive';

/** Which failure an error is; undefined for an answer about one file, such as an id Drive does not know. */
function failureClass(error: unknown): FailureClass | undefined {
  if (
    error instanceof GoogleScopeNotGrantedError ||
    error instanceof GoogleGrantRevokedError ||
    error instanceof NoGoogleSignInError
  ) {
    return 'no-drive';
  }
  if (error instanceof GoogleTokenError) return error.refused ? 'no-drive' : 'unavailable';
  if (error instanceof ProbeUnavailableError) return 'unavailable';
  if (error instanceof GoogleApiError) return error.retryable || isDriveRateLimit(error) ? 'unavailable' : undefined;
  return undefined;
}

const UNAVAILABLE = Symbol('unavailable');
const NO_DRIVE = Symbol('no-drive');

// ---------------------------------------------------------------------------
// What decides each recipient
// ---------------------------------------------------------------------------

/** Why a recipient cannot be confirmed to open a link. */
type Unconfirmed =
  /** The assistant reads the full access list, and they are not on it. */
  | { readonly kind: 'not-shared'; readonly group: boolean }
  | { readonly kind: 'trashed' }
  /** The assistant can only view the file, so Drive names only its owners. */
  | { readonly kind: 'view-only'; readonly owners: readonly string[] }
  /** The assistant cannot see the file at all. */
  | { readonly kind: 'unseen' }
  | { readonly kind: 'form'; readonly verdict: Exclude<ProbeVerdict, 'opens'> }
  | { readonly kind: 'published' }
  | { readonly kind: 'no-drive' };

type Outcome = 'opens' | typeof UNAVAILABLE | Unconfirmed;

/** What Drive says of a file: nothing (no Drive access, or it could not answer), or the file and, when the assistant may read it, its access list. */
type FileRead =
  | typeof UNAVAILABLE
  | typeof NO_DRIVE
  | { readonly file?: DriveFile; readonly permissions?: readonly DrivePermission[] };

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1);
}

function counts(permission: DrivePermission, now: number): boolean {
  if (permission.deleted === true || permission.view !== undefined) return false;
  if (permission.expirationTime === undefined) return true;
  const expires = Date.parse(permission.expirationTime);
  return Number.isNaN(expires) || expires > now;
}

async function inTurn<T, R>(items: readonly T[], limit: number, work: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await work(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

async function readPrincipalAddresses(): Promise<ReadonlySet<string>> {
  if (!(await getDb().hasTable('gws_ea_principal_addresses'))) return new Set();
  return new Set((await listPrincipalAddresses()).map((address) => address.email));
}

function normalized(address: string): string {
  return normalizePrincipalEmail(address) ?? address.trim().toLowerCase();
}

export function createLinkAccess(options: LinkAccessOptions): LinkAccess {
  const { drive, probe } = options;
  const sleep = options.sleep ?? ((ms: number) => delay(ms));
  const now = options.now ?? (() => new Date());
  const principalAddresses = options.principalAddresses ?? readPrincipalAddresses;
  /**
   * The permission id Drive gives each address, once read; a read in flight
   * is shared. The oldest entry goes once it holds more addresses than
   * `MAX_CACHED_PERMISSION_IDS`, so a long-running host never grows it without end.
   */
  const permissionIds = new Map<string, Promise<string | undefined>>();

  /** `read`, asked again briefly while Google is unavailable; the last failure is thrown. */
  async function briefly<T>(read: () => Promise<T>): Promise<T> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await read();
      } catch (error) {
        const wait = RETRY_DELAYS_MS[attempt];
        if (failureClass(error) !== 'unavailable' || wait === undefined) throw error;
        await sleep(wait);
      }
    }
  }

  async function visit(target: ProbeTarget): Promise<ProbeVerdict | typeof UNAVAILABLE> {
    try {
      return await briefly(() => probe(target));
    } catch (error) {
      if (failureClass(error) === 'unavailable') return UNAVAILABLE;
      throw error;
    }
  }

  /** The permission id of an address's account, or undefined when Drive gives none or cannot be asked. */
  async function permissionIdOf(address: string): Promise<string | undefined | typeof UNAVAILABLE> {
    let pending = permissionIds.get(address);
    if (pending === undefined) {
      pending = briefly(() => drive.permissionId(address));
      permissionIds.set(address, pending);
      if (permissionIds.size > MAX_CACHED_PERMISSION_IDS) {
        const oldest = permissionIds.keys().next().value;
        if (oldest !== undefined) permissionIds.delete(oldest);
      }
    }
    try {
      return await pending;
    } catch (error) {
      permissionIds.delete(address);
      const failure = failureClass(error);
      if (failure === 'unavailable') return UNAVAILABLE;
      // Without an id, exact addresses still match.
      if (failure === 'no-drive' || error instanceof GoogleApiError) return undefined;
      throw error;
    }
  }

  async function readFile(fileId: string): Promise<FileRead> {
    let file: DriveFile | undefined;
    try {
      file = await briefly(() => drive.getFile(fileId));
    } catch (error) {
      const failure = failureClass(error);
      if (failure === 'unavailable') return UNAVAILABLE;
      if (failure === 'no-drive') return NO_DRIVE;
      if (error instanceof GoogleApiError) return {};
      throw error;
    }
    if (file === undefined) return {};
    if (file.trashed === true || file.canShare !== true) return { file };
    try {
      return { file, permissions: await briefly(() => drive.listPermissions(fileId)) };
    } catch (error) {
      const failure = failureClass(error);
      if (failure === 'unavailable') return UNAVAILABLE;
      if (failure === 'no-drive') return NO_DRIVE;
      // Its access changed since the file was read: only its owners are known.
      if (error instanceof GoogleApiError) return { file };
      throw error;
    }
  }

  /** Whether the recipient owns the file or holds a grant Drive lists for them; `UNAVAILABLE` when their id could not be read. */
  async function confirmedByDrive(
    recipient: string,
    users: readonly { readonly emailAddress?: string; readonly permissionId?: string }[],
    domains: readonly string[],
  ): Promise<boolean | typeof UNAVAILABLE> {
    if (users.some((user) => user.emailAddress?.toLowerCase() === recipient)) return true;
    if (domains.includes(domainOf(recipient))) return true;
    if (!users.some((user) => user.permissionId !== undefined)) return false;
    const id = await permissionIdOf(recipient);
    if (id === UNAVAILABLE) return UNAVAILABLE;
    return id !== undefined && users.some((user) => user.permissionId === id);
  }

  async function outcomesFor(link: GoogleLink, recipients: readonly string[]): Promise<Outcome[]> {
    if (link.kind !== 'file') {
      const verdict = await visit({ url: link.probeUrl, form: link.kind === 'form' });
      const outcome: Outcome =
        verdict === UNAVAILABLE || verdict === 'opens'
          ? verdict
          : link.kind === 'form'
            ? { kind: 'form', verdict }
            : { kind: 'published' };
      return recipients.map(() => outcome);
    }
    const read = await readFile(link.fileId);
    if (read === UNAVAILABLE) return recipients.map(() => UNAVAILABLE);
    const at = now().getTime();
    const permissions = read === NO_DRIVE ? undefined : read.permissions?.filter((p) => counts(p, at));
    if (permissions?.some((permission) => permission.type === 'anyone')) return recipients.map(() => 'opens');
    const file = read === NO_DRIVE ? undefined : read.file;
    if (file?.trashed === true) return recipients.map(() => ({ kind: 'trashed' }));

    // What Drive itself says of each recipient: by the access list when the assistant may read it, else by the owners.
    const users = permissions
      ?.filter((permission) => permission.type === 'user')
      .map((permission) => ({
        ...(permission.emailAddress === undefined ? {} : { emailAddress: permission.emailAddress }),
        permissionId: permission.id,
      }));
    const domains = (permissions ?? []).flatMap((permission) =>
      permission.type === 'domain' && permission.domain !== undefined ? [permission.domain.toLowerCase()] : [],
    );
    const group = permissions?.some((permission) => permission.type === 'group') ?? false;
    const decided: (Outcome | undefined)[] = await Promise.all(
      recipients.map(async (recipient): Promise<Outcome | undefined> => {
        if (users !== undefined) {
          const confirmed = await confirmedByDrive(recipient, users, domains);
          if (confirmed === UNAVAILABLE) return UNAVAILABLE;
          return confirmed ? 'opens' : { kind: 'not-shared', group };
        }
        if (file !== undefined) {
          const confirmed = await confirmedByDrive(recipient, file.owners ?? [], []);
          if (confirmed === UNAVAILABLE) return UNAVAILABLE;
          if (confirmed) return 'opens';
        }
        return undefined;
      }),
    );
    if (decided.every((outcome) => outcome !== undefined)) return decided;

    // Drive cannot say for the rest, so see what someone signed out sees.
    const verdict = await visit({ url: fileProbeUrl(link, file?.mimeType), form: false });
    const unconfirmed: Outcome =
      verdict === UNAVAILABLE || verdict === 'opens'
        ? verdict
        : read === NO_DRIVE
          ? { kind: 'no-drive' }
          : file === undefined
            ? { kind: 'unseen' }
            : { kind: 'view-only', owners: (file.owners ?? []).flatMap((owner) => owner.emailAddress ?? []) };
    return decided.map((outcome) => outcome ?? unconfirmed);
  }

  return {
    async check(request) {
      const links = googleLinksIn(request.texts);
      if (links.length === 0) return { allowed: true };
      const principal = await principalAddresses();
      const recipients = [...new Set(request.recipients.map(normalized))].filter((address) => !principal.has(address));
      if (recipients.length === 0) return { allowed: true };
      const outcomes = await inTurn(links, READS_AT_ONCE, (link) => outcomesFor(link, recipients));
      const refused: Refused[] = [];
      let unavailable = false;
      links.forEach((link, linkIndex) => {
        recipients.forEach((recipient, recipientIndex) => {
          const outcome = outcomes[linkIndex]?.[recipientIndex];
          if (outcome === UNAVAILABLE) unavailable = true;
          else if (outcome !== undefined && outcome !== 'opens') refused.push({ link, recipient, why: outcome });
        });
      });
      if (refused.length > 0) {
        return {
          allowed: false,
          reason: request.writer === 'main' ? reasonForMain(refused, principal) : reasonForExternalEmail(refused),
        };
      }
      if (unavailable) throw new LinkCheckUnavailableError();
      return { allowed: true };
    },
  };
}

// ---------------------------------------------------------------------------
// Reasons
// ---------------------------------------------------------------------------

interface Refused {
  readonly link: GoogleLink;
  readonly recipient: string;
  readonly why: Unconfirmed;
}

function listed(items: readonly string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1) ?? ''}`;
}

const CHOICES = 'leave them out, or send it without the link.';

/** One sentence for `main`: who cannot open which link, why, and what it can do. */
function sentenceForMain(url: string, who: string, why: Unconfirmed, principal: ReadonlySet<string>): string {
  switch (why.kind) {
    case 'not-shared':
      return why.group
        ? `${who} may not be able to open ${url}: it is shared with a group, and the host can't tell who is in it. Share it with them directly (view-only, unless they need more), ${CHOICES}`
        : `${who} can't open ${url}: it isn't shared with them. Share it with them (view-only, unless they need more), ${CHOICES}`;
    case 'trashed':
      return `${who} can't open ${url}: it is in the trash. Restore it, or send it without the link.`;
    case 'view-only': {
      const owner = why.owners[0];
      const isPrincipal = owner !== undefined && principal.has(owner.toLowerCase());
      const belongs = owner === undefined ? 'someone else' : isPrincipal ? `the principal (${owner})` : owner;
      const ask = owner === undefined ? 'its owner' : isPrincipal ? 'the principal' : owner;
      return `${who} may not be able to open ${url}: it belongs to ${belongs}, and the assistant can only view it, so it can't see who else may open it or share it. Ask ${ask} to share it with them, ${CHOICES}`;
    }
    case 'unseen':
      return `${who} may not be able to open ${url}: the assistant can't open it either, so it can't tell who can. Leave them out, or send it without the link.`;
    case 'form':
      switch (why.verdict) {
        case 'not-accepting':
          return `${url} is a form that isn't published or isn't taking responses, so ${who} can't answer it. Publish it and open it to responses, if it is yours to change, or send it without the link.`;
        case 'sign-in':
          return `${who} may not be able to answer ${url}: only certain people may respond to it. Let anyone with the link respond, if it is yours to change, ${CHOICES}`;
        case 'not-found':
          return `${url} doesn't open for anyone signed out: it may not be published, or may no longer exist. Check the link, or send it without it.`;
        case 'unconfirmed':
          return `${who} may not be able to answer ${url}: the host couldn't confirm the form opens for them. Leave them out, or send it without the link.`;
        default: {
          const unreachable: never = why.verdict;
          throw new Error(`Unknown form verdict: ${String(unreachable)}`);
        }
      }
    case 'published':
      return `${url} doesn't open for anyone signed out: it may not be published, or may no longer exist. Check the link, or send it without it.`;
    case 'no-drive':
      return `the host can't check who may open ${url}, because ${OPERATOR_REASON}. Until then, send it without the link.`;
    default: {
      const unreachable: never = why;
      throw new Error(`Unknown reason: ${JSON.stringify(unreachable)}`);
    }
  }
}

/** Why a refusal is what it is, so recipients refused for the same reason share one sentence. */
function whyKey(why: Unconfirmed): string {
  return JSON.stringify(why);
}

function reasonForMain(refused: readonly Refused[], principal: ReadonlySet<string>): string {
  const groups = new Map<string, { url: string; why: Unconfirmed; recipients: string[] }>();
  for (const { link, recipient, why } of refused) {
    const key = `${link.url}\u0000${whyKey(why)}`;
    const group = groups.get(key) ?? { url: link.url, why, recipients: [] };
    group.recipients.push(recipient);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map(({ url, why, recipients }) => sentenceForMain(url, listed(recipients), why, principal))
    .join(' ');
}

/** For `external-email`: only which of its recipients cannot open a link, nothing of the file, and to tell main. */
function reasonForExternalEmail(refused: readonly Refused[]): string {
  const blocked = [...new Set(refused.filter(({ why }) => why.kind !== 'no-drive').map(({ recipient }) => recipient))];
  const unchecked = refused.some(({ why }) => why.kind === 'no-drive');
  return [
    ...(blocked.length === 0 ? [] : [`${listed(blocked)} can't open a Google link in it.`]),
    ...(unchecked ? [`a Google link in it can't be checked, because ${OPERATOR_REASON}.`] : []),
    blocked.length === 0 ? 'Tell main.' : "Tell main which link, and who can't open it.",
  ].join(' ');
}

// ---------------------------------------------------------------------------
// The host's own check
// ---------------------------------------------------------------------------

/** How long one Drive read may take before the check counts Google as briefly unavailable. */
const DRIVE_READ_TIMEOUT_MS = 5_000;

/** `fetch` held to the check's own short deadline, beside any the caller set. */
const shortFetch: typeof globalThis.fetch = (input, init) => {
  const deadline = AbortSignal.timeout(DRIVE_READ_TIMEOUT_MS);
  const signal = init?.signal ? AbortSignal.any([init.signal, deadline]) : deadline;
  return globalThis.fetch(input, { ...init, signal });
};

/** The host's Drive token, its failures sorted: no sign-in at all is the operator's to fix; an unreachable token endpoint is brief. */
async function driveToken(): Promise<string> {
  try {
    return await hostGoogleAccessToken('drive-host');
  } catch (error) {
    if (
      error instanceof GoogleTokenError ||
      error instanceof GoogleScopeNotGrantedError ||
      error instanceof GoogleGrantRevokedError
    ) {
      throw error;
    }
    if (error instanceof TypeError || (error instanceof DOMException && error.name === 'TimeoutError')) {
      throw new GoogleApiError(0, 'Google could not be reached for a Drive token', { cause: error });
    }
    throw new NoGoogleSignInError(error);
  }
}

let shared: LinkAccess | undefined;

/**
 * Check that everyone a message reaches, the principal aside, can open every
 * Google link in what the assistant wrote. Throws
 * `LinkCheckUnavailableError` when Google was too briefly unavailable to
 * decide.
 */
export function checkLinksOpenable(request: LinkCheckRequest): Promise<LinkCheck> {
  shared ??= createLinkAccess({
    drive: createDriveApi({ token: driveToken, fetch: shortFetch }),
    probe: (target) => probeLink(target),
  });
  return shared.check(request);
}
