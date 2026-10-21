import type { BrowserContext, Page } from 'playwright-core';

import { prepareAuthenticationIsolation } from './authentication-submit.js';
import {
  applyChromeContextPolicy,
  createBackgroundPage,
  verifyChromePolicy,
  type ChromeConnection,
} from './connection.js';

const creationTails = new WeakMap<ChromeConnection, Promise<void>>();

/** Public availability checks get no cookies from the assistant's persistent account. */
export async function withSignedOutBrowserPage<T>(
  connection: ChromeConnection,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const { context, browserContextId } = await createContext(connection);
  try {
    await prepareAuthenticationIsolation(context, true);
    await applyChromeContextPolicy(connection.session, browserContextId);
    const probe = await createBackgroundPage(connection, context, browserContextId);
    try {
      await verifyChromePolicy(probe);
    } finally {
      await probe.close();
    }
    const page = await createBackgroundPage(connection, context, browserContextId);
    return await operation(page);
  } finally {
    await closeContext(connection, context);
  }
}

async function closeContext(connection: ChromeConnection, context: BrowserContext): Promise<void> {
  try {
    await context.close();
  } catch (error) {
    await connection.close();
    throw new Error('Signed-out browser context could not be closed', { cause: error });
  }
}

/** Serialize only native id discovery; independent signed-out checks can then run concurrently. */
async function createContext(
  connection: ChromeConnection,
): Promise<{ context: BrowserContext; browserContextId: string }> {
  const prior = creationTails.get(connection) ?? Promise.resolve();
  let release!: () => void;
  const tail = new Promise<void>((resolve) => {
    release = resolve;
  });
  creationTails.set(connection, tail);
  await prior;
  let context: BrowserContext | undefined;
  try {
    const before = new Set((await connection.session.send('Target.getBrowserContexts')).browserContextIds);
    context = await connection.browser.newContext({ viewport: null, acceptDownloads: false });
    const after = (await connection.session.send('Target.getBrowserContexts')).browserContextIds;
    const created = after.filter((id) => !before.has(id));
    if (created.length !== 1 || !created[0]) throw new Error('Signed-out browser context identity is ambiguous');
    return { context, browserContextId: created[0] };
  } catch (error) {
    if (context) await closeContext(connection, context);
    throw error;
  } finally {
    release();
    if (creationTails.get(connection) === tail) creationTails.delete(connection);
  }
}
