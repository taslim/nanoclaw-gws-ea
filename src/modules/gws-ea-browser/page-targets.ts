import type { CDPSession, Frame, Page } from 'playwright-core';

interface PageTargetSettings {
  /** Each setting resolves once every current frame is covered; false while a live out-of-process frame is not. */
  covered: Array<() => Promise<boolean>>;
  /** Each setting's sessions read the frame ids their targets host; undefined when one cannot be read. */
  frameIds: Array<() => Promise<Set<string> | undefined>>;
  uncovered: Set<() => void>;
}
const settingsByPage = new WeakMap<Page, PageTargetSettings>();
function settingsFor(page: Page): PageTargetSettings {
  let settings = settingsByPage.get(page);
  if (!settings) {
    settings = { covered: [], frameIds: [], uncovered: new Set() };
    settingsByPage.set(page, settings);
  }
  return settings;
}

/** `listener` hears of any frame that appeared later and that some setting could not reach. */
export function onUncoveredPageTarget(page: Page, listener: () => void): void {
  settingsFor(page).uncovered.add(listener);
}

/** The one pre-operation step: every setting reaches every current frame before an operation may act in it. */
export async function pageTargetsReady(page: Page): Promise<boolean> {
  return (await Promise.all(settingsFor(page).covered.map((covered) => covered()))).every(Boolean);
}

/** Every frame id the page's targets host now, read through any setting's sessions, or undefined. */
export async function pageTargetFrameIds(page: Page): Promise<ReadonlySet<string> | undefined> {
  for (const read of settingsFor(page).frameIds) {
    const ids = await read();
    if (ids) return ids;
  }
  return undefined;
}

/** A page with no setting yet gets sessions with none, so its frame trees stay readable. */
export async function ensurePageTargets(page: Page): Promise<void> {
  if (!settingsFor(page).frameIds.length) await coverPageTargets(page, async () => undefined);
}

interface FrameTreeNode {
  frame: { id: string };
  childFrames?: FrameTreeNode[];
}

/**
 * Chrome runs a cross-site frame as its own target, so a setting made on the page session never reaches it.
 * `setup` runs on the page session and on one session per live out-of-process frame until the page closes;
 * an in-process frame shares its local root's session.
 */
export async function coverPageTargets(page: Page, setup: (session: CDPSession) => Promise<void>): Promise<void> {
  const settings = settingsFor(page);
  const pageSession = await page.context().newCDPSession(page);
  try {
    await setup(pageSession);
  } catch (error) {
    await pageSession.detach().catch(() => undefined);
    throw error;
  }
  let closed = false;
  const frameSessions = new Set<CDPSession>();
  const frames = new Map<Frame, Promise<boolean>>();
  const report = (isCovered: boolean): void => {
    if (!isCovered) for (const listener of settings.uncovered) listener();
  };
  const attach = async (frame: Frame, ended: () => void): Promise<'own' | 'shared' | 'gone' | 'uncovered'> => {
    // Only a refusal by a live target makes a frame uncovered; one retry absorbs a transient one.
    // A target that ended is gone: Playwright may list its frame a moment longer, and the frame's
    // next event or the next readiness pass checks it again.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (closed || frame.isDetached()) return 'gone';
      let frameSession: CDPSession;
      try {
        frameSession = await page.context().newCDPSession(frame);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Any other attach failure is retried, then reported uncovered.
      } catch (error) {
        const message = error instanceof Error ? error.message : '';
        // Playwright opens no session for an in-process frame, which its local root's session already covers.
        if (message.includes('does not have a separate CDP session')) return 'shared';
        if (message.includes('No target with given id found')) return 'gone';
        continue;
      }
      let live = true;
      let ready = false;
      frameSession.once('close', () => {
        live = false;
        frameSessions.delete(frameSession);
        if (ready) ended();
      });
      frameSessions.add(frameSession);
      const applied = await setup(frameSession).then(
        () => true,
        () => false,
      );
      if (applied && live && !closed) {
        ready = true;
        return 'own';
      }
      // A session that closed during setup lost its target; one that is still live refused the setup.
      const lost = !live || closed;
      frameSessions.delete(frameSession);
      await frameSession.detach().catch(() => undefined);
      if (lost) return 'gone';
    }
    return closed || frame.isDetached() ? 'gone' : 'uncovered';
  };
  const cover = (frame: Frame): Promise<boolean> => {
    if (closed || frame === page.mainFrame() || frame.isDetached()) return Promise.resolve(true);
    const existing = frames.get(frame);
    if (existing) return existing;
    const covering: Promise<boolean> = attach(frame, () => {
      // A detach or a swap back in-process ended this target; a later out-of-process swap is a new target.
      if (frames.get(frame) === covering) frames.delete(frame);
      if (!closed && !frame.isDetached()) void cover(frame).then(report);
    }).then((coverage) => {
      if (coverage !== 'own' && frames.get(frame) === covering) frames.delete(frame);
      return coverage !== 'uncovered';
    });
    frames.set(frame, covering);
    return covering;
  };
  const covered = async (): Promise<boolean> => (await Promise.all(page.frames().map(cover))).every(Boolean);
  const coverChanged = (frame: Frame): void => {
    void cover(frame).then(report);
  };
  // A brand-new out-of-process frame gets these sessions a few milliseconds after it starts. Its documents
  // never wait on them: the browser-level document gate pauses each from its first request. A setting
  // here guards what needs an agent action, and pageTargetsReady covers every frame before each one.
  page.on('frameattached', coverChanged);
  page.on('framenavigated', coverChanged);
  page.once('close', () => {
    closed = true;
    page.off('frameattached', coverChanged);
    page.off('framenavigated', coverChanged);
    for (const session of [pageSession, ...frameSessions]) void session.detach().catch(() => undefined);
    frameSessions.clear();
  });
  const frameIds = async (): Promise<Set<string> | undefined> => {
    if (!(await covered())) return undefined;
    const ids = new Set<string>();
    for (const session of [pageSession, ...frameSessions]) {
      let tree: FrameTreeNode;
      try {
        ({ frameTree: tree } = await session.send('Page.getFrameTree'));
        // eslint-disable-next-line no-catch-all/no-catch-all -- A failed read leaves the page's frames unknown.
      } catch (_error) {
        // A frame session that closed meanwhile took its frames with it; any other failure is unknown.
        if (session !== pageSession && !frameSessions.has(session)) continue;
        return undefined;
      }
      const visit = (node: FrameTreeNode): void => {
        ids.add(node.frame.id);
        node.childFrames?.forEach(visit);
      };
      visit(tree);
    }
    return ids;
  };
  settings.covered.push(covered);
  settings.frameIds.push(frameIds);
  report(await covered());
}
