import type { Page } from 'playwright-core';

export type BrowserOperationStop = 'timeout' | 'interrupted';

/** Its owner keeps the job lock until `finish` settles: an aborted run's SDK work may still be in flight. */
export class BrowserOperation {
  private readonly controller = new AbortController();
  private readonly timer: NodeJS.Timeout;
  private readonly aborted: Promise<{ stopped: BrowserOperationStop }>;
  private execution: Promise<unknown> | undefined;
  private page: Page | undefined;
  private closing: Promise<void> | undefined;
  private readonly onAbort = (): void => this.abort('interrupted');
  readonly signal: AbortSignal = this.controller.signal;

  constructor(
    readonly deadline: number,
    private readonly closeOwnedPage?: () => Promise<void>,
    private readonly parentSignal?: AbortSignal,
  ) {
    this.aborted = new Promise((resolve) => {
      this.signal.addEventListener('abort', () => resolve({ stopped: this.signal.reason as BrowserOperationStop }), {
        once: true,
      });
    });
    this.timer = setTimeout(() => this.abort('timeout'), this.remaining());
    this.timer.unref();
    parentSignal?.addEventListener('abort', this.onAbort, { once: true });
    if (parentSignal?.aborted) this.onAbort();
  }

  remaining = (): number => Math.max(0, this.deadline - Date.now());

  assertActive = (): void => {
    if (this.signal.aborted || !this.remaining()) throw new Error('Browser operation is no longer active');
  };

  ownPage(page: Page): void {
    this.page = page;
    if (this.signal.aborted)
      this.closing = Promise.all([this.closing, page.close().catch(() => undefined)]).then(() => undefined);
  }

  abort(reason: BrowserOperationStop): void {
    if (this.signal.aborted) return;
    this.controller.abort(reason);
    this.closing = this.closePage();
  }

  private async closePage(): Promise<void> {
    if (this.closeOwnedPage) await this.closeOwnedPage().catch(() => undefined);
    else await this.page?.close().catch(() => undefined);
  }

  async run<T>(execute: () => Promise<T>): Promise<{ value: T } | { stopped: BrowserOperationStop }> {
    if (!this.remaining()) this.abort('timeout');
    if (this.signal.aborted) return this.aborted;
    const execution = Promise.resolve().then(execute);
    this.execution = execution;
    return Promise.race([execution.then((value) => ({ value })), this.aborted]);
  }

  async closeAbortedPage(): Promise<void> {
    await this.closing;
  }

  async finish(): Promise<void> {
    clearTimeout(this.timer);
    this.parentSignal?.removeEventListener('abort', this.onAbort);
    if (this.signal.aborted) await this.execution?.catch(() => undefined);
    await this.closing;
  }
}
