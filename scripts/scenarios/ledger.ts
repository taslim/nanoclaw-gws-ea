import fs from 'node:fs';

interface LedgerEntry {
  readonly id: string;
  readonly reservedUsd: number;
  readonly actualUsd?: number;
}

/** A call that reports no cost keeps its reservation, so a run that died mid-flight still counts. */
export class CostLedger {
  constructor(
    private readonly file: string,
    readonly capUsd: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('A positive cost cap is required.');
  }

  private load(): LedgerEntry[] {
    if (!fs.existsSync(this.file)) return [];
    return (JSON.parse(fs.readFileSync(this.file, 'utf8')) as { entries: LedgerEntry[] }).entries;
  }

  private save(entries: readonly LedgerEntry[]): void {
    fs.writeFileSync(this.file, JSON.stringify({ capUsd: this.capUsd, entries }, null, 2) + '\n');
  }

  reserve(id: string, reservedUsd: number): void {
    const entries = this.load();
    const committed = entries.reduce((sum, entry) => sum + (entry.actualUsd ?? entry.reservedUsd), 0);
    if (committed + reservedUsd > this.capUsd + 1e-9)
      throw new Error(
        `Cost cap would be exceeded: ${committed.toFixed(2)} + ${reservedUsd.toFixed(2)} > ${this.capUsd.toFixed(2)}`,
      );
    this.save([...entries, { id, reservedUsd }]);
  }

  settle(id: string, actualUsd: number | undefined): void {
    if (actualUsd === undefined) return;
    this.save(this.load().map((entry) => (entry.id === id ? { ...entry, actualUsd } : entry)));
  }
}
