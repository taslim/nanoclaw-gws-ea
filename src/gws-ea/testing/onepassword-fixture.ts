/**
 * A 1Password account behind the `op` process boundary, for the tests of
 * 1Password provisioning: the real `OnePasswordCli` drives it. It keeps the
 * operator's desktop sign-in, service accounts and their tokens, vaults,
 * grants, and the account's shared daily request count.
 */
import { randomBytes } from 'node:crypto';

import type { OnePasswordCliSeams } from '../onepassword.js';
import type { SanitizedCommand, SanitizedCommandOutcome } from '../process.js';

export const OP = '/opt/homebrew/bin/op';
export const ACCOUNT_ID = providerId('HALEFAMILY', 1);
export const OTHER_ACCOUNT_ID = providerId('VANCETEAM', 2);
export const OPERATOR_USER_ID = providerId('MORGANELLERY', 1);

/** A 26-character provider ID, distinct for each `n`. */
export function providerId(prefix: string, n: number): string {
  return `${prefix}${String(n).padStart(26 - prefix.length, '0')}`;
}

export interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

interface FakeVault {
  readonly id: string;
  readonly name: string;
  /** The service account that created it. */
  readonly creator: string;
  readonly grants: Map<string, string>;
}

interface FakeServiceAccount {
  readonly id: string;
  readonly name: string;
  readonly token: string;
  /** `create_vaults`, or the one vault it may read and write. */
  readonly access: string;
}

export class FakeOnePassword {
  readonly accounts = [
    { account_uuid: ACCOUNT_ID, user_uuid: OPERATOR_USER_ID, url: 'hale.1password.com', email: 'morgan@example.test' },
  ];
  signedIn = true;
  accountType = 'FAMILY';
  dailyLimit = 1000;
  /** Requests every service account in the account has made today. */
  used = 0;
  rateLimitFails = false;
  readonly vaults = new Map<string, FakeVault>();
  readonly serviceAccounts = new Map<string, FakeServiceAccount>();
  readonly calls: SanitizedCommand[] = [];
  /** Runs before the provider acts; a reply ends the call there. */
  before?: (args: readonly string[]) => Reply | undefined;
  /** Runs after the provider acted; throwing simulates an interrupted call or a crash of this process. */
  after?: (args: readonly string[]) => void;
  #next = 1;

