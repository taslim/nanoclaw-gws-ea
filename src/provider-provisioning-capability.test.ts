import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { providerProvisioningCapabilityDigest } from './provider-provisioning-capability.js';

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function write(root: string, relativePath: string, contents: string): Promise<void> {
  const file = path.join(root, relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, contents);
}

async function fixture(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'provider-capability-'));
  roots.push(root);
  await Promise.all([
    write(root, 'setup/providers/index.ts', "import './claude.js';\n"),
    write(root, 'setup/providers/registry.ts', 'export const registry = new Map();\n'),
    write(root, 'setup/providers/claude.ts', "export { auth } from './claude-auth.js';\n"),
    write(root, 'setup/providers/claude-auth.ts', "export const auth = 'v1';\n"),
    write(root, 'setup/providers/install.ts', "export const install = 'v1';\n"),
    write(root, 'setup/providers/skill-descriptor.ts', "export const skill = 'v1';\n"),
    write(root, 'setup/lib/bright-select.ts', 'export {};\n'),
    write(root, 'setup/lib/captured-token.ts', 'export {};\n'),
    write(root, 'setup/lib/inherit-script.ts', 'export {};\n'),
    write(root, '.claude/skills/add-onecli/scripts/install-claude.sh', '#!/bin/sh\n'),
    write(root, '.claude/skills/add-onecli/scripts/register-claude-token.sh', '#!/bin/sh\n'),
    write(root, 'setup/unrelated.ts', "export const unrelated = 'v1';\n"),
    write(root, 'src/provider-credential.ts', 'export interface Credential {}\n'),
  ]);
  return root;
}

describe('provider provisioning capability digest', () => {
  it('tracks provider authentication code without coupling unrelated setup behavior', async () => {
    const root = await fixture();
    const original = await providerProvisioningCapabilityDigest(root);

    await write(root, 'setup/unrelated.ts', "export const unrelated = 'v2';\n");
    await write(root, 'setup/providers/install.ts', "export const install = 'v2';\n");
    await write(root, 'setup/providers/skill-descriptor.ts', "export const skill = 'v2';\n");
    expect(await providerProvisioningCapabilityDigest(root)).toBe(original);

    await write(root, 'setup/providers/claude-auth.ts', "export const auth = 'v2';\n");
    expect(await providerProvisioningCapabilityDigest(root)).not.toBe(original);
  });

  it('tracks the Claude sign-in script and its executable dependencies', async () => {
    const root = await fixture();
    const original = await providerProvisioningCapabilityDigest(root);

    await write(root, '.claude/skills/add-onecli/scripts/install-claude.sh', '#!/bin/sh\nexit 1\n');
    expect(await providerProvisioningCapabilityDigest(root)).not.toBe(original);

    await write(root, '.claude/skills/add-onecli/scripts/install-claude.sh', '#!/bin/sh\n');
    await write(root, 'setup/lib/captured-token.ts', "export const parser = 'changed';\n");
    expect(await providerProvisioningCapabilityDigest(root)).not.toBe(original);
  });
});
