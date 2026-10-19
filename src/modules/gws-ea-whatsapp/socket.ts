import { fetchLatestWaWebVersion } from '@whiskeysockets/baileys';

/** Refuse Baileys' baked-in fallback: it is returned with isLatest=false/error when the lookup fails. */
export async function resolveWaWebVersion(): Promise<[number, number, number]> {
  const failures: unknown[] = [];
  /* eslint-disable no-catch-all/no-catch-all -- both network lookups may fail; never substitute Baileys' built-in version */
  try {
    const response = await fetch('https://wppconnect.io/whatsapp-versions/', { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const match = /\b2\.3000\.(\d+)\b/u.exec(await response.text());
      if (match) return [2, 3000, Number(match[1])];
    }
  } catch (error) {
    failures.push(error);
  }
  try {
    const result = await fetchLatestWaWebVersion({ signal: AbortSignal.timeout(5000) });
    if (result.isLatest && !result.error) return result.version;
    failures.push(result.error);
  } catch (error) {
    failures.push(error);
  }
  /* eslint-enable no-catch-all/no-catch-all */
  throw new Error('Could not resolve the current WhatsApp Web version; no socket was opened', {
    cause: new AggregateError(failures),
  });
}
