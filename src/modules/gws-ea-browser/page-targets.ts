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
 * `setup` runs on the page session and on one session per live out-of-process frame until the page closes,
 * told which of the two it is;
 * an in-process frame shares its local root's session.
 */
export async function coverPageTargets(
  page: Page,
  setup: (session: CDPSession, target: 'page' | 'frame') => Promise<void>,
): Promise<void> {
  const settings = settingsFor(page);
  const pageSession = await page.context().newCDPSession(page);
  try {
    await setup(pageSession, 'page');
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
      const applied = await setup(frameSession, 'frame').then(
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
  // Accepted residual: Playwright's public API cannot pause a new frame target, so a page script that
  // navigates a brand-new out-of-process frame within milliseconds of its creation can act before this
  // coverage lands. Agent actions are always covered: pageTargetsReady runs before every operation.
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
