import { createHash } from 'node:crypto';
import path from 'node:path';

import Database from 'better-sqlite3';

import { isErrno } from '../community-portal/errors.js';
import { writePrivate } from '../community-portal/private-file.js';
import { loadCreatedRuntime, type InstanceOperation } from './journal.js';
import type { ControlPlanePaths } from './paths.js';
import { normalizePersonName, type PersonNameInput } from './person-name.js';
import {
  assertProfileNameMigrationSource,
  parseProfileNameMigrationInput,
  PROFILE_NAME_INPUT_TABLE,
  type LegacyProfileNames,
  type ProfileNameMigrationInput,
} from './profile-name-migration.js';
import { assertLegacyCreateComplete } from './provision.js';
import { getInstanceReservation } from './registry.js';
import { readOwnerOnlyJson, removePrivateFile } from './secrets.js';
import { GwsEaError } from './types.js';
import { centralDatabaseFile, openWithoutSideFiles } from './verify.js';

function inputFile(paths: ControlPlanePaths, instanceId: string): string {
  return path.join(paths.instanceRoot(instanceId), 'profile-names.json');
}

export function profileNameInputFingerprint(input: ProfileNameMigrationInput | undefined): string | null {
  return input === undefined ? null : createHash('sha256').update(JSON.stringify(input)).digest('hex');
}

export async function readProfileNameInput(
  paths: ControlPlanePaths,
  instanceId: string,
): Promise<ProfileNameMigrationInput | undefined> {
  let raw: unknown;
  try {
    raw = await readOwnerOnlyJson(inputFile(paths, instanceId), 'Prepared names', 'invalid_profile_names');
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined;
    throw error;
  }
  const input = parseProfileNameMigrationInput(raw);
  if (input.instance_id !== instanceId) {
    throw new GwsEaError('invalid_profile_names', 'The prepared names belong to another assistant.');
  }
  return input;
}

export async function clearProfileNameInput(paths: ControlPlanePaths, instanceId: string): Promise<void> {
  await removePrivateFile(inputFile(paths, instanceId));
}

function legacyNames(db: Database.Database): LegacyProfileNames | undefined {
  const columns = db.prepare('PRAGMA table_info(gws_ea_profile)').all() as Array<{ name: string }>;
  if (!columns.some(({ name }) => name === 'assistant_display_name')) return undefined;
  return db
    .prepare('SELECT assistant_display_name, principal_display_name FROM gws_ea_profile WHERE singleton = 1')
    .get() as LegacyProfileNames | undefined;
}

function populated(names: LegacyProfileNames): boolean {
  return names.assistant_display_name !== null || names.principal_display_name !== null;
}

/** Validate while serving as well as after fencing: schema fingerprints do not detect a rename. */
export function assertProfileNameInputCurrent(stateRoot: string, input: ProfileNameMigrationInput | undefined): void {
  const db = openWithoutSideFiles(centralDatabaseFile(stateRoot));
  try {
    const previous = legacyNames(db);
    if (previous === undefined || !populated(previous)) return;
    if (input === undefined)
      throw new GwsEaError(
        'profile_names_required',
        'Prepare explicit name components first: gws-ea names prepare --id <instance_id> --assistant-first-name <name> --principal-first-name <name> (add each optional --assistant-last-name or --principal-last-name).',
      );
    assertProfileNameMigrationSource(input, previous);
  } finally {
    db.close();
  }
}

/** Called under the instance lock; preparation never writes the live database. */
export async function prepareProfileNames(
  operation: InstanceOperation,
  names: { readonly assistant: PersonNameInput; readonly principal: PersonNameInput },
): Promise<boolean> {
  const { paths, instanceId } = operation;
  const reservation = await getInstanceReservation(paths, instanceId);
  await assertLegacyCreateComplete(paths, reservation);
  const runtime = await loadCreatedRuntime(paths, instanceId);
  const assistant = normalizePersonName(names.assistant, 'assistant');
  const principal = normalizePersonName(names.principal, 'principal');
  const db = openWithoutSideFiles(centralDatabaseFile(runtime.state_root));
  let previous: LegacyProfileNames | undefined;
  try {
    previous = legacyNames(db);
  } finally {
    db.close();
  }
  if (previous === undefined) {
    throw new GwsEaError(
      'profile_names_current',
      'This assistant already stores name components; use its native profile commands for changes.',
    );
  }
  const input: ProfileNameMigrationInput = {
    schema_version: 1,
    instance_id: instanceId,
    previous,
    assistant,
    principal,
  };
  if (profileNameInputFingerprint(await readProfileNameInput(paths, instanceId)) === profileNameInputFingerprint(input))
    return false;
  await writePrivate(inputFile(paths, instanceId), input);
  return true;
}

/** Seed only a database copy, or the fenced live database after its snapshot. */
export function installProfileNameInput(file: string, input: ProfileNameMigrationInput | undefined): void {
  const db = new Database(file, { fileMustExist: true });
  try {
    const previous = legacyNames(db);
    if (previous === undefined || !populated(previous)) return;
    if (input === undefined)
      throw new GwsEaError('profile_names_required', 'Run gws-ea names prepare for this assistant before updating.');
    const parsed = parseProfileNameMigrationInput(input);
    assertProfileNameMigrationSource(parsed, previous);
    db.transaction(() => {
      db.exec(
        `CREATE TABLE IF NOT EXISTS ${PROFILE_NAME_INPUT_TABLE} (singleton INTEGER PRIMARY KEY CHECK (singleton = 1), payload TEXT NOT NULL)`,
      );
      db.prepare(
        `INSERT INTO ${PROFILE_NAME_INPUT_TABLE} (singleton, payload) VALUES (1, ?) ON CONFLICT (singleton) DO UPDATE SET payload = excluded.payload`,
      ).run(JSON.stringify(parsed));
    })();
  } finally {
    db.close();
  }
}
