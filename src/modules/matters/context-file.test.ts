import { describe, it, expect } from 'vitest';

import { PENDING_SECTION_HEADER, appendToPendingSection, sanitizePendingEntry } from './context-file.js';

describe('sanitizePendingEntry', () => {
  it('collapses newlines to single spaces', () => {
    expect(sanitizePendingEntry('line one\nline two\r\nline three')).toBe('line one line two line three');
  });

  it('escapes backticks to single quotes so code fences cannot smuggle structure', () => {
    expect(sanitizePendingEntry('see `injected ## Header`')).toBe("see 'injected ## Header'");
  });

  it('strips leading markdown headers so an entry cannot become a sibling section', () => {
    expect(sanitizePendingEntry('# Pending fake header')).toBe('Pending fake header');
    expect(sanitizePendingEntry('### nested')).toBe('nested');
  });

  it('trims whitespace', () => {
    expect(sanitizePendingEntry('   padded   ')).toBe('padded');
  });

  it('returns empty string for whitespace-only input', () => {
    expect(sanitizePendingEntry('   \n  \n  ')).toBe('');
  });
});

describe('appendToPendingSection', () => {
  const line = '- 2026-05-02T12:00:00Z [ag-1 session=s-1] — agent saw something';

  it('creates the section when the body is null', () => {
    const result = appendToPendingSection(null, line);
    expect(result).toBe(`${PENDING_SECTION_HEADER}\n${line}\n`);
  });

  it('creates the section when the body is empty', () => {
    const result = appendToPendingSection('', line);
    expect(result).toBe(`${PENDING_SECTION_HEADER}\n${line}\n`);
  });

  it('appends the section after existing content when no Pending exists', () => {
    const body = '# Title\n\n## Log\n- 2026-05-01 — earlier event\n';
    const result = appendToPendingSection(body, line);
    expect(result).toBe(`# Title\n\n## Log\n- 2026-05-01 — earlier event\n\n${PENDING_SECTION_HEADER}\n${line}\n`);
  });

  it('appends to an existing trailing Pending section', () => {
    const body = `# Title\n\n${PENDING_SECTION_HEADER}\n- earlier pending\n`;
    const result = appendToPendingSection(body, line);
    expect(result).toBe(`# Title\n\n${PENDING_SECTION_HEADER}\n- earlier pending\n${line}\n`);
  });

  it('inserts inside an existing mid-file Pending section without disturbing later sections', () => {
    const body = `${PENDING_SECTION_HEADER}\n- earlier pending\n\n## Log\n- 2026-05-01 — later\n`;
    const result = appendToPendingSection(body, line);
    expect(result).toBe(`${PENDING_SECTION_HEADER}\n- earlier pending\n${line}\n\n## Log\n- 2026-05-01 — later\n`);
  });

  it('preserves Decisions and Log sections when appending Pending fresh', () => {
    const body = '# Title\n\n## Decisions / instructions\n- principal said X\n\n## Log\n- did Y\n';
    const result = appendToPendingSection(body, line);
    expect(result).toContain('## Decisions / instructions');
    expect(result).toContain('## Log');
    expect(result).toContain(PENDING_SECTION_HEADER);
    expect(result.endsWith(`${line}\n`)).toBe(true);
  });
});
