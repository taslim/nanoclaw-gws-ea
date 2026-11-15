import { createServer, request as httpRequest, type IncomingHttpHeaders, type Server } from 'node:http';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { closeDb, getDb, initTestDb, runMigrations } from '../../db/index.js';
import { DENY, defineGuardedAction, type GuardActor } from '../../guard/index.js';
import '../gws-ea-profile/index.js';
import { createHomePageHandler, homePageGuard } from './home.js';
import { principalPages, type PrincipalPageMount, type WebMountPath } from './mounts.js';

const HOST = 'remy.example.test';
const PRINCIPAL = 'morgan@example.test';
const linkGuard = defineGuardedAction({ action: 'test.home-link', decide: () => DENY('test') });
let server: Server;
let port: number;
let pages: PrincipalPageMount[];

function page(name: string, mountPath: WebMountPath, title: string, status: () => Promise<string>): PrincipalPageMount {
  return {
    name,
    audience: 'principal',
    path: mountPath,
    methods: ['GET'],
    title,
    status,
    linkGuard,
    handler: () => () => undefined,
  };
}

interface Reply {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: string;
}
function request(identity: string, route = '/', method = 'GET', host = HOST): Promise<Reply> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { hostname: '127.0.0.1', port, method, path: route, headers: { host, 'cf-access-jwt-assertion': identity } },
      (response) => {
        let output = '';
        response.on('data', (chunk: Buffer) => {
          output += chunk.toString();
        });
        response.on('end', () =>
          resolve({ status: response.statusCode ?? 0, headers: response.headers, body: output }),
        );
      },
    );
    outgoing.on('error', reject);
    outgoing.end();
  });
}

beforeEach(async () => {
  await runMigrations(await initTestDb());
  await getDb().run(
    'INSERT INTO gws_ea_principal_addresses(email,added_at) VALUES(?,?)',
    PRINCIPAL,
    new Date().toISOString(),
  );
  await getDb().run("UPDATE gws_ea_profile SET assistant_first_name = 'Juno', assistant_last_name = 'Hale'");
  pages = [
    page('home', '/', 'Home', async () => ''),
    page('logins', '/logins', 'Logins', async () => '2 saved logins'),
    page('apps', '/apps', 'Apps <beta>', async () => {
      throw new Error('store unreadable');
    }),
  ];
  server = createServer(
    createHomePageHandler({
      hostname: HOST,
      identity: async (incoming) => {
        const identity = incoming.headers['cf-access-jwt-assertion'];
        return typeof identity === 'string' && identity ? identity : undefined;
      },
      pages: () => pages,
    }),
  );
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No test server port');
  port = address.port;
});
afterEach(async () => {
  server.closeAllConnections();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await closeDb();
});

it('lists every other principal page with its summary, and a failing summary leaves the page listed without one', async () => {
  const response = await request(PRINCIPAL);
  expect(response.status).toBe(200);
  expect(response.headers['cache-control']).toBe('no-store');
  expect(response.headers['content-security-policy']).toMatch(/script-src 'nonce-[\w-]+'.*frame-ancestors 'none'/u);
  expect(response.body).toContain(
    '<a class="row" href="/logins" data-navigation><span class="row-main"><span class="row-title">Logins</span><span class="row-sub">2 saved logins</span></span>',
  );
  expect(response.body).toContain(
    '<a class="row" href="/apps" data-navigation><span class="row-main"><span class="row-title">Apps &lt;beta&gt;</span></span>',
  );
  expect(response.body).not.toContain('store unreadable');
  expect(response.body).not.toContain('class="row" href="/"');
  expect(response.body).toContain(
    '<p class="shell-name"><span class="shell-mark" aria-hidden="true">J</span><span>Juno Hale</span></p>',
  );
  expect(response.body).toMatch(
    /<a href="\/" data-navigation aria-current="page"><svg class="icon tab-icon"[^]*?<\/svg><span>Home<\/span><\/a>/u,
  );
  expect(response.body).toMatch(
    /<a href="\/apps" data-navigation><svg class="icon tab-icon"[^]*?<\/svg><span>Apps &lt;beta&gt;<\/span><\/a>/u,
  );
});

it('does not let a page whose summary never settles hold the home page back', async () => {
  let asked = false;
  pages[1] = page('logins', '/logins', 'Logins', () => {
    asked = true;
    return new Promise<string>(() => undefined);
  });
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  try {
    const pending = request(PRINCIPAL);
    await vi.waitFor(() => expect(asked).toBe(true));
    await vi.advanceTimersByTimeAsync(3000);
    const response = await pending;
    expect(response.status).toBe(200);
    expect(response.body).toContain(
      '<a class="row" href="/logins" data-navigation><span class="row-main"><span class="row-title">Logins</span></span>',
    );
  } finally {
    vi.useRealTimers();
  }
});

it('says so when there are no other pages', async () => {
  pages = [pages[0]];
  expect((await request(PRINCIPAL)).body).toContain('<h2>Nothing here yet</h2>');
});

it('shows navigation only to the principal', async () => {
  for (const identity of ['', 'reader@example.test', 'morgan+tag@example.test']) {
    const response = await request(identity);
    expect(response.status).toBe(404);
    expect(response.body).toBe('');
  }
  expect((await request(PRINCIPAL, '/', 'GET', `${HOST}:443`)).status).toBe(404);
  for (const [route, method] of [
    ['/?view=all', 'GET'],
    ['/', 'POST'],
  ])
    expect((await request(PRINCIPAL, route, method)).status).toBe(404);
  const head = await request(PRINCIPAL, '/', 'HEAD');
  expect(head.status).toBe(200);
  expect(head.body).toBe('');
});

it('lets only main obtain the home link', async () => {
  await getDb().run(
    "INSERT INTO agent_groups(id,name,folder,created_at) VALUES('ag-main','Main','main',?),('ag-other','Other','other',?)",
    new Date().toISOString(),
    new Date().toISOString(),
  );
  await getDb().run("UPDATE gws_ea_profile SET principal_first_name = 'Morgan', main_agent_group_id = 'ag-main'");
  const decide = async (actor: GuardActor): Promise<string> =>
    (await homePageGuard.decide({ actor, payload: {} })).effect;
  expect(await decide({ kind: 'agent', agentGroupId: 'ag-main' })).toBe('allow');
  expect(await decide({ kind: 'agent', agentGroupId: 'ag-other' })).toBe('deny');
  expect(await decide({ kind: 'human', userId: 'whatsapp:morgan' })).toBe('deny');
});

it('is registered by the web module itself at the root', async () => {
  await import('./index.js');
  expect(principalPages().find(({ path }) => path === '/')).toMatchObject({
    name: 'home',
    title: 'Home',
    methods: ['GET', 'HEAD'],
    linkGuard: homePageGuard,
  });
});
