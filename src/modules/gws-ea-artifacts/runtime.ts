import { log } from '../../log.js';
import type { WebReadiness } from '../gws-ea-web/runtime.js';
import { ArtifactSharing } from './sharing.js';

/** Artifact intent maintenance continues independently of origin availability. */
export class ArtifactsRuntime {
  readonly sharing: ArtifactSharing;
  private recovered = false;
  private unavailable = false;
  private stopped = false;
  private tick: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(readiness: WebReadiness) {
    this.sharing = new ArtifactSharing(readiness);
  }
  start(signal: AbortSignal): void {
    this.stopped = signal.aborted;
    if (this.stopped || this.timer) return;
    signal.addEventListener(
      'abort',
      () => {
        void this.stop();
      },
      { once: true },
    );
    void this.reconcile();
    this.timer = setInterval(() => {
      void this.reconcile();
    }, 1000);
    this.timer.unref();
  }
  async reconcile(): Promise<void> {
    if (this.stopped) return;
    if (this.tick) return this.tick;
    this.tick = this.maintain();
    try {
      await this.tick;
    } finally {
      this.tick = undefined;
    }
  }
  private async maintain(): Promise<void> {
    try {
      if (!this.recovered) {
        await this.sharing.recover();
        this.recovered = true;
      } else await this.sharing.reconcile();
      this.unavailable = false;
      // eslint-disable-next-line no-catch-all/no-catch-all -- Optional artifact maintenance never aborts conversation startup.
    } catch {
      if (!this.unavailable) log.warn('Artifacts maintenance unavailable');
      this.unavailable = true;
    }
  }
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.tick;
  }
}
