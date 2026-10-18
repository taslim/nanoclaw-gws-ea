/** The principal's side of the consent engine: real approvals, delivery, central DB and mailbox. Only the container wake is mocked. */
import fs from 'node:fs';
import Database from 'better-sqlite3';
import type { Locator, Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
const { root } = await vi.hoisted(async () => {
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return { root: join(tmpdir(), 'nanoclaw-browser-consent-tests') };
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
import type { ResponseFrame } from '../../cli/frame.js';
import { closeDb, createAgentGroup, createMessagingGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { createPendingApproval } from '../../db/sessions.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../delivery.js';
import { inboundDbPath } from '../../mailbox/sqlite/paths.js';
import { resolveSession, resolveSystemSession, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { sweepExpiredApprovals } from '../approvals/index.js';
import { handleApprovalsResponse, resumeApprovedApprovals } from '../approvals/response-handler.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../gws-ea-profile/db.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { recordConsentStops, runConsentPass } from './consent.js';
import { BrowserStore, browserRequestId, type BrowserJob } from './db.js';
import { setBrowserAdmissionReady } from './group.js';
import { CONSENT, openWebFixture, type OpenWebFixture } from './open-web-native-fixture.js';
import { BrowserQueue } from './queue.js';
import { ERRAND_ORIGIN_LINE } from './cards.js';

const PRINCIPAL = 'gchat:users/principal';
const OPERATOR = 'gchat:users/operator';
const WORDING = 'I agree to receive marketing';
const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
let session: Session;
let main: Session;
let job: BrowserJob;
let queue: BrowserQueue;
let sent: Array<{ platformId: string; content: string }>;
let page: Page | undefined;
let requests = 0;

beforeEach(async () => {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/browser`, { recursive: true });
  fs.writeFileSync(`${root}/browser/policy.json`, JSON.stringify({ schemaVersion: 1, enabled: true }), { mode: 0o600 });
  process.env.GWS_EA_BROWSER_POLICY_FILE = `${root}/browser/policy.json`;
  await runMigrations(await initTestDb());
  for (const id of ['main-p', 'browser-p', 'other-p'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
  for (const who of ['principal', 'operator'])
    await createMessagingGroup({
      id: `mg-${who}`,
      channel_type: 'gchat',
      platform_id: `spaces/${who}`,
      name: who,
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
  for (const [id, who] of [
    [PRINCIPAL, 'principal'],
    [OPERATOR, 'operator'],
  ]) {
    await upsertUser({ id, kind: 'gchat', display_name: who, created_at: new Date().toISOString() });
    await upsertUserDm({
      user_id: id,
      channel_type: 'gchat',
      messaging_group_id: `mg-${who}`,
      resolved_at: new Date().toISOString(),
    });
  }
  await bindVerifiedPrincipalUser(PRINCIPAL, new Date().toISOString());
  main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
  session = (await resolveSystemSession('browser-p', 'system:a2a:main-p:join')).session;
  const created = await new BrowserStore().jobForSession(session);
  if (!created) throw new Error('Browser job missing');
  job = created;
  sent = [];
  setDeliveryAdapter({
    async deliver(_type, platformId, _thread, _kind, content) {
      sent.push({ platformId, content });
      return `message-${sent.length}`;
    },
  });
  queue = new BrowserQueue(new BrowserStore(), {
    pageForJob: async (): Promise<never> => {
      throw new Error('A consent request never opens the page');
    },
    connection: async (): Promise<never> => {
      throw new Error('Not used');
    },
    closeJob: async () => undefined,
    onDisconnected: () => () => undefined,
  });
  await queue.start();
  setBrowserAdmissionReady(true);
});
afterEach(async () => {
  setBrowserAdmissionReady(false);
  await queue?.stop();
  await page?.context().close();
  page = undefined;
  delete process.env.GWS_EA_BROWSER_POLICY_FILE;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
});

/** A stop the engine recorded for this job's signup form, on a site and in the frame origin that served it. */
async function stop(
  wording = WORDING,
  jobId = job.id,
  site = 'join.example',
  origin = 'https://join.example',
): Promise<string> {
  const [view] = await recordConsentStops(
    { jobId, db: getDb() },
    {
      site,
      origin,
      fingerprint: 'join-form',
      items: [{ id: 0, wording, kind: 'marketing' }],
    },
  );
  if (!view?.stop_id) throw new Error('Stop missing');
  return view.stop_id;
}
/** The browser agent's request_consent, through native delivery and the job's queue, as its tool sends it. */
async function ask(stopId: string, requestId: string, from = session): Promise<Record<string, unknown> | undefined> {
  await queue.accept('request_consent', { stop_id: stopId }, from, requestId);
  await queue.idle();
  const row = await queue.store.request(browserRequestId(from.id, requestId));
  if (!row?.answer_json) return undefined;
  const frame = JSON.parse(row.answer_json) as { ok: boolean; data?: Record<string, unknown> };
  return frame.data;
}
/** Main's consent_grants tool: one request through native delivery, and the host's one answer in the caller's inbound mailbox. */
async function manageGrants(from: Session, fields: Record<string, unknown>): Promise<ResponseFrame> {
  const requestId = `grants-${++requests}`;
  await getDeliveryAction('consent_grants')!({ ...fields, action: 'consent_grants', requestId }, from);
  const db = new Database(inboundDbPath(from.agent_group_id, from.id), { readonly: true });
  try {
    const row = db.prepare('SELECT content FROM messages_in WHERE id = ?').get(`action-resp-${requestId}`) as {
      content: string;
    };
    return (JSON.parse(row.content) as { frame: ResponseFrame }).frame;
  } finally {
    db.close();
  }
}
async function approvals(): Promise<PendingApproval[]> {
  return getDb().all('SELECT * FROM pending_approvals ORDER BY created_at');
}
async function click(approval: PendingApproval, value = 'approve', userId = PRINCIPAL): Promise<void> {
  await handleApprovalsResponse({
    questionId: approval.approval_id,
    value,
    userId,
    channelType: 'gchat',
    platformId: 'spaces/principal',
    threadId: null,
  });
}
const grants = () =>
  getDb().all<{
    id: string;
    site: string;
    origin: string;
    wording: string;
    approval_id: string;
    principal_user_id: string;
  }>(
    'SELECT id,site,origin,wording,approval_id,principal_user_id FROM gws_ea_browser_consent_grants WHERE withdrawn_at IS NULL',
  );
const stopStatus = async (id: string) =>
  (await getDb().get<{ status: string }>('SELECT status FROM gws_ea_browser_consent_stops WHERE id = ?', id))?.status;
/** The job's consent notices, as its conversation receives them. */
async function notices(): Promise<Array<Record<string, unknown>>> {
  const rows = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
    mailbox.getInboundHistory(100),
  );
  return (rows ?? []).flatMap((row) => {
    const text = (JSON.parse(row.content) as { text?: string }).text;
    const event = text?.includes('browser_consent_outcome') ? (JSON.parse(text) as Record<string, unknown>) : undefined;
    return event ? [event] : [];
  });
}

describe('asking the principal for consent', () => {
  it('posts one card naming the site and the exact wording; approval stands as the principal’s grant and tells the job', async () => {
    const id = await stop();
    expect(await ask(id, 'consent-1')).toMatchObject({ status: 'awaiting_principal', stop_id: id });
    const [approval] = await approvals();
    expect(sent).toHaveLength(1);
    expect(sent[0].platformId).toBe('spaces/principal');
    expect(approval.title).toBe('Agree to this on join.example?');
    expect(approval.question).toContain(`join.example asks me to agree to this:\n"${WORDING}"`);
    expect(approval.question).toContain('until you ask me to stop');
    // The card names the errand in the principal's words, never its internal thread (KTD18).
    expect(approval.question.endsWith(`\n\n${ERRAND_ORIGIN_LINE}`)).toBe(true);
    expect(approval.question).not.toContain(job.thread_id);
    // Only the principal decides it.
    await click(approval, 'approve', OPERATOR);
    expect(await grants()).toEqual([]);
    await click(approval);
    expect(await grants()).toEqual([
      expect.objectContaining({
        site: 'join.example',
        origin: 'https://join.example',
        wording: WORDING,
        approval_id: approval.approval_id,
        principal_user_id: PRINCIPAL,
      }),
    ]);
    expect(await stopStatus(id)).toBe('approved');
    expect(await notices()).toEqual([
      expect.objectContaining({ type: 'browser_consent_outcome', stop_id: id, status: 'approved', wording: WORDING }),
    ]);
    // A replayed approval after a restart records nothing twice.
    await createPendingApproval({ ...approval, status: 'approved' });
    await resumeApprovedApprovals();
    expect(await grants()).toHaveLength(1);
    expect(await notices()).toHaveLength(1);
  });

  it('leaves the box unticked when the principal rejects, and tells the job', async () => {
    const id = await stop();
    await ask(id, 'consent-1');
    const [approval] = await approvals();
    await click(approval, 'reject');
    expect(await grants()).toEqual([]);
    expect(await stopStatus(id)).toBe('rejected');
    expect(await notices()).toEqual([
      expect.objectContaining({
        status: 'rejected',
        stop_id: id,
        message: expect.stringContaining('leaves this box unticked'),
      }),
    ]);
  });

  it('expires an unanswered card and tells the job', async () => {
    const id = await stop();
    await ask(id, 'consent-1');
    await getDb().run("UPDATE pending_approvals SET expires_at = '2026-01-01T00:00:00.000Z'");
    await sweepExpiredApprovals();
    expect(await stopStatus(id)).toBe('expired');
    expect(await notices()).toEqual([expect.objectContaining({ status: 'expired', stop_id: id })]);
  });

  it('refuses an unknown stop, another job’s stop and a stop already used, with no card', async () => {
    const id = await stop();
    expect(await ask('0b5c3a52-8f4e-4c1d-9a7b-2e6f1d3c4b5a', 'unknown')).toEqual(
      expect.objectContaining({ status: 'refused', reason: 'unknown_stop' }),
    );
    const other = (await resolveSystemSession('browser-p', 'system:a2a:main-p:other')).session;
    const otherJob = await new BrowserStore().jobForSession(other);
    if (!otherJob) throw new Error('Second job missing');
    expect(await ask(id, 'foreign', other)).toEqual(
      expect.objectContaining({ status: 'refused', reason: 'unknown_stop' }),
    );
    expect(await ask(id, 'first')).toMatchObject({ status: 'awaiting_principal' });
    expect(await ask(id, 'again')).toEqual(expect.objectContaining({ status: 'refused', reason: 'stop_used' }));
    expect(await approvals()).toHaveLength(1);
    expect(sent).toHaveLength(1);
  });

  it('approves a wording the principal already agreed to on that site and frame origin without a card, and asks again anywhere else', async () => {
    const first = await stop();
    await ask(first, 'consent-1');
    await click((await approvals())[0]);
    const second = await stop();
    expect(second).not.toBe(first);
    expect(await ask(second, 'consent-2')).toMatchObject({ status: 'approved', stop_id: second });
    expect(sent).toHaveLength(1);
    // The grant stands for join.example's own form only: the same words on another site, or in a form another
    // site serves inside join.example, are a new decision.
    const elsewhere = await stop(WORDING, job.id, 'other.example', 'https://other.example');
    expect(await ask(elsewhere, 'consent-3')).toMatchObject({ status: 'awaiting_principal', stop_id: elsewhere });
    const widget = await stop(WORDING, job.id, 'join.example', 'https://widgets.example');
    expect(await ask(widget, 'consent-4')).toMatchObject({ status: 'awaiting_principal', stop_id: widget });
    const cards = await approvals();
    const card = (stopId: string) =>
      cards.find((approval) => (JSON.parse(approval.payload) as { stopId?: unknown }).stopId === stopId);
    expect(cards).toHaveLength(2);
    expect(card(elsewhere)?.title).toBe('Agree to this on other.example?');
    expect(card(widget)?.question).toContain('It is in a form from "https://widgets.example".');
    expect(sent).toHaveLength(3);
  });

  it('lets main list and withdraw a grant, and only a group with browser access', async () => {
    const id = await stop();
    await ask(id, 'consent-1');
    await click((await approvals())[0]);
    const [grant] = await grants();
    const answered = (data: Record<string, unknown>) => ({ id: expect.any(String), ok: true, data });
    expect(await manageGrants(main, { operation: 'list', site: 'https://www.join.example/signup' })).toEqual(
      answered({
        status: 'listed',
        grants: [
          {
            grant_id: grant.id,
            site: 'join.example',
            origin: 'https://join.example',
            wording: WORDING,
            approved_at: expect.any(String),
          },
        ],
      }),
    );
    const other = (await resolveSession('other-p', 'mg-operator', null, 'agent-shared')).session;
    expect(await manageGrants(other, { operation: 'list' })).toMatchObject({ ok: false, error: { code: 'forbidden' } });
    expect(await manageGrants(other, { operation: 'withdraw', grant_id: grant.id })).toMatchObject({
      ok: false,
      error: { code: 'forbidden' },
    });
    expect(await manageGrants(main, { operation: 'withdraw', grant_id: grant.id })).toEqual(
      answered({ status: 'withdrawn', grant_id: grant.id }),
    );
    expect(await grants()).toEqual([]);
    expect(await manageGrants(main, { operation: 'withdraw', grant_id: grant.id })).toEqual(
      answered({ status: 'not_found' }),
    );
  });
});

describe.skipIf(!chromePath)('an approved wording in native Chrome', { timeout: 30_000 }, () => {
  let fixture: OpenWebFixture;
  beforeAll(async () => {
    if (!chromePath) throw new Error('Set GWS_EA_BROWSER_TEST_CHROME for the open-web fixture.');
    fixture = await openWebFixture(chromePath);
  }, 30_000);
  afterAll(async () => {
    await fixture?.close();
  });

  async function pass(target: Locator) {
    const element = await target.elementHandle();
    if (!element || !page) throw new Error('Fixture control missing');
    try {
      return await runConsentPass(page, element, { scope: { jobId: job.id, db: getDb() } });
    } finally {
      await element.dispose();
    }
  }

  it('stops, asks the principal on a card, and after approval ticks only that box on the next submission (AE6)', async () => {
    page = await fixture.newPage();
    await page.goto(CONSENT.required, { waitUntil: 'load' });
    const stopped = await pass(page.locator('#join-button'));
    if (stopped.status !== 'consent_required') throw new Error(`Expected a stop, got ${stopped.status}`);
    const [{ stop_id: stopId }] = stopped.stops;
    expect(stopped.stops).toEqual([{ stop_id: stopId, site: 'join.example', wording: WORDING }]);
    expect(await ask(String(stopId), 'consent-1')).toMatchObject({ status: 'awaiting_principal' });
    await click((await approvals())[0]);
    expect(await pass(page.locator('#join-button'))).toEqual({ status: 'ready', agreements: [], addOns: [] });
    const states = await page.locator('input[type="checkbox"]').evaluateAll((boxes) =>
      boxes.map((node) => {
        const box = node as unknown as { name: string; checked: boolean };
        return [box.name, box.checked];
      }),
    );
    expect(states).toEqual([
      ['marketing', true],
      ['partners', false],
    ]);
  });
});
