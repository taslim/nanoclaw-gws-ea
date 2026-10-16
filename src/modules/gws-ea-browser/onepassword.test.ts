import { chmod, mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  onePasswordHostPaths,
  onePasswordInstancePaths,
  writeOnePasswordHostPolicy,
  writeOnePasswordResources,
  type OnePasswordResources,
} from './onepassword-policy.js';
import { BrowserVault, websitePermitsOrigin } from './onepassword.js';
import { writePrivateFile } from './paths.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), vaults: vi.fn(), resolve: vi.fn() }));
vi.mock('@1password/sdk', () => ({
  createClient: sdk.create,
  RateLimitExceededError: class RateLimitExceededError extends Error {},
}));

const ACCOUNT_ID = 'JUNOHALEACCOUNT00000000001';
const OTHER_ACCOUNT_ID = 'REMYVANCEACCOUNT0000000002';
const MANAGEMENT_ID = 'MANAGEMENTSERVICEACCOUNT01';
const RUNTIME_ID = 'RUNTIMESERVICEACCOUNT00001';
const VAULT_ID = 'morganelleryvault000000001';
const OTHER_VAULT_ID = 'remyvancevault000000000002';
const INSTANCE_ID = '3f2a9c1e-5b7d-4e8f-9a0b-1c2d3e4f5a6b';
const OTHER_INSTANCE_ID = '7a8b9c0d-1e2f-4a3b-8c4d-5e6f7a8b9c0d';
const TOKEN = 'ops_fixture-runtime-service-account-token';
const SECRET = 'fixture-password-private';

let directory: string;
let instanceRoot: string;
let onePasswordPolicyFile: string;
let browserPolicyFile: string;
let tokenFile: string;
let resourceFile: string;
let markerFile: string;
const website = (autofillBehavior = 'AnywhereOnWebsite', url = 'https://shop.example') => ({
  url,
  label: '',
  autofillBehavior,
});
const item = {
  id: 'item1',
  vaultId: VAULT_ID,
  title: 'Shop login',
  category: 'Login',
  state: 'active',
  websites: [website()],
};
const resources = (overrides: Partial<OnePasswordResources> = {}): OnePasswordResources => ({
  schemaVersion: 1,
  instanceId: INSTANCE_ID,
  accountId: ACCOUNT_ID,
  vault: { id: VAULT_ID, createdBy: { kind: 'management_service_account', serviceAccountId: MANAGEMENT_ID } },
  operatorGrant: null,
  runtimeServiceAccountId: RUNTIME_ID,
  ...overrides,
});
const vault = (): BrowserVault => new BrowserVault({ browserPolicyFile, onePasswordPolicyFile });

