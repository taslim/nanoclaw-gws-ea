import { randomUUID } from 'node:crypto';
import type { BrowserNavigationGuard } from './commit-classifier.js';
import type { HeldRequest } from './document-gate.js';

/** Where a credential hold lets host-filled values go. */
export interface SubmissionSite {
  /** The registrable domain the filled values stay on. */
  readonly site: string;
  /** The values the host filled: a request to another site that carries one is refused. */
  readonly values: readonly string[];
  /**
   * Hears each document the hold refused for leaving the site. A refused script request only records a diagnostic:
   * a sign-in page's own telemetry beacons do not make its sign-in fail.
   */
  readonly departed?: () => void;
}

function decoded(text: string): string {
  try {
    return decodeURIComponent(text.replace(/\+/gu, ' '));
    // eslint-disable-next-line no-catch-all/no-catch-all -- text that is not percent-encoding is read as it is
  } catch (_error) {
    return text;
  }
}

/** The forms a page script commonly sends a value in: as typed, URL- or form-encoded, JSON-escaped, or base64. */
export function sentForms(values: readonly string[]): string[] {
  return values.flatMap((value) => {
    const base64 = Buffer.from(value, 'utf8').toString('base64');
    return [
      value,
      encodeURIComponent(value),
      new URLSearchParams({ v: value }).toString().slice(2),
      JSON.stringify(value).slice(1, -1),
      base64,
      base64.replace(/=+$/u, ''),
      Buffer.from(value, 'utf8').toString('base64url'),
    ].map((form) => form.toLowerCase());
  });
}

/** Case-insensitive, since a host name in an address is lowercased on the way out. */
export function readTexts(texts: readonly string[]): string[] {
  return texts.flatMap((text) => [text.toLowerCase(), decoded(text).toLowerCase()]);
}

function carriesForms(read: readonly string[], forms: readonly string[]): boolean {
  return forms.some((form) => read.some((text) => text.includes(form)));
}

/** Whether an address carries any of `values`, in any form a page script commonly sends one. */
export function carriesSecret(url: URL, values: readonly string[]): boolean {
  return carriesForms(readTexts([url.href, ...url.searchParams.values(), url.hash]), sentForms(values));
}

/**
 * Holds `guard`'s page to `site` from before `values` reach it until the returned release: no document but a GET
 * leaves the site and no request carries a value to another site, whatever any other hold allows meanwhile.
 */
export function holdOnSite(
  guard: BrowserNavigationGuard,
  site: string,
  values: readonly string[],
  departed?: () => void,
): () => void {
  const authority = `on-site:${randomUUID()}`;
  guard.holdSubmissions(authority, { site, values, ...(departed ? { departed } : {}) });
  return () => guard.allowSubmissions(authority);
}

/** A sited hold with its values' sent forms read once, as it was placed. */
export interface PlacedHold {
  readonly onSite: SubmissionSite;
  readonly forms: readonly string[];
}

/** A document leaves by being sent anywhere but the site as anything but a GET. */
export function holdRefusesDocument(
  hold: PlacedHold | undefined,
  document: HeldRequest,
  site: string | undefined,
): boolean {
  return !hold || (document.method.toUpperCase() !== 'GET' && site !== hold.onSite.site);
}

/** Any other request leaves only by carrying a filled value to another site, or a body the gate could not read. */
export function holdRefusesRequest(
  hold: PlacedHold | undefined,
  request: HeldRequest,
  site: string | undefined,
  read: () => readonly string[],
): boolean {
  if (!hold) return true;
  if (site === hold.onSite.site) return false;
  return request.body === undefined || carriesForms(read(), hold.forms);
}
