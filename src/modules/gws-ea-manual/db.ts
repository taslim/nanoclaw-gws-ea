import { getDb } from '../../db/connection.js';
import { signalManualChange } from './changes.js';

export const MANUAL_KEYS = ['priorities', 'principles', 'preferences', 'authority', 'narrative'] as const;
export type ManualKey = (typeof MANUAL_KEYS)[number];
export const MANUAL_SECTION_BUDGET_CHARS = 600;
export const MANUAL_LABELS: Readonly<Record<ManualKey, string>> = {
  priorities: 'Priorities',
  principles: 'Principles',
  preferences: 'Preferences beyond scheduling',
  authority: 'Granted authority',
  narrative: 'Who the principal is',
};

export interface ManualSection {
  readonly key: ManualKey;
  readonly text: string;
  readonly updated_at: string;
}
interface ManualRow extends ManualSection {
  readonly previous_text: string | null;
  readonly previous_updated_at: string | null;
}

export function manualKey(value: unknown): ManualKey {
  const key = MANUAL_KEYS.find((candidate) => candidate === value);
  if (key === undefined) throw new Error(`Section must be one of: ${MANUAL_KEYS.join(', ')}`);
  return key;
}

export async function getManualSections(): Promise<ManualSection[]> {
  const rows = await getDb().all<ManualSection>('SELECT key, text, updated_at FROM gws_ea_manual_sections');
  return MANUAL_KEYS.flatMap((key) => rows.filter((row) => row.key === key));
}

export async function getManualSection(key: ManualKey): Promise<ManualSection | undefined> {
  return getDb().get<ManualSection>('SELECT key, text, updated_at FROM gws_ea_manual_sections WHERE key=?', key);
}

/** Only the retained previous value: current prose is read through `get`, never echoed as history. */
export async function getManualHistory(key?: ManualKey): Promise<ManualSection[]> {
  const rows = await getDb().all<ManualRow>('SELECT * FROM gws_ea_manual_sections');
  return MANUAL_KEYS.flatMap((candidate) =>
    rows.flatMap((row) =>
      row.key === candidate &&
      (key === undefined || row.key === key) &&
      row.previous_text !== null &&
      row.previous_updated_at !== null
        ? [{ key: row.key, text: row.previous_text, updated_at: row.previous_updated_at }]
        : [],
    ),
  );
}

/** Size affects presentation alone. Empty text clears a section without inventing another delete interface. */
export async function setManualSection(
  key: ManualKey,
  text: string,
): Promise<{
  readonly section: ManualSection;
  readonly characters: number;
  readonly words: number;
  readonly front_page_budget_characters: number;
  readonly over_front_page_budget: boolean;
}> {
  manualKey(key);
  if (typeof text !== 'string') throw new Error('Manual text must be text');
  const section = await getDb().transaction(async () => {
    const previous = await getManualSection(key);
    // A repeated save, such as a retry after a timeout, keeps the real previous value.
    if (previous?.text === text) return previous;
    const saved: ManualSection = { key, text, updated_at: new Date().toISOString() };
    await getDb().run(
      `INSERT INTO gws_ea_manual_sections (key, text, updated_at, previous_text, previous_updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET text=excluded.text, updated_at=excluded.updated_at,
         previous_text=excluded.previous_text, previous_updated_at=excluded.previous_updated_at`,
      key,
      text,
      saved.updated_at,
      previous?.text ?? null,
      previous?.updated_at ?? null,
    );
    return saved;
  });
  await signalManualChange();
  return {
    section,
    characters: text.length,
    words: text.match(/\S+/gu)?.length ?? 0,
    front_page_budget_characters: MANUAL_SECTION_BUDGET_CHARS,
    over_front_page_budget: text.length > MANUAL_SECTION_BUDGET_CHARS,
  };
}
