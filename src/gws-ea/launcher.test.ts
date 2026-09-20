import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

describe('GWS-EA shell launcher', () => {
  it('ignores Node.js from a publicly writable PATH entry', async () => {
    const root = await mkdtemp(path.join(process.cwd(), '.gws-ea-launcher-test-'));
    const publicBin = path.join(root, 'public-bin');
    const trustedBin = path.join(root, 'trusted-bin');
    const hostileMarker = path.join(root, 'hostile-ran');
    try {
      await Promise.all([mkdir(publicBin, { mode: 0o777 }), mkdir(trustedBin, { mode: 0o700 })]);
      await chmod(publicBin, 0o777);
      await Promise.all([
        writeFile(path.join(publicBin, 'node'), `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\n`, {
          mode: 0o755,
        }),
        writeFile(path.join(trustedBin, 'node'), '#!/bin/sh\nprintf "trusted:%s|%s" "$*" "$PATH"\n', {
          mode: 0o755,
        }),
      ]);

      const { stdout } = await execFileAsync('/bin/bash', ['bin/gws-ea', 'probe'], {
        cwd: process.cwd(),
        env: { PATH: `${publicBin}:${trustedBin}` },
      });

      expect(stdout).toContain('trusted:--import tsx setup/gws-ea.ts probe|');
      expect(stdout).not.toContain(publicBin);
      await expect(readFile(hostileMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
