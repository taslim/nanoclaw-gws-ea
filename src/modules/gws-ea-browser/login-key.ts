import { randomBytes, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import {
  buildHostEnvironment,
  runSanitizedCommandOutcome,
  type SanitizedCommandOutcome,
  type SanitizedCommandOutcomeRunner,
} from '../../gws-ea/process.js';

const SERVICE = 'gws-ea.saved-logins';
const TIMEOUT_MS = 10_000;
export type LoginKeyRead =
  | { readonly status: 'ready'; readonly key: Buffer }
  | { readonly status: 'missing' }
  | { readonly status: 'unavailable' };
export interface LoginKeyOptions {
  readonly instanceId: string;
  readonly runCommand?: SanitizedCommandOutcomeRunner;
}

/** The Keychain is the only key owner. No key survives a call in this adapter. */
export class LoginKey {
  private readonly runCommand: SanitizedCommandOutcomeRunner;
  constructor(private readonly options: LoginKeyOptions) {
    // Also makes the account safe in security's interactive command language.
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/u.test(options.instanceId))
      throw new Error('Invalid login store instance');
    this.runCommand = options.runCommand ?? runSanitizedCommandOutcome;
  }

  private async run(args: readonly string[], input?: string): Promise<SanitizedCommandOutcome | undefined> {
    try {
      return await this.runCommand({
        command: '/usr/bin/security',
        args,
        input,
        cwd: os.homedir(),
        env: buildHostEnvironment(process.env, { HOME: os.homedir() }),
        privateOutput: true,
        outputLimitBytes: 4096,
        timeoutMs: TIMEOUT_MS,
      });
      // eslint-disable-next-line no-catch-all/no-catch-all -- This secret boundary returns constants, never process errors or output.
    } catch {
      return undefined;
    }
  }

  async read(): Promise<LoginKeyRead> {
    const result = await this.run(['find-generic-password', '-s', SERVICE, '-a', this.options.instanceId, '-w']);
    if (result?.exitCode === 44) return { status: 'missing' };
    if (result?.exitCode !== 0 || !/^[a-f0-9]{64}$/iu.test(result.stdout.trim())) return { status: 'unavailable' };
    return { status: 'ready', key: Buffer.from(result.stdout.trim(), 'hex') };
  }

  /** Only the store, after checking both secret tables are empty, may request creation. Never overwrites. */
  async create(): Promise<LoginKeyRead> {
    const generated = randomBytes(32);
    try {
      const result = await this.run(
        ['-i'],
        `add-generic-password -s ${SERVICE} -a ${this.options.instanceId} -w ${generated.toString('hex')}\n`,
      );
      if (result?.exitCode !== 0) return { status: 'unavailable' };
      const read = await this.read();
      if (read.status !== 'ready') return { status: 'unavailable' };
      if (!timingSafeEqual(generated, read.key)) {
        read.key.fill(0);
        return { status: 'unavailable' };
      }
      return read;
    } finally {
      generated.fill(0);
    }
  }

  async remove(): Promise<{ readonly status: 'removed' | 'unavailable' }> {
    const result = await this.run(['delete-generic-password', '-s', SERVICE, '-a', this.options.instanceId]);
    return { status: result?.exitCode === 0 || result?.exitCode === 44 ? 'removed' : 'unavailable' };
  }
}
