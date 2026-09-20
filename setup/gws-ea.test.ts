import { afterEach, describe, expect, it, vi } from 'vitest';

const fixture = vi.hoisted(() => ({
  runCli: vi.fn(async (_args: readonly string[], _runtime: unknown) => 0),
  collect: vi.fn(async (_context: unknown, _dependencies: unknown) => ({ marker: 'collected' })),
  authenticate: vi.fn(async (_provider: string, _providers: unknown) => ({ marker: 'authenticated' })),
  providers: [{ value: 'claude' }],
}));

vi.mock('../src/gws-ea/cli.js', () => ({ runCli: fixture.runCli }));
vi.mock('./gws-ea-input.js', () => ({
  collectGwsEaCreateInput: fixture.collect,
  authenticateGwsEaProvider: fixture.authenticate,
}));
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
    };
    expect(args).toEqual(['create', '--track', 'prod']);
    await runtime.collectCreateInputs({ marker: 'context' });
    await runtime.authenticateProvider('claude');
    expect(fixture.collect).toHaveBeenCalledWith({ marker: 'context' }, { providers: fixture.providers });
    expect(fixture.authenticate).toHaveBeenCalledWith('claude', fixture.providers);
  });
});
