import { existsSync } from 'node:fs';
import type { Lesson } from '../modules/gws-ea-lessons/db.js';
import type { ControlPlanePaths } from './paths.js';
import { getInstanceReservation } from './registry.js';
import { loadInstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { centralDatabaseFile, openWithoutSideFiles } from './verify.js';

export interface LessonsObservation {
  readonly instance_id: string;
  readonly lessons: readonly Lesson[];
}

/** A local observation opens no host socket and leaves closed WAL files closed. */
export async function inspectLessons(paths: ControlPlanePaths, instanceId: string): Promise<LessonsObservation> {
  await getInstanceReservation(paths, instanceId);
  const runtime = await loadInstanceRuntimeConfig(paths.runtimeFile(instanceId));
  const file = centralDatabaseFile(runtime.state_root);
  if (!existsSync(file)) throw new GwsEaError('lessons_unavailable', 'This assistant has no lessons store yet.');
  try {
    const db = openWithoutSideFiles(file);
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='gws_ea_lessons'").get())
        return { instance_id: instanceId, lessons: [] };
      return {
        instance_id: instanceId,
        lessons: db
          .prepare('SELECT id,text,status,created_at FROM gws_ea_lessons ORDER BY created_at,id')
          .all() as Lesson[],
      };
    } finally {
      db.close();
    }
  } catch {
    throw new GwsEaError('lessons_unavailable', 'This assistant’s lessons cannot be read just now.');
  }
}
