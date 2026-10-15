import type { BrowserContext, Page } from 'playwright-core';

import { prepareAuthenticationIsolation } from './authentication-submit.js';
import { secureJobPage, type ChromeConnection } from './connection.js';

const creationTails = new WeakMap<ChromeConnection, Promise<void>>();

/** Public availability checks get no cookies from the assistant's persistent account. */
export async function withSignedOutBrowserPage<T>(
  connection: ChromeConnection,
  operation: (page: Page) => Promise<T>,
): Promise<T> {
  const { context, browserContextId } = await createContext(connection);
  try {
    await prepareAuthenticationIsolation(context, true);
    for (const name of ['clipboard-read', 'clipboard-write', 'local-network-access']) {
      await connection.session.send('Browser.setPermission', {
        permission: { name },
        setting: 'denied',
        browserContextId,
      });
    }
    await connection.session.send('Browser.setDownloadBehavior', { behavior: 'deny', browserContextId });
    const probe = await createBackgroundPage(connection, context, browserContextId);
    try {
      await secureJobPage(probe);
      await verifyInheritedPolicy(probe);
    } finally {
      await probe.close();
    }
    const page = await createBackgroundPage(connection, context, browserContextId);
    await secureJobPage(page);
    if (page.viewportSize() !== null) throw new Error('Chrome unexpectedly enabled viewport emulation');
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

async function createBackgroundPage(
  connection: ChromeConnection,
  context: BrowserContext,
  browserContextId: string,
): Promise<Page> {
  let expectedId!: (id: string) => void;
  const expected = new Promise<string>((resolve) => {
    expectedId = resolve;
  });
  const appeared = context.waitForEvent('page', {
    timeout: 10_000,
    predicate: async (candidate) => {
      const targetId = await expected;
      if (!targetId || candidate.isClosed()) return false;
      const metadata = await context.newCDPSession(candidate);
      try {
        return (await metadata.send('Target.getTargetInfo')).targetInfo.targetId === targetId;
      } finally {
        await metadata.detach();
      }
    },
  });
  const created = connection.session
    .send('Target.createTarget', {
      url: 'about:blank',
      newWindow: true,
      background: true,
      browserContextId,
    })
    .then(
      ({ targetId }) => {
        expectedId(targetId);
      },
      (error: unknown) => {
        expectedId('');
        throw error;
      },
    );
  const [, page] = await Promise.all([created, appeared]);
  return page;
}

/** Incognito must inherit the profile's native policies before a website sees this page. */
async function verifyInheritedPolicy(page: Page): Promise<void> {
  const result: unknown = await page.evaluate(`new Promise((resolve) => {
    const peer = new RTCPeerConnection({iceServers: []});
    let candidates = 0;
    let finished = false;
    const finish = (complete) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      peer.close();
      resolve({complete, candidates});
    };
    const timer = setTimeout(() => finish(false), 3000);
    peer.onicecandidate = event => {if (event.candidate) candidates += 1;};
    peer.onicegatheringstatechange = () => {if (peer.iceGatheringState === 'complete') finish(true);};
    peer.createDataChannel('host-signed-out-policy-check');
    peer.createOffer().then(offer => peer.setLocalDescription(offer)).catch(() => finish(false));
  })`);
  if (
    typeof result !== 'object' ||
    result === null ||
    !('complete' in result) ||
    result.complete !== true ||
    !('candidates' in result) ||
    result.candidates !== 0
  )
    throw new Error('Signed-out Chrome WebRTC policy is unavailable');
  let blocked = false;
  try {
    await page.goto('nanoclaw-signed-out-policy-check://no-registered-handler');
  } catch (error) {
    if (error instanceof Error && error.message.includes('ERR_BLOCKED_BY_ADMINISTRATOR')) blocked = true;
    else throw error;
  }
  if (!blocked) throw new Error('Signed-out Chrome external-protocol policy is unavailable');
}
