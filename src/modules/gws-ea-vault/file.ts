import { constants } from 'node:fs';
import { chmod, lstat, mkdir, open } from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';

function ownedByThisUser(uid: number): boolean {
  return process.getuid === undefined || uid === process.getuid();
}

/**
 * Opens a host-only SQLite store. The file and its directory must be this user's own, the file a
 * single-linked regular file reached without a symlink; looser modes are tightened, never trusted.
 */
export async function openPrivateDatabase(file: string, schema: string): Promise<Database.Database> {
  if (!path.isAbsolute(file) || path.resolve(file) !== file) throw new Error('Private store path is not normalized');
  const directory = path.dirname(file);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const directoryStat = await lstat(directory);
  if (!directoryStat.isDirectory() || !ownedByThisUser(directoryStat.uid))
    throw new Error('Private store directory is not owner-only');
  if ((directoryStat.mode & 0o7777) !== 0o700) await chmod(directory, 0o700);

  const handle = await open(file, constants.O_RDWR | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.nlink !== 1 || !ownedByThisUser(stat.uid))
      throw new Error('Private store file is not owner-only');
    if ((stat.mode & 0o7777) !== 0o600) await handle.chmod(0o600);
  } finally {
    await handle.close();
  }
  const db = new Database(file);
  try {
    db.pragma('journal_mode = DELETE');
    db.pragma('secure_delete = ON');
    db.pragma('synchronous = FULL');
    db.exec(schema);
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

const operationGates = new Map<string, Promise<void>>();

/**
 * Runs one operation on a private store with the file to itself: operations on the same file run one at a time, in
 * the order they were asked, each on its own connection that is closed afterwards.
 */
export async function withPrivateDatabase<T>(
  file: string,
  schema: string,
  operation: (db: Database.Database) => T | Promise<T>,
): Promise<T> {
  const previous = operationGates.get(file);
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  operationGates.set(file, gate);
  await previous;
  try {
    const db = await openPrivateDatabase(file, schema);
    try {
      return await operation(db);
    } finally {
      db.close();
    }
  } finally {
    release();
    if (operationGates.get(file) === gate) operationGates.delete(file);
  }
}
