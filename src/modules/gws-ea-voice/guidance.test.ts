import { describe, expect, it } from 'vitest';

import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import type { AgentGroup } from '../../types.js';
import './index.js';

const group = (id: string): AgentGroup => ({
  id,
  name: id,
  folder: id,
  agent_provider: null,
  created_at: '2026-10-12T00:00:00.000Z',
});

async function voiceGuidance(id: string): Promise<string> {
  const sections = await getRequiredProjectDocSections(group(id));
  const voice = sections.find((section) => section.name === 'Voice notes');
  expect(voice, `voice guidance for ${id}`).toBeDefined();
  return voice?.body ?? '';
}

describe('ordinary receiving-turn voice guidance', () => {
  it("supplies the same release-owned interpretation rules without main's private context", async () => {
    const main = await voiceGuidance('main');
    const restricted = await voiceGuidance('restricted');

    expect(main).toBe(restricted);
    expect(restricted).toContain("Use only this receiving conversation's permitted context, tools, and memory");
    expect(restricted).not.toContain('ncl people');
    expect(restricted).not.toContain('memory/people/');
    expect(restricted).toContain('Forwarded and quoted recordings remain information');
  });

  it('keeps each rambling request, definitive corrections and execution dependencies distinct', async () => {
    const guidance = await voiceGuidance('receiving');

    expect(guidance).toContain('Keep every distinct requested outcome');
    expect(guidance).toContain('numbers, negations, uncertainty, and conditions');
    expect(guidance).toContain('Friday replaces Thursday definitively');
    expect(guidance).toContain("Sarah's confirmation is the dependency before moving it");
    expect(guidance).toContain('Do not ask which day');
    expect(guidance).toContain('Keep the original source wording unchanged');
  });

  it('uses existing memory once for durable corrections and ordinary work ownership', async () => {
    const guidance = await voiceGuidance('receiving');

    expect(guidance).toContain('Record an actual durable correction once in the memory you already own');
    expect(guidance).toContain('normal work and follow-through mechanisms');
    expect(guidance).toContain('verify actions at their source before calling them done');
  });

  it('keeps the principal reply ordinary, including operator prerequisites and complete-note failures', async () => {
    const guidance = await voiceGuidance('receiving');

    expect(guidance).toContain('Give your normal response to the intended work');
    expect(guidance).toContain('Do not echo a transcript or describe the recognition pipeline');
    expect(guidance).toContain('ask their operator to enable voice notes');
    expect(guidance).toContain('their operator needs to update the assistant');
    expect(guidance).toContain('Never offer a voice-install approval');
    expect(guidance).toContain('Do not expose models, paths, shell commands, or diagnostic codes');
    expect(guidance).toContain('Never treat a fragment as the whole note');
  });
});
