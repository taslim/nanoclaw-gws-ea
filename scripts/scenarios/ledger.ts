import fs from 'node:fs';

export interface LedgerEntry {
  readonly id: string;
  readonly model: string;
  readonly reservedUsd: number;
  readonly startedAt: string;
  readonly actualUsd?: number;
  readonly completedAt?: string;
  readonly status: 'reserved' | 'completed' | 'uncertain';
  readonly evidence: string;
}

export class CostLedger {
  private entries: LedgerEntry[];
  constructor(
    private readonly file: string,
    readonly capUsd: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('A positive cost cap is required.');
    this.entries = fs.existsSync(file) ? this.read() : [];
    this.save();
  }
  private read(): LedgerEntry[] {
    const stored: unknown = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    if (
      typeof stored !== 'object' ||
      stored === null ||
      !('capUsd' in stored) ||
      stored.capUsd !== this.capUsd ||
      !('entries' in stored) ||
      !Array.isArray(stored.entries)
    )
      throw new Error('Ledger cap or format differs. Use a new evidence directory.');
    return stored.entries.map((entry: unknown) => {
      if (
        typeof entry !== 'object' ||
        entry === null ||
        !('id' in entry) ||
        typeof entry.id !== 'string' ||
        !('model' in entry) ||
        typeof entry.model !== 'string' ||
        !('reservedUsd' in entry) ||
        typeof entry.reservedUsd !== 'number' ||
        !('startedAt' in entry) ||
        typeof entry.startedAt !== 'string' ||
        !('evidence' in entry) ||
        typeof entry.evidence !== 'string' ||
        !('status' in entry) ||
        !['reserved', 'completed', 'uncertain'].includes(String(entry.status))
      )
        throw new Error('Invalid ledger entry.');
      const actualUsd = 'actualUsd' in entry && typeof entry.actualUsd === 'number' ? entry.actualUsd : undefined;
      return {
        id: entry.id,
        model: entry.model,
        reservedUsd: entry.reservedUsd,
        startedAt: entry.startedAt,
        evidence: entry.evidence,
        status: entry.status as LedgerEntry['status'],
        ...('completedAt' in entry && typeof entry.completedAt === 'string' ? { completedAt: entry.completedAt } : {}),
        ...(actualUsd === undefined ? {} : { actualUsd }),
      };
    });
  }
  reserve(id: string, model: string, reservedUsd: number, evidence: string): void {
    if (!Number.isFinite(reservedUsd) || reservedUsd <= 0) throw new Error('Reservation must be positive.');
    if (this.entries.some((entry) => entry.id === id)) throw new Error(`Attempt already reserved: ${id}`);
    const committed = this.entries.reduce((sum, entry) => sum + (entry.actualUsd ?? entry.reservedUsd), 0);
    if (committed + reservedUsd > this.capUsd + 1e-9)
      throw new Error(
        `Cost cap would be exceeded: ${committed.toFixed(4)} + ${reservedUsd.toFixed(4)} > ${this.capUsd.toFixed(4)}`,
      );
    this.entries.push({ id, model, reservedUsd, startedAt: new Date().toISOString(), status: 'reserved', evidence });
    this.save();
  }
  settle(id: string, actualUsd?: number): void {
    if (actualUsd !== undefined && (!Number.isFinite(actualUsd) || actualUsd < 0))
      throw new Error('Invalid reported model cost.');
    const index = this.entries.findIndex((entry) => entry.id === id);
    const entry = this.entries[index];
    if (!entry) throw new Error(`Unreserved call: ${id}`);
    this.entries[index] = {
      ...entry,
      status: actualUsd === undefined ? 'uncertain' : 'completed',
      actualUsd,
      completedAt: new Date().toISOString(),
    };
    this.save();
  }
  private save(): void {
    fs.writeFileSync(
      this.file,
      JSON.stringify({ schemaVersion: 1, capUsd: this.capUsd, entries: this.entries }, null, 2) + '\n',
    );
  }
}
