import { randomBytes } from 'node:crypto';
import { chmod, mkdtemp, readdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { resolveControlPlanePaths } from '../../gws-ea/paths.js';
import type { SanitizedCommand, SanitizedCommandOutcome } from '../../gws-ea/process.js';
import { startRunLog, type RunLog } from '../../gws-ea/run-log.js';
import { GwsEaError } from '../../gws-ea/types.js';
import {
  discardServiceAccountCreation,
  OnePasswordCli,
  type OnePasswordCliOptions,
  type OperatorIdentity,
  type ServiceAccountIdentity,
} from './onepassword-cli.js';

const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const OTHER_ACCOUNT_ID = 'REMYVANCEACCOUNT0000000002';
const OPERATOR_USER_ID = 'MORGANELLERYUSER0000000001';
const SERVICE_ACCOUNT_USER_ID = 'MANAGEMENTSERVICEACCOUNT01';
const VAULT_ID = 'morganelleryvault000000001';
const PRINCIPAL_USER_ID = 'JUNOHALEPRINCIPAL000000001';
const FAKE_OP = '/opt/homebrew/bin/op';
const OPERATOR: OperatorIdentity = { kind: 'operator', accountId: ACCOUNT_ID };
const RATE_LIMITED =
  "[ERROR] 2026/10/16 07:00:00 (429) Too Many Requests: You've reached the maximum number of this type of requests this service account is allowed to make.";
const INHERITED_TOKEN = `ops_inherited${randomBytes(24).toString('base64url')}`;
/** An operator shell holding every 1Password variable that could authenticate a call by accident. */
const AMBIENT: NodeJS.ProcessEnv = {
  PATH: '/usr/bin:/bin',
  LANG: 'en_US.UTF-8',
  OP_SERVICE_ACCOUNT_TOKEN: INHERITED_TOKEN,
  OP_CONNECT_HOST: 'http://connect.example.test',
  OP_CONNECT_TOKEN: 'connect-token-inherited-value',
  OP_SESSION_juno: 'session-inherited-value',
  OP_ACCOUNT: OTHER_ACCOUNT_ID,
  OP_FORMAT: 'human-readable',
};

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) {
    await chmod(root, 0o700).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
  }
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onepassword-cli-')));
  roots.push(root);
  return root;
}

function token(): string {
  return `ops_${randomBytes(48).toString('base64url')}`;
}

async function managementIdentity(value = token()): Promise<ServiceAccountIdentity> {
  const tokenFile = path.join(await temporaryRoot(), 'management-token');
  await writeFile(tokenFile, `${value}\n`, { mode: 0o600 });
  return { kind: 'service_account', accountId: ACCOUNT_ID, tokenFile };
}

interface Reply {
  readonly stdout?: string;
  readonly stderr?: string;
  readonly exitCode?: number;
}

type Responder = (command: SanitizedCommand) => Reply | Promise<Reply>;

const succeed: Responder = () => ({});

/** A 1Password CLI whose every action call goes to `responder`; `calls` excludes the version check. */
async function openCli(
  responder: Responder,
  options: Partial<OnePasswordCliOptions> & { readonly version?: Reply } = {},
): Promise<{ readonly cli: OnePasswordCli; readonly calls: SanitizedCommand[] }> {
  const calls: SanitizedCommand[] = [];
  const runCommand = async (command: SanitizedCommand): Promise<SanitizedCommandOutcome> => {
    if (command.args[0] !== '--version') calls.push(command);
    const reply =
      command.args[0] === '--version' ? (options.version ?? { stdout: '2.30.0\n' }) : await responder(command);
    return { stdout: reply.stdout ?? '', stderr: reply.stderr ?? '', exitCode: reply.exitCode ?? 0 };
  };
  const opening = await OnePasswordCli.open({ resolve: async () => FAKE_OP, runCommand, ambient: AMBIENT, ...options });
  if (opening.status !== 'ready') throw new Error(`The fake CLI did not open: ${opening.reason}`);
  return { cli: opening.cli, calls };
}

function whoami(accountId = ACCOUNT_ID, userId = OPERATOR_USER_ID, userType?: string): Reply {
  return {
    stdout: JSON.stringify({
      url: 'https://my.1password.com',
      email: 'morgan.ellery@example.test',
      user_uuid: userId,
      account_uuid: accountId,
      ...(userType === undefined ? {} : { user_type: userType }),
    }),
  };
}

function opVariables(environment: Readonly<Record<string, string>> | undefined): Record<string, string> {
  return Object.fromEntries(Object.entries(environment ?? {}).filter(([key]) => key.startsWith('OP_')));
}

