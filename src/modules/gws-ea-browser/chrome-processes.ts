import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, mkdir, open, readdir, readlink, realpath, unlink } from 'node:fs/promises';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { SYSTEM_CHROME } from './availability.js';
import type { BrowserPaths } from './paths.js';

interface ProcessIdentity {
  pid: number;
  parent: number;
  uid: number;
  group: number;
  state: string;
  started: string;
  args: string;
}
interface ProfileOwner {
  pid: number;
  started: string;
}
export interface ChromeProcessGroup {
  readonly id: number;
  readonly members: ReadonlyMap<number, ProcessIdentity>;
}

const ownedProfiles = new Map<string, { file: string; owner: ProfileOwner }>();
const sameProcess = (left: ProfileOwner, right: ProfileOwner): boolean =>
  left.pid === right.pid && left.started === right.started;
const missing = (error: unknown): boolean => error instanceof Error && 'code' in error && error.code === 'ENOENT';

async function ps(args: string[]): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      '/bin/ps',
      args,
      { encoding: 'utf8', timeout: 2_000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' } },
      (error, stdout, stderr) => {
        if (stderr || (error && !(error.code === 1 && stdout === ''))) {
          // Native diagnostics can include unrelated process arguments.
          reject(new Error('Chrome process ownership unavailable'));
        } else resolve(stdout);
      },
    );
  });
}

async function processes(pid?: number): Promise<ProcessIdentity[]> {
  const listed = await ps([
    ...(pid === undefined ? ['-A'] : ['-p', String(pid)]),
    '-ww',
    '-o',
    'pid=,ppid=,uid=,pgid=,stat=,lstart=,args=',
  ]);
  return listed
    .split('\n')
    .filter((line) => line.trim())
    .flatMap((line): ProcessIdentity[] => {
      const values =
        /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s+(\S+)\s+(\w{3}\s+\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4})\s+(.*)$/u.exec(
          line,
        );
      // Other same-user commands may contain newlines in argv; their continuation lines are not process rows.
      if (!values) return [];
      return [
        {
          pid: Number(values[1]),
          parent: Number(values[2]),
          uid: Number(values[3]),
          group: Number(values[4]),
          state: values[5]!,
          started: values[6]!.replace(/\s+/gu, ' '),
          args: values[7]!,
        },
      ];
    });
}

async function readOwner(fileName: string): Promise<ProfileOwner | undefined> {
  let text: string;
  try {
    const file = await open(fileName, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const entry = await file.stat();
      // Atomic publication can leave a second link to the complete temporary receipt after a crash.
      if (
        !entry.isFile() ||
        entry.uid !== process.getuid?.() ||
        entry.mode & 0o077 ||
        entry.nlink < 1 ||
        entry.nlink > 2 ||
        entry.size > 1_024
      )
        throw new Error('Chrome host ownership invalid');
      text = await file.readFile('utf8');
    } finally {
      await file.close();
    }
  } catch (error) {
    if (missing(error)) return undefined;
    throw error;
  }
  const owner: unknown = JSON.parse(text);
  if (
    typeof owner !== 'object' ||
    owner === null ||
    !('pid' in owner) ||
    !Number.isSafeInteger(owner.pid) ||
    Number(owner.pid) <= 1 ||
    !('started' in owner) ||
    typeof owner.started !== 'string' ||
    !/^\w{3} \w{3} \d{1,2} \d{2}:\d{2}:\d{2} \d{4}$/u.test(owner.started)
  )
    throw new Error('Chrome host ownership invalid');
  return { pid: Number(owner.pid), started: owner.started };
}

