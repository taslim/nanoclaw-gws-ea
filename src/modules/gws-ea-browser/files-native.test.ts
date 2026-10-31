import { useAvailableBrowser } from './testing/browser-runtime.js';
/** Native Chrome file bytes, the production connection/window boundary and real durable job records. */
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { Socket } from 'node:net';

import type { Page } from 'playwright-core';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const root = await vi.hoisted(async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  return mkdtempSync(join(tmpdir(), 'browser-native-files-'));
});

vi.mock('../../config.js', async () => ({
  ...(await vi.importActual<typeof import('../../config.js')>('../../config.js')),
  DATA_DIR: root,
}));

import { closeDb, createAgentGroup, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { resolveSystemSession, sessionDir } from '../../session-manager.js';
import type { Session } from '../../types.js';
import '../gws-ea-profile/index.js';
import './index.js';
import { prepareChromeProfile, spawnChrome } from './chrome.js';
import { connectChrome, type ChromeConnection } from './connection.js';
import { BrowserStore, browserRequestId, markBrowserRequestCommitStarted } from './db.js';
import { ensureBrowserNavigationGuard } from './commit-classifier.js';
import { executeBrowserBatch } from './executor.js';

import { observePage, type BrowserRef } from './observe.js';
import { browserPaths } from './paths.js';
import type { BrowserExecutionContext } from './actions.js';
import { JobWindows } from './windows.js';

const chromePath = process.env.GWS_EA_BROWSER_TEST_CHROME;
const invoice = Buffer.concat([Buffer.from('%PDF-1.7\nNative invoice bytes\n'), Buffer.alloc(200_003, 41)]);
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

describe.skipIf(!chromePath)('native Chrome file transfers', { timeout: 30_000 }, () => {
  const paths = browserPaths(path.join(root, 'browser'));
  const sockets = new Set<Socket>();
  let server: Server;
  let connection: ChromeConnection;
  let windows: JobWindows;
  let page: Page;
  let session: Session;
  let context: BrowserExecutionContext;
  let invoiceRequests = 0;
  const documentRequests: string[] = [];

  beforeAll(async () => {
    if (!chromePath) throw new Error('Native Chrome path required');
    await prepareChromeProfile(paths);

    server = createServer((request, response) => {
      const address = request.url ?? '';
      if (request.method !== 'GET' || !/^http:\/\/(?:fixture|elsewhere)\.example\//u.test(address)) {
        response.writeHead(403).end();
        return;
      }
      const url = new URL(address);
      documentRequests.push(url.pathname);
      if (url.pathname.startsWith('/help/')) {
        response.writeHead(200, { 'content-type': 'text/html' }).end(`<!doctype html><h1>${url.pathname}</h1>`);
        return;
      }
      if (url.pathname === '/docs/invoice.pdf') {
        ++invoiceRequests;
        response
          .writeHead(200, {
            'content-type': 'application/pdf',
            'content-disposition': 'attachment; filename="invoice.pdf"',
            'content-length': invoice.length,
          })
          .end(invoice);
        return;
      }
      response
        .writeHead(200, { 'content-type': 'text/html' })
        .end(
          '<!doctype html><h1>Invoice archive</h1><a href="/docs/invoice.pdf" download>Download invoice</a>' +
            '<label>Supporting document<input type="file" name="document"></label>',
        );
    });
    server.on('connection', (socket) => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Fixture proxy did not bind');
    connection = await connectChrome(
      await spawnChrome({ chromePath, paths, proxyUrl: `http://127.0.0.1:${address.port}` }),
      paths,
    );
    windows = new JobWindows(connection);
  }, 30_000);

  beforeEach(async () => {
    useAvailableBrowser();
    vi.stubEnv('GWS_EA_BROWSER_ROOT', paths.root);
    await runMigrations(await initTestDb());
    for (const id of ['main-files', 'browser-files'])
      await createAgentGroup({ id, name: id, folder: id, agent_provider: null, created_at: new Date().toISOString() });
    await getDb().run(
      `UPDATE gws_ea_profile SET assistant_first_name=COALESCE(assistant_first_name,'Juno'),principal_first_name=COALESCE(principal_first_name,'Morgan'),main_agent_group_id = ?, browser_agent_group_id = ? WHERE singleton = 1`,
      'main-files',
      'browser-files',
    );
    session = (await resolveSystemSession('browser-files', 'system:a2a:main-files:invoice')).session;
    const store = new BrowserStore();
    const job = await store.jobForSession(session);
    if (!job) throw new Error('Native browser job was not admitted');
    await store.accept(job, session, 'file-transfer', 'browser', {}, 15_000);
    const id = browserRequestId(session.id, 'file-transfer');
    const request = await store.start(id);
    if (!request) throw new Error('Native browser request did not start');
    const deadline = Date.now() + 15_000;
    page = await windows.pageForJob(job.id);
    await page.goto('http://fixture.example/docs/archive');
    context = {
      kind: 'request',
      job,
      request,
      session,
      signal: new AbortController().signal,
      deadline,
      store,
      runtime: {
        pageForJob: (jobId) => windows.pageForJob(jobId),
        connection: async () => connection,
        closeJob: (jobId) => windows.closeJob(jobId),
        withActivity: <T>(operation: () => Promise<T>): Promise<T> => operation(),
        onDisconnected(listener) {
          connection.browser.on('disconnected', listener);
          return () => connection.browser.off('disconnected', listener);
        },
      },
      page: async () => page,
      async assertActive() {
        if (page.isClosed() || Date.now() >= deadline || (await store.getJob(job.id))?.cancelled !== 0)
          throw new Error('Native file fixture is no longer active');
      },
      wakeWaiters: async () => undefined,
      markCommitStarted: () => markBrowserRequestCommitStarted(store.db, id),
      remaining: () => Math.max(1, deadline - Date.now()),
    };
    invoiceRequests = 0;
    documentRequests.length = 0;
  });

  afterEach(async () => {
    await windows?.close();
    await closeDb();
    vi.unstubAllEnvs();
  });

  afterAll(async () => {
    await windows?.close();
    await connection?.close();
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  async function target(name: string): Promise<BrowserRef> {
    const observation = await observePage(page);
    const line = observation.snapshot
      .split('\n')
      .find((value) => value.includes(JSON.stringify(name)) && value.includes('[ref='));
    const ref = line && /\[ref=((?:f\d+)?e\d+)\]/u.exec(line)?.[1];
    if (!ref) throw new Error(`Missing ${name} in native snapshot: ${observation.snapshot}`);
    return { ref, generation: observation.generation };
  }

  it('hands a real Content-Disposition invoice into the job inbox once, with exact private bytes', async () => {
    const result = await executeBrowserBatch(
      context,
      { actions: [{ kind: 'download', ...(await target('Download invoice')) }] },
      { record: false },
    );
    expect(result.reason).toBeUndefined();
    expect(result).toMatchObject({
      status: 'completed',
      actions: [
        {
          status: 'completed',
          filename: 'invoice.pdf',
          bytes: invoice.length,
          path: `/workspace/inbox/${context.request.id}-0/invoice.pdf`,
        },
      ],
    });
    const row = await context.store.db.get<{
      id: string;
      host_path: string;
      inbox_path: string;
      handed_off_at: string;
    }>('SELECT id,host_path,inbox_path,handed_off_at FROM gws_ea_browser_downloads WHERE job_id = ?', context.job.id);
    if (!row) throw new Error('Download has no durable row');
    expect(row.id).toBe(`${context.request.id}-0`);
    expect(row.handed_off_at).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/u);
    expect(row.inbox_path).toBe(
      fs.realpathSync(path.join(sessionDir(session.agent_group_id, session.id), 'inbox', row.id, 'invoice.pdf')),
    );
    expect(sha256(fs.readFileSync(row.inbox_path))).toBe(sha256(invoice));
    expect(fs.existsSync(row.host_path)).toBe(false);
    expect(fs.statSync(row.inbox_path).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.dirname(row.inbox_path)).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.dirname(row.host_path)).mode & 0o777).toBe(0o700);
    expect(fs.readdirSync(path.dirname(row.host_path))).toEqual([]);
    const replay = await executeBrowserBatch(
      context,
      { actions: [{ kind: 'download', ...(await target('Download invoice')) }] },
      { record: false },
    );
    expect(replay).toMatchObject({
      status: 'completed',
      actions: [
        {
          filename: 'invoice.pdf',
          bytes: invoice.length,
          path: `/workspace/inbox/${context.request.id}-0/invoice.pdf`,
        },
      ],
    });
    expect(invoiceRequests).toBe(1);
    expect(await context.store.db.all('SELECT id FROM gws_ea_browser_downloads')).toEqual([{ id: row.id }]);
    expect(sha256(fs.readFileSync(row.inbox_path))).toBe(sha256(invoice));
  }, 20_000);

  it('keeps selected upload bytes immutable until the page closes, then removes private staging', async () => {
    const original = Buffer.from('The original document selected for upload.');
    const source = path.join(sessionDir(session.agent_group_id, session.id), 'documents', 'supporting.txt');
    fs.mkdirSync(path.dirname(source));
    fs.writeFileSync(source, original);
    const result = await executeBrowserBatch(
      context,
      {
        actions: [
          { kind: 'upload', ...(await target('Supporting document')), path: '/workspace/documents/supporting.txt' },
        ],
      },
      { record: false },
    );
    expect(result).toMatchObject({ status: 'completed', actions: [{ status: 'completed' }] });
    fs.writeFileSync(source, 'A subsequent container edit must not change the selected document.');
    const uploadRoot = path.join(paths.stagingDir, 'uploads');
    function privateFiles(directory: string): string[] {
      expect(fs.statSync(directory).mode & 0o777).toBe(0o700);
      return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const file = path.join(directory, entry.name);
        if (entry.isDirectory()) return privateFiles(file);
        expect(entry.isFile()).toBe(true);
        expect(fs.statSync(file).mode & 0o777).toBe(0o600);
        return [file];
      });
    }
    const staged = privateFiles(uploadRoot);
    expect(staged).toHaveLength(1);
    expect(sha256(fs.readFileSync(staged[0]))).toBe(sha256(original));
    expect(
      await page.locator('input[type="file"]').evaluate((node) => {
        const input = node as unknown as { files: ArrayLike<{ name: string }> };
        return input.files[0].name;
      }),
    ).toBe('supporting.txt');
    const bytes = await page.locator('input[type="file"]').evaluate(async (node) => {
      const input = node as unknown as { files: ArrayLike<{ arrayBuffer(): Promise<ArrayBuffer> }> };
      return Array.from(new Uint8Array(await input.files[0].arrayBuffer()));
    });
    expect(sha256(Uint8Array.from(bytes))).toBe(sha256(original));
    await windows.closeJob(context.job.id);
    expect(fs.readdirSync(uploadRoot)).toEqual([]);
  }, 20_000);

  it('refuses the checkout submit that page script sends as a file is chosen, as it does for typing', async () => {
    const source = path.join(sessionDir(session.agent_group_id, session.id), 'documents', 'receipt.txt');
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, 'A receipt to attach.');
    await page.evaluate(`document.querySelector('input[type="file"]').addEventListener('change', () => {
  void fetch('/api/checkout/submit', { method: 'POST', mode: 'no-cors', body: 'attached=1' }).then(
    () => { document.body.dataset.posted = 'sent'; },
    () => { document.body.dataset.posted = 'refused'; },
  );
})`);
    const result = await executeBrowserBatch(
      context,
      {
        actions: [
          { kind: 'upload', ...(await target('Supporting document')), path: '/workspace/documents/receipt.txt' },
        ],
      },
      { record: false },
    );
    expect(result).toMatchObject({ status: 'completed', actions: [{ status: 'completed' }] });
    await expect.poll(() => page.locator('body').getAttribute('data-posted')).toBe('refused');
  }, 20_000);

  it('refuses File System Access pickers before any native panel opens', async () => {
    // These pickers need a secure context; a routed origin provides one without the network.
    const picker = (name: string, call: string) =>
      `<button onclick="${call}().then(() => { document.body.dataset.${name} = 'opened'; }, (error) => { document.body.dataset.${name} = error.name; })">${name}</button>`;
    const appeared = connection.context.waitForEvent('page');
    await connection.session.send('Target.createTarget', { url: 'about:blank', newWindow: true, background: true });
    // A page without the job page's chooser interception, so only the profile's guards stand.
    const plain = await appeared;
    try {
      for (const [target, refusal] of [
        [page, 'AbortError'],
        [plain, 'NotAllowedError'],
      ] as const) {
        await target.route('https://picker.example/**', (route) =>
          route.fulfill({
            contentType: 'text/html',
            body: `${picker('open', 'showOpenFilePicker')}${picker('save', 'showSaveFilePicker')}`,
          }),
        );
        await target.goto('https://picker.example/');
        for (const name of ['open', 'save']) {
          await target.getByRole('button', { name }).click();
          await expect
            .poll(() => target.locator('body').getAttribute(`data-${name}`), { timeout: 2_000 })
            .toBe(refusal);
        }
      }
    } finally {
      await plain.close();
    }
  });

  it('reopens the owned Chrome profile without losing its persistent cookies', async () => {
    await connection.context.addCookies([
      {
        name: 'owned-profile-cookie',
        value: 'retained-after-restart',
        domain: 'fixture.example',
        path: '/',
        expires: Math.floor(Date.now() / 1000) + 3600,
      },
    ]);
    await windows.close();
    await connection.close();
    expect(connection.child.exitCode !== null || connection.child.signalCode !== null).toBe(true);
    await prepareChromeProfile(paths);
    const address = server.address();
    if (!chromePath || !address || typeof address === 'string') throw new Error('Native fixture unavailable');
    connection = await connectChrome(
      await spawnChrome({
        chromePath,
        paths,
        proxyUrl: `http://127.0.0.1:${address.port}`,
      }),
      paths,
    );
    windows = new JobWindows(connection);
    page = await windows.pageForJob(context.job.id);
    await page.goto('http://fixture.example/docs/archive');
    expect(await connection.context.cookies('http://fixture.example')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'owned-profile-cookie', value: 'retained-after-restart' }),
      ]),
    );
    expect(await page.getByRole('heading', { name: 'Invoice archive' }).isVisible()).toBe(true);
  });

  it('decides a back navigation made after its errand ended, rather than restoring the page', async () => {
    for (const url of ['http://elsewhere.example/help/first', 'http://fixture.example/help/second'])
      await executeBrowserBatch(context, { actions: [{ kind: 'navigate', url }] }, { record: false });
    const guard = await ensureBrowserNavigationGuard(page);
    await page.evaluate('history.back()');
    // Between operations only a GET on the site the job's lease admitted the page to loads; a restored page
    // would have asked nothing.
    await expect.poll(() => guard.reason(), { timeout: 5_000 }).toBe('blocked_address');
    expect(documentRequests.filter((request) => request === '/help/first')).toHaveLength(1);
    expect(page.url()).not.toBe('http://elsewhere.example/help/first');
  }, 20_000);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));
