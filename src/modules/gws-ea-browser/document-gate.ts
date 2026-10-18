import type { Browser, Page } from 'playwright-core';

import {
  ensurePageTargets,
  pageTargetFrameHosts,
  pageTargetId,
  PROTOCOL_READ_TIMEOUT_MS,
  withinTime,
} from './page-targets.js';

/** A paused document request as the gate hands it to its page. */
export interface PausedDocument {
  url: string;
  /** The request's HTTP method, as Chrome sends it. */
  method: string;
  headers: Record<string, string>;
  /**
   * The document is the guarded page's own top-level document. A frame's document, or a window's the page
   * opened, is not: its page decides it, by that page's site.
   */
  topLevel: boolean;
}
/** A page's answer for one of its documents; `headers` replaces the request's headers when given. */
export type DocumentDecision = { allow: true; headers?: Array<{ name: string; value: string }> } | { allow: false };
/** A page's policy as it stood when one request paused. */
export interface CapturedPolicy {
  decide(document: PausedDocument): Promise<DocumentDecision>;
  /** The gate refused this request because it could not tell whether the document was the page's. */
  refuse(): void;
}
/** A guarded job page decides its own documents, and those of every window it opens. */
export interface GuardedPage {
  /** Runs synchronously when a request pauses, so later scope changes cannot reach its decision. */
  capture(): CapturedPolicy;
}
export interface DocumentGate {
  /** `targetId` is the page target id, which is also its main frame's id. Returns the unregistration. */
  register(targetId: string, page: GuardedPage): () => void;
}

/** The target facts placement reads. */
interface TargetFacts {
  targetId: string;
  type: string;
  subtype?: string;
  openerId?: string;
  openerFrameId?: string;
  parentFrameId?: string;
}

/** A guard's own decision, its site lease included, is bounded too: no document waits forever. */
const DECISION_TIMEOUT_MS = 30_000;
/** Chrome can report a new target before Playwright surfaces its frames; placement re-reads for this long. */
const PLACEMENT_WAIT_MS = 1_000;
const PLACEMENT_INTERVAL_MS = 50;

/** A placed document: its guarded page, no guard at all, or a refusal blaming the pages left uncertain. */
type Owner = { page: GuardedPage } | 'unguarded' | { refuse: GuardedPage[] };
const gates = new WeakMap<Browser, Promise<DocumentGate>>();

/**
 * One browser-level Fetch session per Chrome connection pauses every document from its first
 * request, in every target, including a cross-site frame that navigates itself while loading and a
 * window a page opens. Each document goes to the guard of the page it belongs to; a window decides
 * under its opener's guard. A page without a guard, opened by no guarded page, has its documents
 * continued; a document the gate cannot place with certainty is refused.
 */
export function documentGate(browser: Browser): Promise<DocumentGate> {
  let gate = gates.get(browser);
  if (!gate) {
    const opening = openDocumentGate(browser);
    gate = opening;
    gates.set(browser, opening);
    browser.once('disconnected', () => {
      if (gates.get(browser) === opening) gates.delete(browser);
    });
    void opening.catch(() => {
      if (gates.get(browser) === opening) gates.delete(browser);
    });
  }
  return gate;
}

function serviceWorkerScript(headers: Record<string, string>): boolean {
  return Object.entries(headers).some(([name, value]) => name.toLowerCase() === 'service-worker' && value === 'script');
}

