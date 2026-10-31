import { execFile } from 'node:child_process';
import { once } from 'node:events';
import {
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createInterface } from 'node:readline';
import os from 'node:os';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { prepareChromeProfile, retireChromeProfile } from './chrome.js';
import { captureChromeGroup, claimChromeProfile, retireChromeGroup } from './chrome-processes.js';
import { browserPaths, type BrowserPaths } from './paths.js';

vi.mock('node:child_process', async (load) => ({
  ...(await load<typeof import('node:child_process')>()),
  execFile: vi.fn(),
}));
vi.mock('node:fs/promises', async (load) => {
  const original = await load<typeof import('node:fs/promises')>();
  return {
    ...original,
    readlink: vi.fn(original.readlink),
    realpath: vi.fn(original.realpath),
    unlink: vi.fn(original.unlink),
  };
});

const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const uid = process.getuid!();
const born = 'Fri Oct 30 21:40:44 2026';
interface ProcessRow {
  pid: number;
  parent: number;
  group: number;
  executable: string;
  args: string;
  uid?: number;
  born?: string;
}
let root: string;
let paths: BrowserPaths;
let rows: ProcessRow[];

function row(pid: number, parent = 1, profile = paths.profileDir): ProcessRow {
  return {
    pid,
    parent,
    group: pid,
    executable: chrome,
    args: `${chrome} --user-data-dir=${profile} --remote-debugging-port=45679`,
  };
}

function terminateFixture(pid: number): void {
  try {
    process.kill(pid, 'SIGKILL');
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

beforeEach(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'chrome processes-'));
  paths = browserPaths(root);
  await mkdir(paths.profileDir, { mode: 0o700 });
  rows = [];
  const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
  vi.mocked(unlink).mockImplementation(filesystem.unlink);
  vi.mocked(readlink).mockImplementation((async (file: string) => {
    const match = /^\/proc\/(\d+)\/exe$/u.exec(file);
    if (!match) return filesystem.readlink(file);
    const item = rows.find((candidate) => candidate.pid === Number(match[1]));
    if (!item) throw Object.assign(new Error('No fixture process'), { code: 'ENOENT' });
    return item.executable;
  }) as typeof readlink);
  vi.mocked(realpath).mockImplementation((async (file: string) =>
    file === chrome ? chrome : filesystem.realpath(file)) as typeof realpath);
  vi.mocked(execFile).mockImplementation(((
    _command: string,
    args: readonly string[],
    _options: unknown,
    callback: (error: null, stdout: string, stderr: string) => void,
  ) => {
    const pid = args.includes('-p') ? Number(args[args.indexOf('-p') + 1]) : undefined;
    const host = { ...row(process.pid), executable: process.execPath, args: `${process.execPath} host.js` };
    const listed = rows.some((item) => item.pid === process.pid) ? rows : [...rows, host];
    const selected = listed.filter((item) => pid === undefined || item.pid === pid);
    callback(
      null,
      args.includes('comm=')
        ? selected.map((item) => item.executable).join('\n')
        : selected
            .map(
              (item) =>
                `${item.pid} ${item.parent} ${item.uid ?? uid} ${item.group} S ${item.born ?? born} ${item.args}`,
            )
            .join('\n'),
      '',
    );
    return {};
  }) as typeof execFile);
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  await rm(root, { recursive: true, force: true });
});