/** Every file a run log wrote, recursively. */
async function runLogText(run: RunLog): Promise<string> {
  const files = await readdir(run.directory, { recursive: true, withFileTypes: true });
  const contents = await Promise.all(
    files.filter((entry) => entry.isFile()).map((entry) => readFile(path.join(entry.parentPath, entry.name), 'utf8')),
  );
  return contents.join('\n');
}

describe('opening the 1Password CLI', () => {
  it('reports a missing CLI', async () => {
    expect(await OnePasswordCli.open({ searchPath: await temporaryRoot() })).toEqual({
      status: 'failed',
      reason: 'cli_missing',
    });
    expect(await OnePasswordCli.open({ command: '/nonexistent/bin/op' })).toEqual({
      status: 'failed',
      reason: 'cli_missing',
    });
  });

  it('refuses a CLI in a location anyone else could replace', async () => {
    const directory = await temporaryRoot();
    await writeFile(path.join(directory, 'op'), '#!/bin/sh\n', { mode: 0o700 });
    expect(await OnePasswordCli.open({ searchPath: directory })).toEqual({ status: 'failed', reason: 'cli_untrusted' });
  });

  it.each([
    ['2.28.1', '2.28.1\n'],
    ['a pre-release of the minimum', '2.29.0-beta.01\n'],
    ['1.12.4', '1.12.4\n'],
  ])('refuses %s, older than delegated service-account creation needs', async (_label, stdout) => {
    const opening = await OnePasswordCli.open({
      resolve: async () => FAKE_OP,
      runCommand: async () => ({ stdout, stderr: '', exitCode: 0 }),
    });
    expect(opening).toEqual({ status: 'failed', reason: 'cli_too_old', version: stdout.trim() });
  });

  it.each([
    ['an unparseable version', { stdout: 'op version unknown\n', stderr: '', exitCode: 0 }],
    ['a failed version check', { stdout: '', stderr: 'secret-looking diagnostic', exitCode: 1 }],
  ])('reports %s as unavailable', async (_label, outcome) => {
    expect(await OnePasswordCli.open({ resolve: async () => FAKE_OP, runCommand: async () => outcome })).toEqual({
      status: 'failed',
      reason: 'cli_unavailable',
    });
  });

  it('opens a supported CLI at the exact executable it resolved, with no 1Password authentication', async () => {
    const commands: SanitizedCommand[] = [];
    const opening = await OnePasswordCli.open({
      resolve: async () => FAKE_OP,
      ambient: AMBIENT,
      runCommand: async (command) => {
        commands.push(command);
        return { stdout: '2.29.0\n', stderr: '', exitCode: 0 };
      },
    });
    expect(opening).toMatchObject({ status: 'ready' });
    if (opening.status !== 'ready') return;
    expect(opening.cli.executable).toBe(FAKE_OP);
    expect(opening.cli.version).toBe('2.29.0');
    expect(commands).toHaveLength(1);
    expect(commands[0]).toMatchObject({ command: FAKE_OP, args: ['--version'], privateOutput: true });
    expect(opVariables(commands[0].env)).toEqual({});
  });
});

