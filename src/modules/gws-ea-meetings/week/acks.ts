import { getDb } from '../../../db/connection.js';
import type { Finding, FindingAcknowledgement } from './checker.js';

export interface StoredAcknowledgement extends FindingAcknowledgement {
  readonly event_key: string;
  readonly kind: string;
  readonly acknowledged_at: string;
}
export async function acknowledgeFinding(finding: Finding): Promise<void> {
  await getDb().run(
    `INSERT INTO gws_ea_week_acknowledgements (finding_key,event_key,kind,version,acknowledged_at) VALUES (?,?,?,?,?) ON CONFLICT(finding_key,version) DO NOTHING`,
    finding.key,
    finding.eventKeys.join('|'),
    finding.kind,
    finding.version,
    new Date().toISOString(),
  );
}
export async function loadAcknowledgements(): Promise<StoredAcknowledgement[]> {
  return getDb().all<StoredAcknowledgement>(
    'SELECT finding_key AS key,event_key,kind,version,acknowledged_at FROM gws_ea_week_acknowledgements ORDER BY finding_key,version',
  );
}
