import { spawnSync } from 'node:child_process';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { getInstallScopedNames, getInstallSlug } from '../../src/install-slug.js';

const SCRIPT = path.resolve(import.meta.dirname, 'install-slug.sh');
const ROOT = '/some/checkout';

afterEach(() => {
  delete process.env.NANOCLAW_INSTALL_ID;
});

/** Run one of the shell helpers as `container/build.sh` does: source the file, then call it. */
function shell(helper: string, installId?: string): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', ['-c', `source "$SCRIPT"; ${helper}`], {
    env: {
      PATH: process.env.PATH,
      SCRIPT,
      NANOCLAW_PROJECT_ROOT: ROOT,
      ...(installId === undefined ? {} : { NANOCLAW_INSTALL_ID: installId }),
    },
    encoding: 'utf8',
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

/** What the TypeScript helper names for the same checkout and environment. */
function typescriptNames(installId?: string) {
  if (installId === undefined) delete process.env.NANOCLAW_INSTALL_ID;
  else process.env.NANOCLAW_INSTALL_ID = installId;
  return getInstallScopedNames(getInstallSlug(ROOT));
}

describe('install-slug.sh', () => {
  it.each([
    ['derived from the checkout path', undefined],
    ['NANOCLAW_INSTALL_ID, as a gws-ea assistant sets it', '0123456789abcdef0123456789abcdef'],
    ['a NANOCLAW_INSTALL_ID with every allowed character', 'prod-eks_1'],
  ])('names what src/install-slug.ts names for a slug %s', (_label, installId) => {
    const names = typescriptNames(installId);

    expect(shell('container_image_base', installId)).toMatchObject({ status: 0, stdout: names.containerImageBase });
    expect(shell('launchd_label', installId)).toMatchObject({ status: 0, stdout: names.launchdLabel });
    expect(shell('systemd_unit', installId)).toMatchObject({ status: 0, stdout: names.systemdUnit });
  });

  it.each(['UPPER', '-leading', 'has space', 'a'.repeat(33), 'dot.dot', 'new\nline'])(
    'refuses the NANOCLAW_INSTALL_ID %j that src/install-slug.ts refuses, naming nothing',
    (installId) => {
      expect(() => typescriptNames(installId)).toThrow(/NANOCLAW_INSTALL_ID/u);

      for (const helper of ['container_image_base', 'launchd_label', 'systemd_unit']) {
        const result = shell(helper, installId);
        expect(result.status, helper).not.toBe(0);
        expect(result.stdout, helper).toBe('');
        expect(result.stderr, helper).toContain('NANOCLAW_INSTALL_ID');
      }
    },
  );
});