/** The receipt survives a crash or Chrome self-relaunch, where parent PID alone no longer names its host. */
export async function claimChromeProfile(paths: BrowserPaths): Promise<void> {
  await mkdir(paths.root, { recursive: true, mode: 0o700 });
  const root = await lstat(paths.root);
  if (!root.isDirectory() || root.isSymbolicLink() || root.uid !== process.getuid?.() || root.mode & 0o077)
    throw new Error('Chrome profile is not a private owned directory');
  const listed = await processes(process.pid);
  const host = listed.find((item) => item.pid === process.pid && item.uid === process.getuid?.());
  if (!host) throw new Error('Chrome host ownership unavailable');
  const held = ownedProfiles.get(paths.root);
  if (held) {
    const owner = await readOwner(held.file);
    if (owner && sameProcess(owner, host) && sameProcess(held.owner, host)) return;
    throw new Error('Chrome profile has another live owner');
  }
  const receipt = path.join(paths.root, `.chrome-owner.${randomUUID()}.json`);
  const temporary = `${receipt}.tmp`;
  const file = await open(
    temporary,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await file.writeFile(JSON.stringify({ pid: host.pid, started: host.started }));
    await file.sync();
    await link(temporary, receipt);
  } finally {
    try {
      await file.close();
    } finally {
      await unlink(temporary);
    }
  }
  try {
    for (const name of await readdir(paths.root)) {
      if (!/^\.chrome-owner\.[A-Za-z0-9-]+\.json$/u.test(name)) continue;
      const peerFile = path.join(paths.root, name);
      if (peerFile === receipt) continue;
      const peer = await readOwner(peerFile);
      if (!peer) continue;
      if ((await processes(peer.pid)).some((item) => sameProcess(item, peer) && !item.state.startsWith('Z')))
        throw new Error('Chrome profile has another live owner');
      // Each acquisition has an immutable name; deleting a dead claim cannot erase a replacement.
      await unlink(peerFile).catch((error: unknown) => {
        if (!missing(error)) throw error;
      });
    }
    ownedProfiles.set(paths.root, { file: receipt, owner: { pid: host.pid, started: host.started } });
  } catch (error) {
    await unlink(receipt).catch((cleanup: unknown) => {
      if (!missing(cleanup)) throw cleanup;
    });
    throw error;
  }
}

async function privateProfile(paths: BrowserPaths): Promise<boolean> {
  for (const directory of [paths.root, paths.profileDir]) {
    let entry;
    try {
      entry = await lstat(directory);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== process.getuid?.() || entry.mode & 0o077)
      throw new Error('Chrome profile is not a private owned directory');
  }
  return true;
}

function usesProfile(item: ProcessIdentity, paths: BrowserPaths): boolean {
  const flag = `--user-data-dir=${paths.profileDir}`;
  const offset = item.args.indexOf(flag);
  return (
    offset >= 0 &&
    (offset === 0 || item.args[offset - 1] === ' ') &&
    (offset + flag.length === item.args.length || item.args[offset + flag.length] === ' ')
  );
}

async function chromeExecutable(item: ProcessIdentity, chromePath: string): Promise<boolean> {
  let executable: string;
  let expected = chromePath;
  if (process.platform === 'linux') {
    try {
      executable = await readlink(`/proc/${item.pid}/exe`);
      expected = await realpath(chromePath);
    } catch (error) {
      if (missing(error)) return false;
      throw error;
    }
  } else executable = (await ps(['-p', String(item.pid), '-o', 'comm='])).trim();
  if (executable === expected) return true;
  const suffix = '/Contents/MacOS/Google Chrome';
  return (
    chromePath.endsWith(suffix) &&
    executable.startsWith(`${chromePath.slice(0, -suffix.length)}/Contents/Frameworks/`) &&
    /\/(?:Google Chrome Helper(?: \([A-Za-z]+\))?|chrome_crashpad_handler)$/u.test(executable)
  );
}

async function signalIdentity(item: ProcessIdentity, signal: NodeJS.Signals): Promise<void> {
  const current = (await processes(item.pid)).find((candidate) => sameProcess(candidate, item));
  if (!current || current.uid !== item.uid || current.args !== item.args || current.state.startsWith('Z')) return;
  try {
    process.kill(item.pid, signal);
  } catch (error) {
    if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
  }
}

