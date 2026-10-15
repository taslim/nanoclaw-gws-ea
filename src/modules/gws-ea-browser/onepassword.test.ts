import { chmod, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { writePrivateFile } from './paths.js';
import { BrowserVault, websitePermitsOrigin } from './onepassword.js';

const sdk = vi.hoisted(() => ({ create: vi.fn(), list: vi.fn(), vaults: vi.fn(), resolve: vi.fn() }));
vi.mock('@1password/sdk', () => ({
  createClient: sdk.create,
  RateLimitExceededError: class RateLimitExceededError extends Error {},
}));
let directory: string;
let policyFile: string;
const website = (autofillBehavior = 'AnywhereOnWebsite', url = 'https://shop.example') => ({
  url,
  label: '',
  autofillBehavior,
});
const item = {
  id: 'item1',
  vaultId: 'vault1',
  title: 'Shop login',
  category: 'Login',
  state: 'active',
  websites: [website()],
};
beforeEach(async () => {
  directory = await mkdtemp(path.join(os.tmpdir(), 'browser-vault-'));
  policyFile = path.join(directory, 'browser', 'policy.json');
  await writePrivateFile(policyFile, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: '1password' }));
  await writePrivateFile(path.join(directory, 'secrets', 'browser-1password'), 'service-account-token');
  vi.clearAllMocks();
  sdk.create.mockResolvedValue({
    vaults: { list: sdk.vaults },
    items: { list: sdk.list },
    secrets: { resolve: sdk.resolve },
  });
  sdk.vaults.mockResolvedValue([{ id: 'vault1' }]);
  sdk.list.mockResolvedValue([item]);
  sdk.resolve.mockResolvedValue('fixture-password-private');
});
afterEach(async () => {
  vi.useRealTimers();
  await rm(directory, { recursive: true, force: true });
});

it('keeps IDs and values host-only, caches overviews, and resolves only the chosen field at fill time', async () => {
  const vault = new BrowserVault(policyFile);
  const choices = await vault.itemsForOrigin('https://www.shop.example');
  expect(choices).toEqual([{ title: 'Shop login', item_handle: expect.stringMatching(/^vault_/u) }]);
  expect(JSON.stringify(choices)).not.toMatch(/item1|vault1|fixture-password-private/u);
  await vault.itemsForOrigin('https://www.shop.example');
  expect(sdk.list).toHaveBeenCalledTimes(1);
  expect(sdk.resolve).not.toHaveBeenCalled();
  expect(await vault.resolve(choices[0].item_handle, 'password', 'https://www.shop.example')).toBe(
    'fixture-password-private',
  );
  expect(sdk.resolve).toHaveBeenCalledWith('op://vault1/item1/password');
  await vault.resolve(choices[0].item_handle, 'otp', 'https://www.shop.example');
  expect(sdk.resolve).toHaveBeenLastCalledWith('op://vault1/item1/one-time password?attribute=otp');
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

it('refuses an ineligible frame before resolving and refreshes misses within a fixed cooldown', async () => {
  vi.useFakeTimers();
  const vault = new BrowserVault(policyFile);
  const choices = await vault.itemsForOrigin('https://shop.example');
  await expect(vault.resolve(choices[0].item_handle, 'password', 'http://shop.example')).rejects.toMatchObject({
    reason: 'origin_mismatch',
  });
  expect(sdk.resolve).not.toHaveBeenCalled();
  sdk.list.mockResolvedValue([{ ...item, id: 'item2', websites: [website('Never')] }]);
  await vault.itemsForOrigin('https://unknown.example');
  await vault.itemsForOrigin('https://unknown.example');
  expect(sdk.list).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(30_001);
  expect(await vault.itemsForOrigin('https://unknown.example')).toEqual([]);
  expect(sdk.list).toHaveBeenCalledTimes(2);
});

it('does not create the SDK for absent tokens or email-only mode; rejects multi-vault credentials', async () => {
  await rm(path.join(directory, 'secrets', 'browser-1password'));
  await expect(new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(sdk.create).not.toHaveBeenCalled();
  await writePrivateFile(policyFile, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: 'email' }));
  await expect(new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(sdk.create).not.toHaveBeenCalled();
  await writePrivateFile(policyFile, JSON.stringify({ schemaVersion: 1, enabled: true, credentialMode: '1password' }));
  await writePrivateFile(path.join(directory, 'secrets', 'browser-1password'), 'service-account-token');
  sdk.vaults.mockResolvedValue([{ id: 'vault1' }, { id: 'vault2' }]);
  await expect(new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(sdk.list).not.toHaveBeenCalled();
});

it('maps SDK rate limits and scrubs all other SDK error material', async () => {
  const { RateLimitExceededError } = await import('@1password/sdk');
  sdk.list.mockRejectedValue(new RateLimitExceededError('fixture-password-private'));
  const vault = new BrowserVault(policyFile);
  await expect(vault.itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'rate_limited',
    message: 'rate_limited',
  });
  await expect(vault.itemsForOrigin('https://shop.example')).rejects.toMatchObject({ reason: 'rate_limited' });
  expect(sdk.list).toHaveBeenCalledTimes(1);
  sdk.create.mockRejectedValue(new Error('fixture-password-private'));
  await expect(new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
    message: 'vault_unavailable',
  });
});

it('rejects unsafe token files before SDK initialization and ignores Never items', async () => {
  await chmod(path.join(directory, 'secrets', 'browser-1password'), 0o644);
  await expect(new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).rejects.toMatchObject({
    reason: 'vault_unavailable',
  });
  expect(sdk.create).not.toHaveBeenCalled();
  await chmod(path.join(directory, 'secrets', 'browser-1password'), 0o600);
  sdk.list.mockResolvedValue([{ ...item, websites: [website('Never')] }]);
  expect(await new BrowserVault(policyFile).itemsForOrigin('https://shop.example')).toEqual([]);
  expect(sdk.resolve).not.toHaveBeenCalled();
});
