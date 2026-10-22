/**
 * The product a release is: every GWS-EA host module, the Google Chat channel
 * among them (it registers from `gws-ea-chat`, not the channel barrel), and
 * the OneCLI gateway are composed into this tree. A release is the tool's
 * own clean commit, so this is a property of the commit, checked here once
 * rather than at every create and update. Derived from the tree, so adding a
 * module needs no list edit. Both product templates, and the agent each
 * stamps, are the template guard's (`src/templates/gws-ea-main.test.ts`).
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

  it('composes the principal chat channels from their modules, and the OneCLI gateway', async () => {
    expect(imports(await read('src/modules/index.ts'), 'gws-ea-chat/index')).toBe(true);
    expect(imports(await read('src/modules/index.ts'), 'gws-ea-whatsapp/index')).toBe(true);
    expect(imports(await read('src/channels/index.ts'), 'gchat')).toBe(false);
    expect(imports(await read('src/channels/index.ts'), 'whatsapp')).toBe(false);
    expect(imports(await read('src/gateway-providers/index.ts'), 'installed')).toBe(true);
    expect(imports(await read('src/gateway-providers/installed.ts'), 'onecli')).toBe(true);
  });

  it('keeps optional voice installation out of package, image, create, and ordinary update', async () => {
    const packageJson: unknown = JSON.parse(await read('package.json'));
    expect(JSON.stringify(packageJson)).not.toMatch(/whisper\.cpp|ffmpeg|ggml-(base|small|large)/u);
    expect(await read('container/Dockerfile')).not.toMatch(/whisper|ggml-|install-voice/u);
    for (const file of ['src/gws-ea/provision.ts', 'src/gws-ea/update.ts', 'src/gws-ea/rollback.ts']) {
      expect(await read(file), file).not.toMatch(
        /installVoiceAssets|installLocalVoice|voiceModelUrl|install-voice\.js/u,
      );
    }
  });
});
