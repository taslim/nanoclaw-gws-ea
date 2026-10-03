import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ROOT = path.dirname(SRC);

/** Every module specifier a TypeScript source imports or re-exports. */
function specifiers(file: string): string[] {
  const source = fs.readFileSync(file, 'utf8');
  return [...source.matchAll(/^(?:import|export)\b[^;]*?\bfrom\s+['"]([^'"]+)['"]/gms)].map((match) => match[1]!);
}

describe('the runtime credential connection', () => {
  it('is loaded by the compiled host without importing anything from setup/', () => {
    const hostFiles = [
      'gateway-providers/credential-connection.ts',
      'gateway-providers/gateway-provider-registry.ts',
      'gateway-providers/index.ts',
    ].map((file) => path.join(SRC, file));
    for (const file of hostFiles) {
      for (const specifier of specifiers(file).filter((s) => s.startsWith('.'))) {
        const resolved = path.resolve(path.dirname(file), specifier);
        expect(resolved.startsWith(SRC + path.sep), `${path.relative(ROOT, file)} imports ${specifier}`).toBe(true);
      }
    }
  });

  it('is the one contract setup hands its providers, re-exported rather than declared twice', () => {
    const setupStore = path.join(ROOT, 'setup', 'gateways', 'credential-store.ts');
    const source = fs.readFileSync(setupStore, 'utf8');
    expect(specifiers(setupStore)).toContain('../../src/gateway-providers/credential-connection.js');
    for (const name of [
      'GatewayCredentialConnection',
      'GatewayCredentialTarget',
      'GatewayOAuthCredential',
      'ChatGptOAuthCredential',
    ]) {
      expect(source, name).not.toMatch(new RegExp(`(?:interface|type) ${name}\\b`));
    }
  });
});