beforeEach(async () => {
  directory = await realpath(await mkdtemp(path.join(os.tmpdir(), 'browser-vault-')));
  const configRoot = path.join(directory, 'config');
  await mkdir(configRoot, { mode: 0o700 });
  onePasswordPolicyFile = onePasswordHostPaths(configRoot).policyFile;
  await writeOnePasswordHostPolicy(onePasswordPolicyFile, {
    schemaVersion: 1,
    accountId: ACCOUNT_ID,
    cliPath: '/opt/homebrew/bin/op',
    managementServiceAccountId: MANAGEMENT_ID,
  });
  instanceRoot = path.join(directory, INSTANCE_ID.slice(0, 8));
  await mkdir(instanceRoot, { mode: 0o700 });
  browserPolicyFile = path.join(instanceRoot, 'browser', 'policy.json');
  markerFile = path.join(instanceRoot, 'state', 'data', 'gws-ea', 'instance.json');
  await writePrivateFile(markerFile, JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }));
  ({ runtimeTokenFile: tokenFile, resourceFile } = onePasswordInstancePaths(instanceRoot));
  await writeOnePasswordResources(resourceFile, resources());
  await writePrivateFile(tokenFile, TOKEN);
  vi.clearAllMocks();
  sdk.create.mockResolvedValue({
    vaults: { list: sdk.vaults },
    items: { list: sdk.list },
    secrets: { resolve: sdk.resolve },
  });
  sdk.vaults.mockResolvedValue([{ id: VAULT_ID }]);
  sdk.list.mockResolvedValue([item]);
  sdk.resolve.mockResolvedValue(SECRET);
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('keeps IDs and values host-only, caches overviews, and resolves only the chosen field at fill time', async () => {
  const subject = vault();
  const choices = await subject.itemsForOrigin('https://www.shop.example');
  expect(choices).toEqual([{ title: 'Shop login', item_handle: expect.stringMatching(/^vault_/u) }]);
  expect(JSON.stringify(choices)).not.toMatch(new RegExp(`item1|${VAULT_ID}|${SECRET}|${TOKEN}`, 'u'));
  await subject.itemsForOrigin('https://www.shop.example');
  expect(sdk.list).toHaveBeenCalledTimes(1);
  expect(sdk.list).toHaveBeenCalledWith(VAULT_ID, expect.anything());
  expect(sdk.resolve).not.toHaveBeenCalled();
  expect(await subject.resolve(choices[0].item_handle, 'password', 'https://www.shop.example')).toBe(SECRET);
  expect(sdk.resolve).toHaveBeenCalledWith(`op://${VAULT_ID}/item1/password`);
  await subject.resolve(choices[0].item_handle, 'otp', 'https://www.shop.example');
  expect(sdk.resolve).toHaveBeenLastCalledWith(`op://${VAULT_ID}/item1/one-time password?attribute=otp`);
  expect(sdk.create).toHaveBeenCalledTimes(1);
  expect(sdk.create).toHaveBeenCalledWith(expect.objectContaining({ auth: TOKEN }));
});

it('matches HTTPS, private registrable domains and exact effective ports, ignoring Never', () => {
  expect(websitePermitsOrigin(website(), 'https://www.shop.example')).toBe(true);
  expect(websitePermitsOrigin(website(), 'http://shop.example')).toBe(false);
  expect(
    websitePermitsOrigin(website('ExactDomain', 'https://login.shop.example:8443'), 'https://login.shop.example'),
  ).toBe(false);
  expect(
    websitePermitsOrigin(website('ExactDomain', 'https://login.shop.example:443'), 'https://login.shop.example'),
  ).toBe(true);
  expect(websitePermitsOrigin(website('ExactDomain', 'https://login.shop.example'), 'https://shop.example')).toBe(
    false,
  );
  expect(websitePermitsOrigin(website('Never'), 'https://shop.example')).toBe(false);
  expect(websitePermitsOrigin(website('AnywhereOnWebsite', 'https://alice.github.io'), 'https://bob.github.io')).toBe(
    false,
  );
});

it('refuses an ineligible frame before resolving, and serves misses from the cache until an explicit refresh', async () => {
  vi.useFakeTimers();
  const subject = vault();
  const choices = await subject.itemsForOrigin('https://shop.example');
  await expect(subject.resolve(choices[0].item_handle, 'password', 'http://shop.example')).rejects.toMatchObject({
    reason: 'origin_mismatch',
  });
  expect(sdk.resolve).not.toHaveBeenCalled();
  // The principal saves a login for another site: nothing lists the vault again on its own, however long it waits.
  const library = {
    ...item,
    id: 'item2',
    title: 'Library login',
    websites: [website(undefined, 'https://library.example')],
  };
  sdk.list.mockResolvedValue([item, library]);
  vi.advanceTimersByTime(24 * 60 * 60_000);
  expect(await subject.itemsForOrigin('https://library.example')).toEqual([]);
  await expect(subject.resolve('vault_unlisted', 'password', 'https://library.example')).rejects.toMatchObject({
    reason: 'no_item_for_site',
  });
  expect(sdk.list).toHaveBeenCalledTimes(1);
  await subject.refresh();
  expect(sdk.list).toHaveBeenCalledTimes(2);
  expect(await subject.itemsForOrigin('https://library.example')).toEqual([
    { title: 'Library login', item_handle: expect.stringMatching(/^vault_/u) },
  ]);
  // A refresh keeps the handles of logins it still lists.
  expect(await subject.itemsForOrigin('https://shop.example')).toEqual(choices);
  expect(sdk.list).toHaveBeenCalledTimes(2);
  expect(sdk.create).toHaveBeenCalledTimes(1);
});

