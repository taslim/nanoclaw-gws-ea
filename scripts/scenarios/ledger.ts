import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

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
  private readonly file: string;
  constructor(
    file: string,
    readonly capUsd: number,
  ) {
    if (!Number.isFinite(capUsd) || capUsd <= 0) throw new Error('A positive cost cap is required.');
    this.file = fs.existsSync(file)
      ? fs.realpathSync(file)
      : path.join(fs.realpathSync(path.dirname(file)), path.basename(file));
    this.exclusive(() => {
      if (fs.existsSync(this.file)) this.read();
      else this.save([]);
    });
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
        !Number.isFinite(entry.reservedUsd) ||
        entry.reservedUsd <= 0 ||
        !('startedAt' in entry) ||
        typeof entry.startedAt !== 'string' ||
        !('evidence' in entry) ||
        typeof entry.evidence !== 'string' ||
        !('status' in entry) ||
        !['reserved', 'completed', 'uncertain'].includes(String(entry.status))
      )
        throw new Error('Invalid ledger entry.');
      if (
        'actualUsd' in entry &&
        (typeof entry.actualUsd !== 'number' || !Number.isFinite(entry.actualUsd) || entry.actualUsd < 0)
      )
        throw new Error('Invalid persisted model cost.');
      const actualUsd = 'actualUsd' in entry ? (entry.actualUsd as number) : undefined;
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
    this.exclusive(() => {
      const entries = this.read();
      if (entries.some((entry) => entry.id === id)) throw new Error(`Attempt already reserved: ${id}`);
      const committed = entries.reduce((sum, entry) => sum + (entry.actualUsd ?? entry.reservedUsd), 0);
      if (committed + reservedUsd > this.capUsd + 1e-9)
        throw new Error(
          `Cost cap would be exceeded: ${committed.toFixed(4)} + ${reservedUsd.toFixed(4)} > ${this.capUsd.toFixed(4)}`,
        );
      entries.push({ id, model, reservedUsd, startedAt: new Date().toISOString(), status: 'reserved', evidence });
      this.save(entries);
    });
  }
  settle(id: string, actualUsd?: number): void {
    if (actualUsd !== undefined && (!Number.isFinite(actualUsd) || actualUsd < 0))
      throw new Error('Invalid reported model cost.');
    this.exclusive(() => {
      const entries = this.read();
      const index = entries.findIndex((entry) => entry.id === id);
      const entry = entries[index];
      if (!entry) throw new Error(`Unreserved call: ${id}`);
      entries[index] = {
        ...entry,
        status: actualUsd === undefined ? 'uncertain' : 'completed',
        actualUsd,
        completedAt: new Date().toISOString(),
      };
      this.save(entries);
    });
  }
  /** An uncertain or contested claim never admits inference, and is never reclaimed by guessing. */
  private exclusive<T>(work: () => T): T {
    const lock = `${this.file}.lock`;
    let descriptor: number;
    try {
      descriptor = fs.openSync(lock, 'wx', 0o600);
    } catch (error) {
      if (error instanceof Error && 'code' in error && error.code === 'EEXIST')
        throw new Error('Ledger is locked or its previous operation is uncertain; no budget was admitted.', {
          cause: error,
        });
      throw error;
    }
    const owned = fs.fstatSync(descriptor);
    let result!: T;
    let failed = false;
    let failure: unknown;
    try {
      result = work();
      // eslint-disable-next-line no-catch-all/no-catch-all -- release the owned claim before rethrowing the operation error
    } catch (error) {
      failed = true;
      failure = error;
    }
    try {
      fs.closeSync(descriptor);
      const current = fs.lstatSync(lock);
      if (current.ino !== owned.ino || current.dev !== owned.dev)
        throw new Error('Ledger lock ownership changed; retain the reservation as uncertain.');
      fs.unlinkSync(lock);
    } catch (error) {
      if (failed)
        throw new AggregateError(
          [failure, error],
          'Ledger operation and claim release failed; no budget is admitted.',
          { cause: error },
        );
      throw error;
    }
    if (failed) throw failure;
    return result;
  }

  private save(entries: readonly LedgerEntry[]): void {
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    const descriptor = fs.openSync(temporary, 'wx', 0o600);
    try {
      fs.writeFileSync(descriptor, JSON.stringify({ schemaVersion: 1, capUsd: this.capUsd, entries }, null, 2) + '\n');
      fs.fsyncSync(descriptor);
    } finally {
      fs.closeSync(descriptor);
    }
    try {
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), 'r');
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
    }
  }
}
