import { describe, expect, it } from 'vitest';

import type { AgentGroup } from './types.js';
import { getRequiredProjectDocSections, registerRequiredProjectDocSection } from './project-doc-sections.js';

const group = (id: string): AgentGroup => ({
  id,
  name: id,
  folder: id,
  agent_provider: null,
  created_at: '2026-09-18T00:00:00.000Z',
});

describe('required project-document sections', () => {
  it('collects applicable sections in registration order without adding defaults', async () => {
    expect(await getRequiredProjectDocSections(group('ag-unmatched'))).toEqual([]);

    registerRequiredProjectDocSection('test:first', (candidate) =>
      candidate.id === 'ag-target' ? { name: 'First', body: 'first body' } : undefined,
    );
    registerRequiredProjectDocSection('test:second', (candidate) =>
      candidate.id === 'ag-target' ? { name: 'Second', body: 'second body' } : undefined,
    );

    await expect(getRequiredProjectDocSections(group('ag-target'))).resolves.toEqual([
      { name: 'First', body: 'first body' },
      { name: 'Second', body: 'second body' },
    ]);
    await expect(getRequiredProjectDocSections(group('ag-other'))).resolves.toEqual([]);
  });

  it('rejects duplicate provider identities', () => {
    registerRequiredProjectDocSection('test:duplicate', () => undefined);

    expect(() => registerRequiredProjectDocSection('test:duplicate', () => undefined)).toThrow(/already registered/i);
  });
});
