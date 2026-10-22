/** A site's consent wording as an agent reads it, inside untrusted markers that name the site (consent.ts). */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');

/** Matches exactly `wording` from `site`, wrapped the way `untrusted` wraps it under any marker id. */
export function siteWordingPattern(wording: string, site: string): RegExp {
  return new RegExp(
    `^<<<EXTERNAL_UNTRUSTED_CONTENT id="([0-9a-f]{16})">>>\\nSource: ${escaped(site)}\\n---\\n${escaped(wording)}\\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="\\1">>>$`,
    'u',
  );
}