/** Retires only a verified private profile whose previous host has ended. Never adopts its connection. */
export async function retireChromeProfile(paths: BrowserPaths, chromePath = SYSTEM_CHROME): Promise<void> {
  if (!(await privateProfile(paths))) return;
  await claimChromeProfile(paths);
  const claim = ownedProfiles.get(paths.root);
  if (!claim) throw new Error('Chrome host ownership unavailable');
  const known = new Map<number, ProcessIdentity>();
  const signalled = new Set<string>();
  const started = Date.now();
  for (;;) {
    const listed = await processes();
    const matching = listed.filter((item) => usesProfile(item, paths) && !item.state.startsWith('Z'));
    const expected = new Set(matching.map((item) => item.pid));
    for (const item of matching) {
      if (item.uid !== process.getuid?.() || !(await chromeExecutable(item, chromePath))) {
        if (!(await processes()).some((current) => sameProcess(item, current))) continue;
        throw new Error('Chrome profile process ownership invalid');
      }
      if (item.parent !== 1 && item.parent !== process.pid && !expected.has(item.parent))
        throw new Error('Chrome profile has another live owner');
      known.set(item.pid, item);
    }
    // Capture the complete tree before parents exit, including helpers with no profile flag of their own.
    const byPid = new Map(listed.map((item) => [item.pid, item]));
    let discovered = true;
    while (discovered) {
      discovered = false;
      for (const item of listed) {
        const parent = known.get(item.parent);
        const currentParent = byPid.get(item.parent);
        if (
          parent &&
          currentParent &&
          sameProcess(parent, currentParent) &&
          !known.has(item.pid) &&
          !item.state.startsWith('Z')
        ) {
          if (item.uid !== process.getuid?.() || !(await chromeExecutable(item, chromePath)))
            throw new Error('Chrome child process ownership invalid');
          known.set(item.pid, item);
          discovered = true;
        }
      }
    }
    const alive = listed.filter((item) => {
      const identity = known.get(item.pid);
      return identity && sameProcess(identity, item) && !item.state.startsWith('Z');
    });
    if (!alive.length) break;
    const elapsed = Date.now() - started;
    if (elapsed >= 5_000) throw new Error('Chrome processes did not stop');
    const signal = elapsed >= 3_000 ? 'SIGKILL' : 'SIGTERM';
    for (const item of alive) {
      const key = `${item.pid}:${item.started}:${signal}`;
      if (!signalled.has(key)) {
        await signalIdentity(item, signal);
        signalled.add(key);
      }
    }
    await delay(25);
  }
  const current = await readOwner(claim.file);
  if (!current || !sameProcess(current, claim.owner)) throw new Error('Chrome host ownership invalid');
  await unlink(claim.file);
  if (ownedProfiles.get(paths.root) === claim) ownedProfiles.delete(paths.root);
}

/** Capture before Browser.close, while a known member still proves this group has not been reused. */
export async function captureChromeGroup(id: number, previous?: ChromeProcessGroup): Promise<ChromeProcessGroup> {
  const members = (await processes()).filter((item) => item.group === id && !item.state.startsWith('Z'));
  if (members.some((item) => item.uid !== process.getuid?.())) throw new Error('Chrome group ownership invalid');
  if (
    members.length &&
    !(previous
      ? members.some((item) => {
          const known = previous.members.get(item.pid);
          return known && sameProcess(known, item);
        })
      : members.some((item) => item.pid === id && item.parent === process.pid))
  )
    throw new Error('Chrome group ownership invalid');
  return { id, members: new Map(members.map((item) => [item.pid, item])) };
}

/** A captured live member proves the group still belongs to this spawn after the browser's main child exits. */
export async function retireChromeGroup(initial: ChromeProcessGroup): Promise<void> {
  const started = Date.now();
  let group = initial;
  let lastSignal: NodeJS.Signals | undefined;
  for (;;) {
    group = await captureChromeGroup(group.id, group);
    if (!group.members.size) return;
    const elapsed = Date.now() - started;
    if (elapsed >= 5_000) throw new Error('Chrome processes did not stop');
    const signal = elapsed >= 3_000 ? 'SIGKILL' : 'SIGTERM';
    if (signal !== lastSignal) {
      try {
        process.kill(-group.id, signal);
      } catch (error) {
        if (!(error instanceof Error && 'code' in error && error.code === 'ESRCH')) throw error;
      }
      lastSignal = signal;
    }
    await delay(25);
  }
}