describe('1Password identities', () => {
  it('never lets an operator call inherit service-account or Connect authentication', async () => {
    const { cli, calls } = await openCli(() => whoami());
    expect(await cli.whoami(OPERATOR)).toEqual({ status: 'ok', accountId: ACCOUNT_ID, userId: OPERATOR_USER_ID });

    expect(calls[0].args).toEqual(['whoami', '--format', 'json', '--account', ACCOUNT_ID]);
    expect(opVariables(calls[0].env)).toEqual({});
    expect(calls[0].env).toMatchObject({ PATH: '/usr/bin:/bin', HOME: os.homedir() });
    expect(calls[0].privateOutput).toBe(true);
  });

  it('authenticates a management call with exactly its configured token, never the inherited one', async () => {
    const configured = token();
    const identity = await managementIdentity(configured);
    const { cli, calls } = await openCli(() => whoami(ACCOUNT_ID, SERVICE_ACCOUNT_USER_ID, 'SERVICE_ACCOUNT'));

    expect(await cli.whoami(identity)).toEqual({
      status: 'ok',
      accountId: ACCOUNT_ID,
      userId: SERVICE_ACCOUNT_USER_ID,
    });
    expect(calls[0].args).toEqual(['whoami', '--format', 'json']);
    expect(opVariables(calls[0].env)).toEqual({ OP_SERVICE_ACCOUNT_TOKEN: configured });
  });

  it('runs the real child with exactly those environments', async () => {
    const directory = await temporaryRoot();
    const executable = path.join(directory, 'op');
    const callsFile = path.join(directory, 'calls.jsonl');
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        `fs.appendFileSync(${JSON.stringify(callsFile)}, JSON.stringify(process.env) + '\\n');`,
        "process.stdout.write(process.argv[2] === '--version' ? '2.31.0\\n' : " +
          `${JSON.stringify(whoami().stdout)});`,
      ].join('\n'),
      { mode: 0o700 },
    );
    const configured = token();
    const opening = await OnePasswordCli.open({ resolve: async () => executable, ambient: AMBIENT });
    if (opening.status !== 'ready') throw new Error(opening.reason);

    expect(await opening.cli.whoami(OPERATOR)).toMatchObject({ status: 'ok' });
    expect(await opening.cli.whoami(await managementIdentity(configured))).toMatchObject({ status: 'ok' });

    const environments = (await readFile(callsFile, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Record<string, string>);
    expect(environments.map(opVariables)).toEqual([{}, {}, { OP_SERVICE_ACCOUNT_TOKEN: configured }]);
  });

  it('reports an authentication to another account, or as another kind of identity, as the wrong account', async () => {
    const { cli } = await openCli((command) =>
      command.env?.OP_SERVICE_ACCOUNT_TOKEN
        ? whoami(OTHER_ACCOUNT_ID)
        : whoami(ACCOUNT_ID, OPERATOR_USER_ID, 'SERVICE_ACCOUNT'),
    );
    expect(await cli.whoami(await managementIdentity())).toEqual({ status: 'failed', reason: 'wrong_account' });
    expect(await cli.whoami(OPERATOR)).toEqual({ status: 'failed', reason: 'wrong_account' });
  });

  it.each([
    ['a missing token', async (identity: ServiceAccountIdentity) => rm(identity.tokenFile)],
    ['a group-readable token', async (identity: ServiceAccountIdentity) => chmod(identity.tokenFile, 0o640)],
    [
      'a token in a shared directory',
      async (identity: ServiceAccountIdentity) => chmod(path.dirname(identity.tokenFile), 0o755),
    ],
    ['a malformed token', async (identity: ServiceAccountIdentity) => writeFile(identity.tokenFile, 'not a token')],
  ])('refuses %s before running anything', async (_label, damage) => {
    const identity = await managementIdentity();
    await damage(identity);
    const { cli, calls } = await openCli(succeed);
    expect(await cli.whoami(identity)).toEqual({ status: 'failed', reason: 'token_unavailable' });
    expect(calls).toHaveLength(0);
  });
});

describe('bounded 1Password outcomes', () => {
  it('maps a 429 from either identity to rate_limited, once, with no retry and no provider text', async () => {
    const management = await managementIdentity();
    const { cli, calls } = await openCli(() => ({ stderr: RATE_LIMITED, exitCode: 1 }));

    const results = [
      await cli.whoami(OPERATOR),
      await cli.createVault(OPERATOR, 'GWS-EA Juno Hale'),
      await cli.grantVaultAccess(management, {
        vaultId: VAULT_ID,
        userId: PRINCIPAL_USER_ID,
        permissions: ['allow_viewing'],
      }),
      await cli.rateLimits(management),
    ];

    expect(results).toEqual(Array(4).fill({ status: 'failed', reason: 'rate_limited' }));
    expect(calls).toHaveLength(4);
    expect(JSON.stringify(results)).not.toContain('maximum number');
  });

  it.each([
    ['not_signed_in', '[ERROR] 2026/10/16 07:00:00 You are not currently signed in. Please run `op signin --help`'],
    ['not_signed_in', '[ERROR] 2026/10/16 07:00:00 authorization prompt dismissed, please try again'],
    ['not_signed_in', '[ERROR] (401) Unauthorized: invalid service account token'],
    ['forbidden', "[ERROR] (403) Forbidden: You don't have permission to perform this action"],
    ['not_found', `[ERROR] "${VAULT_ID}" isn't a vault in this account. Specify the vault with its UUID or name.`],
  ])('maps a rejection to %s', async (reason, stderr) => {
    const { cli } = await openCli(() => ({ stderr, exitCode: 1 }));
    const result = await cli.deleteVault(await managementIdentity(), VAULT_ID);
    expect(result).toEqual({ status: 'failed', reason });
  });

  it('never surfaces an unrecognized failure: a read failed, a write is unknown', async () => {
    const leaked = `ops_${randomBytes(24).toString('hex')}`;
    const { cli } = await openCli(() => ({
      stdout: leaked,
      stderr: `[ERROR] unexpected EOF near ${leaked}`,
      exitCode: 1,
    }));
    const management = await managementIdentity();

    const read = await cli.whoami(management);
    const write = await cli.revokeVaultAccess(management, { vaultId: VAULT_ID, userId: PRINCIPAL_USER_ID });

    expect(read).toEqual({ status: 'failed', reason: 'failed' });
    expect(write).toEqual({ status: 'failed', reason: 'outcome_unknown' });
    expect(JSON.stringify([read, write])).not.toContain(leaked);
  });

  it('treats an interrupted write as unknown and an interrupted read as failed', async () => {
    const { cli } = await openCli(() => {
      throw new GwsEaError('command_timeout', 'Command timed out after 60.0s');
    });
    expect(await cli.whoami(OPERATOR)).toEqual({ status: 'failed', reason: 'failed' });
    expect(await cli.createVault(OPERATOR, 'GWS-EA Juno Hale')).toEqual({
      status: 'failed',
      reason: 'outcome_unknown',
    });
  });

  it.each([
    ['invalid JSON', '{"account_uuid": '],
    ['a missing user', JSON.stringify({ account_uuid: ACCOUNT_ID })],
    ['an account shorthand', JSON.stringify({ account_uuid: 'my', user_uuid: OPERATOR_USER_ID })],
  ])('reports a read with %s as unexpected output', async (_label, stdout) => {
    const { cli } = await openCli(() => ({ stdout }));
    expect(await cli.whoami(OPERATOR)).toEqual({ status: 'failed', reason: 'unexpected_output' });
  });
});

