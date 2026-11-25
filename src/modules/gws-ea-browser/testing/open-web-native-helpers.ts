import { randomUUID } from 'node:crypto';
import fs from 'node:fs';

import Database from 'better-sqlite3';
import type { ElementHandle, Locator, Page } from 'playwright-core';
import { expect } from 'vitest';

import type { OutboundFile } from '../../../channels/adapter.js';
import {
  closeDb,
  createAgentGroup,
  createMessagingGroup,
  getDb,
  initTestDb,
  runMigrations,
} from '../../../db/index.js';
import { SqliteDriver } from '../../../db/drivers/sqlite.js';
import { getDeliveryAction, setDeliveryAdapter } from '../../../delivery.js';
import { resolveSession, resolveSystemSession } from '../../../session-manager.js';
import type { Session } from '../../../types.js';
import { bindVerifiedPrincipalUser, reconcileGwsEaProfile } from '../../gws-ea-profile/db.js';
import { upsertUser } from '../../permissions/db/users.js';
import { upsertUserDm } from '../../permissions/db/user-dms.js';
import '../../gws-ea-profile/index.js';
import '../index.js';
import type { BrowserExecutionContext } from '../actions.js';
import { configureBrowserCancellation } from '../cancel.js';
import { BrowserStore } from '../db.js';
import { setBrowserAdmissionReady } from '../group.js';
import { createBrowserQueue } from '../index.js';
import { prepareMerchantPage } from '../merchant-read.js';
import { browserConsentMigration, browserRecipesMigration, browserSiteLeasesMigration } from '../migration.js';
import type { OpenWebFixture } from '../open-web-native-fixture.js';
import { registerBrowserPurchaseDelivery, resumeBrowserPurchaseCommits } from '../purchase.js';
import type { BrowserQueue } from '../queue.js';
import { registerReservationGuaranteeDelivery } from '../reservation-guarantee.js';

export const PRINCIPAL = 'gchat:users/principal';
export const ALIAS = 'aya.web@example.test';