  readonly runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
    if (command.command !== OP) throw new Error(`Unexpected process ${command.command}`);
    if (command.args[0] === '--version') return { stdout: '2.31.1\n', stderr: '', exitCode: 0 };
    this.calls.push(command);
    const early = this.before?.(command.args);
    const reply = early ?? this.#respond(command);
    this.after?.(command.args);
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
  };

  get tokens(): string[] {
    return [...this.serviceAccounts.values()].map((account) => account.token);
  }

  serviceAccountCalls(): string[][] {
    return this.calls.filter((call) => call.env?.OP_SERVICE_ACCOUNT_TOKEN !== undefined).map((call) => [...call.args]);
  }

  #id(prefix: string): string {
    return providerId(prefix, this.#next++);
  }

  #respond(command: SanitizedCommand): Reply {
    const args = command.args;
    const token = command.env?.OP_SERVICE_ACCOUNT_TOKEN;
    const words = args.join(' ');
    if (token !== undefined) {
      const account = [...this.serviceAccounts.values()].find((candidate) => candidate.token === token);
      if (!account) return { exitCode: 1, stderr: '[ERROR] (401) Unauthorized: invalid token' };
      this.used += 1;
      return this.#asServiceAccount(account, args);
    }
    const selected = args.at(-2) === '--account' ? args.at(-1) : undefined;
    if (words === 'account list --format json') return { stdout: JSON.stringify(this.accounts) };
    if (!this.signedIn) return { exitCode: 1, stderr: '[ERROR] account is not signed in' };
    if (selected !== ACCOUNT_ID) return { exitCode: 1, stderr: `[ERROR] no account found for filter ${selected}` };
    if (args[0] === 'whoami')
      return {
        stdout: JSON.stringify({ account_uuid: ACCOUNT_ID, user_uuid: OPERATOR_USER_ID, user_type: 'HUMAN' }),
      };
    if (args[0] === 'service-account' && args[1] === 'create') {
      const vaultFlag = args.indexOf('--vault');
      let access = 'create_vaults';
      if (vaultFlag !== -1) {
        const [vaultId, grant] = args[vaultFlag + 1].split(':');
        if (grant !== 'read_items,write_items') return { exitCode: 1, stderr: '[ERROR] invalid permissions' };
        if (this.vaults.get(vaultId)?.grants.get(OPERATOR_USER_ID) !== 'allow_managing')
          return { exitCode: 1, stderr: "[ERROR] (403) Forbidden: You don't have permission to manage this vault" };
        access = vaultId;
      }
      const account = {
        id: this.#id('SERVICEACCOUNT'),
        name: args[2],
        token: `ops_${randomBytes(48).toString('base64url')}`,
        access,
      };
      this.serviceAccounts.set(account.id, account);
      return { stdout: `${account.token}\n` };
    }
    throw new Error(`Unexpected operator call: ${words}`);
  }

  #asServiceAccount(account: FakeServiceAccount, args: readonly string[]): Reply {
    const words = args.join(' ');
    if (words === 'whoami --format json')
      return {
        stdout: JSON.stringify({ account_uuid: ACCOUNT_ID, user_uuid: account.id, user_type: 'SERVICE_ACCOUNT' }),
      };
    if (words === 'account get --format json')
      return { stdout: JSON.stringify({ id: ACCOUNT_ID, name: 'Hale', type: this.accountType }) };
    if (words === 'service-account ratelimit') {
      if (this.rateLimitFails) return { exitCode: 1, stderr: '[ERROR] the service could not answer' };
      return {
        stdout: [
          'TYPE       ACTION        LIMIT    USED    REMAINING    RESET',
          'token      write         100      0       100          N/A',
          'token      read          1000     2       998          59 minutes from now',
          `account    read_write    ${this.dailyLimit}     ${this.used}       ${this.dailyLimit - this.used}          23 hours from now`,
          '',
        ].join('\n'),
      };
    }
    if (args[0] === 'vault' && args[1] === 'create') {
      if (account.access !== 'create_vaults') return { exitCode: 1, stderr: '[ERROR] (403) Forbidden' };
      const vault: FakeVault = { id: this.#id('VAULT'), name: args[2], creator: account.id, grants: new Map() };
      this.vaults.set(vault.id, vault);
      return { stdout: JSON.stringify({ id: vault.id, name: vault.name, content_version: 1 }) };
    }
    if (args[0] === 'vault' && args[1] === 'user' && args[2] === 'grant') {
      const vault = this.vaults.get(args[args.indexOf('--vault') + 1]);
      if (!vault || vault.creator !== account.id) return { exitCode: 1, stderr: '[ERROR] (403) Forbidden' };
      vault.grants.set(args[args.indexOf('--user') + 1], args[args.indexOf('--permissions') + 1]);
      return {};
    }
    if (args[0] === 'vault' && args[1] === 'get') {
      const vault = this.vaults.get(args[2]);
      if (!vault || (account.access !== vault.id && vault.creator !== account.id))
        return { exitCode: 1, stderr: `[ERROR] "${args[2]}" isn't a vault in this account` };
      return { stdout: JSON.stringify({ id: vault.id, name: vault.name }) };
    }
    throw new Error(`Unexpected service account call: ${words}`);
  }

  /** The CLI seams that run every `op` call against this account. */
  cli(): OnePasswordCliSeams {
    return { resolve: async () => OP, runCommand: this.runCommand, ambient: { PATH: '/usr/bin:/bin' } };
  }
}
