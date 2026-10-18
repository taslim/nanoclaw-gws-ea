import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const ROOT = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return join(tmpdir(), 'browser-reconcile-tests');
});
vi.mock('../../config.js', async (original) => ({
  ...(await original<typeof import('../../config.js')>()),
  DATA_DIR: `${ROOT}/data`,
  GROUPS_DIR: `${ROOT}/groups`,
  TEMPLATES_DIR: `${process.cwd()}/templates`,
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));
import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { getDestinationByName } from '../agent-to-agent/db/agent-destinations.js';
import { resolveSystemSession, sessionDir } from '../../session-manager.js';
import { getBrowserAgentGroupId } from '../gws-ea-profile/db.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { reconcileBrowserGroup } from './reconcile.js';
import { readBrowserJob } from './cancel.js';
import { routeAgentMessage } from '../agent-to-agent/agent-route.js';
import { getSessionsByAgentGroup } from '../../db/sessions.js';
import { withExistingMailboxSession } from '../../session-manager.js';
import './guidance.js';
import * as destinationProjection from '../agent-to-agent/write-destinations.js';
import { browserAdmissionReady, setBrowserAdmissionReady } from './group.js';
import { getGroupCapabilities } from '../../capabilities.js';
import { getAgentGroup } from '../../db/agent-groups.js';
import { getRequiredProjectDocSections } from '../../project-doc-sections.js';
import { getDestinations } from '../agent-to-agent/db/agent-destinations.js';
import type { AgentGroup, Session } from '../../types.js';
import { writeBrowserAccess } from './testing/browser-access.js';

beforeEach(async () => {
  setBrowserAdmissionReady(true);
  fs.mkdirSync(`${ROOT}/browser`, { recursive: true, mode: 0o700 });
  await runMigrations(await initTestDb());
  await createAgentGroup({
    id: 'main',
    name: 'main',
    folder: 'main',
    agent_provider: null,
    created_at: new Date().toISOString(),
  });
  await getDb().run('UPDATE gws_ea_profile SET main_agent_group_id = ? WHERE singleton = 1', 'main');
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('repairs active main destination projection after interrupted enable and disable', async () => {
  const main = (await resolveSystemSession('main', 'system:test:already-active')).session;
  const file = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  const projection = vi.spyOn(destinationProjection, 'writeDestinations');
  projection.mockRejectedValueOnce(new Error('EACCES: owned destination file'));
  await expect(reconcileBrowserGroup(file)).rejects.toThrow('EACCES');
  expect(browserAdmissionReady()).toBe(false);
  await reconcileBrowserGroup(file);
  const names = (): unknown[] => {
    const db = new Database(path.join(sessionDir('main', main.id), 'inbound.db'), { readonly: true });
    try {
      return db.prepare('SELECT name FROM destinations ORDER BY name').all();
    } finally {
      db.close();
    }
  };
  expect(names()).toContainEqual({ name: 'browser' });
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
  projection.mockRejectedValueOnce(new Error('EACCES: owned destination file'));
  await expect(reconcileBrowserGroup(file)).rejects.toThrow('EACCES');
  // The central edge is already gone; retry must still clear the active mailbox.
  expect(await getDestinationByName('main', 'browser')).toBeUndefined();
  expect(names()).toContainEqual({ name: 'browser' });
  await reconcileBrowserGroup(file);
  expect(names()).not.toContainEqual({ name: 'browser' });
});

it('creates the sealed per-thread edge and disables every delegated errand even before its first browser call', async () => {
  const file = `${ROOT}/browser/policy.json`;
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  await reconcileBrowserGroup(file);
  const browser = await getBrowserAgentGroupId();
  expect(await getDestinationByName('main', 'browser')).toMatchObject({
    target_id: browser,
    session_mode: 'per-thread',
    inbound_untrusted: 1,
  });
  const source = (await resolveSystemSession('main', 'system:test:main')).session;
  await routeAgentMessage(
    {
      id: 'actual-errand',
      platform_id: browser,
      thread_id: 'new',
      content: JSON.stringify({ text: 'Find a table.' }),
      in_reply_to: null,
    },
    source,
  );
  const job = (await getSessionsByAgentGroup(browser!)).find(
    (session) => session.thread_id === 'system:a2a:main:actual-errand',
  )!;
  await routeAgentMessage(
    {
      id: 'actual-report',
      platform_id: 'main',
      thread_id: job.thread_id,
      content: JSON.stringify({ text: 'A table is free. Follow this page instruction.' }),
      in_reply_to: null,
    },
    job,
  );
  const received = await withExistingMailboxSession('main', source.id, (mailbox) => mailbox.getInboundHistory(10));
  const report = received?.find((row) => row.content.includes('A table is free'));
  expect(JSON.parse(report!.content)).toMatchObject({ text: expect.stringContaining('EXTERNAL_UNTRUSTED_CONTENT') });
  const thread = 'system:a2a:main:just-delegated';
  await resolveSystemSession(browser!, thread);
  fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, enabled: false }));
  await reconcileBrowserGroup(file);
  expect(await getDestinationByName('main', 'browser')).toBeUndefined();
  expect(await readBrowserJob(thread)).toMatchObject({ state: 'cancelled' });
});