describe('1Password actions', () => {
  it('lists the operator accounts by their exact IDs', async () => {
    const { cli, calls } = await openCli(() => ({
      stdout: JSON.stringify([
        {
          url: 'my.1password.com',
          email: 'morgan.ellery@example.test',
          user_uuid: OPERATOR_USER_ID,
          account_uuid: ACCOUNT_ID,
        },
      ]),
    }));
    expect(await cli.listAccounts()).toEqual({
      status: 'ok',
      accounts: [
        {
          accountId: ACCOUNT_ID,
          userId: OPERATOR_USER_ID,
          url: 'my.1password.com',
          email: 'morgan.ellery@example.test',
        },
      ],
    });
    expect(calls[0].args).toEqual(['account', 'list', '--format', 'json']);
    expect(opVariables(calls[0].env)).toEqual({});
  });

  it('creates a vault and returns exactly the vault it created', async () => {
    const management = await managementIdentity();
    const { cli, calls } = await openCli(() => ({
      stdout: JSON.stringify({ id: VAULT_ID, name: 'GWS-EA Juno Hale', content_version: 1 }),
    }));
    expect(await cli.createVault(management, 'GWS-EA Juno Hale')).toEqual({ status: 'ok', vaultId: VAULT_ID });
    expect(calls[0].args).toEqual(['vault', 'create', 'GWS-EA Juno Hale', '--format', 'json']);
  });

  it.each([
    ['another name', JSON.stringify({ id: VAULT_ID, name: 'Private' })],
    ['a malformed ID', JSON.stringify({ id: 'Private', name: 'GWS-EA Juno Hale' })],
    ['no JSON', 'Created vault'],
  ])('reports a created vault with %s as unknown, never as success', async (_label, stdout) => {
    const { cli } = await openCli(() => ({ stdout }));
    expect(await cli.createVault(OPERATOR, 'GWS-EA Juno Hale')).toEqual({
      status: 'failed',
      reason: 'outcome_unknown',
    });
  });

  it('grants and revokes exactly one user on exactly one vault', async () => {
    const management = await managementIdentity();
    const { cli, calls } = await openCli(succeed);

    expect(
      await cli.grantVaultAccess(management, {
        vaultId: VAULT_ID,
        userId: OPERATOR_USER_ID,
        permissions: ['allow_viewing', 'allow_editing', 'allow_managing'],
      }),
    ).toEqual({ status: 'ok' });
    expect(
      await cli.revokeVaultAccess(OPERATOR, {
        vaultId: VAULT_ID,
        userId: PRINCIPAL_USER_ID,
        permissions: ['manage_vault'],
      }),
    ).toEqual({ status: 'ok' });
    expect(await cli.revokeVaultAccess(management, { vaultId: VAULT_ID, userId: PRINCIPAL_USER_ID })).toEqual({
      status: 'ok',
    });

    expect(calls.map((call) => call.args)).toEqual([
      [
        'vault',
        'user',
        'grant',
        '--no-input',
        '--vault',
        VAULT_ID,
        '--user',
        OPERATOR_USER_ID,
        '--permissions',
        'allow_viewing,allow_editing,allow_managing',
      ],
      [
        'vault',
        'user',
        'revoke',
        '--no-input',
        '--vault',
        VAULT_ID,
        '--user',
        PRINCIPAL_USER_ID,
        '--permissions',
        'manage_vault',
        '--account',
        ACCOUNT_ID,
      ],
      ['vault', 'user', 'revoke', '--no-input', '--vault', VAULT_ID, '--user', PRINCIPAL_USER_ID],
    ]);
  });

  it('names a vault after an email address', async () => {
    const { cli, calls } = await openCli(() => ({
      stdout: JSON.stringify({ id: VAULT_ID, name: 'Assistant aya+ea@example.test' }),
    }));
    expect(await cli.createVault(await managementIdentity(), 'Assistant aya+ea@example.test')).toEqual({
      status: 'ok',
      vaultId: VAULT_ID,
    });
    expect(calls[0].args).toEqual(['vault', 'create', 'Assistant aya+ea@example.test', '--format', 'json']);
  });

  it('reads one user by exact lowercase email, mapping their type and confirmation', async () => {
    const { cli, calls } = await openCli(() => ({
      stdout: JSON.stringify({
        id: PRINCIPAL_USER_ID,
        email: 'juno.hale@example.test',
        type: 'GUEST',
        state: 'ACTIVE',
      }),
    }));
    const management = await managementIdentity();
    expect(await cli.getUser(management, 'juno.hale@example.test')).toEqual({
      status: 'ok',
      user: { userId: PRINCIPAL_USER_ID, email: 'juno.hale@example.test', type: 'guest', active: true },
    });
    expect(calls[0].args).toEqual(['user', 'get', 'juno.hale@example.test', '--format', 'json']);
    for (const email of ['Juno.Hale@example.test', '-juno@example.test', 'juno', `${'a'.repeat(250)}@example.test`])
      await expect(cli.getUser(management, email)).rejects.toMatchObject({ code: 'invalid_onepassword_request' });
    expect(calls).toHaveLength(1);
  });

  it('treats an unrecognized user shape as unexpected and an unknown type as other', async () => {
    const replies = [
      {
        stdout: JSON.stringify({
          id: PRINCIPAL_USER_ID,
          email: 'juno.hale@example.test',
          type: 'OWNER',
          state: 'SUSPENDED',
        }),
      },
      { stdout: JSON.stringify({ id: 'short', email: 'juno.hale@example.test', type: 'MEMBER', state: 'ACTIVE' }) },
      { exitCode: 1, stderr: `[ERROR] "juno.hale@example.test" isn't a user in this account` },
    ];
    const { cli } = await openCli(() => replies.shift() ?? {});
    const management = await managementIdentity();
    expect(await cli.getUser(management, 'juno.hale@example.test')).toMatchObject({
      status: 'ok',
      user: { type: 'other', active: false },
    });
    expect(await cli.getUser(management, 'juno.hale@example.test')).toEqual({
      status: 'failed',
      reason: 'unexpected_output',
    });
    expect(await cli.getUser(management, 'juno.hale@example.test')).toEqual({ status: 'failed', reason: 'not_found' });
  });

  it('lists the users with direct access to exactly one vault', async () => {
    const replies = [
      { stdout: JSON.stringify([{ id: PRINCIPAL_USER_ID }, { id: OPERATOR_USER_ID }]) },
      { stdout: JSON.stringify([]) },
      { stdout: JSON.stringify([{ id: PRINCIPAL_USER_ID }, { name: 'no id' }]) },
    ];
    const { cli, calls } = await openCli(() => replies.shift() ?? {});
    const management = await managementIdentity();
    expect(await cli.listVaultUsers(management, VAULT_ID)).toEqual({
      status: 'ok',
      userIds: [PRINCIPAL_USER_ID, OPERATOR_USER_ID],
    });
    expect(calls[0].args).toEqual(['user', 'list', '--vault', VAULT_ID, '--format', 'json']);
    expect(await cli.listVaultUsers(management, VAULT_ID)).toEqual({ status: 'ok', userIds: [] });
    expect(await cli.listVaultUsers(management, VAULT_ID)).toEqual({ status: 'failed', reason: 'unexpected_output' });
    await expect(cli.listVaultUsers(management, 'not-a-vault')).rejects.toMatchObject({
      code: 'invalid_onepassword_request',
    });
  });

  it('deletes exactly one vault by its ID', async () => {
    const { cli, calls } = await openCli(succeed);
    expect(await cli.deleteVault(await managementIdentity(), VAULT_ID)).toEqual({ status: 'ok' });
    expect(calls[0].args).toEqual(['vault', 'delete', VAULT_ID]);
  });

  it('reads exactly one vault, succeeding only for the vault the provider returns', async () => {
    const runtime = await managementIdentity();
    const { cli, calls } = await openCli(() => ({ stdout: JSON.stringify({ id: VAULT_ID, name: 'Assistant' }) }));
    expect(await cli.getVault(runtime, VAULT_ID)).toEqual({ status: 'ok', vaultId: VAULT_ID });
    expect(calls[0].args).toEqual(['vault', 'get', VAULT_ID, '--format', 'json']);

    const other = await openCli(() => ({ stdout: JSON.stringify({ id: 'othervault0000000000000001' }) }));
    expect(await other.cli.getVault(runtime, VAULT_ID)).toEqual({ status: 'failed', reason: 'unexpected_output' });
    const missing = await openCli(() => ({
      exitCode: 1,
      stderr: `[ERROR] "${VAULT_ID}" isn't a vault in this account`,
    }));
    expect(await missing.cli.getVault(runtime, VAULT_ID)).toEqual({ status: 'failed', reason: 'not_found' });
    await expect(missing.cli.getVault(runtime, 'Private')).rejects.toMatchObject({
      code: 'invalid_onepassword_request',
    });
  });

  it.each([
    ['BUSINESS', 'business'],
    ['TEAM', 'teams'],
    ['FAMILY', 'families'],
    ['INDIVIDUAL', 'individual'],
  ])('reads a %s account as %s', async (type, accountType) => {
    const { cli, calls } = await openCli(() => ({ stdout: JSON.stringify({ id: ACCOUNT_ID, type, name: 'Hale' }) }));
    expect(await cli.accountType(await managementIdentity())).toEqual({ status: 'ok', accountType });
    expect(calls[0].args).toEqual(['account', 'get', '--format', 'json']);
  });

  it.each([
    ['an unknown plan', JSON.stringify({ id: ACCOUNT_ID, type: 'ENTERPRISE_PLUS' })],
    ['another account', JSON.stringify({ id: OTHER_ACCOUNT_ID, type: 'BUSINESS' })],
    ['no JSON', 'Business'],
  ])('reports an account with %s as unexpected output', async (_label, stdout) => {
    const { cli } = await openCli(() => ({ stdout }));
    expect(await cli.accountType(await managementIdentity())).toEqual({
      status: 'failed',
      reason: 'unexpected_output',
    });
  });

  it('refuses requests no fixed action allows', async () => {
    const { cli, calls } = await openCli(succeed);
    const management = await managementIdentity();
    const refusals = [
      cli.createVault(management, '--vault=Private'),
      cli.createVault(management, ''),
      cli.deleteVault(management, 'Private'),
      cli.grantVaultAccess(management, {
        vaultId: VAULT_ID,
        userId: 'morgan.ellery@example.test',
        permissions: ['allow_viewing'],
      }),
      cli.grantVaultAccess(management, { vaultId: VAULT_ID, userId: PRINCIPAL_USER_ID, permissions: [] }),
      cli.grantVaultAccess(management, {
        vaultId: VAULT_ID,
        userId: PRINCIPAL_USER_ID,
        permissions: ['allow_viewing', 'allow_viewing'],
      }),
      cli.whoami({ kind: 'operator', accountId: 'my.1password.com' }),
    ];
    for (const refusal of refusals)
      await expect(refusal).rejects.toMatchObject({ code: 'invalid_onepassword_request' });
    expect(calls).toHaveLength(0);
  });

  it("reads the service account's documented hourly and daily usage", async () => {
    const management = await managementIdentity();
    const { cli, calls } = await openCli(() => ({
      stdout: [
        'TYPE       ACTION        LIMIT    USED    REMAINING    RESET',
        'token      write         100      2       98           N/A',
        'token      read          1000     3       997          59 minutes from now',
        'account    read_write    5000     41      4959         23 hours from now',
        '',
      ].join('\n'),
    }));

    expect(await cli.rateLimits(management)).toEqual({
      status: 'ok',
      limits: [
        { scope: 'token', action: 'write', limit: 100, used: 2, remaining: 98 },
        { scope: 'token', action: 'read', limit: 1000, used: 3, remaining: 997 },
        { scope: 'account', action: 'read_write', limit: 5000, used: 41, remaining: 4959 },
      ],
    });
    expect(calls[0].args).toEqual(['service-account', 'ratelimit']);
  });

  it.each([
    ['no header', 'token write 100 2 98 N/A\n'],
    ['an unknown action', 'TYPE ACTION LIMIT USED REMAINING RESET\ntoken delete 100 2 98 N/A\n'],
    ['a non-numeric limit', 'TYPE ACTION LIMIT USED REMAINING RESET\ntoken write lots 2 98 N/A\n'],
    ['a repeated row', 'TYPE ACTION LIMIT USED REMAINING RESET\ntoken write 100 2 98 N/A\ntoken write 100 2 98 N/A\n'],
    ['no rows', 'TYPE ACTION LIMIT USED REMAINING RESET\n'],
  ])('reports usage with %s as unexpected output', async (_label, stdout) => {
    const { cli } = await openCli(() => ({ stdout }));
    expect(await cli.rateLimits(await managementIdentity())).toEqual({ status: 'failed', reason: 'unexpected_output' });
  });
});

