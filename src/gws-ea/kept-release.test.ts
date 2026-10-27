import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { keptReleaseFiles, readKeptHostEnvironment } from './kept-release.js';
import { writePrivateTextFile } from './secrets.js';

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

it('reads the retired artifacts policy key kept by a pre-web release', async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'kept-web-release-'));
  roots.push(root);
  const environment = { GWS_EA_ARTIFACTS_POLICY_FILE: '/instance/artifacts/policy.json' };
  await writePrivateTextFile(keptReleaseFiles(root).hostEnvironment, JSON.stringify(environment));
  expect(await readKeptHostEnvironment(root)).toEqual(environment);
});
