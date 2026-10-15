import { getBrowserRuntime } from './index.js';

/** Host-only status contains no URLs, credentials, cookies, page text or debugging transport. */
export async function browserHealth(): Promise<
  { schemaVersion: 1 } & ReturnType<ReturnType<typeof getBrowserRuntime>['state']>
> {
  const runtime = getBrowserRuntime();
  await runtime.reconcile();
  return { schemaVersion: 1, ...runtime.state() };
}
