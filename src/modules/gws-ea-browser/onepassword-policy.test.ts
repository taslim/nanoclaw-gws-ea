import { randomBytes } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { REDACTED, redact } from '../../gws-ea/redact.js';
import {
  isOnePasswordId,
  onePasswordHostPaths,
  onePasswordInstancePaths,
  onePasswordManagementIdentity,
  onePasswordSignInAddress,
  readOnePasswordHostPolicy,
  readOnePasswordResources,
  readOnePasswordToken,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
  type OnePasswordHostPolicy,
  type OnePasswordResources,
} from './onepassword-policy.js';

const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const OTHER_ACCOUNT_ID = 'REMYVANCEACCOUNT0000000002';
const MANAGEMENT_ID = 'MANAGEMENTSERVICEACCOUNT01';
const RUNTIME_ID = 'RUNTIMESERVICEACCOUNT00001';
const OPERATOR_USER_ID = 'MORGANELLERYUSER0000000001';
const VAULT_ID = 'morganelleryvault000000001';
const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const OTHER_INSTANCE_ID = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'gws-ea-onepassword-policy-')));
  roots.push(root);
  return root;
}

function hostPolicy(overrides: Partial<OnePasswordHostPolicy> = {}): OnePasswordHostPolicy {
  return {
    schemaVersion: 2,
    enabled: true,
    accountId: ACCOUNT_ID,
    signInAddress: 'hale.1password.com',
    cliPath: '/opt/homebrew/bin/op',
    managementServiceAccountId: MANAGEMENT_ID,
    ...overrides,
  };
}

function resources(overrides: Partial<OnePasswordResources> = {}): OnePasswordResources {
  return {
    schemaVersion: 2,
    instanceId: INSTANCE_ID,
    accountId: ACCOUNT_ID,
    vault: { id: VAULT_ID, createdBy: { kind: 'management_service_account', serviceAccountId: MANAGEMENT_ID } },
    operatorGrant: { userId: OPERATOR_USER_ID, permissions: ['allow_managing'] },
    runtimeServiceAccountId: RUNTIME_ID,
    retiredRuntimeServiceAccountIds: [],
    ...overrides,
  };
}

/** A configuration root with a written host policy, and the policy file's raw JSON rewritten by `edit`. */
async function writtenHostPolicy(edit?: (raw: Record<string, unknown>) => unknown): Promise<string> {
  const paths = onePasswordHostPaths(path.join(await temporaryRoot(), 'config'));
  await mkdir(path.dirname(paths.directory), { mode: 0o700 });
  await writeOnePasswordHostPolicy(paths.policyFile, hostPolicy());
  if (edit) {
    const raw = JSON.parse(await readFile(paths.policyFile, 'utf8')) as Record<string, unknown>;
    const edited = edit(raw);
    await writeFile(paths.policyFile, typeof edited === 'string' ? edited : JSON.stringify(edited));
  }
  return paths.policyFile;
}

/** An assistant's private instance root, named for its ID, holding a written resource record. */
async function writtenResources(instanceId = INSTANCE_ID): Promise<string> {
  const instanceRoot = path.join(await temporaryRoot(), instanceId.slice(0, 8));
  await mkdir(instanceRoot, { mode: 0o700 });
  const { resourceFile } = onePasswordInstancePaths(instanceRoot);
  await writeOnePasswordResources(resourceFile, resources({ instanceId }));
  return resourceFile;
}

describe('1Password identifiers', () => {
  it('accepts only 26-character alphanumeric IDs', () => {
    for (const valid of [ACCOUNT_ID, VAULT_ID]) expect(isOnePasswordId(valid)).toBe(true);
    for (const invalid of [
      '',
      ACCOUNT_ID.slice(1),
      `${ACCOUNT_ID}0`,
      'JUNOHALEACCOUNT0000000000-',
      'my.1password.com',
      7,
    ])
      expect(isOnePasswordId(invalid)).toBe(false);
  });
});

describe('the account sign-in address', () => {
  it('keeps the address the 1Password app lists, in one form, and builds its link from that alone', () => {
    for (const [listed, address] of [
      ['hale.1password.com', 'hale.1password.com'],
      ['https://Hale.1Password.com/', 'hale.1password.com'],
      ['my.1password.eu', 'my.1password.eu'],
      ['vance-team.ent.1password.com', 'vance-team.ent.1password.com'],
    ])
      expect(onePasswordSignInAddress(listed)).toBe(address);
    for (const other of [
      '',
      '1password.com',
      'hale.1password.example',
      'hale.1password.com.example',
      'http://hale.1password.com',
      'https://hale.1password.com/vaults',
      'hale.1password.com?a=x',
      'a.b.c.1password.com',
    ])
      expect(onePasswordSignInAddress(other)).toBeUndefined();
  });
});

