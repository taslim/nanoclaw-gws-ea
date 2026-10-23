import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
vi.mock('../../log.js', () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));
import '../index.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { lookup } from '../../cli/registry.js';

let root: string | undefined;
afterEach(async () => {
  await closeDb();
  vi.unstubAllEnvs();
  if (root) await rm(root, { recursive: true, force: true });
});
it('observes only canonical main and explicitly selected live eligible authors, without mutating selection', async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'artifact-authors-'));
  const file = path.join(root, 'policy.json');
  const policy = {
    schemaVersion: 1,
    enabled: true,
    hostname: 'views.example.com',
    pathPrefix: '/aya',
    listenPort: 32123,
    accessIssuer: 'https://team.cloudflareaccess.com',
    accessAud: 'aud',
    cloudflare: { accountId: 'account', applicationId: 'app', operatorConfigFile: path.join(root, 'config.json') },
  };
  await writeFile(file, JSON.stringify(policy), { mode: 0o600 });
  vi.stubEnv('GWS_EA_ARTIFACTS_POLICY_FILE', file);
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of ['canonical', 'writer', 'retired', 'sealed', 'unselected', 'all']) {
    await createAgentGroup({ id, name: id, folder: id, created_at: now, agent_provider: null });
    await getDb().run(
      'INSERT INTO container_configs(agent_group_id,capabilities,updated_at) VALUES(?,?,?)',
      id,
      id === 'all' ? '"all"' : JSON.stringify(id === 'unselected' ? [] : ['artifacts']),
      now,
    );
  }
  await getDb().run(
    "UPDATE gws_ea_profile SET main_agent_group_id='canonical',assistant_first_name='Aya',principal_first_name='Morgan',browser_agent_group_id='sealed' WHERE singleton=1",
  );
  await createMessagingGroup({
    id: 'retired-chat',
    channel_type: 'gchat',
    platform_id: randomUUID(),
    name: null,
    is_group: 1,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await getDb().run(
    "INSERT INTO gws_ea_job_agents(agent_group_id,messaging_group_id,state,created_at,updated_at) VALUES('retired','retired-chat','retired',?,?)",
    now,
    now,
  );
  const before = await getDb().all('SELECT agent_group_id,capabilities FROM container_configs ORDER BY agent_group_id');
  const command = lookup('gws-ea-artifacts-author-groups');
  expect(command).toMatchObject({ hostOnly: true, access: 'hidden' });
  if (!command) throw new Error('Missing artifact author observation command');
  expect(await command.handler(command.parseArgs({}), { caller: 'host' })).toEqual({
    group_ids: ['canonical', 'writer'],
  });
  expect(
    await getDb().all('SELECT agent_group_id,capabilities FROM container_configs ORDER BY agent_group_id'),
  ).toEqual(before);
  await writeFile(file, JSON.stringify({ ...policy, enabled: false }));
  expect(await command.handler(command.parseArgs({}), { caller: 'host' })).toEqual({ group_ids: [] });
});
