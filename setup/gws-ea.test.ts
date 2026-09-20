import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runCli: vi.fn(async (_args: readonly string[], _runtime: unknown) => 0),
  collect: vi.fn(async (_context: unknown, _dependencies: unknown) => ({ marker: 'collected' })),
  authenticate: vi.fn(async (_provider: string, _providers: unknown) => ({ marker: 'authenticated' })),
  providers: [{ value: 'claude' }],
  warn: vi.fn(),
  note: vi.fn(),
  password: vi.fn(async () => 'fresh-cloudflare-token'),
  discoverZones: vi.fn(async () => [
    {
      accountId: 'a'.repeat(32),
      accountName: 'Example account',
      zoneId: 'b'.repeat(32),
      name: 'example.com',
      status: 'active' as const,
    },
  ]),
  retainAccountToken: vi.fn(),
  requireAccountToken: vi.fn(() => 'fresh-cloudflare-token'),
  clearAccountToken: vi.fn(),
  ensureGcloudReady: vi.fn(async () => ({ account: 'operator@example.com' })),
}));

vi.mock('@clack/prompts', () => ({
  log: { warn: fixture.warn },
  note: fixture.note,
  password: fixture.password,
  isCancel: () => false,
}));
vi.mock('../src/gws-ea/cli.js', () => ({ runCli: fixture.runCli }));
vi.mock('../src/gws-ea/cloudflare-api.js', () => ({
  createManagedIngressSetupSession: () => ({
    discoverZones: fixture.discoverZones,
    retainAccountToken: fixture.retainAccountToken,
    requireAccountToken: fixture.requireAccountToken,
    clearAccountToken: fixture.clearAccountToken,
  }),
}));
vi.mock('./gws-ea-input.js', () => ({
  collectGwsEaCreateInput: fixture.collect,
  authenticateGwsEaProvider: fixture.authenticate,
  CLOUDFLARE_API_TOKEN_GUIDANCE: 'cloudflare-token-guidance',
}));
vi.mock('./gws-ea-prerequisites.js', () => ({ ensureGcloudReady: fixture.ensureGcloudReady }));
vi.mock('./providers/registry.js', () => ({ listSetupProviders: () => fixture.providers }));
vi.mock('./providers/index.js', () => ({}));

describe('GWS-EA launcher', () => {
  afterEach(() => {
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  it('passes one composed provider snapshot to both input collection and authentication', async () => {
    const originalArgv = process.argv;
    process.argv = ['node', 'setup/gws-ea.ts', 'create', '--track', 'prod'];
    try {
      await import('./gws-ea.js');
    } finally {
      process.argv = originalArgv;
    }

    expect(fixture.runCli).toHaveBeenCalledOnce();
    const [args, unknownRuntime] = fixture.runCli.mock.calls[0]!;
    const runtime = unknownRuntime as {
      collectCreateInputs(context: unknown): Promise<unknown>;
      authenticateProvider(provider: string): Promise<unknown>;
      requestCloudflareAccountToken(accountId: string, observation: string): Promise<string>;
      preflightGcloud(): Promise<{ readonly account: string }>;
    };
    expect(args).toEqual(['create', '--track', 'prod']);
    await runtime.collectCreateInputs({ marker: 'context' });
    await runtime.authenticateProvider('claude');
    await expect(runtime.preflightGcloud()).resolves.toEqual({ account: 'operator@example.com' });
    expect(fixture.collect).toHaveBeenCalledWith({ marker: 'context' }, { providers: fixture.providers });
    expect(fixture.authenticate).toHaveBeenCalledWith('claude', fixture.providers);
    expect(fixture.ensureGcloudReady).toHaveBeenCalledOnce();
    await expect(
      runtime.requestCloudflareAccountToken('a'.repeat(32), 'The public callback listener does not match.'),
    ).resolves.toBe('fresh-cloudflare-token');
    expect(fixture.warn).toHaveBeenCalledWith('The public callback listener does not match.');
    expect(fixture.note).toHaveBeenCalledWith('cloudflare-token-guidance', 'Cloudflare access');
    expect(fixture.warn.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);
    expect(fixture.note.mock.invocationCallOrder[0]).toBeLessThan(fixture.password.mock.invocationCallOrder[0]!);
    expect(fixture.discoverZones).toHaveBeenCalledWith('fresh-cloudflare-token');
    expect(fixture.retainAccountToken).toHaveBeenCalledWith('fresh-cloudflare-token');
    expect(fixture.requireAccountToken).toHaveBeenCalledWith('a'.repeat(32));
  });
});
