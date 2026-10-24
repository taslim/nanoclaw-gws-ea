import { createServer, type Server } from 'node:http';
import { readArtifactsOperatorConfig, reconcileArtifactsAccessEmails } from '../../gws-ea/artifacts-cloudflare.js';
import { log } from '../../log.js';
import { createArtifactViewResolver } from './access.js';
import { artifactDigest } from './db.js';
import { ARTIFACTS_POLICY_VERSIONS, readArtifactsPolicy, type ArtifactsPolicyFile } from './policy.js';
import { createArtifactViewHandler } from './server.js';
import { artifactAdmissionEmails, ArtifactSharing } from './sharing.js';

export interface ArtifactsHealth {
  readonly policyVersions: readonly number[];
  readonly enabled: boolean;
  readonly availability: 'disabled' | 'available' | 'unavailable';
  readonly listener: { readonly state: 'listening' | 'stopped'; readonly port?: number };
  readonly reason?: string;
}
export interface ArtifactsRuntimeDependencies {
  readonly reconcileAccess?: typeof reconcileArtifactsAccessEmails;
}
/** One optional origin and one non-overlapping reconciliation tick per host. */
export class ArtifactsRuntime {
  readonly sharing: ArtifactSharing;
  private server: Server | undefined;
  private config: ArtifactsPolicyFile | undefined;
  private verified: string | undefined;
  private verifying: Promise<void> | undefined;
  private recovered = false;
  private ready = false;
  private unavailable = false;
  private retryAt = 0;
  private retryPolicy: string | undefined;
  private stopped = false;
  private tick: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(private readonly dependencies: ArtifactsRuntimeDependencies = {}) {
    this.sharing = new ArtifactSharing({
      verifyAdmission: (config) => this.verifyAdmission(config),
      publicationReady: async (config) => {
        try {
          return (
            (await this.coordinatesMatch(config, true)) &&
            this.ready &&
            this.server?.listening === true &&
            artifactDigest(config) === artifactDigest(this.config)
          );
          // eslint-disable-next-line no-catch-all/no-catch-all -- Optional owner-state failure closes access while preserving historical receipts.
        } catch {
          return false;
        }
      },
    });
  }
  private async coordinatesMatch(config: ArtifactsPolicyFile, publication = false): Promise<boolean> {
    const operator = await readArtifactsOperatorConfig(config.cloudflare.operatorConfigFile);
    const assistant = operator
      ? Object.values(operator.assistants).find(
          (candidate) => candidate.applicationId === config.cloudflare.applicationId,
        )
      : undefined;
    return (
      operator?.accountId === config.cloudflare.accountId &&
      `https://${operator.teamName}.cloudflareaccess.com` === config.accessIssuer &&
      assistant?.enabled === true &&
      (!publication || assistant.publicationReady === true) &&
      assistant.aud === config.accessAud &&
      assistant.claim.hostname === config.hostname &&
      assistant.claim.path_prefix === config.pathPrefix &&
      assistant.claim.listen_port === config.listenPort
    );
  }
  private async verifyAdmission(config: ArtifactsPolicyFile): Promise<void> {
    if (!(await this.coordinatesMatch(config))) throw new Error('Artifact coordinates do not match their owner.');
    if (this.retryPolicy === artifactDigest(config) && Date.now() < this.retryAt)
      throw new Error('Artifact admission retry is deferred.');
    if (this.verifying) await this.verifying;
    const desired = artifactDigest([config, await artifactAdmissionEmails()]);
    if (this.verifying) {
      await this.verifying;
      return this.verifyAdmission(config);
    }
    if (this.verified === desired) return;
    const task = async (): Promise<void> => {
      const result = await (this.dependencies.reconcileAccess ?? reconcileArtifactsAccessEmails)({
        ...config.cloudflare,
        emails: artifactAdmissionEmails,
      });
      if (this.stopped || !(await this.coordinatesMatch(config))) throw new Error('Artifact coordinates changed.');
      this.verified = artifactDigest([config, result.emails]);
    };
    this.verifying = task();
    try {
      await this.verifying;
      this.retryAt = 0;
    } catch (error) {
      this.retryAt = Date.now() + 15000;
      this.retryPolicy = artifactDigest(config);
      throw error;
    } finally {
      this.verifying = undefined;
    }
  }
  async health(): Promise<ArtifactsHealth> {
    const policy = await readArtifactsPolicy();
    let coordinates = false;
    /* eslint-disable no-catch-all/no-catch-all -- health observes malformed optional state without repairing it */
    try {
      coordinates = policy.status === 'enabled' && (await this.coordinatesMatch(policy.config));
    } catch {
      coordinates = false;
    }
    /* eslint-enable no-catch-all/no-catch-all */
    const listening =
      this.server?.listening === true &&
      this.ready &&
      coordinates &&
      policy.status === 'enabled' &&
      artifactDigest(policy.config) === artifactDigest(this.config);
    return {
      policyVersions: ARTIFACTS_POLICY_VERSIONS,
      enabled: policy.status === 'enabled',
      availability: policy.status === 'disabled' ? 'disabled' : listening ? 'available' : 'unavailable',
      listener: listening && this.config ? { state: 'listening', port: this.config.listenPort } : { state: 'stopped' },
      ...(policy.status === 'unavailable'
        ? { reason: policy.reason }
        : policy.status === 'enabled' && !listening
          ? { reason: 'artifacts-origin-unavailable' }
          : {}),
    };
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
    /* eslint-disable no-catch-all/no-catch-all -- optional origin failure closes serving without aborting chat startup */
    try {
      const policy = await readArtifactsPolicy();
      if (policy.status !== 'enabled') {
        this.ready = false;
        this.verified = undefined;
        this.retryAt = 0;
        await this.closeListener();
        await this.sharing.reconcile();
        return;
      }
      if (this.config && artifactDigest(this.config) !== artifactDigest(policy.config)) {
        this.ready = false;
        this.verified = undefined;
        await this.closeListener();
      }
      if (!this.recovered) {
        await this.sharing.recover();
        this.recovered = true;
      } else await this.sharing.reconcile();
      await this.verifyAdmission(policy.config);
      const fresh = await readArtifactsPolicy();
      if (
        this.stopped ||
        fresh.status !== 'enabled' ||
        artifactDigest(fresh.config) !== artifactDigest(policy.config)
      ) {
        this.ready = false;
        await this.closeListener();
        return;
      }
      if (!this.server) {
        const resolve = createArtifactViewResolver(fresh.config);
        const server = createServer(
          createArtifactViewHandler({
            ...fresh.config,
            resolve: (request, route) => (this.ready ? resolve(request, route) : Promise.resolve(undefined)),
          }),
        );
        this.server = server;
        await new Promise<void>((resolveListening, reject) => {
          server.once('error', reject);
          server.listen(fresh.config.listenPort, '127.0.0.1', () => {
            server.off('error', reject);
            resolveListening();
          });
        });
        server.on('error', () => {
          this.ready = false;
        });
        this.config = fresh.config;
      }
      this.ready = !this.stopped;
      this.unavailable = false;
    } catch {
      this.ready = false;
      this.verified = undefined;
      await this.closeListener();
      if (!this.unavailable) log.warn('Artifacts runtime unavailable', { reason: 'artifacts-origin-unavailable' });
      this.unavailable = true;
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  private async closeListener(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.config = undefined;
    if (!server?.listening) return;
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  async stop(): Promise<void> {
    this.stopped = true;
    this.ready = false;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.closeListener();
    await this.tick;
    await this.closeListener();
  }
}
