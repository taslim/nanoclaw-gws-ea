import type { RequestListener } from 'node:http';
import type { GuardedAction } from '../../guard/index.js';
import { WEB_PUBLIC_PATHS } from '../../gws-ea/web-cloudflare.js';
import { listPrincipalAddresses } from '../gws-ea-profile/db.js';
import type { WebIdentity } from './access.js';
import type { IconName } from './kit/html.js';
import type { WebPolicyFile } from './policy.js';

export type WebMethod = 'GET' | 'HEAD' | 'POST';
/** `/` matches only the root; any other path matches itself and everything below it. */
export type WebMountPath = '/' | `/${string}`;
export type WebHandlerFactory = (config: WebPolicyFile, identity: WebIdentity) => RequestListener;

interface WebMountBase {
  readonly name: string;
  readonly path: WebMountPath;
  readonly methods: readonly WebMethod[];
}

/** Served only after the web module has verified the principal, on every request. */
export interface PrincipalPageMount extends WebMountBase {
  readonly audience: 'principal';
  readonly handler: WebHandlerFactory;
  readonly title: string;
  /** Marks the page in the phone's tab bar. */
  readonly icon?: IconName;
  /** A rejection leaves the page listed without a summary. */
  readonly status: () => Promise<string>;
  /** Decides which agents may obtain this page's link. */
  readonly linkGuard: GuardedAction;
  /** Returned beside the link, so they must never carry a credential. */
  readonly linkFacts?: () => Promise<Readonly<Record<string, unknown>>>;
}

/** Authorizes its own readers; the web module only enforces sandboxing of authored content. */
export interface ArtifactReadersMount extends WebMountBase {
  readonly audience: 'artifact-readers';
  readonly handler: WebHandlerFactory;
  readonly admissionEmails: () => Promise<readonly string[]>;
  /** Responses on these paths render authored content and must carry an opaque-origin sandbox. */
  readonly authoredContent: (pathname: string) => boolean;
}

// A public mount never receives identity.
export interface PublicMount extends WebMountBase {
  readonly audience: 'public';
  readonly handler: (config: WebPolicyFile) => RequestListener;
}

export type WebMount = PrincipalPageMount | ArtifactReadersMount | PublicMount;

const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const PATH = /^(?:\/[a-z0-9]+(?:-[a-z0-9]+)*)+$/u;
const METHODS: readonly WebMethod[] = ['GET', 'HEAD', 'POST'];

export function mountCovers(path: WebMountPath, pathname: string): boolean {
  return path === '/' ? pathname === '/' : pathname === path || pathname.startsWith(`${path}/`);
}

function overlaps(left: WebMountPath, right: WebMountPath): boolean {
  return mountCovers(left, right) || mountCovers(right, left);
}

/**
 * The pathname every mount is matched on, or undefined when it could address something other than what it
 * spells: an encoded slash, backslash or dot, a dot segment, or an empty segment.
 */
export function normalizeWebPathname(url: string | undefined): string | undefined {
  if (!url?.startsWith('/')) return undefined;
  const [pathname] = url.split('?', 1);
  if (pathname === '/') return pathname;
  if (/%(?:2e|2f|5c)|\\/iu.test(pathname)) return undefined;
  return pathname
    .slice(1)
    .split('/')
    .some((segment) => segment === '' || segment === '.' || segment === '..')
    ? undefined
    : pathname;
}

export class WebMountRegistry {
  private readonly mounts: WebMount[] = [];

  register(mount: WebMount): void {
    if (!NAME.test(mount.name)) throw new Error(`Web mount name "${mount.name}" is invalid.`);
    if (mount.path !== '/' && !PATH.test(mount.path))
      throw new Error(`Web mount "${mount.name}" has an invalid path "${mount.path}".`);
    if (
      mount.methods.length === 0 ||
      new Set(mount.methods).size !== mount.methods.length ||
      mount.methods.some((method) => !METHODS.includes(method))
    )
      throw new Error(`Web mount "${mount.name}" has invalid methods.`);
    if (mount.audience === 'principal' && !mount.title.trim())
      throw new Error(`Principal page "${mount.name}" needs a title.`);
    if (mount.audience === 'public' && !WEB_PUBLIC_PATHS.some((pattern) => pattern === `${mount.path}/*`))
      throw new Error(`Public web mount "${mount.name}" is outside the paths Access serves publicly.`);
    for (const existing of this.mounts) {
      if (existing.name === mount.name) throw new Error(`Web mount "${mount.name}" is already registered.`);
      if (overlaps(existing.path, mount.path))
        throw new Error(`Web mount "${mount.name}" overlaps "${existing.name}" at ${mount.path}.`);
    }
    this.mounts.push(Object.freeze({ ...mount, methods: Object.freeze([...mount.methods]) }));
  }

  all(): readonly WebMount[] {
    return [...this.mounts];
  }

  principalPages(): readonly PrincipalPageMount[] {
    return this.mounts.filter((mount): mount is PrincipalPageMount => mount.audience === 'principal');
  }
}

const registry = new WebMountRegistry();

export function registerWebMount(mount: WebMount): void {
  registry.register(mount);
}

export function webMounts(): readonly WebMount[] {
  return registry.all();
}

export function principalPages(): readonly PrincipalPageMount[] {
  return registry.principalPages();
}

/** Access must admit the principal for principal pages and each artifact-readers mount's own readers. */
export async function webAdmissionEmails(mounts: readonly WebMount[] = webMounts()): Promise<string[]> {
  const [principal, readers] = await Promise.all([
    mounts.some((mount) => mount.audience === 'principal') ? listPrincipalAddresses() : [],
    Promise.all(mounts.flatMap((mount) => (mount.audience === 'artifact-readers' ? [mount.admissionEmails()] : []))),
  ]);
  return [...new Set([...principal.map(({ email }) => email), ...readers.flat()])].sort();
}
