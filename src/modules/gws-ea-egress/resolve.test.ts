import { afterEach, describe, expect, it, vi } from 'vitest';

import { RefusedDestination, resolveDestination } from './resolve.js';

const dnsBoundary = vi.hoisted(() => ({
  lookup:
    vi.fn<
      (hostname: string, options: { all: true; verbatim: true }) => Promise<{ address: string; family: number }[]>
    >(),
}));
vi.mock('node:dns/promises', async () => {
  const actual = await vi.importActual<typeof import('node:dns/promises')>('node:dns/promises');
  return { ...actual, default: { ...actual, lookup: dnsBoundary.lookup } };
});

afterEach(() => {
  dnsBoundary.lookup.mockReset();
});

describe('public destination resolver', () => {
  it.each(['10.0.0.5', '127.0.0.1', '::1', '169.254.169.254', '::ffff:10.0.0.5', '::ffff:127.0.0.1'])(
    'refuses a name resolving to %s',
    async (address) => {
      dnsBoundary.lookup.mockResolvedValue([{ address, family: address.includes(':') ? 6 : 4 }]);
      await expect(resolveDestination(new URL('https://mcp.example.test/'))).rejects.toBeInstanceOf(RefusedDestination);
    },
  );

  it.each([
    'https://2130706433/',
    'https://0x7f000001/',
    'https://0177.0.0.1/',
    'https://0xa.0.0.5/',
    'https://[::1]/',
  ])('refuses the literal spelling %s without a lookup', async (url) => {
    await expect(resolveDestination(new URL(url))).rejects.toBeInstanceOf(RefusedDestination);
    expect(dnsBoundary.lookup).not.toHaveBeenCalled();
  });

  it('refuses an answer that mixes a public and a private address', async () => {
    dnsBoundary.lookup.mockResolvedValue([
      { address: '93.184.215.14', family: 4 },
      { address: '10.0.0.5', family: 4 },
    ]);
    await expect(resolveDestination(new URL('https://mcp.example.test/'))).rejects.toBeInstanceOf(RefusedDestination);
  });

  it('refuses credentials and other ports before any lookup', async () => {
    await expect(resolveDestination(new URL('https://juno:secret@mcp.example.test/'))).rejects.toBeInstanceOf(
      RefusedDestination,
    );
    await expect(resolveDestination(new URL('https://mcp.example.test:8443/'))).rejects.toBeInstanceOf(
      RefusedDestination,
    );
    expect(dnsBoundary.lookup).not.toHaveBeenCalled();
  });

  it('pins the first public answer on the scheme port', async () => {
    dnsBoundary.lookup.mockResolvedValue([
      { address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c', family: 6 },
      { address: '93.184.215.14', family: 4 },
    ]);
    await expect(resolveDestination(new URL('https://mcp.example.test/mcp'))).resolves.toEqual({
      address: '2606:2800:21f:cb07:6820:80da:af6b:8b2c',
      family: 6,
      port: 443,
    });
    expect(dnsBoundary.lookup).toHaveBeenCalledWith('mcp.example.test', { all: true, verbatim: true });
  });
});
