import { registerCapability } from '../../capabilities.js';
import { answeredGuard, answeringAction, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, defineGuardedAction, guard, type GuardActor } from '../../guard/index.js';
import { principalPages, type PrincipalPageMount } from './mounts.js';
import { readWebPolicy, type WebPolicyFile } from './policy.js';

export const PRINCIPAL_PAGE_ACTION = 'principal_page';
export const PRINCIPAL_PAGES_CAPABILITY = 'gws-ea-principal-pages';

/** The only address of a principal page that may be sent; the outgoing-link check compares against it exactly. */
export function principalPageUrl(hostname: string, page: Pick<PrincipalPageMount, 'path'>): string {
  return `https://${hostname}${page.path}`;
}

function pageNamed(name: unknown): PrincipalPageMount | undefined {
  return typeof name === 'string' ? principalPages().find((page) => page.name === name) : undefined;
}

async function mayLink(page: PrincipalPageMount, actor: GuardActor): Promise<boolean> {
  return (await guard(page.linkGuard, { actor, payload: {} })).effect === 'allow';
}

/** Whether some registered page would give this group its link: exactly the groups that hold the link tool. */
export async function mayObtainPrincipalPage(agentGroupId: string): Promise<boolean> {
  if (!(await getDb().hasTable('gws_ea_profile'))) return false;
  for (const page of principalPages()) if (await mayLink(page, { kind: 'agent', agentGroupId })) return true;
  return false;
}

registerCapability(PRINCIPAL_PAGES_CAPABILITY, {
  description: "principal_page: the link to one of the principal's own pages on the assistant's web address",
  default: 'off',
  instructions: [PRINCIPAL_PAGES_CAPABILITY],
  // Each page's own link guard still decides every request.
  grantedTo: mayObtainPrincipalPage,
});

const principalPageGuard = defineGuardedAction({
  action: 'gws_ea_web.principal_page',
  async decide({ actor, payload }) {
    if (actor.kind !== 'agent') return DENY("Only an agent may obtain a link to the principal's pages.");
    const page = pageNamed(payload.page);
    // Nothing is linked for a page that does not exist, and the answer names the pages there are.
    if (!page) return ALLOW('The request names no principal page and is answered as invalid.');
    return (await mayLink(page, actor))
      ? ALLOW(`The ${page.name} page's own guard lets this agent obtain its link.`)
      : DENY(`This agent may not obtain the link to the principal's ${page.title} page.`);
  },
});

interface PrincipalPageDependencies {
  readonly publicationReady: (config: WebPolicyFile) => Promise<boolean>;
}

export function registerPrincipalPageDelivery(dependencies: PrincipalPageDependencies): void {
  registerDeliveryAction(
    PRINCIPAL_PAGE_ACTION,
    answeringAction(PRINCIPAL_PAGE_ACTION, async (content) => {
      if (Object.keys(content).some((key) => !['action', 'requestId', 'page'].includes(key)))
        throw invalidArgs('The request takes only page.');
      const page = pageNamed(content.page);
      if (!page)
        throw invalidArgs(
          `page must name one of the principal's pages: ${principalPages()
            .map(({ name }) => name)
            .join(', ')}.`,
        );
      const facts = page.linkFacts ? { facts: await page.linkFacts() } : {};
      const web = await readWebPolicy();
      if (web.status !== 'enabled') return { status: 'operator_needed', ...facts };
      if (!(await dependencies.publicationReady(web.config))) return { status: 'unavailable', ...facts };
      return { status: 'available', url: principalPageUrl(web.config.hostname, page), ...facts };
    }),
    answeredGuard(principalPageGuard),
  );
}
