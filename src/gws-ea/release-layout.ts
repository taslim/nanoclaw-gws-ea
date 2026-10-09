/**
 * An assistant's releases and its state, laid out so that switching releases
 * never moves or copies state (KTD1, design C). Under the instance root:
 *
 *   nanoclaw -> 0123abcd   the live release: a relative link, the one path the
 *                          service definition names and NanoClaw runs from;
 *                          absent while a switch has fenced the assistant
 *   0123abcd/              one release: a checkout of its commit, staged while
 *                          the assistant serves and never edited once complete;
 *                          its `.env`, `data`, `groups`, and `store` link to
 *                          `../state/<name>`, and its `logs` to `../logs`
 *   state/                 the assistant's state, which never moves
 *   logs/                  the host's output
 *   kept/0123abcd/         what is kept with each release, its receipt last
 *   snapshots/<op>/        a copy of `state/` an operation took while fenced
 *   quarantine/<op>/       the state a snapshot restore replaced
 *   fence.json             which fence is in force
 *
 * NanoClaw roots its state at `process.cwd()` (`src/config.ts`), and upstream
 * already supports `data`, `groups`, `store`, and `.env` as links to storage
 * elsewhere (`.gitignore`'s bare entries, `setup/set-env.ts`), so a release
 * reaches the one state through its links and nothing in NanoClaw changes.
 * Switching is one `rename(2)` of the `nanoclaw` link; with the link absent
 * the service manager can start nothing, even after a reboot, which fences
 * every switch.
 *
 * A release directory is named by the first eight hex digits of its commit,
 * the length of the `nanoclaw` name: NanoClaw binds `ncl` at
 * `<cwd>/data/ncl.sock` with `cwd` the release's physical path, and macOS caps
 * a socket path at 104 bytes.
 *
 * Removal here unlinks links and never follows them, and every link is
 * refused but the ones written here: the live link names only an 8-hex
 * sibling, and a release's links are exactly `../state/<name>` and `../logs`.
 */