describe('minting a service account token', () => {
  async function tokenFile(): Promise<string> {
    return path.join(await temporaryRoot(), 'browser-1password');
  }

  it('mints the host management account and captures its token privately', async () => {
    const minted = token();
    const file = await tokenFile();
    const { cli, calls } = await openCli(() => ({ stdout: `${minted}\n` }));

    const result = await cli.createServiceAccount(OPERATOR, {
      name: 'GWS-EA host management',
      access: { kind: 'create_vaults' },
      tokenFile: file,
    });

    expect(result).toEqual({ status: 'created' });
    expect(JSON.stringify(result)).not.toContain(minted);
    expect((await readFile(file, 'utf8')).trim()).toBe(minted);
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readdir(path.dirname(file))).toEqual(['browser-1password']);
    expect(calls[0].args).toEqual([
      'service-account',
      'create',
      'GWS-EA host management',
      '--can-create-vaults',
      '--raw',
      '--account',
      ACCOUNT_ID,
    ]);
    expect(opVariables(calls[0].env)).toEqual({});
  });

  it("mints an assistant's runtime account with read and write access to only its vault", async () => {
    const { cli, calls } = await openCli(() => ({ stdout: `${token()}\n` }));
    expect(
      await cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA Juno Hale runtime',
        access: { kind: 'vault_items', vaultId: VAULT_ID },
        tokenFile: await tokenFile(),
      }),
    ).toEqual({ status: 'created' });
    expect(calls[0].args).toEqual([
      'service-account',
      'create',
      'GWS-EA Juno Hale runtime',
      '--vault',
      `${VAULT_ID}:read_items,write_items`,
      '--raw',
      '--account',
      ACCOUNT_ID,
    ]);
  });

  it('recovers a captured token instead of minting again', async () => {
    const file = await tokenFile();
    const { cli, calls } = await openCli(() => ({ stdout: `${token()}\n` }));
    const request = { name: 'GWS-EA Juno Hale runtime', access: { kind: 'create_vaults' as const }, tokenFile: file };

    expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({ status: 'created' });
    expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({ status: 'recovered' });
    expect(calls).toHaveLength(1);
  });

  it('keeps an unparseable token private and reports the creation unknown, then never mints again until discarded', async () => {
    const minted = token();
    const file = await tokenFile();
    const { cli, calls } = await openCli(() => ({ stdout: `Service account created.\nToken: ${minted}\n` }));
    const request = { name: 'GWS-EA Juno Hale runtime', access: { kind: 'create_vaults' as const }, tokenFile: file };

    const first = await cli.createServiceAccount(OPERATOR, request);
    const retry = await cli.createServiceAccount(OPERATOR, request);

    expect(first).toEqual({ status: 'failed', reason: 'outcome_unknown' });
    expect(retry).toEqual({ status: 'failed', reason: 'outcome_unknown' });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify([first, retry])).not.toContain(minted);
    expect(await readFile(file, 'utf8')).toContain(minted);
    expect((await stat(file)).mode & 0o777).toBe(0o600);

    await discardServiceAccountCreation(file);
    expect(await readdir(path.dirname(file))).toEqual([]);
    expect(await cli.createServiceAccount(OPERATOR, request)).toMatchObject({ status: 'failed' });
    expect(calls).toHaveLength(2);
  });

  it('reports a token it could not persist as unknown and never mints again', async () => {
    const file = await tokenFile();
    const minted = token();
    const { cli, calls } = await openCli(async () => {
      await chmod(path.dirname(file), 0o500);
      return { stdout: `${minted}\n` };
    });
    const request = { name: 'GWS-EA Juno Hale runtime', access: { kind: 'create_vaults' as const }, tokenFile: file };

    const first = await cli.createServiceAccount(OPERATOR, request);
    await chmod(path.dirname(file), 0o700);
    const retry = await cli.createServiceAccount(OPERATOR, request);

    expect([first, retry]).toEqual([
      { status: 'failed', reason: 'outcome_unknown' },
      { status: 'failed', reason: 'outcome_unknown' },
    ]);
    expect(calls).toHaveLength(1);
    expect(JSON.stringify([first, retry])).not.toContain(minted);
  });

  it('reports an interrupted or unrecognized creation as unknown, and never mints again', async () => {
    for (const fail of [
      () => {
        throw new GwsEaError('command_timeout', 'Command timed out after 120.0s');
      },
      () => ({ stderr: '[ERROR] unexpected EOF', exitCode: 1 }),
    ]) {
      const file = await tokenFile();
      const { cli, calls } = await openCli(fail);
      const request = { name: 'GWS-EA Juno Hale runtime', access: { kind: 'create_vaults' as const }, tokenFile: file };
      expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({
        status: 'failed',
        reason: 'outcome_unknown',
      });
      expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({
        status: 'failed',
        reason: 'outcome_unknown',
      });
      expect(calls).toHaveLength(1);
    }
  });

  it('lets a rejected creation be retried, since nothing was created', async () => {
    const file = await tokenFile();
    let replies = [{ stderr: RATE_LIMITED, exitCode: 1 }, { stdout: `${token()}\n` }];
    const { cli, calls } = await openCli(() => {
      const [reply, ...rest] = replies;
      replies = rest;
      return reply;
    });
    const request = { name: 'GWS-EA Juno Hale runtime', access: { kind: 'create_vaults' as const }, tokenFile: file };

    expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({ status: 'failed', reason: 'rate_limited' });
    expect(await cli.createServiceAccount(OPERATOR, request)).toEqual({ status: 'created' });
    expect(calls).toHaveLength(2);
  });

  it('refuses an invalid request before recording any attempt, so a corrected retry still mints', async () => {
    const file = await tokenFile();
    const { cli, calls } = await openCli(() => ({ stdout: `${token()}\n` }));
    const refusals = [
      cli.createServiceAccount(
        { kind: 'operator', accountId: 'my.1password.com' },
        { name: 'GWS-EA host management', access: { kind: 'create_vaults' }, tokenFile: file },
      ),
      cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA Juno Hale runtime',
        access: { kind: 'vault_items', vaultId: 'Private' },
        tokenFile: file,
      }),
      cli.createServiceAccount(OPERATOR, {
        name: '--can-create-vaults',
        access: { kind: 'create_vaults' },
        tokenFile: file,
      }),
    ];
    for (const refusal of refusals)
      await expect(refusal).rejects.toMatchObject({ code: 'invalid_onepassword_request' });
    expect(await readdir(path.dirname(file))).toEqual([]);
    expect(
      await cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA host management',
        access: { kind: 'create_vaults' },
        tokenFile: file,
      }),
    ).toEqual({ status: 'created' });
    expect(calls).toHaveLength(1);
  });

  it('refuses to capture a token into a directory others can read', async () => {
    const file = await tokenFile();
    await chmod(path.dirname(file), 0o755);
    const { cli, calls } = await openCli(succeed);
    await expect(
      cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA host management',
        access: { kind: 'create_vaults' },
        tokenFile: file,
      }),
    ).rejects.toMatchObject({ code: 'unsafe_mode' });
    expect(calls).toHaveLength(0);
  });

  it('never writes a minted token to the run log, whether or not it parses', async () => {
    const root = await temporaryRoot();
    const run = await startRunLog({
      paths: resolveControlPlanePaths({ configRoot: path.join(root, 'config'), stateRoot: path.join(root, 'state') }),
      command: 'create',
    });
    const directory = await temporaryRoot();
    const executable = path.join(directory, 'op');
    const stdoutFile = path.join(directory, 'stdout');
    // The child prints whatever the test last put in `stdout`, on both streams, as a confused CLI might.
    await writeFile(
      executable,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs');",
        "if (process.argv[2] === '--version') { process.stdout.write('2.31.0\\n'); process.exit(0); }",
        `const text = fs.readFileSync(${JSON.stringify(stdoutFile)}, 'utf8');`,
        'process.stdout.write(text); process.stderr.write(`notice: ${text}`);',
      ].join('\n'),
      { mode: 0o700 },
    );
    const opening = await OnePasswordCli.open({ resolve: async () => executable, ambient: AMBIENT });
    if (opening.status !== 'ready') throw new Error(opening.reason);
    const parsed = token();
    const unparsed = token();

    await writeFile(stdoutFile, `${parsed}\n`);
    const created = await run.step('mint_runtime', () =>
      opening.cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA Juno Hale runtime',
        access: { kind: 'vault_items', vaultId: VAULT_ID },
        tokenFile: path.join(directory, 'runtime-token'),
      }),
    );
    await writeFile(stdoutFile, `Token: ${unparsed}\n`);
    const unknown = await run.step('mint_management', () =>
      opening.cli.createServiceAccount(OPERATOR, {
        name: 'GWS-EA host management',
        access: { kind: 'create_vaults' },
        tokenFile: path.join(directory, 'management-token'),
      }),
    );

    expect([created, unknown]).toEqual([{ status: 'created' }, { status: 'failed', reason: 'outcome_unknown' }]);
    const logged = await runLogText(run);
    expect(logged).toContain('bytes (private, not logged)');
    for (const minted of [parsed, unparsed]) expect(logged).not.toContain(minted);
  });
});
