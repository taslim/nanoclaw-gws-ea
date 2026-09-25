import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const LAUNCHER = path.join(process.cwd(), 'bin', 'gws-ea');
const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'gws-ea-launcher-test-'));
  roots.push(root);
  return root;
}

describe('GWS-EA shell launcher', () => {
  it('uses the first absolute PATH entry and ignores empty and relative entries', async () => {
    const root = await temporaryRoot();
    const trustedBin = path.join(root, 'trusted-bin');
    const hostileMarker = path.join(root, 'hostile-ran');
    const hostile = `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\n`;
    await Promise.all([mkdir(path.join(root, 'relative-bin')), mkdir(trustedBin)]);
    await Promise.all([
      writeFile(path.join(root, 'node'), hostile, { mode: 0o755 }),
      writeFile(path.join(root, 'relative-bin', 'node'), hostile, { mode: 0o755 }),
      writeFile(path.join(trustedBin, 'node'), '#!/bin/sh\nprintf "trusted:%s|%s" "$*" "$PATH"\n', { mode: 0o755 }),
    ]);

    const { stdout } = await execFileAsync('/bin/bash', [LAUNCHER, 'probe'], {
      cwd: root,
      env: { PATH: `:relative-bin::${trustedBin}:` },
    });

    expect(stdout).toBe(`trusted:--import tsx setup/gws-ea.ts probe|${trustedBin}`);
    await expect(readFile(hostileMarker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails clearly when Node.js is not on PATH', async () => {
    const root = await temporaryRoot();

    await writeFile(path.join(root, 'node'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });

    await expect(
      execFileAsync('/bin/bash', [LAUNCHER, 'probe'], { cwd: root, env: { PATH: `.::${path.join(root, 'absent')}` } }),
    ).rejects.toMatchObject({ code: 1, stderr: expect.stringContaining('Node.js was not found on PATH') });
  });
});
