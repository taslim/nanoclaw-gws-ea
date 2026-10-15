import type { Page } from 'playwright-core';

import { secureJobPage, type ChromeConnection } from './connection.js';

export const BROWSER_WINDOW_IDLE_MS = 10 * 60 * 1000;

/** One working page per job; target creation is serialized so simultaneous jobs cannot share a page event. */
export class JobWindows {
  private readonly pages = new Map<string, { page: Page; lastUsed: number }>();
  private opening: Promise<void> = Promise.resolve();

  constructor(private readonly connection: ChromeConnection) {}

  get size(): number {
    return this.pages.size;
  }

  async pageForJob(jobId: string): Promise<Page> {
    const prior = this.opening;
    let release!: () => void;
    this.opening = new Promise<void>((resolve) => {
      release = resolve;
    });
    await prior;
    try {
      const existing = this.pages.get(jobId);
      if (existing && !existing.page.isClosed()) {
        existing.lastUsed = Date.now();
        return existing.page;
      }
      let resolveTarget!: (id: string) => void;
      const expectedTarget = new Promise<string>((resolve) => {
        resolveTarget = resolve;
      });
      const appeared = this.connection.context.waitForEvent('page', {
        timeout: 10_000,
        predicate: async (candidate) => {
          const targetId = await expectedTarget;
          if (!targetId || candidate.isClosed()) return false;
          const metadata = await this.connection.context.newCDPSession(candidate);
          try {
            const { targetInfo } = await metadata.send('Target.getTargetInfo');
            return targetInfo.targetId === targetId;
          } finally {
            await metadata.detach();
          }
        },
      });
      // Bind the resulting page to the exact created target, so an unrelated
      // page event can never become another job's working page.
      const created = this.connection.session
        .send('Target.createTarget', {
          url: 'about:blank',
          newWindow: true,
          background: true,
        })
        .then(
          (result) => {
            resolveTarget(result.targetId);
            return result;
          },
          (error: unknown) => {
            resolveTarget('');
            throw error;
          },
        );
      const [, page] = await Promise.all([created, appeared]);
      await secureJobPage(page);
      if (page.viewportSize() !== null) {
        await page.close();
        throw new Error('Chrome unexpectedly enabled viewport emulation');
      }
      this.pages.set(jobId, { page, lastUsed: Date.now() });
      page.once('close', () => {
        if (this.pages.get(jobId)?.page === page) this.pages.delete(jobId);
      });
      return page;
    } finally {
      release();
    }
  }

  async closeJob(jobId: string): Promise<void> {
    await this.opening;
    const existing = this.pages.get(jobId);
    this.pages.delete(jobId);
    await existing?.page.close().catch(() => undefined);
  }

  async closeIdle(now = Date.now()): Promise<void> {
    await this.opening;
    for (const [job, value] of this.pages) if (now - value.lastUsed >= BROWSER_WINDOW_IDLE_MS) await this.closeJob(job);
  }

  async close(): Promise<void> {
    await this.opening;
    for (const jobId of [...this.pages.keys()]) await this.closeJob(jobId);
  }
}
