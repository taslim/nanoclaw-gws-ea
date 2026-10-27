import { createServer, type Server, type RequestListener } from 'node:http';
import { readWebOperatorConfig, reconcileWebAccessEmails } from '../../gws-ea/web-cloudflare.js';
import { log } from '../../log.js';
import { createWebIdentity, type WebIdentity } from './access.js';
import { WEB_POLICY_VERSIONS, readWebPolicy, webPolicyDigest, type WebPolicyFile } from './policy.js';
import { createWebHandler } from './server.js';

export interface WebHealth {
  readonly policyVersions: readonly number[];
  readonly enabled: boolean;
  readonly availability: 'disabled' | 'available' | 'unavailable';
  readonly listener: { readonly state: 'listening' | 'stopped'; readonly port?: number };
  readonly reason?: string;
}
export interface WebRuntimeDependencies {
  readonly reconcileAccess?: typeof reconcileWebAccessEmails;
}
export interface WebReadiness {
  readonly verifyAdmission: (config: WebPolicyFile) => Promise<void>;
  readonly publicationReady: (config: WebPolicyFile) => Promise<boolean>;
}
/** One optional origin and one non-overlapping admission reconciliation tick per host. */
export class WebRuntime {
  private server: Server | undefined;
  private config: WebPolicyFile | undefined;
  private verified: string | undefined;
  private verifying: Promise<void> | undefined;
  private ready = false;
  private unavailable = false;
  private retryAt = 0;
  private retryPolicy: string | undefined;
  private stopped = false;
  private tick: Promise<void> | undefined;
  private timer: NodeJS.Timeout | undefined;
  constructor(
    private readonly artifacts: (config: WebPolicyFile, identity: WebIdentity) => RequestListener,
    private readonly admissionEmails: () => Promise<readonly string[]>,
    private readonly dependencies: WebRuntimeDependencies = {},
  ) {}
  async publicationReady(config: WebPolicyFile): Promise<boolean> {
    try {
      return (
        (await this.coordinatesMatch(config, true)) &&
        this.ready &&
        this.server?.listening === true &&
        webPolicyDigest(config) === webPolicyDigest(this.config)
      );
      // eslint-disable-next-line no-catch-all/no-catch-all -- Optional owner-state failure closes publication.
    } catch {
      return false;
    }
  }
  private async coordinatesMatch(config: WebPolicyFile, publication = false): Promise<boolean> {
    const operator = await readWebOperatorConfig(config.cloudflare.operatorConfigFile);
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
      assistant.claim.listen_port === config.listenPort
    );
  }
  async verifyAdmission(config: WebPolicyFile): Promise<void> {
    if (!(await this.coordinatesMatch(config))) throw new Error('Web coordinates do not match their owner.');
    if (this.retryPolicy === webPolicyDigest(config) && Date.now() < this.retryAt)
      throw new Error('Web admission retry is deferred.');
    if (this.verifying) await this.verifying;
    const desired = JSON.stringify([webPolicyDigest(config), await this.admissionEmails()]);
    if (this.verifying) {
      await this.verifying;
      return this.verifyAdmission(config);
    }
    if (this.verified === desired) return;
    const task = async (): Promise<void> => {
      const result = await (this.dependencies.reconcileAccess ?? reconcileWebAccessEmails)({
        ...config.cloudflare,
        emails: this.admissionEmails,
      });
      if (this.stopped || !(await this.coordinatesMatch(config))) throw new Error('Web coordinates changed.');
      this.verified = JSON.stringify([webPolicyDigest(config), result.emails]);
    };
    this.verifying = task();
    try {
      await this.verifying;
      this.retryAt = 0;
    } catch (error) {
      this.retryAt = Date.now() + 15000;
      this.retryPolicy = webPolicyDigest(config);
      throw error;
    } finally {
      this.verifying = undefined;
    }
  }
  async health(): Promise<WebHealth> {
    const policy = await readWebPolicy();
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
      webPolicyDigest(policy.config) === webPolicyDigest(this.config);
    return {
      policyVersions: WEB_POLICY_VERSIONS,
      enabled: policy.status === 'enabled',
      availability: policy.status === 'disabled' ? 'disabled' : listening ? 'available' : 'unavailable',
      listener: listening && this.config ? { state: 'listening', port: this.config.listenPort } : { state: 'stopped' },
      ...(policy.status === 'unavailable'
        ? { reason: policy.reason }
        : policy.status === 'enabled' && !listening
          ? { reason: 'web-origin-unavailable' }
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
      const policy = await readWebPolicy();
      if (policy.status !== 'enabled') {
        this.ready = false;
        this.verified = undefined;
        this.retryAt = 0;
        await this.closeListener();
        return;
      }
      if (this.config && webPolicyDigest(this.config) !== webPolicyDigest(policy.config)) {
        this.ready = false;
        this.verified = undefined;
        await this.closeListener();
      }
      await this.verifyAdmission(policy.config);
      const fresh = await readWebPolicy();
      if (
        this.stopped ||
        fresh.status !== 'enabled' ||
        webPolicyDigest(fresh.config) !== webPolicyDigest(policy.config)
      ) {
        this.ready = false;
        await this.closeListener();
        return;
      }
      if (!this.server) {
        const artifacts = this.artifacts(fresh.config, createWebIdentity(fresh.config));
        const server = createServer(
          createWebHandler(fresh.config.hostname, (request, response) => {
            if (this.ready) artifacts(request, response);
            else {
              response.writeHead(404, {
                'cache-control': 'no-store',
                'content-security-policy': "default-src 'none'; frame-ancestors 'none'",
              });
              response.end();
            }
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
      if (!this.unavailable) log.warn('Web runtime unavailable', { reason: 'web-origin-unavailable' });
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
