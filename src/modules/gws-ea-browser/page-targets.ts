import type { CDPSession, Frame, Page } from 'playwright-core';

interface PageTargetSettings {
  /** Each setting resolves once every current frame is covered; false while a live out-of-process frame is not. */
  covered: Array<() => Promise<boolean>>;
  /** Each setting's sessions map every frame their targets host to the hosting target; undefined if one fails. */
  frameHosts: Array<() => Promise<Map<string, string> | undefined>>;
  /** The page's own target id, which is also its main frame's id. */
  targetId?: string;
  uncovered: Set<() => void>;
}
const settingsByPage = new WeakMap<Page, PageTargetSettings>();
function settingsFor(page: Page): PageTargetSettings {
  let settings = settingsByPage.get(page);
  if (!settings) {
    settings = { covered: [], frameHosts: [], uncovered: new Set() };
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

/** A protocol read that has not answered within this is no answer. */
export const PROTOCOL_READ_TIMEOUT_MS = 2_000;

/** `work`, or a rejection once `ms` pass without its answer. */
export function withinTime<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    work,
    new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(`No answer within ${ms}ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

/** A protocol read, bounded by PROTOCOL_READ_TIMEOUT_MS unless `ms` says otherwise. */
export function bounded<T>(work: Promise<T>, ms = PROTOCOL_READ_TIMEOUT_MS): Promise<T> {
  return withinTime(work, ms);
}

/**
 * Every frame the page's targets host now, each mapped to the target hosting it, read through any
 * setting's sessions; undefined when the page's targets cannot all be read.
 */
export async function pageTargetFrameHosts(page: Page): Promise<ReadonlyMap<string, string> | undefined> {
  for (const read of settingsFor(page).frameHosts) {
    const hosts = await read();
    if (hosts) return hosts;
  }
  return undefined;
}

/** The page's target id, once some setting covers it. */
export function pageTargetId(page: Page): string | undefined {
  return settingsFor(page).targetId;
}

const ensuring = new WeakMap<Page, Promise<void>>();
/**
 * A page with no setting yet gets sessions with none, so its frame trees stay readable. Concurrent
 * callers share one setup; one that fails is forgotten, so a later call tries again.
 */
export async function ensurePageTargets(page: Page): Promise<void> {
  if (settingsFor(page).frameHosts.length) return;
  let pending = ensuring.get(page);
  if (!pending) {
    pending = coverPageTargets(page, async () => undefined).finally(() => ensuring.delete(page));
    ensuring.set(page, pending);
  }
  await pending;
}

/** A frame as a target's frame tree lists it. */
export interface TreeFrame {
  id: string;
  parentId?: string;
  loaderId: string;
  url: string;
}
export interface FrameTreeNode {
  frame: TreeFrame;
  childFrames?: FrameTreeNode[];
}

/** Every frame a target's frame tree lists: its own frame first, each frame before the frames it holds. */
export function frameTreeFrames(tree: FrameTreeNode): TreeFrame[] {
  return [tree.frame, ...(tree.childFrames ?? []).flatMap(frameTreeFrames)];
}

/** Playwright opens no CDP session for an in-process frame: its local root's session hosts it. */
export function sharesTargetSession(error: unknown): boolean {
  return error instanceof Error && error.message.includes('does not have a separate CDP session');
}

/**
 * A CDP session on the target hosting `frame`: its own, or for an in-process frame its nearest ancestor's,
 * with the frame that target is. Undefined when no frame up to the page has a session of its own. `ms`
 * bounds each attempt.
 */
export async function attachFrameTarget(
  frame: Frame,
  ms?: number,
): Promise<{ session: CDPSession; owner: Frame } | undefined> {
  for (let owner: Frame | null = frame; owner; owner = owner.parentFrame()) {
    try {
      const opening = frame.page().context().newCDPSession(owner);
      return { session: await (ms === undefined ? opening : withinTime(opening, ms)), owner };
    } catch (error) {
      if (!sharesTargetSession(error)) throw error;
    }
  }
  return undefined;
}

/**
 * One CDP session per target, opened together: the page's, first and under its main frame, and each
 * out-of-process frame's; an in-process frame shares its local root's. Any other frame that cannot be opened
 * fails the opening unless `leaveOut` leaves it unread; the page's own session never can be. Undefined on a
 * failure, every session opened detached again.
 */
export async function openTargetSessions(
  page: Page,
  leaveOut: (frame: Frame) => boolean,
): Promise<Map<Frame, CDPSession> | undefined> {
  const frames = page.frames().filter((frame) => frame !== page.mainFrame());
  const opened = await Promise.allSettled([
    bounded(page.context().newCDPSession(page)),
    ...frames.map((frame) => bounded(page.context().newCDPSession(frame))),
  ]);
  const sessions = new Map<Frame, CDPSession>();
  let failed = false;
  opened.forEach((attempt, index) => {
    const frame = index === 0 ? page.mainFrame() : frames[index - 1];
    if (attempt.status === 'fulfilled') sessions.set(frame, attempt.value);
    else if (index === 0 || !(sharesTargetSession(attempt.reason) || leaveOut(frame))) failed = true;
  });
  if (!failed) return sessions;
  await Promise.all([...sessions.values()].map((session) => session.detach().catch(() => undefined)));
  return undefined;
}

/** A reader the host installs in a fresh isolated world of each frame it reads, as a global there. */
export interface IsolatedReader {
  readonly world: string;
  readonly global: string;
  /** Plain JavaScript that evaluates to the reader. */
  readonly source: string;
}

/**
 * Installs the reader in a fresh isolated world of the frame, so page script cannot answer for it: the world's
 * context, or undefined when the reader did not install.
 */
export async function installReader(
  session: CDPSession,
  frameId: string,
  reader: IsolatedReader,
): Promise<number | undefined> {
  const { executionContextId } = await bounded(
    session.send('Page.createIsolatedWorld', { frameId, worldName: reader.world }),
  );
  const installed = await bounded(
    session.send('Runtime.evaluate', {
      contextId: executionContextId,
      expression: `globalThis.${reader.global} = ${reader.source}; true`,
      returnByValue: true,
    }),
  );
  return installed.exceptionDetails || installed.result.value !== true ? undefined : executionContextId;
}

/** A frame one of a read's sessions hosts, with the isolated world its reader is installed in. */
export interface HostedFrame {
  readonly id: string;
  readonly parentId?: string;
  readonly url: string;
  readonly session: CDPSession;
  readonly context: number;
}

/** Which failures leave part of a read unread, rather than failing the read. */
export interface ReadTolerance {
  /** Whether a frame session whose frame tree cannot be read leaves its frames unread; the page's tree never can. */
  readonly unreadTree: boolean;
  /** Whether a frame the reader could not be installed in, for this failure, is left unread. */
  readonly unreadFrame: (error: unknown) => boolean;
}

/**
 * The reader, installed in a fresh isolated world of every frame the sessions host (the page's session first),
 * each frame read through the first session whose tree lists it; with the page's main frame as its tree lists it.
 */
export async function installReaders(
  sessions: Iterable<CDPSession>,
  reader: IsolatedReader,
  tolerance: ReadTolerance,
): Promise<{ main?: TreeFrame; frames: Map<string, HostedFrame> }> {
  const listed = new Map<string, Omit<HostedFrame, 'context'>>();
  let main: TreeFrame | undefined;
  for (const session of sessions) {
    let frameTree: FrameTreeNode;
    try {
      ({ frameTree } = await bounded(session.send('Page.getFrameTree')));
    } catch (error) {
      // The page's own tree, read first, is always required.
      if (!main || !tolerance.unreadTree) throw error;
      continue;
    }
    main ??= frameTree.frame;
    for (const frame of frameTreeFrames(frameTree))
      if (!listed.has(frame.id))
        listed.set(frame.id, {
          id: frame.id,
          ...(frame.parentId ? { parentId: frame.parentId } : {}),
          url: frame.url,
          session,
        });
  }
  const frames = new Map<string, HostedFrame>();
  await Promise.all(
    [...listed.values()].map(async (hosted) => {
      try {
        const context = await installReader(hosted.session, hosted.id, reader);
        if (context === undefined) throw new Error('The reader did not install');
        frames.set(hosted.id, { ...hosted, context });
      } catch (error) {
        if (!tolerance.unreadFrame(error)) throw error;
      }
    }),
  );
  return { ...(main ? { main } : {}), frames };
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
    settings.targetId ??= (await pageSession.send('Target.getTargetInfo')).targetInfo.targetId;
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
        // Playwright opens no session for an in-process frame, which its local root's session already covers.
        if (sharesTargetSession(error)) return 'shared';
        if (error instanceof Error && error.message.includes('No target with given id found')) return 'gone';
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
  const frameHosts = async (): Promise<Map<string, string> | undefined> => {
    if (!(await covered())) return undefined;
    const sessions = [pageSession, ...frameSessions];
    const trees = await Promise.all(
      sessions.map((session) =>
        withinTime(session.send('Page.getFrameTree'), PROTOCOL_READ_TIMEOUT_MS).then(
          ({ frameTree }) => frameTree as FrameTreeNode,
          // A frame session that closed meanwhile took its frames with it; any other failure is unknown.
          () => (session !== pageSession && !frameSessions.has(session) ? null : undefined),
        ),
      ),
    );
    const hosts = new Map<string, string>();
    for (const tree of trees) {
      if (tree === undefined) return undefined;
      if (tree === null) continue;
      // A session's tree is rooted at its own target: the page, or an out-of-process frame.
      const host = tree.frame.id;
      for (const frame of frameTreeFrames(tree)) hosts.set(frame.id, host);
    }
    return hosts;
  };
  settings.covered.push(covered);
  settings.frameHosts.push(frameHosts);
  report(await covered());
}
