import type { Page } from 'playwright-core';

import { createBackgroundPage, type ChromeConnection } from './connection.js';
import { releaseBrowserUploads } from './files.js';

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
      const page = await createBackgroundPage(this.connection);
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
    if (existing) await releaseBrowserUploads(existing.page);
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
