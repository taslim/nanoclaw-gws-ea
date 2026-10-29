import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as config from '../config.js';
import '../providers/index.js';
import '../provider-contracts/index.js';
import { registerProviderMemorySessionHook } from '../provider-contracts/realize.js';
import { createProvider } from '../providers/factory.js';
import { MEMORY_SESSION_HOOK } from '../memory/session-hook.js';

const roots: string[] = [];
const original = process.env.CLAUDE_CONFIG_DIR;
afterEach(() => {
  spyOn(config, 'runnerCapabilities').mockRestore();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
  if (original === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = original;
});
describe('main-only week hook registration', () => {
  it('installs both hooks once for main and removes them for external-email and external-chat', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'week-registration-'));
    roots.push(root);
    process.env.CLAUDE_CONFIG_DIR = root;
    const capabilities = spyOn(config, 'runnerCapabilities').mockReturnValue(new Set(['gws-ea-main-context']));
    const provider = createProvider('claude');
    const register = () => registerProviderMemorySessionHook('claude', provider, MEMORY_SESSION_HOOK);
    register();
    register();
    const file = path.join(root, 'settings.json');
    const settings = JSON.parse(fs.readFileSync(file, 'utf8')) as {
      hooks: { UserPromptSubmit: unknown; SessionStart: readonly { hooks: readonly { command: string }[] }[] };
    };
    expect(settings.hooks.UserPromptSubmit).toEqual([
      { hooks: [{ type: 'command', command: 'bun /app/src/week-view/hook.ts', timeout: 10 }] },
    ]);
    expect(
      settings.hooks.SessionStart.filter((entry) => entry.hooks.some((hook) => hook.command.includes('week-view'))),
    ).toEqual([
      {
        matcher: 'startup|resume|clear|compact',
        hooks: [{ type: 'command', command: 'bun /app/src/week-view/hook.ts', timeout: 10 }],
      },
    ]);
    for (const role of ['gws-ea-external-email', 'gws-ea-external-chat']) {
      capabilities.mockReturnValue(new Set([role]));
      register();
      expect(fs.readFileSync(file, 'utf8')).not.toContain('week-view/hook.ts');
    }
  });
});
