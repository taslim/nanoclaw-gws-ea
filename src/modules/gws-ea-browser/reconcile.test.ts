import * as availability from './availability.js';
import { BrowserStore } from './db.js';
import { useAvailableBrowser } from './testing/browser-runtime.js';
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
import { configureBrowserAccess } from './testing/browser-access.js';

beforeEach(async () => {
  useAvailableBrowser();
  vi.stubEnv('GWS_EA_BROWSER_ROOT', `${ROOT}/browser`);
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
  await getDb().run(
    `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ? WHERE singleton = 1`,
    'main',
  );
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  delete process.env.GWS_EA_BROWSER_ROOT;
  vi.restoreAllMocks();
  await closeDb();
  fs.rmSync(ROOT, { recursive: true, force: true });
});

it('repairs active main destination projection after interrupted configuration changes', async () => {
  const main = (await resolveSystemSession('main', 'system:test:already-active')).session;
  const file = `${ROOT}/browser`;

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
  vi.stubEnv('GWS_EA_BROWSER_ROOT', '');
  projection.mockRejectedValueOnce(new Error('EACCES: owned destination file'));
  await expect(reconcileBrowserGroup()).rejects.toThrow('EACCES');
  // The central edge is already gone; retry must still clear the active mailbox.
  expect(await getDestinationByName('main', 'browser')).toBeUndefined();
  expect(names()).toContainEqual({ name: 'browser' });
  await reconcileBrowserGroup();
  expect(names()).not.toContainEqual({ name: 'browser' });
});

it('creates the sealed per-thread edge and cancels every delegated errand when the root is unconfigured even before its first browser call', async () => {
  await reconcileBrowserGroup();
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
  vi.stubEnv('GWS_EA_BROWSER_ROOT', '');
  await reconcileBrowserGroup();
  expect(await getDestinationByName('main', 'browser')).toBeUndefined();
  expect(await readBrowserJob(thread)).toMatchObject({ state: 'cancelled' });
});

describe('stored browser delegation grants', () => {
  const file = `${ROOT}/browser`;
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

  it('gives each explicitly granted group its own edge pair, tools and guidance, and its reports come back to it alone', async () => {
    await configureBrowserAccess(file, ['main', 'research']);
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

  it('cancels the jobs of a group whose grant is revoked and takes back its edges, tools and guidance', async () => {
    await configureBrowserAccess(file, ['main', 'research']);
    await reconcileBrowserGroup(file);
    const browser = (await getBrowserAgentGroupId())!;
    const desk = (await resolveSystemSession('research', 'system:test:research')).session;
    const started = await delegate(desk, 'started');
    await readBrowserJob(started.thread_id!);
    const unstarted = await delegate(desk, 'unstarted');
    const own = await delegate((await resolveSystemSession('main', 'system:test:main')).session, 'kept');

    await configureBrowserAccess(file, ['main']);
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

  it('keeps main available when no optional group is granted', async () => {
    await configureBrowserAccess(file);
    await reconcileBrowserGroup(file);
    const errand = await delegate((await resolveSystemSession('main', 'system:test:main')).session, 'before');
    await configureBrowserAccess(file, []);
    await reconcileBrowserGroup(file);
    expect(await edges('main')).toHaveLength(1);
    expect(await readBrowserJob(errand.thread_id!)).toMatchObject({ state: 'idle' });
    expect((await getGroupCapabilities('main')).has('browser-delegate')).toBe(true);
  });
});

it('retains destinations and errands when Chrome disappears, and refuses the next delegation with its fix', async () => {
  await reconcileBrowserGroup();
  const browser = (await getBrowserAgentGroupId())!;
  const source = (await resolveSystemSession('main', 'system:test:main')).session;
  const errand = (await resolveSystemSession(browser, 'system:a2a:main:existing')).session;
  const store = new BrowserStore();
  const job = await store.jobForSession(errand);
  expect(job).toBeDefined();
  vi.spyOn(availability, 'browserAvailability').mockResolvedValue({ available: false, reason: 'chrome-missing' });
  await reconcileBrowserGroup();
  expect(await getDestinationByName('main', 'browser')).toMatchObject({ target_id: browser });
  expect(await store.getJob(job!.id)).toMatchObject({ cancelled: 0 });
  await expect(
    routeAgentMessage(
      {
        id: 'missing-chrome',
        platform_id: browser,
        thread_id: 'new',
        content: JSON.stringify({ text: 'Find a table.' }),
        in_reply_to: null,
      },
      source,
    ),
  ).rejects.toMatchObject({ reason: expect.stringMatching(/Chrome.*ask your operator/u) });
});
