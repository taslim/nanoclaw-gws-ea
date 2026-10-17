import type { Browser } from 'playwright-core';

/** A paused document request as the gate hands it to its page. */
export interface PausedDocument {
  url: string;
  headers: Record<string, string>;
}
/** A page's answer for one of its documents; `headers` replaces the request's headers when given. */
export type DocumentDecision = { allow: true; headers?: Array<{ name: string; value: string }> } | { allow: false };
/** A page's policy as it stood when one request paused. */
export interface CapturedPolicy {
  decide(document: PausedDocument): Promise<DocumentDecision>;
  /** The gate refused this request because it could not tell whether the document was the page's. */
  refuse(): void;
}
/** A guarded job page: it decides its own documents and lists the frames its targets host. */
export interface GuardedPage {
  /** Runs synchronously when a request pauses, so later scope changes cannot reach its decision. */
  capture(): CapturedPolicy;
  /** Every frame id the page's targets host now, or undefined when they cannot all be read. */
  frameIds(): Promise<ReadonlySet<string> | undefined>;
}
export interface DocumentGate {
  /** `targetId` is the page target id, which is also its main frame's id. Returns the unregistration. */
  register(targetId: string, page: GuardedPage): () => void;
}

type Owner = GuardedPage | 'unguarded' | { uncertain: GuardedPage[] };
const gates = new WeakMap<Browser, Promise<DocumentGate>>();

/**
 * One browser-level Fetch session per Chrome connection pauses every document from its first
 * request, in every target, including a cross-site frame that navigates itself while loading.
 * Each document goes to the guard of the page it belongs to. A page without a guard has its documents
 * continued unchanged; a document the gate cannot place with certainty is refused.
 */
export function documentGate(browser: Browser): Promise<DocumentGate> {
  let gate = gates.get(browser);
  if (!gate) {
    gate = openDocumentGate(browser);
    gates.set(browser, gate);
    browser.once('disconnected', () => gates.delete(browser));
    void gate.catch(() => gates.delete(browser));
  }
  return gate;
}

async function openDocumentGate(browser: Browser): Promise<DocumentGate> {
  const session = await browser.newBrowserCDPSession();
  const pages = new Map<string, GuardedPage>();
  // Frames already traced to their page. A frame id belongs to one frame tree node for its lifetime.
  const frames = new Map<string, GuardedPage>();

  // A same-process child frame is no target: only the covering sessions' frame trees place it.
  const sameProcessOwner = async (frameId: string): Promise<Owner> => {
    const unread: GuardedPage[] = [];
    for (const page of new Set(pages.values())) {
      const hosted = await page.frameIds();
      if (!hosted) unread.push(page);
      else if (hosted.has(frameId)) {
        frames.set(frameId, page);
        return page;
      }
    }
    return unread.length ? { uncertain: unread } : 'unguarded';
  };
  const ownerOf = async (frameId: string, depth = 0): Promise<Owner> => {
    const known = pages.get(frameId) ?? frames.get(frameId);
    if (known) return known;
    if (depth > 16) return { uncertain: [...pages.values()] };
    let info;
    try {
      ({ targetInfo: info } = await session.send('Target.getTargetInfo', { targetId: frameId }));
      // eslint-disable-next-line no-catch-all/no-catch-all -- Any other lookup failure leaves the owner uncertain, which refuses.
    } catch (error) {
      if (error instanceof Error && error.message.includes('No target with given id found'))
        return sameProcessOwner(frameId);
      return { uncertain: [...pages.values()] };
    }
    // A page target is its own main frame; the registered ones were matched above.
    if (info.type === 'page') return 'unguarded';
    if (info.type !== 'iframe' || !info.parentFrameId) return { uncertain: [...pages.values()] };
    const parent = await ownerOf(info.parentFrameId, depth + 1);
    if (typeof parent !== 'string' && !('uncertain' in parent)) frames.set(frameId, parent);
    return parent;
  };

  session.on('Fetch.requestPaused', (event) => {
    // Every guard's policy is taken as it stood at the pause, before attribution can await.
    const captured = new Map<GuardedPage, CapturedPolicy>();
    for (const page of new Set(pages.values())) captured.set(page, page.capture());
    const document = { url: event.request.url, headers: event.request.headers };
    void (async () => {
      let decision: DocumentDecision;
      const found = await ownerOf(event.frameId).catch((): Owner => ({ uncertain: [...captured.keys()] }));
      if (found === 'unguarded') decision = { allow: true };
      else if ('uncertain' in found) {
        for (const page of found.uncertain) captured.get(page)?.refuse();
        decision = { allow: false };
      } else {
        // A page whose guard registered after this request paused had none when it paused.
        const policy = captured.get(found);
        decision = policy
          ? await policy.decide(document).catch((): DocumentDecision => ({ allow: false }))
          : { allow: true };
      }
      if (decision.allow)
        await session
          .send('Fetch.continueRequest', {
            requestId: event.requestId,
            ...(decision.headers ? { headers: decision.headers } : {}),
          })
          .catch(() =>
            session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' }),
          );
      else await session.send('Fetch.failRequest', { requestId: event.requestId, errorReason: 'BlockedByClient' });
    })().catch(() => {
      // Only a send fails here, once its request or its target is gone: nothing was let through.
    });
  });
  await session.send('Fetch.enable', { patterns: [{ requestStage: 'Request', resourceType: 'Document' }] });
  return {
    register(targetId, page) {
      pages.set(targetId, page);
      return () => {
        if (pages.get(targetId) === page) pages.delete(targetId);
        for (const [frameId, owner] of frames) if (owner === page) frames.delete(frameId);
      };
    },
  };
}
