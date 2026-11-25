import { describe, expect, it } from 'vitest';

import {
  buildShardPlan,
  CHROME_HEAVY_FILES,
  loadTimings,
  parseShardSpec,
  SHELL_TEST_FILES,
  shardNeedsShells,
} from './ci-shard.js';

describe('ci-shard', () => {
  it('partitions every file into exactly one shard deterministically regardless of input order', () => {
    const files = [
      'src/a.test.ts',
      'src/b.test.ts',
      'src/c.test.ts',
      'src/d.test.ts',
      'src/e.test.ts',
      'src/f.test.ts',
    ];
    const timings = {
      'src/a.test.ts': 200_000,
      'src/b.test.ts': 120_000,
      'src/c.test.ts': 110_000,
      'src/d.test.ts': 80_000,
    };

    const plan1 = buildShardPlan(files, timings, 4);
    const plan2 = buildShardPlan([...files].reverse(), timings, 4);

    expect(plan1).toEqual(plan2);
    const flattened = plan1.shards.flat();
    expect(flattened).toHaveLength(files.length);
    expect(new Set(flattened)).toEqual(new Set(files));

    // Top 4 slowest files land on 4 distinct shards.
    for (const heavy of ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts']) {
      const shardsWithHeavy = plan1.shards.filter((shard) => shard.includes(heavy));
      expect(shardsWithHeavy).toHaveLength(1);
    }
    const heavyShardIndexes = ['src/a.test.ts', 'src/b.test.ts', 'src/c.test.ts', 'src/d.test.ts'].map((heavy) =>
      plan1.shards.findIndex((shard) => shard.includes(heavy)),
    );
    expect(new Set(heavyShardIndexes).size).toBe(4);
  });

  it('includes unknown/new test files with a positive default weight', () => {
    const plan = buildShardPlan(
      ['src/brand-new.test.ts', 'src/existing.test.ts'],
      { 'src/existing.test.ts': 5_000 },
      2,
    );
    expect(plan.shards.flat().sort()).toEqual(['src/brand-new.test.ts', 'src/existing.test.ts']);
    expect(plan.weightsMs[0]).toBeGreaterThan(0);
    expect(plan.weightsMs[1]).toBeGreaterThan(0);
  });

  it('detects shards that require external shell packages', () => {
    expect(shardNeedsShells(['src/other.test.ts'])).toBe(false);
    for (const file of SHELL_TEST_FILES) {
      expect(shardNeedsShells(['src/other.test.ts', file])).toBe(true);
    }
  });

  it('parses valid shard specs and rejects invalid ones', () => {
    expect(parseShardSpec('2/4')).toEqual({ index: 2, total: 4 });
    expect(() => parseShardSpec('0/4')).toThrow();
    expect(() => parseShardSpec('5/4')).toThrow();
    expect(() => parseShardSpec('abc')).toThrow();
  });

  it('loads the checked-in CI timings file cleanly and spreads Chrome-heavy suites evenly', () => {
    const timings = loadTimings();
    expect(Object.keys(timings).length).toBeGreaterThan(20);
    const chromeFiles = [...CHROME_HEAVY_FILES];
    const plan = buildShardPlan(chromeFiles, timings, 4);
    const counts = plan.shards.map((shard) => shard.length);
    expect(Math.max(...counts) - Math.min(...counts)).toBeLessThanOrEqual(1);
  });
});
