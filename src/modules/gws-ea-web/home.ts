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
  renderEmptyState,
  renderPageHeading,
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

interface HomeRow {
  readonly title: string;
  readonly path: string;
  readonly status: string | undefined;
}

function homeContent(rows: readonly HomeRow[]): string {
  const heading = renderPageHeading('Home');
  if (rows.length === 0) return `${heading}${renderEmptyState('Nothing here yet', 'apps')}`;
  return `${heading}<nav class="list" aria-label="Your pages">${rows
    .map(
      (row) =>
        `<a class="row" href="${escapeHtml(row.path)}" data-navigation><span class="row-main"><span class="row-title">${escapeHtml(row.title)}</span>${row.status ? `<span class="row-sub">${escapeHtml(row.status)}</span>` : ''}</span>${icon('arrow', 'row-chevron')}</a>`,
    )
    .join('')}</nav>`;
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
