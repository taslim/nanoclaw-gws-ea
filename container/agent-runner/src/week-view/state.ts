import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { readWeekViewFile } from './clock.js';

export const WEEK_VIEW_STATE_DIR = '/workspace/.week-view-delivered';
export interface ViewEntry {
  readonly id: string;
  readonly text: string;
  readonly version: string;
}
export interface ViewDay {
  readonly date: string;
  readonly header: string;
  readonly version: string;
  readonly entries: readonly ViewEntry[];
}
export interface DeliveredView {
  readonly fingerprint: string;
  readonly days: readonly ViewDay[];
  /** The Manual sections this session holds, from its project document or from this hook. */
  readonly manual: readonly string[];
}
export const fingerprint = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const file = (id: string, dir: string) => path.join(dir, fingerprint(id));
export function readDelivered(id: string, dir = WEEK_VIEW_STATE_DIR): DeliveredView | undefined {
  try {
    const value = readWeekViewFile(file(id, dir));
    if (
      !isRecord(value) ||
      typeof value.fingerprint !== 'string' ||
      !validSections(value.manual) ||
      !validDays(value.days)
    )
      return undefined;
    return { fingerprint: value.fingerprint, manual: value.manual, days: value.days };
  } catch {
    return undefined;
  }
}
export function recordDelivered(id: string, snapshot: DeliveredView, dir = WEEK_VIEW_STATE_DIR): void {
  const target = file(id, dir);
  const temporary = `${target}.${process.pid}.tmp`;
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(temporary, JSON.stringify(snapshot));
    fs.renameSync(temporary, target);
  } catch {
    try {
      fs.rmSync(temporary, { force: true });
    } catch {}
  }
}
export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
export function validSections(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((section) => typeof section === 'string');
}
export function validDays(value: unknown): value is ViewDay[] {
  return (
    Array.isArray(value) &&
    value.length <= 8 &&
    value.every(
      (day: unknown) =>
        isRecord(day) &&
        typeof day.date === 'string' &&
        typeof day.header === 'string' &&
        typeof day.version === 'string' &&
        Array.isArray(day.entries) &&
        day.entries.every(
          (entry: unknown) =>
            isRecord(entry) &&
            typeof entry.id === 'string' &&
            typeof entry.text === 'string' &&
            typeof entry.version === 'string',
        ),
    )
  );
}