async function openDocumentGate(browser: Browser): Promise<DocumentGate> {
  const session = await browser.newBrowserCDPSession();
  const pages = new Map<string, GuardedPage>();
  // Frames already traced to their guarded page. Pruned to what some page still hosts after each full read.
  const frames = new Map<string, GuardedPage>();
  const guarded = (): GuardedPage[] => [...new Set(pages.values())];
  const targetInfo = async (targetId: string): Promise<TargetFacts> =>
    (await withinTime(session.send('Target.getTargetInfo', { targetId }), PROTOCOL_READ_TIMEOUT_MS)).targetInfo;

  const ownerOfTarget = (info: TargetFacts, visited: Set<string>, search: boolean): Promise<Owner> => {
    if (info.type === 'page') {
      // A prerendered page is refused, so its activation falls back to a navigation the gate decides.
      if (info.subtype === 'prerender') return Promise.resolve({ refuse: [] });
      // A window decides under its opener; only a page nobody opened is unguarded.
      const opener = info.openerFrameId ?? info.openerId;
      return opener ? ownerOf(opener, visited, search) : Promise.resolve('unguarded');
    }
    if (info.type === 'iframe' && info.parentFrameId) return ownerOf(info.parentFrameId, visited, search);
    // A worker, or any other target, is no page's frame.
    return Promise.resolve({ refuse: info.type === 'iframe' ? guarded() : [] });
  };

  const ownerOf = async (frameId: string, visited = new Set<string>(), search = true): Promise<Owner> => {
    const known = pages.get(frameId) ?? frames.get(frameId);
    if (known) return { page: known };
    if (visited.has(frameId)) return { refuse: [] };
    visited.add(frameId);
    let info: TargetFacts | undefined;
    try {
      info = await targetInfo(frameId);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Any other lookup failure leaves the owner uncertain, which refuses.
    } catch (error) {
      if (!(error instanceof Error && error.message.includes('No target with given id found')))
        // No answer about this frame: none of the guarded pages can be ruled out.
        return { refuse: guarded() };
      if (!search) return { refuse: [] };
    }
    const owner = info ? await ownerOfTarget(info, visited, search) : await hostOf(frameId, visited);
    // A frame id names one frame for its lifetime, so a frame placed on a guarded page stays placed.
    if (typeof owner !== 'string' && 'page' in owner) frames.set(frameId, owner.page);
    return owner;
  };

  // A same-process child frame is no target. Every open page's frame trees are read, guarded or not,
  // so the frame is placed with the target that hosts it; it is never taken as unguarded by absence.
  const hostOf = async (frameId: string, visited: Set<string>): Promise<Owner> => {
    const started = Date.now();
    for (;;) {
      const open = browser
        .contexts()
        .flatMap((context) => context.pages())
        .filter((page) => !page.isClosed());
      // Each page's read is bounded as a whole: covering its frames, then reading their trees.
      const reads = await Promise.all(
        open.map((page) =>
          withinTime(
            ensurePageTargets(page).then(() => pageTargetFrameHosts(page)),
            PROTOCOL_READ_TIMEOUT_MS,
          ).catch(() => undefined),
        ),
      );
      const unread = open.filter((_page, index) => !reads[index]);
      if (!unread.length) {
        const hosted = new Set(reads.flatMap((hosts) => (hosts ? [...hosts.keys()] : [])));
        for (const cached of frames.keys()) if (!hosted.has(cached)) frames.delete(cached);
      }
      const host = reads.find((hosts) => hosts?.has(frameId))?.get(frameId);
      if (host) return ownerOf(host, visited);
      const covered = new Set(reads.flatMap((hosts) => (hosts ? [...hosts.values()] : [])));
      // Only a target Chrome runs that Playwright has not surfaced yet is worth waiting for.
      const pending = await uncoveredTargets(covered);
      if (!pending.length || Date.now() - started >= PLACEMENT_WAIT_MS) return { refuse: await blame(unread, pending) };
      await new Promise((resolve) => setTimeout(resolve, PLACEMENT_INTERVAL_MS));
    }
  };
  // Pages and frames Chrome runs that no read covered yet; none known when Chrome cannot say.
  const uncoveredTargets = async (covered: Set<string>): Promise<string[]> => {
    try {
      const { targetInfos } = await withinTime(session.send('Target.getTargets'), PROTOCOL_READ_TIMEOUT_MS);
      return targetInfos
        .filter((info) => (info.type === 'page' || info.type === 'iframe') && !covered.has(info.targetId))
        .map((info) => info.targetId);
      // eslint-disable-next-line no-catch-all/no-catch-all -- Without a target list only the unread pages stay uncertain.
    } catch (_error) {
      return [];
    }
  };
  // Uncertainty blames only the guarded pages an unread page or an uncovered target belongs to. A frame
  // no guarded page hosts, with every page read, is refused blaming nobody: it is no job's document.
  const blame = async (unread: Page[], pending: string[]): Promise<GuardedPage[]> => {
    const owners = await Promise.all([
      ...unread.map((page) => {
        const id = pageTargetId(page);
        // A page whose own target is unknown cannot be traced to any guard.
        return id ? ownerOf(id, new Set(), false) : Promise.resolve<Owner>({ refuse: [] });
      }),
      ...pending.map((id) => ownerOf(id, new Set(), false)),
    ]);
    return [
      ...new Set(
        owners.flatMap((owner) => (typeof owner === 'string' ? [] : 'page' in owner ? [owner.page] : owner.refuse)),
      ),
    ];
  };

  const answer = (requestId: string, decision: DocumentDecision): void => {
    const fail = (): Promise<unknown> =>
      session.send('Fetch.failRequest', { requestId, errorReason: 'BlockedByClient' }).catch(() => undefined);
    void (
      decision.allow
        ? session
            .send('Fetch.continueRequest', { requestId, ...(decision.headers ? { headers: decision.headers } : {}) })
            .catch(fail)
        : fail()
    ).catch(() => undefined);
  };
  session.on('Fetch.requestPaused', (event) => {
    // A service worker's script is the only other request paused here. Refusing it keeps every site's
    // worker unregistered, so no navigation is ever answered by a worker instead of the network.
    if (event.resourceType !== 'Document') {
      answer(event.requestId, { allow: !serviceWorkerScript(event.request.headers) });
      return;
    }
    // Every guard's policy is taken as it stood at the pause, before placement can await.
    const captured = new Map<GuardedPage, CapturedPolicy>();
    for (const page of guarded()) captured.set(page, page.capture());
    // A page's target id is its main frame's id: only a document there is the page's own top-level document.
    const topOf = pages.get(event.frameId);
    const decide = async (): Promise<DocumentDecision> => {
      const owner = await ownerOf(event.frameId);
      if (owner === 'unguarded') return { allow: true };
      if ('refuse' in owner) {
        for (const page of owner.refuse) captured.get(page)?.refuse();
        return { allow: false };
      }
      const document: PausedDocument = {
        url: event.request.url,
        method: event.request.method,
        headers: event.request.headers,
        topLevel: topOf === owner.page,
      };
      // A page whose guard registered after this request paused had none when it paused.
      return captured.get(owner.page)?.decide(document) ?? { allow: true };
    };
    // A paused request is always answered: a decision that fails or never comes refuses it.
    void withinTime(decide(), DECISION_TIMEOUT_MS).then(
      (decision) => answer(event.requestId, decision),
      () => answer(event.requestId, { allow: false }),
    );
  });
  await session.send('Fetch.enable', {
    patterns: [
      { requestStage: 'Request', resourceType: 'Document' },
      { requestStage: 'Request', resourceType: 'Other' },
    ],
  });
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