describe('the host 1Password policy', () => {
  it('lives in one private directory under the configuration root, beside the management token', () => {
    expect(onePasswordHostPaths('/Users/operator/.config/gws-ea')).toEqual({
      directory: '/Users/operator/.config/gws-ea/onepassword',
      policyFile: '/Users/operator/.config/gws-ea/onepassword/policy.json',
      managementTokenFile: '/Users/operator/.config/gws-ea/onepassword/management-token',
    });
  });

  it('round-trips an owner-only policy in an owner-only directory', async () => {
    const file = await writtenHostPolicy();
    const read = await readOnePasswordHostPolicy(file);

    expect(read).toEqual({
      status: 'ready',
      policy: hostPolicy(),
      paths: {
        directory: path.dirname(file),
        policyFile: file,
        managementTokenFile: path.join(path.dirname(file), 'management-token'),
      },
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect((await stat(path.dirname(file))).mode & 0o777).toBe(0o700);
  });

  it('records the fallback without a management service account, which then has no management identity', async () => {
    const paths = onePasswordHostPaths(await temporaryRoot());
    const fallback = hostPolicy({ managementServiceAccountId: null });
    await writeOnePasswordHostPolicy(paths.policyFile, fallback);

    const read = await readOnePasswordHostPolicy(paths.policyFile);
    expect(read).toMatchObject({ status: 'ready', policy: fallback });
    expect(onePasswordManagementIdentity(fallback, paths)).toBeNull();
    expect(onePasswordManagementIdentity(hostPolicy(), paths)).toEqual({
      kind: 'service_account',
      accountId: ACCOUNT_ID,
      tokenFile: paths.managementTokenFile,
    });
  });

  it('records the disabled intent beside the account and management identity it keeps', async () => {
    const paths = onePasswordHostPaths(await temporaryRoot());
    const disabled = hostPolicy({ enabled: false });
    await writeOnePasswordHostPolicy(paths.policyFile, disabled);
    expect(await readOnePasswordHostPolicy(paths.policyFile)).toMatchObject({ status: 'ready', policy: disabled });
  });

  it('is absent when neither its directory nor its file exists', async () => {
    const paths = onePasswordHostPaths(await temporaryRoot());
    expect(await readOnePasswordHostPolicy(paths.policyFile)).toEqual({ status: 'absent' });
    await mkdir(paths.directory, { mode: 0o700 });
    expect(await readOnePasswordHostPolicy(paths.policyFile)).toEqual({ status: 'absent' });
  });

  it('fails closed on unsafe permissions, links and locations', async () => {
    const readable = await writtenHostPolicy();
    await chmod(readable, 0o644);
    const openDirectory = await writtenHostPolicy();
    await chmod(path.dirname(openDirectory), 0o755);
    const linked = await writtenHostPolicy();
    const elsewhere = path.join(await temporaryRoot(), 'elsewhere.json');
    await writeFile(elsewhere, JSON.stringify(hostPolicy()), { mode: 0o600 });
    await rm(linked);
    await symlink(elsewhere, linked);
    const misplaced = path.join(path.dirname(await writtenHostPolicy()), 'other.json');
    await writeFile(misplaced, JSON.stringify(hostPolicy()), { mode: 0o600 });

    for (const file of [readable, openDirectory, linked, misplaced, 'onepassword/policy.json', '/tmp/x/policy.json'])
      expect(await readOnePasswordHostPolicy(file)).toEqual({ status: 'invalid', problem: 'unsafe' });
  });

  it.each([
    ['invalid JSON', () => '{"schemaVersion": 1,'],
    ['an unknown field', (raw: Record<string, unknown>) => ({ ...raw, tokenFile: '/tmp/token' })],
    ['a newer schema', (raw: Record<string, unknown>) => ({ ...raw, schemaVersion: 3 })],
    [
      'the first schema, which had no disabled intent',
      ({ enabled: _omitted, ...raw }: Record<string, unknown>) => ({ ...raw, schemaVersion: 1 }),
    ],
    ['a missing disabled intent', ({ enabled: _omitted, ...raw }: Record<string, unknown>) => raw],
    ['a disabled intent that is not a boolean', (raw: Record<string, unknown>) => ({ ...raw, enabled: 'no' })],
    ['an account shorthand instead of its ID', (raw: Record<string, unknown>) => ({ ...raw, accountId: 'my' })],
    ['a missing sign-in address', ({ signInAddress: _omitted, ...raw }: Record<string, unknown>) => raw],
    [
      'a sign-in address on another domain',
      (raw: Record<string, unknown>) => ({ ...raw, signInAddress: 'hale.1password.example' }),
    ],
    [
      'a sign-in address that is a full URL',
      (raw: Record<string, unknown>) => ({ ...raw, signInAddress: 'https://hale.1password.com/vaults' }),
    ],
    ['a relative CLI path', (raw: Record<string, unknown>) => ({ ...raw, cliPath: 'bin/op' })],
    ['an unnormalized CLI path', (raw: Record<string, unknown>) => ({ ...raw, cliPath: '/opt/homebrew/../bin/op' })],
    ['a missing management field', ({ managementServiceAccountId: _omitted, ...raw }: Record<string, unknown>) => raw],
    ['a malformed management ID', (raw: Record<string, unknown>) => ({ ...raw, managementServiceAccountId: 'x' })],
    ['an array', () => '[]'],
  ])('fails closed on %s', async (_label, edit) => {
    expect(await readOnePasswordHostPolicy(await writtenHostPolicy(edit))).toEqual({
      status: 'invalid',
      problem: 'malformed',
    });
  });

  it('refuses to write an invalid policy or to a location outside its contract', async () => {
    const paths = onePasswordHostPaths(await temporaryRoot());
    await expect(writeOnePasswordHostPolicy(paths.policyFile, hostPolicy({ accountId: 'acme' }))).rejects.toMatchObject(
      {
        code: 'invalid_onepassword_policy',
      },
    );
    await expect(
      writeOnePasswordHostPolicy(path.join(paths.directory, 'other.json'), hostPolicy()),
    ).rejects.toMatchObject({ code: 'unsafe_path' });
    await expect(readFile(paths.policyFile)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

describe("an assistant's 1Password resource record", () => {
  it('keeps the runtime token in the instance secrets and the identifiers outside them', () => {
    expect(onePasswordInstancePaths('/state/3f2a9c1e')).toEqual({
      runtimeTokenFile: '/state/3f2a9c1e/secrets/browser-1password',
      resourceFile: '/state/3f2a9c1e/onepassword.json',
    });
  });

  it('round-trips the exact owned resources of its own instance', async () => {
    const file = await writtenResources();
    expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID, accountId: ACCOUNT_ID })).toEqual({
      status: 'ready',
      resources: resources(),
    });
    expect((await stat(file)).mode & 0o777).toBe(0o600);
  });

  it('records a vault the operator created, and a vault whose runtime service account is not minted yet', async () => {
    const instanceRoot = path.join(await temporaryRoot(), INSTANCE_ID.slice(0, 8));
    await mkdir(instanceRoot, { mode: 0o700 });
    const { resourceFile } = onePasswordInstancePaths(instanceRoot);
    const staged = resources({
      vault: { id: VAULT_ID, createdBy: { kind: 'operator' } },
      operatorGrant: null,
      runtimeServiceAccountId: null,
    });
    await writeOnePasswordResources(resourceFile, staged);
    expect(await readOnePasswordResources(resourceFile, { instanceId: INSTANCE_ID })).toEqual({
      status: 'ready',
      resources: staged,
    });
  });

  it('keeps the runtime service accounts whose local tokens were deleted, until the assistant is removed', async () => {
    const instanceRoot = path.join(await temporaryRoot(), INSTANCE_ID.slice(0, 8));
    await mkdir(instanceRoot, { mode: 0o700 });
    const { resourceFile } = onePasswordInstancePaths(instanceRoot);
    const retired = resources({
      runtimeServiceAccountId: null,
      retiredRuntimeServiceAccountIds: [RUNTIME_ID, 'RUNTIMESERVICEACCOUNT00002'],
    });
    await writeOnePasswordResources(resourceFile, retired);
    expect(await readOnePasswordResources(resourceFile, { instanceId: INSTANCE_ID })).toEqual({
      status: 'ready',
      resources: retired,
    });
  });

  it('is absent before provisioning', async () => {
    const instanceRoot = path.join(await temporaryRoot(), INSTANCE_ID.slice(0, 8));
    await mkdir(instanceRoot, { mode: 0o700 });
    expect(
      await readOnePasswordResources(onePasswordInstancePaths(instanceRoot).resourceFile, { instanceId: INSTANCE_ID }),
    ).toEqual({ status: 'absent' });
  });

  it("refuses another instance's record and a record in another account", async () => {
    const file = await writtenResources();
    expect(await readOnePasswordResources(file, { instanceId: OTHER_INSTANCE_ID })).toEqual({
      status: 'invalid',
      problem: 'wrong_instance',
    });
    expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID, accountId: OTHER_ACCOUNT_ID })).toEqual({
      status: 'invalid',
      problem: 'wrong_account',
    });

    // A record copied under another assistant's root names the wrong instance for its location.
    const otherRoot = path.join(await temporaryRoot(), OTHER_INSTANCE_ID.slice(0, 8));
    await mkdir(otherRoot, { mode: 0o700 });
    const copied = onePasswordInstancePaths(otherRoot).resourceFile;
    await writeFile(copied, await readFile(file), { mode: 0o600 });
    expect(await readOnePasswordResources(copied, { instanceId: OTHER_INSTANCE_ID })).toEqual({
      status: 'invalid',
      problem: 'wrong_instance',
    });
    await expect(writeOnePasswordResources(copied, resources())).rejects.toMatchObject({ code: 'unsafe_path' });
  });

  it('fails closed on unsafe permissions', async () => {
    const readable = await writtenResources();
    await chmod(readable, 0o640);
    const openRoot = await writtenResources();
    await chmod(path.dirname(openRoot), 0o755);
    for (const file of [readable, openRoot])
      expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID })).toEqual({
        status: 'invalid',
        problem: 'unsafe',
      });
  });

  it.each([
    ['an unknown creator', { kind: 'principal' }],
    ['a management creator without its ID', { kind: 'management_service_account' }],
    ['an operator creator naming an ID', { kind: 'operator', serviceAccountId: MANAGEMENT_ID }],
  ])('fails closed on %s', async (_label, createdBy) => {
    const file = await writtenResources();
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...raw, vault: { id: VAULT_ID, createdBy } }));
    expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID })).toEqual({
      status: 'invalid',
      problem: 'malformed',
    });
  });

  it.each([
    ['a grant without permissions', { userId: OPERATOR_USER_ID, permissions: [] }],
    ['an undocumented permission', { userId: OPERATOR_USER_ID, permissions: ['administer'] }],
    ['a repeated permission', { userId: OPERATOR_USER_ID, permissions: ['allow_managing', 'allow_managing'] }],
    ['a grant to an email address', { userId: 'morgan.ellery@example.test', permissions: ['allow_managing'] }],
    ['a missing grant', undefined],
  ])('fails closed on %s', async (_label, operatorGrant) => {
    const file = await writtenResources();
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...raw, operatorGrant }));
    expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID })).toEqual({
      status: 'invalid',
      problem: 'malformed',
    });
  });

  it.each([
    [
      'the first schema, which kept no retired accounts',
      { schemaVersion: 1, retiredRuntimeServiceAccountIds: undefined },
    ],
    ['a repeated retired account', { retiredRuntimeServiceAccountIds: [MANAGEMENT_ID, MANAGEMENT_ID] }],
    ['the current runtime account among the retired', { retiredRuntimeServiceAccountIds: [RUNTIME_ID] }],
    ['a malformed retired account', { retiredRuntimeServiceAccountIds: ['GWS-EA runtime'] }],
  ])('fails closed on %s', async (_label, edit) => {
    const file = await writtenResources();
    const raw = JSON.parse(await readFile(file, 'utf8')) as Record<string, unknown>;
    await writeFile(file, JSON.stringify({ ...raw, ...edit }));
    expect(await readOnePasswordResources(file, { instanceId: INSTANCE_ID })).toEqual({
      status: 'invalid',
      problem: 'malformed',
    });
  });

  it('refuses to write malformed identifiers', async () => {
    const instanceRoot = path.join(await temporaryRoot(), INSTANCE_ID.slice(0, 8));
    await mkdir(instanceRoot, { mode: 0o700 });
    const { resourceFile } = onePasswordInstancePaths(instanceRoot);
    await expect(
      writeOnePasswordResources(resourceFile, resources({ vault: { id: 'Private', createdBy: { kind: 'operator' } } })),
    ).rejects.toMatchObject({ code: 'invalid_onepassword_resources' });
  });
});

