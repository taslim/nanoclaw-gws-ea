/** Incidents against a real central DB and real session DBs: recorded with their job's stop, told once. */
import fs from 'node:fs';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-browser-incident-tests') };
});
vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
  GROUPS_DIR: `${root}/groups`,
}));
vi.mock('../../container-runner.js', () => ({
  getContainerStartedAtMs: vi.fn(() => Date.now()),
  isContainerRunning: vi.fn(() => false),
  killContainer: vi.fn(),
  registerSessionAdmissionPolicy: vi.fn(),
  wakeContainer: vi.fn(async () => true),
}));
vi.mock('../../request-wake.js', () => ({ requestWake: vi.fn(async () => true) }));

import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { requestWake } from '../../request-wake.js';
import {
  resolveSession,
  resolveSystemSession,
  withExistingMailboxSession,
  writeSessionMessage,
} from '../../session-manager.js';
import type { Session } from '../../types.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import type { ConfirmationEvidence } from './confirmation.js';
import { BrowserStore, type BrowserJob } from './db.js';
import { notifyPendingIncidents, recordIncidentWithStop, stopForUnapprovedCommit } from './incidents.js';
import type { BrowserExecutionContext } from './queue.js';

const PRINCIPAL = 'gchat:users/principal';
const EVIDENCE: ConfirmationEvidence = {
  source: 'https://shop.example/reorder/submit',
  reference: 'SO-48213',
  charged: { amountMinor: 4200, currency: 'USD' },
  structured: true,
};

let main: Session;

async function policy(agentGroupIds?: readonly string[]): Promise<void> {
  fs.mkdirSync(`${root}/browser`, { recursive: true });
  fs.writeFileSync(
    `${root}/browser/policy.json`,
    JSON.stringify(
      agentGroupIds ? { schemaVersion: 2, enabled: true, agentGroupIds } : { schemaVersion: 1, enabled: true },
    ),
    { mode: 0o600 },
  );
}

/** A live errand that `source` opened, with its lazily created job. */
async function errand(source: string, name: string): Promise<{ session: Session; job: BrowserJob }> {
  const session = (await resolveSystemSession('browser-p', `system:a2a:${source}:${name}`)).session;
  const job = await new BrowserStore().jobForSession(session);
  if (!job) throw new Error('The errand was not admitted');
  return { session, job };
}

/** The request context an executor stops its job from. */
const context = (job: BrowserJob): BrowserExecutionContext =>
  ({ job, request: { id: `request-${job.id}` }, store: new BrowserStore() }) as unknown as BrowserExecutionContext;

/** What the host wrote into a session, oldest first. */
async function notes(session: Session): Promise<string[]> {
  return (
    (await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
      mailbox
        .getInboundHistory(20)
        .map((message) => (JSON.parse(message.content) as { text: string }).text)
        .reverse(),
    )) ?? []
  );
}

const incidents = () =>
  getDb().all<{ kind: string; site: string; job_id: string; notified_at: string | null }>(
    'SELECT kind, site, job_id, notified_at FROM gws_ea_browser_incidents ORDER BY created_at',
  );

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  await policy();
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', `${root}/browser/policy.json`);
  await runMigrations(await initTestDb());
  for (const id of ['main-p', 'browser-p', 'desk-p'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  await createMessagingGroup({
    id: 'mg-principal',
    channel_type: 'gchat',
    platform_id: 'spaces/principal',
    name: 'principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: new Date().toISOString(),
  });
  await reconcileGwsEaProfile({
    assistantDisplayName: 'Aya',
    assistantWorkspaceEmail: 'aya@example.test',
    principalDisplayName: 'Morgan',
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: 'main-p',
    principalEmails: ['morgan@example.test'],
  });
  await getDb().run('UPDATE gws_ea_profile SET browser_agent_group_id = ? WHERE singleton = 1', 'browser-p');
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: new Date().toISOString() });
  main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
  vi.mocked(requestWake).mockClear();
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/** The principal's direct message, through which main's notes reach them. */
async function principalReachable(): Promise<void> {
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal',
    resolved_at: new Date().toISOString(),
  });
  await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
}

