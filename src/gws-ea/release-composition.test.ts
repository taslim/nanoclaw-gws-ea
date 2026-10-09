/**
 * The product a release is: every GWS-EA host module, the Google Chat channel,
 * the OneCLI gateway, and both product templates are composed into this tree.
 * A release is the tool's own clean commit, so this is a property of the
 * commit, checked here once rather than at every create and update. Derived
 * from the tree, so adding a module needs no list edit.
 */
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

import { CONTROL_PLANE_ROOT } from './paths.js';

const read = (relativePath: string): Promise<string> => readFile(path.join(CONTROL_PLANE_ROOT, relativePath), 'utf8');

function imports(barrel: string, moduleName: string): boolean {
  return barrel.split('\n').some((line) => line.trim() === `import './${moduleName}.js';`);
}

describe('release composition', () => {
  it('composes every GWS-EA host module into the module barrel', async () => {
    const modules = (await readdir(path.join(CONTROL_PLANE_ROOT, 'src/modules'), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && entry.name.startsWith('gws-ea-'))
      .map((entry) => entry.name);
    expect(modules.length).toBeGreaterThan(0);
    const barrel = await read('src/modules/index.ts');
    expect(modules.filter((name) => !imports(barrel, `${name}/index`))).toEqual([]);
    expect(imports(barrel, 'capabilities/index')).toBe(true);
  });

  it('composes the Google Chat channel and the OneCLI gateway', async () => {
    expect(imports(await read('src/channels/index.ts'), 'gchat')).toBe(true);
    expect(imports(await read('src/gateway-providers/index.ts'), 'installed')).toBe(true);
    expect(imports(await read('src/gateway-providers/installed.ts'), 'onecli')).toBe(true);
  });

  it.each(['main', 'external-email'] as const)('ships the %s template stamping exactly that agent', async (agent) => {
    const template = JSON.parse(await read(`templates/gws-ea/${agent}/plugin.json`)) as {
      name?: unknown;
      extensions?: { 'ai.nanoco.nanoclaw'?: { agentName?: unknown } };
    };
    expect(template.name).toBe(`gws-ea-${agent}`);
    expect(template.extensions?.['ai.nanoco.nanoclaw']?.agentName).toBe(agent);
  });
});