describe('availability from the provisioned resources', () => {
  it('requires the host policy, this instance’s finished resource record and an owner-only token', async () => {
    expect(await vault().availability()).toEqual({
      status: 'available',
      binding: {
        instanceId: INSTANCE_ID,
        accountId: ACCOUNT_ID,
        vaultId: VAULT_ID,
        runtimeServiceAccountId: RUNTIME_ID,
      },
    });
    await rm(tokenFile);
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'not_provisioned' });
    await writePrivateFile(tokenFile, TOKEN);
    await writeOnePasswordResources(resourceFile, resources({ runtimeServiceAccountId: null }));
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'not_provisioned' });
    await rm(resourceFile);
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'not_provisioned' });
    await writeOnePasswordResources(resourceFile, resources());
    await rm(onePasswordPolicyFile);
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'not_enabled' });
    expect(await new BrowserVault({ browserPolicyFile, onePasswordPolicyFile: '' }).availability()).toEqual({
      status: 'unavailable',
      reason: 'not_enabled',
    });
    await expect(vault().itemsForOrigin('https://shop.example')).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    expect(sdk.create).not.toHaveBeenCalled();
  });

  it('refuses a resource record for another instance or account, and an unlocatable instance', async () => {
    await writePrivateFile(resourceFile, JSON.stringify(resources({ instanceId: OTHER_INSTANCE_ID })));
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'invalid_state' });
    await writeOnePasswordResources(resourceFile, resources({ accountId: OTHER_ACCOUNT_ID }));
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'invalid_state' });
    await writeOnePasswordResources(resourceFile, resources());
    // The host's own marker names its instance: a record in a root named for another assistant is refused.
    await writePrivateFile(markerFile, JSON.stringify({ schema_version: 1, instance_id: OTHER_INSTANCE_ID }));
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'invalid_state' });
    await rm(markerFile);
    expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'invalid_state' });
    await writePrivateFile(markerFile, JSON.stringify({ schema_version: 1, instance_id: INSTANCE_ID }));
    for (const located of ['', path.join(instanceRoot, 'policy.json'), path.join(instanceRoot, 'browser', 'x.json')])
      expect(await new BrowserVault({ browserPolicyFile: located, onePasswordPolicyFile }).availability()).toEqual({
        status: 'unavailable',
        reason: 'invalid_state',
      });
    await expect(
      new BrowserVault({ browserPolicyFile: '', onePasswordPolicyFile }).itemsForOrigin('https://shop.example'),
    ).rejects.toMatchObject({ reason: 'vault_unavailable' });
    expect(sdk.create).not.toHaveBeenCalled();
    expect(await vault().availability()).toMatchObject({ status: 'available' });
  });

  it('uses exactly the recorded vault and refuses a token for any other, whatever else it can see', async () => {
    sdk.vaults.mockResolvedValue([{ id: OTHER_VAULT_ID }]);
    await expect(vault().itemsForOrigin('https://shop.example')).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    sdk.vaults.mockResolvedValue([]);
    await expect(vault().itemsForOrigin('https://shop.example')).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    expect(sdk.list).not.toHaveBeenCalled();
    sdk.vaults.mockResolvedValue([{ id: OTHER_VAULT_ID }, { id: VAULT_ID }]);
    sdk.list.mockResolvedValue([item, { ...item, id: 'item2', vaultId: OTHER_VAULT_ID }]);
    expect(await vault().itemsForOrigin('https://shop.example')).toEqual([
      { title: 'Shop login', item_handle: expect.stringMatching(/^vault_/u) },
    ]);
    expect(sdk.list).toHaveBeenCalledTimes(1);
    expect(sdk.list).toHaveBeenCalledWith(VAULT_ID, expect.anything());
  });

  it('rebinds when provisioning replaces the token or the recorded vault', async () => {
    const subject = vault();
    const [first] = await subject.itemsForOrigin('https://shop.example');
    await writePrivateFile(tokenFile, `${TOKEN}-replacement`);
    expect(await subject.itemsForOrigin('https://shop.example')).toHaveLength(1);
    expect(sdk.create).toHaveBeenCalledTimes(2);
    expect(sdk.create).toHaveBeenLastCalledWith(expect.objectContaining({ auth: `${TOKEN}-replacement` }));
    await expect(subject.resolve(first.item_handle, 'password', 'https://shop.example')).rejects.toMatchObject({
      reason: 'no_item_for_site',
    });
    await writeOnePasswordResources(
      resourceFile,
      resources({ vault: { id: OTHER_VAULT_ID, createdBy: { kind: 'operator' } } }),
    );
    await expect(subject.itemsForOrigin('https://shop.example')).rejects.toMatchObject({
      reason: 'vault_unavailable',
    });
    expect(sdk.create).toHaveBeenCalledTimes(3);
    expect(sdk.list).toHaveBeenCalledTimes(2);
  });
});