describe('owned Chrome process recovery', () => {
  it('refuses a competing live owner before changing preferences or upload staging', async () => {
    rows = [{ ...row(200), executable: '/host/node', args: '/host/node host.js' }];
    await writeFile(path.join(root, '.chrome-owner.fixture.json'), JSON.stringify({ pid: 200, started: born }), {
      mode: 0o600,
    });
    await mkdir(path.join(paths.profileDir, 'Default'), { mode: 0o700 });
    const preferences = path.join(paths.profileDir, 'Default', 'Preferences');
    const original = JSON.stringify({ sentinel: 'another host owns this profile' });
    await writeFile(preferences, original, { mode: 0o600 });
    await mkdir(path.join(paths.stagingDir, 'uploads'), { recursive: true, mode: 0o700 });
    const upload = path.join(paths.stagingDir, 'uploads', 'pending');
    await writeFile(upload, 'pending upload', { mode: 0o600 });
    await expect(prepareChromeProfile(paths)).rejects.toThrow(/live owner/);
    expect(await readFile(preferences, 'utf8')).toBe(original);
    expect(await readFile(upload, 'utf8')).toBe('pending upload');
  });

  it('retires an orphan for the exact private profile while preserving another assistant and personal Chrome', async () => {
    rows = [row(100), row(101, 1, `${paths.profileDir}-other`), row(102, 1, '/personal/profile')];
    const sent: number[] = [];
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      sent.push(pid);
      rows = rows.filter((item) => item.pid !== pid);
      return true;
    });
    await retireChromeProfile(paths, chrome);
    expect(sent).toEqual([100]);
    expect(rows.map((item) => item.pid)).toEqual([101, 102]);
  });

  it('refuses a profile whose Chrome still belongs to another live parent before sending any signal', async () => {
    rows = [row(100, 200), { ...row(200), executable: '/host/node', args: '/host/node host.js' }];
    const kill = vi.spyOn(process, 'kill');
    await expect(retireChromeProfile(paths, chrome)).rejects.toThrow(/live owner/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('refuses an orphan whose host ownership receipt still identifies another live host', async () => {
    rows = [row(100), { ...row(200), executable: '/host/node', args: '/host/node host.js' }];
    await writeFile(path.join(root, '.chrome-owner.fixture.json'), JSON.stringify({ pid: 200, started: born }), {
      mode: 0o600,
    });
    const kill = vi.spyOn(process, 'kill');
    await expect(retireChromeProfile(paths, chrome)).rejects.toThrow(/live owner/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('does not signal a reused PID whose birth identity changed during retirement', async () => {
    rows = [row(100)];
    const original = vi.mocked(execFile).getMockImplementation()!;
    let listings = 0;
    vi.mocked(execFile).mockImplementation(((...args: Parameters<typeof execFile>) => {
      if (++listings === 2) rows = [{ ...row(100), born: 'Fri Oct 30 21:41:44 2026', args: '/personal/chrome' }];
      return original(...args);
    }) as typeof execFile);
    const kill = vi.spyOn(process, 'kill');
    await retireChromeProfile(paths, chrome);
    expect(kill).not.toHaveBeenCalled();
  });

  it('retires profile helpers and a verified relaunch that appears during shutdown', async () => {
    rows = [row(100), { ...row(101, 100), group: 100 }];
    let relaunched = false;
    const kill = vi.spyOn(process, 'kill').mockImplementation((pid) => {
      rows = rows.filter((item) => item.pid !== pid);
      if (pid === 100 && !relaunched) {
        relaunched = true;
        rows.push(row(102));
      }
      return true;
    });
    await retireChromeProfile(paths, chrome);
    expect(rows).toEqual([]);
    expect(kill.mock.calls.map(([pid]) => pid)).toEqual(expect.arrayContaining([100, 101, 102]));
  });

  it('fails closed when profile ownership cannot be verified', async () => {
    rows = [row(100)];
    await chmod(paths.profileDir, 0o755);
    const kill = vi.spyOn(process, 'kill');
    await expect(retireChromeProfile(paths, chrome)).rejects.toThrow(/private/);
    expect(kill).not.toHaveBeenCalled();
  });

  it.each(['foreign user', 'foreign executable'] as const)('refuses a %s using the profile', async (kind) => {
    rows = [{ ...row(100), ...(kind === 'foreign user' ? { uid: uid + 1 } : { executable: '/unrelated/program' }) }];
    const kill = vi.spyOn(process, 'kill');
    await expect(retireChromeProfile(paths, chrome)).rejects.toThrow(/ownership invalid/);
    expect(kill).not.toHaveBeenCalled();
  });

  it('bounds retirement when a process ignores both termination signals', async () => {
    rows = [row(100)];
    let elapsed = 0;
    vi.spyOn(Date, 'now').mockImplementation(() => (elapsed += 1_000));
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    await expect(retireChromeProfile(paths, chrome)).rejects.toThrow('Chrome processes did not stop');
    expect(kill.mock.calls).toEqual([
      [100, 'SIGTERM'],
      [100, 'SIGKILL'],
    ]);
  });

  it('refuses a process group reused after every captured Chrome process has exited', async () => {
    rows = [{ ...row(100, process.pid), group: 100 }];
    const group = await captureChromeGroup(100);
    rows = [{ ...row(100, process.pid), group: 100, born: 'Fri Oct 30 21:41:44 2026' }];
    const kill = vi.spyOn(process, 'kill');
    await expect(retireChromeGroup(group)).rejects.toThrow('Chrome group ownership invalid');
    expect(kill).not.toHaveBeenCalled();
  });

  it('keeps persistent profile data and removes the dead host receipt only after retirement', async () => {
    rows = [row(100)];
    await writeFile(path.join(root, '.chrome-owner.fixture.json'), JSON.stringify({ pid: 200, started: born }), {
      mode: 0o600,
    });
    await writeFile(path.join(paths.profileDir, 'Cookies'), 'persistent login', { mode: 0o600 });
    vi.spyOn(process, 'kill').mockImplementation((pid) => {
      rows = rows.filter((item) => item.pid !== pid);
      return true;
    });
    await retireChromeProfile(paths, chrome);
    expect(await readFile(path.join(paths.profileDir, 'Cookies'), 'utf8')).toBe('persistent login');
    await expect(readFile(path.join(root, '.chrome-owner.fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('records the live host identity exclusively before a new Chrome can start', async () => {
    rows = [{ ...row(process.pid), executable: process.execPath, args: `${process.execPath} host.js` }];
    await claimChromeProfile(paths);
    const [claim] = (await readdir(root)).filter((name) => name.startsWith('.chrome-owner.') && name.endsWith('.json'));
    if (!claim) throw new Error('Missing owner receipt');
    expect(JSON.parse(await readFile(path.join(root, claim), 'utf8'))).toEqual({
      pid: process.pid,
      started: born,
    });
    await claimChromeProfile(paths);
    rows = [row(200)];
    await writeFile(path.join(root, claim), JSON.stringify({ pid: 200, started: born }));
    await expect(claimChromeProfile(paths)).rejects.toThrow(/live owner/);
  });

  it('recovers a completely published receipt after a crash before its temporary link was removed', async () => {
    const temporary = path.join(root, '.chrome-owner.interrupted.tmp');
    await writeFile(temporary, JSON.stringify({ pid: 200, started: born }), { mode: 0o600 });
    await link(temporary, path.join(root, '.chrome-owner.fixture.json'));
    await retireChromeProfile(paths, chrome);
    await expect(readFile(path.join(root, '.chrome-owner.fixture.json'))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a live peer claim published while a stale claim is being removed', async () => {
    const stale = path.join(root, '.chrome-owner.stale.json');
    const replacement = path.join(root, '.chrome-owner.replacement.json');
    await writeFile(stale, JSON.stringify({ pid: 300, started: born }), { mode: 0o600 });
    const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(unlink).mockImplementation(async (file) => {
      if (file === stale) {
        rows.push({ ...row(200), executable: '/host/node', args: '/host/node host.js' });
        await writeFile(replacement, JSON.stringify({ pid: 200, started: born }), { mode: 0o600 });
      }
      await filesystem.unlink(file);
    });
    await retireChromeProfile(paths, chrome);
    expect(JSON.parse(await readFile(replacement, 'utf8'))).toEqual({ pid: 200, started: born });
    await expect(prepareChromeProfile(paths)).rejects.toThrow(/live owner/);
  });

  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'excludes a second host across concurrent acquisition and different timezones before profile writes',
    async () => {
      const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(execFile).mockImplementation(native.execFile);
      vi.mocked(readlink).mockImplementation(filesystem.readlink);
      vi.mocked(realpath).mockImplementation(filesystem.realpath);
      vi.stubEnv('TZ', 'UTC');
      const script = `
        import { createInterface } from 'node:readline';
        import { claimChromeProfile, retireChromeProfile } from ${JSON.stringify(new URL('./chrome-processes.ts', import.meta.url).href)};
        import { browserPaths } from ${JSON.stringify(new URL('./paths.ts', import.meta.url).href)};
        const paths = browserPaths(process.argv[1]);
        for await (const action of createInterface({ input: process.stdin })) {
          try {
            if (action === 'claim') await claimChromeProfile(paths);
            else await retireChromeProfile(paths, process.execPath);
            process.stdout.write('ok\\n');
          } catch { process.stdout.write('refused\\n'); }
        }
      `;
      const peer = native.spawn(
        process.execPath,
        ['--import', 'tsx', '--input-type=module', '-e', script, paths.root],
        {
          env: { ...process.env, TZ: 'America/Los_Angeles' },
          stdio: ['pipe', 'pipe', 'pipe'],
        },
      );
      const replies = createInterface({ input: peer.stdout })[Symbol.asyncIterator]();
      const send = async (action: 'claim' | 'retire'): Promise<string> => {
        peer.stdin.write(`${action}\n`);
        const reply = await replies.next();
        if (reply.done) throw new Error('Peer owner exited before answering');
        return reply.value;
      };
      try {
        const peerClaim = send('claim');
        const local = await claimChromeProfile(paths).then(
          () => true,
          () => false,
        );
        const foreign = (await peerClaim) === 'ok';
        expect(Number(local) + Number(foreign)).toBeLessThanOrEqual(1);
        if (local) await retireChromeProfile(paths, process.execPath);
        expect(await send('claim')).toBe('ok');
        await mkdir(path.join(paths.profileDir, 'Default'), { mode: 0o700 });
        const preferences = path.join(paths.profileDir, 'Default', 'Preferences');
        await writeFile(preferences, '{"owned":"peer"}', { mode: 0o600 });
        await expect(retireChromeProfile(paths, process.execPath)).rejects.toThrow(/live owner/);
        await expect(prepareChromeProfile(paths)).rejects.toThrow(/live owner/);
        expect(await readFile(preferences, 'utf8')).toBe('{"owned":"peer"}');
        expect(await send('retire')).toBe('ok');
        await claimChromeProfile(paths);
        await retireChromeProfile(paths, process.execPath);
        expect((await readdir(root)).filter((name) => name.endsWith('.json'))).toEqual([]);
      } finally {
        const exited = peer.exitCode !== null || peer.signalCode !== null ? Promise.resolve() : once(peer, 'exit');
        peer.stdin.end();
        if (peer.exitCode === null && peer.signalCode === null) peer.kill('SIGTERM');
        await exited;
        vi.unstubAllEnvs();
      }
    },
    30_000,
  );

  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'recovers a real orphan by its private profile without touching an unrelated process',
    async () => {
      const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(execFile).mockImplementation(native.execFile);
      const filesystem = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
      vi.mocked(readlink).mockImplementation(filesystem.readlink);
      vi.mocked(realpath).mockImplementation(filesystem.realpath);
      const child = native.spawn(
        process.execPath,
        [
          '-e',
          `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)','--',process.argv[1]],{detached:true,stdio:'ignore'});console.log(child.pid);child.unref();`,
          '--',
          `--user-data-dir=${paths.profileDir}`,
        ],
        { stdio: ['ignore', 'pipe', 'ignore'] },
      );
      if (!child.stdout) throw new Error('Native process fixture unavailable');
      const exited = once(child, 'exit');
      const other = native.spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
      let orphan = 0;
      try {
        const [data] = (await once(child.stdout, 'data')) as [Buffer];
        orphan = Number(data.toString('utf8').trim());
        if (!Number.isSafeInteger(orphan) || orphan <= 1) throw new Error('Native orphan fixture unavailable');
        await exited;
        await retireChromeProfile(paths, process.execPath);
        expect(() => process.kill(orphan, 0)).toThrow();
        expect(other.pid && process.kill(other.pid, 0)).toBe(true);
      } finally {
        other.kill('SIGKILL');
        if (orphan) terminateFixture(orphan);
      }
    },
  );

  it.skipIf(!process.env.GWS_EA_BROWSER_TEST_CHROME)(
    'retires a real owned process group after its original parent has exited',
    async () => {
      const native = await vi.importActual<typeof import('node:child_process')>('node:child_process');
      vi.mocked(execFile).mockImplementation(native.execFile);
      const child = native.spawn(
        process.execPath,
        [
          '-e',
          `const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);child.unref();process.stdin.resume();`,
        ],
        { detached: true, stdio: ['pipe', 'pipe', 'ignore'] },
      );
      if (child.pid === undefined || !child.stdout) throw new Error('Native process fixture unavailable');
      const group = child.pid;
      const exited = once(child, 'exit');
      let helper = 0;
      try {
        const [data] = (await once(child.stdout, 'data')) as [Buffer];
        helper = Number(data.toString('utf8').trim());
        if (!Number.isSafeInteger(helper) || helper <= 1) throw new Error('Native helper fixture unavailable');
        const captured = await captureChromeGroup(group);
        child.stdin!.end();
        await exited;
        expect(process.kill(helper, 0)).toBe(true);
        await retireChromeGroup(captured);
        expect(() => process.kill(helper, 0)).toThrow();
      } finally {
        terminateFixture(-group);
      }
    },
  );
});