describe('a service account token file', () => {
  async function tokenFile(contents: string, mode = 0o600): Promise<string> {
    const file = path.join(await temporaryRoot(), 'browser-1password');
    await writeFile(file, contents, { mode });
    return file;
  }

  it('reads one trimmed token and registers it for redaction before returning it', async () => {
    const token = `ops_${randomBytes(48).toString('base64url')}`;
    expect(await readOnePasswordToken(await tokenFile(`${token}\n`))).toEqual({ status: 'ready', token });
    expect(redact(`header ${token} trailer`)).toBe(`header ${REDACTED} trailer`);
  });

  it('is absent before it is minted', async () => {
    expect(await readOnePasswordToken(path.join(await temporaryRoot(), 'missing'))).toEqual({ status: 'absent' });
  });

  it('refuses an unsafe file or anything but one token line', async () => {
    const token = `ops_${randomBytes(48).toString('base64url')}`;
    const openDirectory = await tokenFile(token);
    await chmod(path.dirname(openDirectory), 0o755);
    for (const file of [
      await tokenFile(token, 0o640),
      openDirectory,
      await tokenFile(''),
      await tokenFile(`Token: ${token}`),
      await tokenFile(`${token}\n${token}`),
      await tokenFile(JSON.stringify({ token })),
    ])
      expect(await readOnePasswordToken(file)).toEqual({ status: 'invalid' });
    expect(await readOnePasswordToken('relative/browser-1password')).toEqual({ status: 'invalid' });
  });
});