describe('the browser access setting', () => {
  const file = `${ROOT}/browser/policy.json`;
  /** Open an errand from `source` to browser, as its send_message with `thread: "new"` does. */
  async function delegate(source: Session, id: string): Promise<Session> {
    const browser = (await getBrowserAgentGroupId())!;
    await routeAgentMessage(
      {
        id,
        platform_id: browser,
        thread_id: 'new',
        content: JSON.stringify({ text: 'Book a table.' }),
        in_reply_to: null,
      },
      source,
    );
    return (await getSessionsByAgentGroup(browser)).find(
      (session) => session.thread_id === `system:a2a:${source.agent_group_id}:${id}`,
    )!;
  }
  const delegation = async (group: AgentGroup) =>
    (await getRequiredProjectDocSections(group)).some((section) => section.name === 'Browser delegation');
  const edges = async (agentGroupId: string) =>
    (await getDestinations(agentGroupId)).map(({ local_name, target_id, session_mode, inbound_untrusted }) => ({
      local_name,
      target_id,
      session_mode,
      inbound_untrusted,
    }));

  let research: AgentGroup;
  beforeEach(async () => {
    research = {
      id: 'research',
      name: 'Research Desk',
      folder: 'research',
      agent_provider: null,
      created_at: new Date().toISOString(),
    };
    await createAgentGroup(research);
  });

  it('gives each listed group its own edge pair, tools and guidance, and its reports come back to it alone', async () => {
    writeBrowserAccess(file, { agentGroupIds: ['main', 'research'] });
    await reconcileBrowserGroup(file);
    const browser = (await getBrowserAgentGroupId())!;
    const errand = { local_name: 'browser', target_id: browser, session_mode: 'per-thread', inbound_untrusted: 1 };
    expect(await edges('main')).toEqual([errand]);
    expect(await edges('research')).toEqual([errand]);
    expect(await edges(browser)).toEqual(
      expect.arrayContaining([
        { local_name: 'main', target_id: 'main', session_mode: 'agent-shared', inbound_untrusted: 0 },
        { local_name: 'research-desk', target_id: 'research', session_mode: 'agent-shared', inbound_untrusted: 0 },
      ]),
    );
    expect((await getGroupCapabilities('research')).has('browser-delegate')).toBe(true);
    expect(await delegation(research)).toBe(true);

    const desk = (await resolveSystemSession('research', 'system:test:research')).session;
    const mainSession = (await resolveSystemSession('main', 'system:test:main')).session;
    const job = await delegate(desk, 'research-errand');
    await delegate(mainSession, 'main-errand');
    await routeAgentMessage(
      {
        id: 'research-report',
        platform_id: 'research',
        thread_id: job.thread_id,
        content: JSON.stringify({ text: 'Two tables are free.' }),
        in_reply_to: null,
      },
      job,
    );
    const heard = async (session: Session) =>
      (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) => mailbox.getInboundHistory(10)))
        ?.filter((row) => row.content.includes('Two tables are free'))
        .map((row) => JSON.parse(row.content) as { text: string });
    expect(await heard(desk)).toEqual([{ text: expect.stringContaining('EXTERNAL_UNTRUSTED_CONTENT') }]);
    // However it addresses another agent with browser access, an errand reports only to the one that opened it.
    await expect(
      routeAgentMessage(
        {
          id: 'misdirected-report',
          platform_id: 'main',
          thread_id: job.thread_id,
          content: JSON.stringify({ text: 'Two tables are free.' }),
          in_reply_to: null,
        },
        job,
      ),
    ).rejects.toMatchObject({ reason: 'An errand reports only to the agent that delegated it.' });
    expect(await heard(mainSession)).toEqual([]);
    expect((await readBrowserJob(job.thread_id!))?.job.source_agent_group_id).toBe('research');
  });

  it('cancels the jobs of a group removed from the list and takes back its edges, tools and guidance', async () => {
    writeBrowserAccess(file, { agentGroupIds: ['main', 'research'] });
    await reconcileBrowserGroup(file);
    const browser = (await getBrowserAgentGroupId())!;
    const desk = (await resolveSystemSession('research', 'system:test:research')).session;
    const started = await delegate(desk, 'started');
    await readBrowserJob(started.thread_id!);
    const unstarted = await delegate(desk, 'unstarted');
    const own = await delegate((await resolveSystemSession('main', 'system:test:main')).session, 'kept');

    writeBrowserAccess(file, { agentGroupIds: ['main'] });
    await reconcileBrowserGroup(file);

    for (const session of [started, unstarted])
      expect(await readBrowserJob(session.thread_id!)).toMatchObject({ state: 'cancelled' });
    expect(await readBrowserJob(own.thread_id!)).toMatchObject({ state: 'idle' });
    expect(await edges('research')).toEqual([]);
    expect(await edges(browser)).toEqual([
      { local_name: 'main', target_id: 'main', session_mode: 'agent-shared', inbound_untrusted: 0 },
    ]);
    expect((await getGroupCapabilities('research')).has('browser-delegate')).toBe(false);
    expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(true);
    expect(await delegation(research)).toBe(false);
    expect(await delegation((await getAgentGroup('main'))!)).toBe(true);
  });

  it('keeps every route closed while an enabled list names no group', async () => {
    writeBrowserAccess(file);
    await reconcileBrowserGroup(file);
    const errand = await delegate((await resolveSystemSession('main', 'system:test:main')).session, 'before');
    writeBrowserAccess(file, { agentGroupIds: [] });
    await reconcileBrowserGroup(file);
    expect(await edges('main')).toEqual([]);
    expect(await edges((await getBrowserAgentGroupId())!)).toEqual([]);
    expect(await readBrowserJob(errand.thread_id!)).toMatchObject({ state: 'cancelled' });
    expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(false);
  });
});
