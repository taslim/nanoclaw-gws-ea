import type { Page } from 'playwright-core';

import { createBackgroundPage, type ChromeConnection } from './connection.js';
import { releaseBrowserUploads } from './files.js';

/** One working page per job; target creation is serialized so simultaneous jobs cannot share a page event. */
export class JobWindows {
  private readonly pages = new Map<string, Page>();
  private opening: Promise<void> = Promise.resolve();

  constructor(private readonly connection: ChromeConnection) {}

  get size(): number {
    return this.pages.size;
  }

  jobs(): readonly string[] {
    return [...this.pages.keys()];
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
      if (existing && !existing.isClosed()) {
        return existing;
      }
      const page = await createBackgroundPage(this.connection);
      this.pages.set(jobId, page);
      page.once('close', () => {
        if (this.pages.get(jobId) === page) this.pages.delete(jobId);
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
    await existing?.close().catch(() => undefined);
    if (existing) await releaseBrowserUploads(existing);
  }

  async close(): Promise<void> {
    await this.opening;
    for (const jobId of [...this.pages.keys()]) await this.closeJob(jobId);
  }
}
