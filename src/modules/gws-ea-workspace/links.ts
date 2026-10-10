/**
 * The Google links the link check reads (KTD5): exactly the Docs, Sheets,
 * Slides, Forms and Drive shapes on exactly docs.google.com,
 * drive.google.com and forms.gle, however the scheme, userinfo or port was
 * written, since a visit only ever goes to an https address rebuilt from
 * the id.
 *
 * - A file link names a Drive item by its id: a Doc, Sheet, deck or form to
 *   edit, a Drive file or folder, or `open?id=` and `uc?id=`. The `/u/N/`
 *   account and `/a/<domain>/` prefixes are read past, and a resource key is
 *   kept exactly.
 * - A form's responder link, `/forms/d/e/<id>/…`, a `/viewform` by file id,
 *   or a `forms.gle` short link, names who may answer through the form's own
 *   settings, not through Drive, so only a signed-out visit can judge it.
 * - A file published to the web (`/d/e/<id>/pub`, or `/pub` by file id)
 *   opens for anyone while it stays published, again judged by a visit.
 *
 * Every other URL passes untouched: Meet, Calendar, Maps, googleapis.com,
 * and any redirector, which is never read through. Links are found in the
 * text as written and among a markdown reader's link targets, the reading
 * the privacy check gives (`linkTargets`).
 *
 * A leaf (KTD4): it imports only the privacy module's link reading.
 */
import { linkTargets } from '../gws-ea-privacy/index.js';

/** What a file link's path says it is: a Docs editor's file, or a Drive file or folder. */
export type LinkedProduct = 'document' | 'spreadsheets' | 'presentation' | 'forms' | 'file' | 'folder';

export type GoogleLink =
  /** A Drive item by its id, which Drive can say who may open. */
  | {
      readonly kind: 'file';
      readonly url: string;
      readonly fileId: string;
      readonly product?: LinkedProduct;
      readonly resourceKey?: string;
    }
  /** A form's responder link: who may answer it is the form's setting. */
  | { readonly kind: 'form'; readonly url: string; readonly probeUrl: string }
  /** A file published to the web: anyone opens it while it stays published. */
  | { readonly kind: 'published'; readonly url: string; readonly probeUrl: string };

const DOCS = 'docs.google.com';
const DRIVE = 'drive.google.com';
const SHORT_FORMS = 'forms.gle';
const EDITORS = ['document', 'spreadsheets', 'presentation', 'forms'] as const;
const RESPONDER_PAGES: ReadonlySet<string> = new Set(['viewform', 'formResponse']);
const PUBLISHED_PAGES: ReadonlySet<string> = new Set(['pub', 'pubhtml']);
const ID = /^[A-Za-z0-9_-]+$/u;
const SHORT_CODE = /^[A-Za-z0-9]+$/u;

function isEditor(segment: string | undefined): segment is (typeof EDITORS)[number] {
  return EDITORS.some((editor) => editor === segment);
}

/** A URL as the link check reads one: https on a checked host, with no userinfo and no port. */
/**
 * A URL on exactly one of the three hosts, over http or https. How it was
 * written (http, userinfo, a port) doesn't excuse it from the check: the
 * check reads only the file id or form it names, and any visit goes to an
 * https address rebuilt from that id, never to the URL as written.
 */
function checkedUrl(candidate: string): URL | undefined {
  const url = URL.parse(candidate);
  if (url === null) return undefined;
  const exact = url.hostname === DOCS || url.hostname === DRIVE || url.hostname === SHORT_FORMS;
  return (url.protocol === 'https:' || url.protocol === 'http:') && exact ? url : undefined;
}

/** A path's segments without the `/a/<domain>/` and `/u/N/` prefixes Google adds for an account. */
function segmentsOf(pathname: string): string[] {
  let segments = pathname.split('/').filter((segment) => segment !== '');
  if (segments[0] === 'a' && segments.length > 2) segments = segments.slice(2);
  // `/u/N/` leads a Drive path (`/u/0/open`) or follows its first segment (`/document/u/0/d/…`, `/drive/u/0/folders/…`).
  for (const at of [0, 1]) {
    if (segments[at] === 'u' && /^\d+$/u.test(segments[at + 1] ?? '')) {
      segments = [...segments.slice(0, at), ...segments.slice(at + 2)];
      break;
    }
  }
  return segments;
}

function fileLink(url: URL, written: string, fileId: string, product: LinkedProduct | undefined): GoogleLink {
  const resourceKey = url.searchParams.get('resourcekey');
  return {
    kind: 'file',
    url: written,
    fileId,
    ...(product === undefined ? {} : { product }),
    ...(resourceKey === null || resourceKey === '' ? {} : { resourceKey }),
  };
}

