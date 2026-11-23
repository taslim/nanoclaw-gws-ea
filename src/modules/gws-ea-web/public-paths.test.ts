import { expect, it, vi } from 'vitest';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { WEB_PUBLIC_PATHS } from '../../gws-ea/web-cloudflare.js';
import { mountCovers, webMounts } from './mounts.js';

// Artifact readers authorize their own public shares inside the /artifacts mount.
const ARTIFACT_PUBLIC_SHARES = '/artifacts/public/*';

it('serves every path Access lets through without identity, and serves no public mount outside them', () => {
  const mounts = webMounts();
  const publicMounts = mounts.filter((mount) => mount.audience === 'public');
  const allowed: readonly string[] = WEB_PUBLIC_PATHS;
  expect(publicMounts.filter((mount) => !allowed.includes(`${mount.path}/*`)).map(({ path }) => path)).toEqual([]);
  expect(
    WEB_PUBLIC_PATHS.filter(
      (pattern) =>
        !publicMounts.some((mount) => `${mount.path}/*` === pattern) &&
        !(
          pattern === ARTIFACT_PUBLIC_SHARES &&
          mounts.some((mount) => mount.audience === 'artifact-readers' && mountCovers(mount.path, pattern.slice(0, -2)))
        ),
    ),
  ).toEqual([]);
});
