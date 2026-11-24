import { describe, expect, it } from 'vitest';

import { resolveFinalToolUpdates, sorterVersion } from '../../../src/modules/gws-ea-connections/sort-rules.js';
import { APP_TOOL_SORT_CORPUS } from './corpus.js';
import { scoreSortCase, scoreSortSuite } from './score.js';

describe('app-tool-sort eval corpus and mechanical scorer', () => {
  it('covers all curated domains and adversarial cases with distinct tool names and hashes', () => {
    const ids = APP_TOOL_SORT_CORPUS.map((entry) => entry.id);
    expect(ids).toEqual(
      expect.arrayContaining([
        'food-ordering',
        'payments',
        'banking',
        'email',
        'calendars',
        'code-hosting',
        'issue-trackers',
        'notes',
        'online-stores',
        'generic-query',
        'dynamic-enums',
        'adversarial',
      ]),
    );
    for (const entry of APP_TOOL_SORT_CORPUS) {
      const names = new Set(entry.tools.map((tool) => tool.definition.name));
      expect(names.size, entry.id).toBe(entry.tools.length);
      expect(
        entry.tools.some((tool) => tool.expectation === 'must_ask'),
        entry.id,
      ).toBe(true);
    }
  });

  it('passes when every must_ask tool is ask_first and reports unnecessary asks without failing', () => {
    const food = APP_TOOL_SORT_CORPUS.find((entry) => entry.id === 'food-ordering')!;
    const updates = food.tools.map((item) => ({
      name: item.definition.name,
      definitionHash: item.definitionHash,
      label:
        item.definition.name === 'add_to_cart' || item.expectation === 'must_ask'
          ? ('ask_first' as const)
          : ('just_do' as const),
      source: 'sorter' as const,
      reason: 'Classified',
    }));
    const scored = scoreSortCase(food, updates);
    expect(scored.passed).toBe(true);
    expect(scored.missedMustAsk).toEqual([]);
    expect(scored.unnecessaryAsks.map((item) => item.name)).toEqual(['add_to_cart']);

    const suite = scoreSortSuite({
      model: 'claude-sonnet-4-6',
      sorterVersion: sorterVersion('claude-sonnet-4-6'),
      cases: [scored],
    });
    expect(suite.passed).toBe(true);
    expect(suite.unnecessaryAskCount).toBe(1);
    expect(suite.sorterVersion).toContain('@claude-sonnet-4-6');
  });

  it('fails immediately on a planted wrong just_do for a must_ask tool or a stale hash', () => {
    const banking = APP_TOOL_SORT_CORPUS.find((entry) => entry.id === 'banking')!;
    const expected = new Map(
      banking.tools.map((item) => [
        item.definition.name,
        { definitionHash: item.definitionHash, definition: item.definition },
      ]),
    );
    // Plant a wrong just_do on wire_funds (a must_ask tool without an English floor verb in its name).
    const planted = banking.tools.map((item) => ({
      name: item.definition.name,
      definitionHash: item.definitionHash,
      label:
        item.definition.name === 'wire_funds'
          ? ('just_do' as const)
          : item.expectation === 'must_ask'
            ? ('ask_first' as const)
            : ('just_do' as const),
      reason: 'Planted classification',
    }));
    const { updates } = resolveFinalToolUpdates(expected, planted);
    const scored = scoreSortCase(banking, updates);
    expect(scored.passed).toBe(false);
    expect(scored.missedMustAsk.map((item) => item.name)).toEqual(['wire_funds']);

    const suite = scoreSortSuite({
      model: 'test-model',
      sorterVersion: sorterVersion('test-model'),
      cases: [scored],
    });
    expect(suite.passed).toBe(false);
    expect(suite.missedMustAskCount).toBe(1);

    const missing = scoreSortCase(
      banking,
      updates.filter((item) => item.name !== 'freeze_card'),
    );
    expect(missing.passed).toBe(false);
    expect(missing.missingTools).toEqual(['freeze_card']);

    const staleHash = scoreSortCase(
      banking,
      updates.map((item) => (item.name === 'freeze_card' ? { ...item, definitionHash: 'stale-hash-000' } : item)),
    );
    expect(staleHash.passed).toBe(false);
    expect(staleHash.missingTools).toEqual(['freeze_card']);
  });
});
