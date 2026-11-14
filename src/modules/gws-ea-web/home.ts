import type { RequestListener } from 'node:http';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import type { WebIdentity } from './access.js';
import {
  escapeHtml,
  icon,
  isPrincipalRequest,
  pageNonce,
  readShell,
  refuse,
  renderPrincipalPage,
  sendPage,
  sendUnavailable,
} from './kit/index.js';
import { principalPages, type PrincipalPageMount } from './mounts.js';

/** A slow page's summary must not hold the home page back. */
const STATUS_WAIT_MS = 3000;

export const homePageGuard = defineGuardedAction({
  action: 'gws_ea_web.home_page',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getMainAgentGroupId())
      ? ALLOW("Main asks for the principal's home page.")
      : DENY("Only main may obtain the principal's home page.");
  },
});

/** Undefined when the page cannot say in time; the page is listed regardless. */
async function summary(page: PrincipalPageMount): Promise<string | undefined> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), STATUS_WAIT_MS);
  });
  /* eslint-disable no-catch-all/no-catch-all -- Any failure of one page's summary leaves that page listed without one. */
  try {
    const status = await Promise.race([page.status(), late]);
    return status?.trim() || undefined;
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
  /* eslint-enable no-catch-all/no-catch-all */
}

const STYLE = `
.page-list { overflow: hidden; background: var(--panel); border: 1px solid var(--line); border-radius: 12px; }
.page-row { display: flex; align-items: center; gap: 20px; padding: 17px 20px; min-height: 76px; transition: background-color .15s; }
.page-row + .page-row { border-top: 1px solid var(--line); }
.page-row:hover { background: var(--hover); }
.page-row:focus-visible { outline-offset: -3px; }
.page-identity { min-width: 0; flex: 1; display: flex; flex-direction: column; gap: 3px; }
.page-title { font-size: 15px; font-weight: 500; line-height: 1.4; letter-spacing: -.015em; overflow-wrap: anywhere; }
.page-status { font-size: 12px; color: var(--muted); overflow-wrap: anywhere; }
.row-arrow { width: 15px; height: 15px; color: var(--muted); }
@media (max-width: 600px) {
  .page-row { gap: 16px; padding: 16px; }
  .page-title { font-size: 14px; }
}
`;

interface HomeRow {
  readonly title: string;
  readonly path: string;
  readonly status: string | undefined;
}

function homeContent(rows: readonly HomeRow[]): string {
  const heading = '<div class="page-heading"><div><h1>Home</h1></div></div>';
  if (rows.length === 0) return `${heading}<section class="empty-state"><h2>No pages yet.</h2></section>`;
  return `${heading}<section class="page-list" aria-label="Your pages">${rows
    .map(
      (row) =>
        `<a class="page-row" href="${escapeHtml(row.path)}" data-navigation><span class="page-identity"><span class="page-title">${escapeHtml(row.title)}</span>${row.status ? `<span class="page-status">${escapeHtml(row.status)}</span>` : ''}</span>${icon('arrow', 'row-arrow')}</a>`,
    )
    .join('')}</section>`;
}

interface HomePageOptions {
  readonly hostname: string;
  readonly identity: WebIdentity;
  readonly pages?: () => readonly PrincipalPageMount[];
}

export function createHomePageHandler(options: HomePageOptions): RequestListener {
  const pages = options.pages ?? principalPages;
  return (request, response) => {
    const serve = async (): Promise<void> => {
      if ((request.method !== 'GET' && request.method !== 'HEAD') || request.url !== '/') return refuse(response);
      if (!(await isPrincipalRequest(request, options.hostname, options.identity))) return refuse(response);
      const registered = pages();
      const listed = registered.filter(({ path }) => path !== '/');
      const [shell, statuses] = await Promise.all([readShell(registered), Promise.all(listed.map(summary))]);
      const nonce = pageNonce();
      sendPage(response, {
        status: 200,
        nonce,
        body:
          request.method === 'HEAD'
            ? undefined
            : renderPrincipalPage(
                {
                  shell,
                  page: '/',
                  title: 'Home',
                  view: 'home',
                  outcome: '',
                  error: false,
                  content: homeContent(
                    listed.map(({ title, path }, index) => ({ title, path, status: statuses[index] })),
                  ),
                  style: STYLE,
                },
                nonce,
              ),
      });
    };
    void serve().catch((_error: unknown) => {
      if (response.headersSent) response.destroy();
      else sendUnavailable(response);
    });
  };
}

export const homeWebMount: PrincipalPageMount = {
  name: 'home',
  audience: 'principal',
  path: '/',
  methods: ['GET', 'HEAD'],
  title: 'Home',
  // Home lists the other pages and is never listed itself.
  status: async () => '',
  linkGuard: homePageGuard,
  handler: (config, identity) => createHomePageHandler({ hostname: config.hostname, identity }),
};