import { randomUUID } from 'node:crypto';
import { constants as fsConstants, type Stats } from 'node:fs';
import {
  chmod,
  copyFile,
  lchown,
  lstat,
  lutimes,
  mkdir,
  open,
  readdir,
  readFile,
  readlink,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { GwsEaError } from './types.js';
import { canonicalTimestamp, isRecord } from './validation.js';

/** NanoClaw's state roots, each reached from a release through `../state/<root>`; `.env` is the one file. */
export const STATE_ROOTS = ['.env', 'data', 'groups', 'store'] as const;

/** Every link a release holds, and the one target each may have. */
const RELEASE_LINKS: ReadonlyMap<string, string> = new Map([
  ...STATE_ROOTS.map((root): [string, string] => [root, path.join('..', 'state', root)]),
  ['logs', path.join('..', 'logs')],
]);

const RELEASE_NAME = /^[0-9a-f]{8}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
/** An operation's name: its start time, compact (`20261009T101500123Z`), so names sort by when operations began. */
const OPERATION_NAME = /^\d{8}T\d{9}Z$/u;
/** The file a release's receipt is: written last, so a release without it is incomplete. */
const RECEIPT = 'release-preflight.json';
const SNAPSHOT_RECORD = 'snapshot.json';
const RETURNED = '-returned';

export interface InstanceLayout {
  readonly root: string;
  /** The live link, `<root>/nanoclaw`. */
  readonly current: string;
  readonly state: string;
  readonly logs: string;
  /** `<root>/<name>`: one release's checkout. */
  release(name: string): string;
  /** `<root>/kept/<name>`: what is kept with release `name` besides its checkout. */
  kept(name: string): string;
  /** Release `name`'s receipt in `kept/<name>/`, written last: the release is complete once it exists. */
  receipt(name: string): string;
  /** `<root>/snapshots/<op>`: the copy of `state/` operation `op` took while fenced. */
  snapshot(op: string): string;
  /** `<root>/quarantine/<op>`: the state operation `op`'s snapshot restore replaced. */
  quarantine(op: string): string;
}

export function instanceLayout(root: string): InstanceLayout {
  const resolved = path.resolve(root);
  return {
    root: resolved,
    current: path.join(resolved, 'nanoclaw'),
    state: path.join(resolved, 'state'),
    logs: path.join(resolved, 'logs'),
    release: (name) => path.join(resolved, requireReleaseName(name)),
    kept: (name) => path.join(keptRoot(resolved), requireReleaseName(name)),
    receipt: (name) => path.join(keptRoot(resolved), requireReleaseName(name), RECEIPT),
    snapshot: (op) => path.join(snapshotsRoot(resolved), requireOperationName(op)),
    quarantine: (op) => path.join(quarantineRoot(resolved), requireOperationName(op)),
  };
}

const keptRoot = (root: string): string => path.join(root, 'kept');
const snapshotsRoot = (root: string): string => path.join(root, 'snapshots');
const quarantineRoot = (root: string): string => path.join(root, 'quarantine');
const fenceFile = (layout: InstanceLayout): string => path.join(layout.root, 'fence.json');

function unsafe(message: string): GwsEaError {
  return new GwsEaError('unsafe_release_layout', message);
}

function requireReleaseName(name: string): string {
  if (!RELEASE_NAME.test(name)) throw unsafe(`${JSON.stringify(name)} is not a release name`);
  return name;
}

function requireOperationName(op: string): string {
  if (!OPERATION_NAME.test(op)) throw unsafe(`${JSON.stringify(op)} is not an operation name`);
  return op;
}

/** The directory name of the release at `commit`. */
export function releaseName(commit: string): string {
  if (!COMMIT.test(commit)) throw unsafe(`${JSON.stringify(commit)} is not a commit`);
  return commit.slice(0, 8);
}

/** The name an operation that began at `startedAt` (a canonical timestamp) keeps its snapshot and quarantine under. */
export function operationName(startedAt: string): string {
  if (canonicalTimestamp(startedAt) === undefined) throw unsafe(`${JSON.stringify(startedAt)} is not a start time`);
  return requireOperationName(startedAt.replace(/[-:.]/gu, ''));
}

async function lstatIfPresent(target: string): Promise<Stats | undefined> {
  try {
    return await lstat(target);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
}

async function syncDirectory(directory: string): Promise<void> {
  const handle = await open(directory, fsConstants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

/**
 * Create the assistant's state and log directories, owner-only, with each
 * state root a create has not made yet: directories, and `.env` as a file.
 * Only a create calls this; staging a release never creates state.
 */
export async function createState(layout: InstanceLayout): Promise<void> {
  await mkdir(layout.state, { recursive: true, mode: 0o700 });
  await mkdir(layout.logs, { recursive: true, mode: 0o700 });
  for (const root of STATE_ROOTS) {
    const target = path.join(layout.state, root);
    if (await lstatIfPresent(target)) continue;
    if (root === '.env') await writeFile(target, '', { mode: 0o600, flag: 'wx' });
    else await mkdir(target, { mode: 0o700 });
  }
}

/**
 * Give a staged release its links to the assistant's state and logs. A link
 * already in place is kept; anything else at a link's name is refused, since
 * a release holding state of its own would split it. Only links are written:
 * nothing is created through them, so `state/` need not exist yet.
 */
export async function linkReleaseState(layout: InstanceLayout, name: string): Promise<void> {
  const release = await physicalRelease(layout, name);
  let linked = false;
  for (const [link, target] of RELEASE_LINKS) {
    const at = path.join(release, link);
    if (await lstatIfPresent(at)) {
      await assertLink(at, target);
      continue;
    }
    await symlink(target, at);
    linked = true;
  }
  if (linked) await syncDirectory(release);
}

async function physicalRelease(layout: InstanceLayout, name: string): Promise<string> {
  const release = layout.release(name);
  if (!(await lstatIfPresent(release))?.isDirectory()) {
    throw unsafe(`Release ${name} is not a directory at ${release}.`);
  }
  return release;
}

async function assertLink(at: string, target: string): Promise<void> {
  const info = await lstatIfPresent(at);
  if (!info?.isSymbolicLink() || (await readlink(at)) !== target) {
    throw unsafe(`${at} is not a link to ${target}, so the release does not share the assistant's state.`);
  }
}

/** A release directory with every link exactly in place. */
async function assertLinkedRelease(layout: InstanceLayout, name: string): Promise<void> {
  const release = await physicalRelease(layout, name);
  for (const [link, target] of RELEASE_LINKS) await assertLink(path.join(release, link), target);
}

/**
 * Whether release `name` is complete: its directory is in place with its
 * links, and its receipt is written. A release with links other than its own
 * is refused, not reported incomplete.
 */
export async function isReleaseComplete(layout: InstanceLayout, name: string): Promise<boolean> {
  if (!(await lstatIfPresent(layout.release(name)))) return false;
  if (!(await lstatIfPresent(layout.receipt(name)))?.isFile()) return false;
  await assertLinkedRelease(layout, name);
  return true;
}

/**
 * Remove release `name`, which has no receipt, and whatever was kept for it,
 * so it can be staged again. Removal unlinks its links and never follows
 * them. A complete release is refused: it is never edited or replaced.
 */
export async function discardIncompleteRelease(layout: InstanceLayout, name: string): Promise<void> {
  if (await lstatIfPresent(layout.receipt(name))) throw unsafe(`Release ${name} is complete, so it is not restaged.`);
  await rm(layout.kept(name), { recursive: true, force: true });
  await rm(layout.release(name), { recursive: true, force: true });
}

/**
 * The release the live link names, or undefined while a switch has fenced
 * it. A link that names anything but a release directory beside it is
 * refused: nothing else is ever written there.
 */
export async function readCurrent(layout: InstanceLayout): Promise<string | undefined> {
  const info = await lstatIfPresent(layout.current);
  if (!info) return undefined;
  if (!info.isSymbolicLink()) throw unsafe(`${layout.current} is not the live release's link.`);
  const target = await readlink(layout.current);
  if (!RELEASE_NAME.test(target)) throw unsafe(`${layout.current} links to ${JSON.stringify(target)}, not a release.`);
  return target;
}

/** The `epoch` a JSON record at `file` names, or undefined when there is no such file or it names none. */
async function readEpoch(file: string): Promise<string | undefined> {
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) return undefined;
    throw error;
  }
  return isRecord(value) && typeof value.epoch === 'string' && value.epoch ? value.epoch : undefined;
}

/**
 * Remove the live link, so neither the service manager nor anything else can
 * start a host until a switch points it again, and return the fence's epoch.
 * Each fence that removes the link starts a new epoch, recorded before the
 * link goes: a release may have run since any earlier fence, so a snapshot
 * that one took is stale. Fencing again while fenced keeps the epoch.
 */
export async function fence(layout: InstanceLayout): Promise<string> {
  const live = await readCurrent(layout);
  const recorded = await readEpoch(fenceFile(layout));
  if (live === undefined && recorded !== undefined) return recorded;
  const epoch = randomUUID();
  await writePrivate(fenceFile(layout), { epoch });
  if (live !== undefined) {
    await rm(layout.current);
    await syncDirectory(layout.root);
  }
  return epoch;
}

/** The epoch of the fence in force; refused unless a fence is. */
async function assertFenced(layout: InstanceLayout, action: string): Promise<string> {
  const epoch = await readEpoch(fenceFile(layout));
  if ((await readCurrent(layout)) !== undefined || epoch === undefined) {
    throw unsafe(`The assistant is not fenced, so ${action}.`);
  }
  return epoch;
}

/**
 * Point the live link at complete release `name`, in one rename: the link is
 * whole at its old target or its new one, never anything between. A leftover
 * from an earlier attempt cut short is replaced.
 */
export async function pointCurrent(layout: InstanceLayout, name: string): Promise<void> {
  if (!(await isReleaseComplete(layout, name))) throw unsafe(`Release ${name} is not complete.`);
  if ((await readCurrent(layout)) === name) return;
  const pending = `${layout.current}.pending`;
  await rm(pending, { force: true });
  await symlink(name, pending);
  await rename(pending, layout.current);
  await syncDirectory(layout.root);
}

/** Keep `source`'s owner, mode, and times on `target`; ownership first, since changing it can clear mode bits. */
async function preserve(target: string, source: Stats): Promise<void> {
  const current = await lstat(target);
  if (current.uid !== source.uid || current.gid !== source.gid) await lchown(target, source.uid, source.gid);
  if (source.isSymbolicLink()) {
    await lutimes(target, source.atime, source.mtime);
    return;
  }
  await chmod(target, source.mode & 0o7777);
  await utimes(target, source.atime, source.mtime);
}

/**
 * Copy `source` to `destination` as it is: files cloned where the filesystem
 * can, links copied as links and never followed, directories walked. A
 * socket, pipe, or device belongs to a process, not to state, and is left
 * out. Nothing is opened as a database, so a planted file is copied like any
 * other; one this user cannot copy is refused by name.
 */
async function copyTree(source: string, destination: string): Promise<void> {
  const info = await lstat(source);
  try {
    if (info.isDirectory()) {
      await mkdir(destination, { mode: 0o700 });
      for (const entry of await readdir(source)) {
        await copyTree(path.join(source, entry), path.join(destination, entry));
      }
    } else if (info.isSymbolicLink()) {
      await symlink(await readlink(source), destination);
    } else if (info.isFile()) {
      await copyFile(source, destination, fsConstants.COPYFILE_FICLONE | fsConstants.COPYFILE_EXCL);
    } else {
      return;
    }
    await preserve(destination, info);
  } catch (error) {
    if (error instanceof GwsEaError) throw error;
    if (isErrno(error, 'EACCES') || isErrno(error, 'EPERM')) {
      throw new GwsEaError('state_uncopyable', `${source} cannot be copied with its owner and mode.`, {
        cause: error,
      });
    }
    throw error;
  }
}

/**
 * Copy `from`'s state roots into `to`, which does not exist: built aside and
 * renamed into place whole, so a copy cut short is never mistaken for one.
 */
async function copyState(from: string, to: string, record?: Readonly<Record<string, string>>): Promise<void> {
  const building = `${to}.building`;
  await rm(building, { recursive: true, force: true });
  await mkdir(building, { mode: 0o700 });
  for (const root of STATE_ROOTS) {
    const source = path.join(from, root);
    if (await lstatIfPresent(source)) await copyTree(source, path.join(building, root));
  }
  if (record) await writePrivate(path.join(building, SNAPSHOT_RECORD), record);
  await rename(building, to);
  await syncDirectory(path.dirname(to));
}

/**
 * Copy `state/` to `snapshots/<op>/` while fenced, beside a record of the
 * release it was taken from and the fence it was taken under. A snapshot `op`
 * already took under this fence is kept; one from an earlier fence is taken
 * again, since the release that fence ended may have written the state since.
 * The caller has proven nothing holds the state.
 */
export async function takeSnapshot(layout: InstanceLayout, op: string, release: string): Promise<string> {
  requireReleaseName(release);
  const snapshot = layout.snapshot(op);
  const epoch = await assertFenced(layout, 'no snapshot is taken');
  if ((await readEpoch(path.join(snapshot, SNAPSHOT_RECORD))) === epoch) return snapshot;
  await mkdir(snapshotsRoot(layout.root), { recursive: true, mode: 0o700 });
  await rm(snapshot, { recursive: true, force: true });
  await copyState(layout.state, snapshot, { release, epoch, taken_at: new Date().toISOString() });
  return snapshot;
}

/** When snapshot `op` was taken, as the record kept with it says. */
export async function snapshotTakenAt(layout: InstanceLayout, op: string): Promise<string> {
  const file = path.join(layout.snapshot(op), SNAPSHOT_RECORD);
  let value: unknown;
  try {
    value = JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isErrno(error, 'ENOENT') || error instanceof SyntaxError) throw unsafe(`Snapshot ${op} is not kept whole.`);
    throw error;
  }
  const takenAt = isRecord(value) ? canonicalTimestamp(value.taken_at) : undefined;
  if (takenAt === undefined) throw unsafe(`Snapshot ${op} records no time it was taken.`);
  return takenAt;
}

/**
 * While fenced, put snapshot `snapshot` back as the assistant's state for
 * operation `op`: rename the state aside whole into `quarantine/<op>/`, then
 * clone the snapshot into a new `state/`, keeping the snapshot for a later
 * attempt. A restore cut short at either step is finished by running it again.
 */
export async function restoreSnapshot(layout: InstanceLayout, snapshot: string, op: string): Promise<void> {
  await assertFenced(layout, 'its state is not restored');
  const source = layout.snapshot(snapshot);
  if (!(await lstatIfPresent(source))?.isDirectory()) throw unsafe(`Snapshot ${snapshot} is not kept.`);
  const quarantined = layout.quarantine(op);
  if (!(await lstatIfPresent(quarantined))) {
    await mkdir(quarantineRoot(layout.root), { recursive: true, mode: 0o700 });
    if (await lstatIfPresent(layout.state)) {
      await rename(layout.state, quarantined);
      await syncDirectory(quarantineRoot(layout.root));
    }
  }
  if (await lstatIfPresent(layout.state)) return;
  await copyState(source, layout.state);
}

/**
 * While fenced, undo operation `op`'s snapshot restore after its rollback
 * failed (KTD5): rename the state the rollback's target produced aside into
 * `quarantine/<op>-returned/`, then rename `quarantine/<op>/` back to
 * `state/`, so the assistant has exactly the state it had before. A return
 * cut short at either step is finished by running it again. A rollback whose
 * restore never began quarantined nothing, and its state stays as it is.
 */
export async function returnQuarantinedState(layout: InstanceLayout, op: string): Promise<void> {
  await assertFenced(layout, 'its state is not returned');
  const quarantined = layout.quarantine(op);
  const returned = `${quarantined}${RETURNED}`;
  if (!(await lstatIfPresent(quarantined)) && !(await lstatIfPresent(returned))) return;
  if (!(await lstatIfPresent(returned)) && (await lstatIfPresent(layout.state))) {
    await rename(layout.state, returned);
    await syncDirectory(quarantineRoot(layout.root));
  }
  if (await lstatIfPresent(layout.state)) return;
  if (!(await lstatIfPresent(quarantined))) throw unsafe(`No state of operation ${op} is quarantined to return.`);
  await rm(`${layout.state}.building`, { recursive: true, force: true });
  await rename(quarantined, layout.state);
  await syncDirectory(layout.root);
}

/** What a prune keeps besides the live release (KTD4). */
export interface PruneKeep {
  /** The release a rollback returns to, and the snapshot taken as the assistant left it. */
  readonly rollbackPoint?: { readonly release: string; readonly snapshot: string };
  /** The release an update staged and has not switched to. */
  readonly staging?: string;
}

async function entries(directory: string): Promise<string[]> {
  try {
    return await readdir(directory);
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return [];
    throw error;
  }
}

/**
 * Delete every release but the live one and those `keep` names, with what
 * was kept for it and, through `removeImage`, its agent image tag; every
 * snapshot but the rollback point's; and every quarantine but the newest.
 * A release's receipt goes first, so a prune cut short leaves an incomplete
 * release the next prune finishes. Removal unlinks links and never follows
 * them. Refused while fenced, when which release goes live is not settled.
 */
export async function pruneInstance(
  layout: InstanceLayout,
  keep: PruneKeep,
  removeImage: (release: string) => Promise<void>,
): Promise<string[]> {
  const live = await readCurrent(layout);
  if (live === undefined) throw unsafe('The assistant is fenced, so nothing is pruned.');
  const keptReleases = new Set([live]);
  if (keep.rollbackPoint) keptReleases.add(requireReleaseName(keep.rollbackPoint.release));
  if (keep.staging) keptReleases.add(requireReleaseName(keep.staging));
  const keptSnapshot = keep.rollbackPoint ? requireOperationName(keep.rollbackPoint.snapshot) : undefined;

  const candidates = new Set(await entries(keptRoot(layout.root)));
  for (const entry of await readdir(layout.root, { withFileTypes: true })) {
    if (entry.isDirectory()) candidates.add(entry.name);
  }
  const pruned = [...candidates].filter((name) => RELEASE_NAME.test(name) && !keptReleases.has(name)).sort();
  for (const name of pruned) {
    await rm(layout.kept(name), { recursive: true, force: true });
    await removeImage(name);
    await rm(layout.release(name), { recursive: true, force: true });
  }

  for (const entry of await entries(snapshotsRoot(layout.root))) {
    if (entry !== keptSnapshot) {
      await rm(path.join(snapshotsRoot(layout.root), entry), { recursive: true, force: true });
    }
  }
  // Operation names sort by start time, and an operation's returned state sorts after what it quarantined first.
  const quarantines = (await entries(quarantineRoot(layout.root))).sort();
  const newest = quarantines.filter((entry) => OPERATION_NAME.test(entry.replace(RETURNED, ''))).at(-1);
  for (const entry of quarantines) {
    if (entry !== newest) await rm(path.join(quarantineRoot(layout.root), entry), { recursive: true, force: true });
  }
  return pruned;
}