describe('an unapproved commit', () => {
  it('is recorded with its job stop in one transaction and told to main at once, once', async () => {
    await principalReachable();
    const { job } = await errand('main-p', 'reorder');
    expect(await stopForUnapprovedCommit(context(job), { site: 'shop.example', evidence: EVIDENCE })).toEqual({
      site: 'shop.example',
      reference: 'SO-48213',
      charged: '$42.00',
    });
    expect(await incidents()).toEqual([
      { kind: 'unapproved_commit', site: 'shop.example', job_id: job.id, notified_at: expect.any(String) },
    ]);
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.id)).toEqual({
      cancelled: 1,
    });
    const told = await notes(main);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`Browser job ${job.id} was stopped`);
    expect(told[0]).toContain('$42.00');
    expect(told[0]).toContain('SO-48213');
    expect(vi.mocked(requestWake).mock.calls.some(([woken]) => woken.id === main.id)).toBe(true);
    // The same evidence again records nothing new and tells no one again.
    const again = await recordIncidentWithStop(new BrowserStore(), job.thread_id, {
      kind: 'unapproved_commit',
      site: 'shop.example',
      evidenceKey: `${EVIDENCE.source}#${EVIDENCE.reference}`,
      evidence: EVIDENCE,
    });
    expect(again.stop.status).toBe('already_cancelled');
    await notifyPendingIncidents();
    expect(await incidents()).toHaveLength(1);
    expect(await notes(main)).toHaveLength(1);
  });

  it('is told to another group with browser access in the session it delegated from, never main', async () => {
    await principalReachable();
    await policy(['main-p', 'desk-p']);
    const desk = (await resolveSession('desk-p', null, null, 'agent-shared')).session;
    const { session, job } = await errand('desk-p', 'restock');
    await writeSessionMessage('browser-p', session.id, {
      id: 'desk-delegation',
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: 'desk-p',
      channelType: 'agent',
      threadId: session.thread_id,
      content: JSON.stringify({ text: 'Reorder the aprons.' }),
      sourceSessionId: desk.id,
    });
    await stopForUnapprovedCommit(context(job), { site: 'shop.example', evidence: EVIDENCE });
    const told = await notes(desk);
    expect(told).toHaveLength(1);
    expect(told[0]).toContain(`Browser job ${job.id} was stopped`);
    expect(await notes(main)).toEqual([]);
    expect(vi.mocked(requestWake).mock.calls.some(([woken]) => woken.id === desk.id)).toBe(true);
  });

  it('keeps an incident whose notice could not go out, and the sweep tells of it once it can', async () => {
    const { job } = await errand('main-p', 'reorder');
    await stopForUnapprovedCommit(context(job), { site: 'shop.example', evidence: EVIDENCE });
    expect(await incidents()).toMatchObject([{ notified_at: null }]);
    expect(await notes(main)).toEqual([]);
    await principalReachable();
    await notifyPendingIncidents();
    expect(await incidents()).toMatchObject([{ notified_at: expect.any(String) }]);
    expect(await notes(main)).toHaveLength(1);
    await notifyPendingIncidents();
    expect(await notes(main)).toHaveLength(1);
  });

  it('refuses evidence that shows no charge', async () => {
    const { job } = await errand('main-p', 'rsvp');
    await expect(
      stopForUnapprovedCommit(context(job), {
        site: 'events.example',
        evidence: { ...EVIDENCE, charged: { amountMinor: 0, currency: 'USD' } },
      }),
    ).rejects.toThrow('A confirmation without a charge is no unapproved commit');
    expect(await incidents()).toEqual([]);
    expect(await getDb().get('SELECT cancelled FROM gws_ea_browser_jobs WHERE id = ?', job.id)).toEqual({
      cancelled: 0,
    });
  });
});
