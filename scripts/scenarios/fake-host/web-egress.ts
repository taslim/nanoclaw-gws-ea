import type { ScenarioCase } from '../types.js';

export const PUBLIC_WEB_CASES: ReadonlySet<string> = new Set(['commute-day', 'home-day', 'today-exception']);

/** Native CLI account metadata is outside the invented task and must never become a web query. */
export function webEgressRefusal(
  scenario: ScenarioCase,
  tool: string,
  args: Readonly<Record<string, unknown>>,
): string | undefined {
  if (!PUBLIC_WEB_CASES.has(scenario.id)) return 'Public web transport is unavailable for this scenario.';
  let text = JSON.stringify(args);
  try {
    text = decodeURIComponent(text);
  } catch (error) {
    if (error instanceof URIError) return 'Malformed encoded web request.';
    throw error;
  }
  if (/[A-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[A-Z0-9.-]+/iu.test(text))
    return 'An email address cannot leave this synthetic fixture in a web request.';
  if (
    /\b(?:Morgan\s+Ellery|Juno\s+Hale|Remy\s+Vance|14\s+Imaginary\s+Terrace)\b/iu.test(text) ||
    /(?:\+?\d[\s().-]*){9,}/u.test(text) ||
    (scenario.privateMarkers ?? []).some((marker) =>
      text.toLocaleLowerCase('en').includes(marker.toLocaleLowerCase('en')),
    )
  )
    return 'Private task identity or contact data cannot leave this synthetic fixture in a web request.';
  if (tool === 'WebFetch') {
    try {
      const url = new URL(String(args.url));
      if (url.protocol !== 'https:' || url.username || url.password)
        return 'This fixture permits native public HTTPS reads only.';
    } catch (error) {
      if (error instanceof TypeError) return 'A native web fetch requires a valid public HTTPS URL.';
      throw error;
    }
  }
  return undefined;
}