function docsLink(url: URL, written: string, segments: readonly string[]): GoogleLink | undefined {
  const [product, d, first, second, third] = segments;
  if (!isEditor(product) || d !== 'd' || first === undefined) return undefined;
  if (first === 'e') {
    if (second === undefined || !ID.test(second)) return undefined;
    if (product === 'forms') {
      return { kind: 'form', url: written, probeUrl: `https://${DOCS}/forms/d/e/${second}/viewform` };
    }
    const page = third !== undefined && PUBLISHED_PAGES.has(third) ? third : 'pub';
    return { kind: 'published', url: written, probeUrl: `https://${DOCS}/${product}/d/e/${second}/${page}` };
  }
  if (!ID.test(first)) return undefined;
  if (product === 'forms' && second !== undefined && RESPONDER_PAGES.has(second)) {
    return { kind: 'form', url: written, probeUrl: `https://${DOCS}/forms/d/${first}/viewform` };
  }
  if (second !== undefined && PUBLISHED_PAGES.has(second)) {
    return { kind: 'published', url: written, probeUrl: `https://${DOCS}/${product}/d/${first}/${second}` };
  }
  return fileLink(url, written, first, product);
}

function driveLink(url: URL, written: string, segments: readonly string[]): GoogleLink | undefined {
  const [first, second, third] = segments;
  if (first === 'file' && second === 'd' && third !== undefined && ID.test(third)) {
    return fileLink(url, written, third, 'file');
  }
  if (first === 'drive' && second === 'folders' && third !== undefined && ID.test(third)) {
    return fileLink(url, written, third, 'folder');
  }
  if ((first === 'open' || first === 'uc') && second === undefined) {
    const id = url.searchParams.get('id');
    if (id !== null && ID.test(id)) return fileLink(url, written, id, undefined);
  }
  return undefined;
}

/** The checked Google link `candidate` is, or undefined for any URL the check leaves untouched. */
export function googleLinkOf(candidate: string): GoogleLink | undefined {
  const url = checkedUrl(candidate);
  if (url === undefined) return undefined;
  const segments = segmentsOf(url.pathname);
  if (url.hostname === SHORT_FORMS) {
    const [code, rest] = segments;
    if (code === undefined || rest !== undefined || !SHORT_CODE.test(code)) return undefined;
    return { kind: 'form', url: candidate, probeUrl: `https://${SHORT_FORMS}/${code}` };
  }
  return url.hostname === DOCS ? docsLink(url, candidate, segments) : driveLink(url, candidate, segments);
}

/** An address as written in prose: up to whitespace or a character no URL is written with. */
const WRITTEN_URL = /https?:\/\/[^\s<>"'`\\]+/giu;
/** Sentence and markdown punctuation that ends a written address but is never part of a Google link. */
const TRAILING = /[.,;:!?)\]}*'"]+$/u;

function identity(link: GoogleLink): string {
  return link.kind === 'file' ? `file:${link.fileId}` : `visit:${link.probeUrl}`;
}

/**
 * The checked Google links in these texts, each file or form once, in the
 * order they first appear: every address written in them and every link
 * target a markdown reader sees.
 */
export function googleLinksIn(texts: readonly string[]): GoogleLink[] {
  const found = new Map<string, GoogleLink>();
  for (const text of texts) {
    const written = (text.match(WRITTEN_URL) ?? []).map((address) => address.replace(TRAILING, ''));
    for (const candidate of [...written, ...linkTargets(text)]) {
      const link = googleLinkOf(candidate);
      if (link !== undefined && !found.has(identity(link))) found.set(identity(link), link);
    }
  }
  return [...found.values()];
}

const EDITOR_MIME_TYPES: Readonly<Record<string, LinkedProduct>> = {
  'application/vnd.google-apps.document': 'document',
  'application/vnd.google-apps.spreadsheet': 'spreadsheets',
  'application/vnd.google-apps.presentation': 'presentation',
  'application/vnd.google-apps.form': 'forms',
  'application/vnd.google-apps.folder': 'folder',
};

/**
 * Where a signed-out visit to a file goes: the page Google serves it on to
 * someone holding only its link, by what the link says it is or, when Drive
 * told the host, by its type. Never the link as written.
 */
export function fileProbeUrl(link: Extract<GoogleLink, { kind: 'file' }>, mimeType?: string): string {
  const product = (mimeType === undefined ? undefined : EDITOR_MIME_TYPES[mimeType]) ?? link.product;
  const id = encodeURIComponent(link.fileId);
  const page =
    product === 'folder'
      ? `https://${DRIVE}/drive/folders/${id}`
      : product === undefined || product === 'file'
        ? `https://${DRIVE}/file/d/${id}/view`
        : `https://${DOCS}/${product}/d/${id}/edit`;
  return link.resourceKey === undefined
    ? page
    : `${page}?${new URLSearchParams({ resourcekey: link.resourceKey }).toString()}`;
}