/** A PNG's width and height, as its header states them. */
export function pngSize(data: Buffer): { width: number; height: number } {
  expect(data.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
}

/** Runs `read` on the element `target` names, then lets its handle go. */
export async function withElement<T>(target: Locator, read: (element: ElementHandle) => Promise<T>): Promise<T> {
  const element = await target.elementHandle();
  if (!element) throw new Error('Fixture control missing');
  try {
    return await read(element);
  } finally {
    await element.dispose();
  }
}

/** An in-memory browser database holding the jobs `jobs`, with the tables an executor batch reads and writes. */
export async function jobDb(...jobs: string[]): Promise<SqliteDriver> {
  const db = new SqliteDriver(new Database(':memory:'));
  await db.exec('CREATE TABLE gws_ea_browser_jobs(id TEXT PRIMARY KEY)');
  for (const job of jobs) await db.run('INSERT INTO gws_ea_browser_jobs VALUES(?)', job);
  for (const migration of [browserSiteLeasesMigration, browserConsentMigration, browserRecipesMigration])
    await migration.up(db);
  await db.exec('CREATE TABLE gws_ea_browser_requests(answer_json TEXT,job_id TEXT,started_at TEXT,action TEXT)');
  return db;
}

/** Job `job`'s request context over `page`, as the queue builds one. */
export function jobContext(db: SqliteDriver, page: Page, job: string): BrowserExecutionContext {
  return {
    job: { id: job, thread_id: job },
    request: { id: `request-${randomUUID()}` },
    session: {},
    store: new BrowserStore(db),
    page: async () => page,
    assertActive: async () => undefined,
    wakeWaiters: async () => undefined,
    remaining: () => 30_000,
    signal: new AbortController().signal,
  } as unknown as BrowserExecutionContext;
}

/** The host as one errand of main's meets it: the central database, a queue over one fixture page, what it sent. */
export interface ErrandHost {
  readonly page: Page;
  readonly queue: BrowserQueue;
  readonly main: Session;
  readonly errand: Session;
  /** Each delivery's content, in order. */
  readonly sent: string[];
  /** The files each delivery carried, beside its content in `sent`. */
  readonly attached: Array<readonly OutboundFile[] | undefined>;
  /** How often the queue closed the errand's page. */
  closed: number;
}

/**
 * Starts the host for main's errand on `thread`: browser access for main, a browser group, the assistant's alias,
 * the principal reachable in their DM, and every delivery captured. The page is prepared as the host prepares a job's.
 */
export async function startErrandHost(root: string, fixture: OpenWebFixture, thread: string): Promise<ErrandHost> {
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(`${root}/browser`, { recursive: true });

  process.env.GWS_EA_BROWSER_ROOT = `${root}/browser`;
  await runMigrations(await initTestDb());
  const now = new Date().toISOString();
  for (const id of ['main-p', 'browser-p'])
    await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: now });
  await createMessagingGroup({
    id: 'mg-principal',
    channel_type: 'gchat',
    platform_id: 'spaces/principal',
    name: 'principal',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now,
  });
  await reconcileGwsEaProfile({
    assistantName: { firstName: 'Aya', lastName: null },
    assistantWorkspaceEmail: 'aya@example.test',
    principalName: { firstName: 'Morgan', lastName: null },
    principalTimezone: 'America/Los_Angeles',
    mainAgentGroupId: 'main-p',
    principalEmails: ['morgan@example.test'],
  });
  await getDb().run(
    'UPDATE gws_ea_profile SET browser_agent_group_id = ?, assistant_alias = ? WHERE singleton = 1',
    'browser-p',
    ALIAS,
  );
  await upsertUser({ id: PRINCIPAL, kind: 'gchat', display_name: 'Morgan', created_at: now });
  await upsertUserDm({
    user_id: PRINCIPAL,
    channel_type: 'gchat',
    messaging_group_id: 'mg-principal',
    resolved_at: now,
  });
  await bindVerifiedPrincipalUser(PRINCIPAL, now);
  const main = (await resolveSession('main-p', 'mg-principal', null, 'agent-shared')).session;
  const errand = (await resolveSystemSession('browser-p', thread)).session;
  const page = await fixture.newPage();
  await prepareMerchantPage(page);
  const host: ErrandHost = {
    page,
    main,
    errand,
    sent: [],
    attached: [],
    closed: 0,
    queue: createBrowserQueue(new BrowserStore(), {
      pageForJob: async () => page,
      connection: async (): Promise<never> => {
        throw new Error('Not used');
      },
      closeJob: async () => {
        host.closed++;
      },
      withActivity: <T>(operation: () => Promise<T>): Promise<T> => operation(),
      onDisconnected: () => () => undefined,
    }),
  };
  setDeliveryAdapter({
    async deliver(_type, _platformId, _thread, _kind, content, files) {
      host.sent.push(content);
      host.attached.push(files);
      return `message-${host.sent.length}`;
    },
  });
  configureBrowserCancellation(host.queue);
  registerBrowserPurchaseDelivery(() => host.queue);
  if (!getDeliveryAction('reservation_bounds')) registerReservationGuaranteeDelivery();
  await host.queue.start();
  await resumeBrowserPurchaseCommits(host.queue);
  setBrowserAdmissionReady(true);
  return host;
}

/** Stops what `startErrandHost` started, and removes its data. */
export async function stopErrandHost(root: string, host: ErrandHost | undefined): Promise<void> {
  setBrowserAdmissionReady(false);
  await host?.queue.stop();
  await host?.page.context().close();
  delete process.env.GWS_EA_BROWSER_ROOT;
  await closeDb();
  fs.rmSync(root, { recursive: true, force: true });
}

/** The data of the queue's answer to the errand's request `id`, without the queue's timing. */
export async function answerOf(host: ErrandHost, id: string): Promise<Record<string, unknown>> {
  const row = await getDb().get<{ answer_json: string }>(
    'SELECT answer_json FROM gws_ea_browser_requests WHERE session_id = ? AND request_id = ?',
    host.errand.id,
    id,
  );
  if (!row) throw new Error(`No answer for ${id}`);
  const { timing: _timing, ...data } = (JSON.parse(row.answer_json) as { data: Record<string, unknown> }).data;
  return data;
}

/** One request through the queue, as the errand's browser agent sends it; its answer's data. */
export async function errandRequest(
  host: ErrandHost,
  id: string,
  action: string,
  content: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  await host.queue.accept(action, content, host.errand, id);
  await host.queue.idle();
  return answerOf(host, id);
}