it('maps SDK rate limits and scrubs all other SDK error material', async () => {
  const { RateLimitExceededError } = await import('@1password/sdk');
  sdk.list.mockRejectedValue(new RateLimitExceededError(SECRET));
  const subject = vault();
  await expect(subject.itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'rate_limited',
    message: 'rate_limited',
  });
  await expect(subject.itemsForOrigin('https://shop.example')).rejects.toMatchObject({ reason: 'rate_limited' });
  await expect(subject.refresh()).rejects.toMatchObject({ reason: 'rate_limited' });
  expect(sdk.list).toHaveBeenCalledTimes(1);
  sdk.create.mockRejectedValue(new Error(SECRET));
  await expect(vault().itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
    message: 'vault_unavailable',
  });
});

it('reads a fill’s metadata from the cache and spends one request on its secret; a 429 stops further calls', async () => {
  vi.useFakeTimers();
  const { RateLimitExceededError } = await import('@1password/sdk');
  const subject = vault();
  const [choice] = await subject.itemsForOrigin('https://shop.example');
  const requests = (): number =>
    [sdk.create, sdk.vaults, sdk.list, sdk.resolve].reduce((total, call) => total + call.mock.calls.length, 0);
  const before = requests();
  vi.advanceTimersByTime(24 * 60 * 60_000);
  expect(await subject.resolve(choice.item_handle, 'password', 'https://shop.example')).toBe(SECRET);
  expect(requests()).toBe(before + 1);
  sdk.resolve.mockRejectedValue(new RateLimitExceededError(SECRET));
  const limited = await subject
    .resolve(choice.item_handle, 'password', 'https://shop.example')
    .catch((error: unknown) => error);
  expect(limited).toMatchObject({ reason: 'rate_limited', message: 'rate_limited' });
  expect(String(limited)).not.toContain(SECRET);
  const spent = requests();
  await expect(subject.resolve(choice.item_handle, 'password', 'https://shop.example')).rejects.toMatchObject({
    reason: 'rate_limited',
  });
  await expect(subject.itemsForOrigin('https://shop.example')).rejects.toMatchObject({ reason: 'rate_limited' });
  await expect(subject.refresh()).rejects.toMatchObject({ reason: 'rate_limited' });
  expect(requests()).toBe(spent);
});

it('rejects unsafe token files before SDK initialization and ignores Never items', async () => {
  await chmod(tokenFile, 0o644);
  await expect(vault().itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(await vault().availability()).toEqual({ status: 'unavailable', reason: 'invalid_state' });
  expect(sdk.create).not.toHaveBeenCalled();
  await chmod(tokenFile, 0o600);
  sdk.list.mockResolvedValue([{ ...item, websites: [website('Never')] }]);
  expect(await vault().itemsForOrigin('https://shop.example')).toEqual([]);
  expect(sdk.resolve).not.toHaveBeenCalled();
});
