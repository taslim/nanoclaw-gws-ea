import type { CDPSession, Frame, Page } from 'playwright-core';

interface PageTargetSettings {
  /** Each setting resolves once every current frame is covered; false while a live out-of-process frame is not. */
  covered: Array<() => Promise<boolean>>;
  uncovered: Set<() => void>;
}
const settingsByPage = new WeakMap<Page, PageTargetSettings>();
function settingsFor(page: Page): PageTargetSettings {
  let settings = settingsByPage.get(page);
  if (!settings) {
    settings = { covered: [], uncovered: new Set() };
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
  const attach = async (frame: Frame, ended: () => void): Promise<'own' | 'shared' | 'uncovered'> => {
    // One retry absorbs a target that ended mid-attach; a frame still live and not set up is uncovered.
    for (let attempt = 0; attempt < 2; attempt++) {
      if (closed || frame.isDetached()) return 'shared';
      let frameSession: CDPSession;
      try {
        frameSession = await page.context().newCDPSession(frame);
        // eslint-disable-next-line no-catch-all/no-catch-all -- Any other attach failure is retried, then reported uncovered.
      } catch (error) {
        // Playwright opens no session for an in-process frame, which its local root's session already covers.
        if (error instanceof Error && error.message.includes('does not have a separate CDP session')) return 'shared';
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
      frameSessions.delete(frameSession);
      await frameSession.detach().catch(() => undefined);
    }
    return closed || frame.isDetached() ? 'shared' : 'uncovered';
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
  page.on('frameattached', coverChanged);
  page.on('framenavigated', coverChanged);
  page.once('close', () => {
    closed = true;
    page.off('frameattached', coverChanged);
    page.off('framenavigated', coverChanged);
    for (const session of [pageSession, ...frameSessions]) void session.detach().catch(() => undefined);
    frameSessions.clear();
  });
  settings.covered.push(covered);
  report(await covered());
}
