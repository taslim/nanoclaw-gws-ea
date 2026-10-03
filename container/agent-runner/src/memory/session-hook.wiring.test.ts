import { describe, expect, it } from 'bun:test';
import fs from 'fs';
import path from 'path';

describe('Claude memory hook wiring', () => {
  const providerSource = fs.readFileSync(path.join(import.meta.dir, '..', 'providers', 'claude.ts'), 'utf-8');
  const runnerSource = fs.readFileSync(path.join(import.meta.dir, '..', 'index.ts'), 'utf-8');
  const groupInitSource = fs.readFileSync(
    path.join(import.meta.dir, '..', '..', '..', '..', 'src', 'group-init.ts'),
    'utf-8',
  );

  it("passes the session's memory hook to Claude without a second SDK hook path", () => {
    expect(runnerSource).toMatch(/registerProviderMemorySessionHook\(providerName, provider, memoryHook\)/);
    // A sealed session archives no exchange through a provider's exchange hook.
    expect(runnerSource).toContain('if (sealed) delete provider.onExchangeComplete;');
    expect(providerSource).toMatch(
      /registerMemorySessionHook\(hook: MemorySessionHookRegistration, memory\?: unknown\)/,
    );
    expect(providerSource).not.toContain('memorySessionStartHook');
    expect(providerSource).not.toContain('providesMemorySessionHook');
    expect(groupInitSource).not.toContain('MEMORY_SESSION_START_MATCHER');
  });
});
