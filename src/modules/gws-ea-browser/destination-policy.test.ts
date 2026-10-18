import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createDestination } from '../agent-to-agent/db/agent-destinations.js';
import { assertWiringAdmitted } from '../../db/wiring-admission.js';
import '../gws-ea-profile/index.js';
import './destination-policy.js';

beforeEach(async () => {
  await runMigrations(await initTestDb());
  for (const id of ['main', 'browser', 'external'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await getDb().run(
    'UPDATE gws_ea_profile SET main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1',
    'main',
    'browser',
  );
});
afterEach(async () => {
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
});

it('admits only the two sealed main/browser edges with per-thread untrusted delegation', async () => {
  const row = {
    agent_group_id: 'main',
    local_name: 'browser',
    target_type: 'agent' as const,
    target_id: 'browser',
    created_at: new Date().toISOString(),
    session_mode: 'per-thread' as const,
    inbound_untrusted: 1 as const,
  };
  await createDestination(row);
  await createDestination({
    ...row,
    agent_group_id: 'browser',
    local_name: 'main',
    target_id: 'main',
    session_mode: 'agent-shared',
    inbound_untrusted: 0,
  });
  await expect(createDestination({ ...row, agent_group_id: 'external' })).rejects.toThrow(
    'only an agent with browser access may address browser',
  );
  await expect(
    createDestination({ ...row, agent_group_id: 'browser', local_name: 'external', target_id: 'external' }),
  ).rejects.toThrow('browser may address only the agents with browser access');
  await expect(createDestination({ ...row, local_name: 'unsafe', session_mode: 'agent-shared' })).rejects.toThrow(
    'per-thread',
  );
  await expect(createDestination({ ...row, local_name: 'trusted', inbound_untrusted: 0 })).rejects.toThrow('untrusted');
});

it('refuses direct channel wiring to the browser even from a trusted host caller', async () => {
  await expect(
    assertWiringAdmitted({
      operation: 'create',
      proposed: {
        id: 'browser-channel',
        messaging_group_id: 'principal-chat',
        agent_group_id: 'browser',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'all',
        ignored_message_policy: 'drop',
        session_mode: 'per-thread',
        priority: 0,
        created_at: new Date().toISOString(),
      },
    }),
  ).rejects.toThrow('delegated errand');
});

it('admits the edge pair of each group a version-2 list names, and no other', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'browser-destination-policy-'));
  try {
    fs.mkdirSync(path.join(root, 'browser'), { mode: 0o700 });
    const file = path.join(root, 'browser', 'policy.json');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 2, enabled: false, agentGroupIds: ['external'] }), {
      mode: 0o600,
    });
    process.env.GWS_EA_BROWSER_POLICY_FILE = file;
    const out = {
      agent_group_id: 'external',
      local_name: 'browser',
      target_type: 'agent' as const,
      target_id: 'browser',
      created_at: new Date().toISOString(),
      session_mode: 'per-thread' as const,
      inbound_untrusted: 1 as const,
    };
    await createDestination(out);
    await createDestination({
      ...out,
      agent_group_id: 'browser',
      local_name: 'external',
      target_id: 'external',
      session_mode: 'agent-shared',
      inbound_untrusted: 0,
    });
    await expect(createDestination({ ...out, agent_group_id: 'main' })).rejects.toThrow(
      'only an agent with browser access may address browser',
    );
    await expect(
      createDestination({ ...out, agent_group_id: 'browser', local_name: 'main', target_id: 'main' }),
    ).rejects.toThrow('browser may address only the agents with browser access');
    await expect(createDestination({ ...out, local_name: 'trusted-browser', inbound_untrusted: 0 })).rejects.toThrow(
      'untrusted',
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
