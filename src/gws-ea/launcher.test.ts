import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, readlink, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);
const LAUNCHER = path.join(process.cwd(), 'bin', 'gws-ea');
const MACHINE_SETUP = path.join(process.cwd(), 'gws-ea.sh');
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
    const laterBin = path.join(root, 'later-bin');
    const hostileMarker = path.join(root, 'hostile-ran');
    const hostile = `#!/bin/sh\nprintf hostile > ${JSON.stringify(hostileMarker)}\n`;
    await Promise.all([mkdir(path.join(root, 'relative-bin')), mkdir(trustedBin), mkdir(laterBin)]);
    await Promise.all([
      writeFile(path.join(root, 'node'), hostile, { mode: 0o755 }),
      writeFile(path.join(root, 'relative-bin', 'node'), hostile, { mode: 0o755 }),
      writeFile(path.join(laterBin, 'node'), hostile, { mode: 0o755 }),
      writeFile(path.join(trustedBin, 'node'), '#!/bin/sh\nprintf "trusted:%s|%s" "$*" "$PATH"\n', { mode: 0o755 }),
    ]);

    const { stdout } = await execFileAsync('/bin/bash', [LAUNCHER, 'probe'], {
      cwd: root,
      env: { PATH: `:relative-bin::${trustedBin}:${laterBin}:` },
    });

    expect(stdout).toBe(`trusted:--import tsx setup/gws-ea.ts probe|${trustedBin}:${laterBin}`);
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

describe('GWS-EA machine setup', () => {
  /** A checkout holding the real gws-ea.sh, with NanoClaw's bootstrap replaced by one that records how it ran. */
  async function checkout(root: string, name: string): Promise<string> {
    const directory = path.join(root, name);
    await mkdir(path.join(directory, 'bin'), { recursive: true });
    await copyFile(MACHINE_SETUP, path.join(directory, 'gws-ea.sh'));
    await writeFile(path.join(directory, 'bin', 'gws-ea'), '#!/bin/sh\n', { mode: 0o755 });
    await writeFile(
      path.join(directory, 'setup.sh'),
      [
        'printf "diagnostics=%s" "$NANOCLAW_NO_DIAGNOSTICS" > "$HOME/bootstrap-ran"',
        'if [ -n "${BOOTSTRAP_FAILS:-}" ]; then echo "STATUS: deps_failed"; exit 1; fi',
        'echo "STATUS: success"',
      ].join('\n'),
    );
    return directory;
  }

  async function setUp(directory: string, home: string, env: Record<string, string> = {}, args: string[] = []) {
    await mkdir(home, { recursive: true });
    return execFileAsync('/bin/bash', [path.join(directory, 'gws-ea.sh'), ...args], {
      env: { HOME: home, PATH: '/usr/bin:/bin', SHELL: '/bin/zsh', ...env },
    });
  }

  it('bootstraps without NanoClaw diagnostics, links the gws-ea command, and names the next step', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    const first = await checkout(root, 'first');
    const link = path.join(home, '.local', 'bin', 'gws-ea');

    const fresh = await setUp(first, home);
    expect(await readlink(link)).toBe(path.join(first, 'bin', 'gws-ea'));
    expect(await readFile(path.join(home, 'bootstrap-ran'), 'utf8')).toBe('diagnostics=1');
    expect(fresh.stdout).toContain(`Linked ${link}.`);
    expect(fresh.stdout).toContain('Add ~/.local/bin to your PATH in ~/.zshrc');
    expect(fresh.stdout.trimEnd().split('\n').at(-1)).toBe('Next: gws-ea create --track dogfood');

    // A rerun with ~/.local/bin on PATH leaves the link as it is and gives no PATH advice.
    const rerun = await setUp(first, home, { PATH: `${path.join(home, '.local', 'bin')}:/usr/bin:/bin` });
    expect(rerun.stdout).not.toMatch(/Linked|Pointed|Add ~\/\.local\/bin/u);

    // Setting up another checkout re-points the command at it, and says so.
    const second = await checkout(root, 'second');
    const moved = await setUp(second, home);
    expect(await readlink(link)).toBe(path.join(second, 'bin', 'gws-ea'));
    expect(moved.stdout).toContain(`(it pointed at ${path.join(first, 'bin', 'gws-ea')})`);
  });

  it('leaves a file it did not make alone, and stops on a failed bootstrap or any option', async () => {
    const root = await temporaryRoot();
    const home = path.join(root, 'home');
    const directory = await checkout(root, 'checkout');
    const link = path.join(home, '.local', 'bin', 'gws-ea');

    await expect(setUp(directory, home, { BOOTSTRAP_FAILS: '1' })).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining('STATUS: deps_failed'),
    });
    await expect(readlink(link)).rejects.toMatchObject({ code: 'ENOENT' });

    await mkdir(path.dirname(link), { recursive: true });
    await writeFile(link, 'someone else', { mode: 0o755 });
    const kept = await setUp(directory, home);
    expect(await readFile(link, 'utf8')).toBe('someone else');
    expect(kept.stderr).toContain(`Left ${link} alone`);
    expect(kept.stdout).toContain(`Next: ${path.join(directory, 'bin', 'gws-ea')} create --track dogfood`);

    await expect(setUp(directory, home, {}, ['create'])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining('takes no options'),
    });
  });
});
