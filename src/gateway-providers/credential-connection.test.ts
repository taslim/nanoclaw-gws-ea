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
