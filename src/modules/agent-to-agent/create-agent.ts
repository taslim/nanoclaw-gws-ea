/**
 * `create_agent` delivery-action bodies.
 *
 * SECURITY: `create_agent` writes to the CENTRAL DB (agent_groups,
 * container_configs, agent_destinations) and scaffolds host filesystem state —
 * a privileged operation a confined container is otherwise architecturally
 * barred from. The container's MCP tool gate is inside the (untrusted)
 * container and is trivially bypassed by writing the outbound system row
 * directly, so authorization MUST be enforced host-side: the delivery
 * registry wraps this action with the guard, whose `agents.create` decision
 * (./guard.ts) is the old cli_scope branch verbatim — trusted global-scope
 * groups allow, everything else (including unknown config, fail-closed)
 * holds for admin approval. On approve the continuation re-enters the
 * wrapped action with the approval row as its grant and `createAgent` runs.
 * `performCreateAgent` is the module-private body for a plain create; a
 * request with a `template` ref is stamped from that template instead, under
 * the same authorization (the grant is bound to the ref, ./guard.ts).
 */
import path from 'path';

import { GROUPS_DIR } from '../../config.js';
import { createAgentGroup, getAgentGroup, getAgentGroupByFolder } from '../../db/agent-groups.js';
import { getContainerConfig } from '../../db/container-configs.js';
import { getSession } from '../../db/sessions.js';
import { requestWake } from '../../request-wake.js';
import { groupFolderExistsOnDisk } from '../../group-folder.js';
import { initGroupFilesystem } from '../../group-init.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import { createAgentFromTemplate } from '../../templates/create-agent.js';
import { isValidTemplateRef } from '../../templates/local-dir.js';
import { ensureTemplateLocal, hasLocalTemplate } from '../../templates/library.js';
import { destinationRefusal } from '../../db/wiring-admission.js';
import type { AgentDestination, AgentGroup, Session } from '../../types.js';
import { requestApproval } from '../approvals/index.js';
import { NAME_LIMIT, quoted } from '../approvals/request-text.js';
import { createDestination, getDestinationByName, normalizeName } from './db/agent-destinations.js';
import { writeDestinations } from './write-destinations.js';

async function notifyAgent(session: Session, text: string): Promise<void> {
  await writeSessionMessage(session.agent_group_id, session.id, {
    id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    kind: 'chat',
    timestamp: new Date().toISOString(),
    platformId: session.agent_group_id,
    channelType: 'agent',
    threadId: null,
    content: JSON.stringify({ text, sender: 'system', senderId: 'system' }),
  });
  const fresh = await getSession(session.id);
  if (fresh) await requestWake(fresh, 'agent-created');
}

function templateRef(content: Record<string, unknown>): string | undefined {
  return typeof content.template === 'string' && content.template ? content.template : undefined;
}

/** Guard precheck: malformed requests are answered without ever creating a hold. */
export async function validateCreateAgent(content: Record<string, unknown>, session: Session): Promise<boolean> {
  const name = typeof content.name === 'string' ? content.name : '';
  if (!name) {
    await notifyAgent(session, 'create_agent failed: name is required.');
    return false;
  }
  if (
    content.template !== undefined &&
    !(typeof content.template === 'string' && isValidTemplateRef(content.template))
  ) {
    await notifyAgent(
      session,
      `create_agent failed: "${String(content.template)}" is not a template ref. Refs look like "sales/sdr"; list them with \`ncl templates list\`.`,
    );
    return false;
  }
  if (!(await getAgentGroup(session.agent_group_id))) {
    await notifyAgent(session, 'create_agent failed: source agent group not found.');
    log.warn('create_agent failed: missing source group', { sessionAgentGroup: session.agent_group_id, name });
    return false;
  }
  return true;
}

/**
 * The payload every create_agent hold stores. The approved replay runs with it
 * as its content, so it must carry the template; a templated hold stores no
 * instructions because the template replaces them. Wrappers (slack-agent-flow)
 * add their own fields on top.
 */
export function createAgentHoldPayload(content: Record<string, unknown>): Record<string, unknown> {
  const name = typeof content.name === 'string' ? content.name : '';
  const template = templateRef(content);
  if (template) return { name, instructions: null, template };
  return { name, instructions: typeof content.instructions === 'string' ? content.instructions : null };
}

/** The approval card's template sentence: which template, and whether approving downloads it. */
export function templateApprovalNote(content: Record<string, unknown>): string {
  const template = templateRef(content);
  if (!template) return '';
  const source = hasLocalTemplate(template) ? 'already on this machine' : 'downloaded from the public template library';
  return ` It will be built from the template "${template}" (${source}).`;
}

/** Guard hold: card the requesting group's admin chain. */
export async function requestCreateAgentHold(content: Record<string, unknown>, session: Session): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const template = templateRef(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!sourceGroup) return;

  await requestApproval({
    session,
    agentName: sourceGroup.name,
    action: 'create_agent',
    payload: createAgentHoldPayload(content),
    title: 'Create an agent',
    // The name the asking agent chose, as one quoted line, then the ask in the assistant's voice (KTD14).
    question: [
      `Name: ${quoted(name, NAME_LIMIT)}`,
      ...(template
        ? [
            `Template: ${quoted(template, NAME_LIMIT)}, ${hasLocalTemplate(template) ? 'already on this machine' : 'downloaded from the public template library'}`,
          ]
        : []),
      "I'd like to create a new agent for this, with its own workspace and container.",
    ].join('\n'),
    details: {
      supplied: {
        name: { text: name, source: 'agent' },
        ...(template ? { template: { text: template, source: 'agent' } } : {}),
      },
    },
  });
}

export interface CreateAgentOptions {
  /**
   * Suppress the terminal `Agent "<name>" created…` success notify. Error
   * notifies (collision, invalid path) still fire. For wrappers whose own
   * completion text is the requester's only "done" signal — e.g.
   * slack-agent-flow, where Slack provisioning runs AFTER this returns and
   * relaying the upstream text would report "done" ~a minute early.
   */
  suppressCreatedNotify?: boolean;
}

/** Guard allow body: performs the creation (fresh global-scope call or approved replay). */
export async function createAgent(
  content: Record<string, unknown>,
  session: Session,
  options?: CreateAgentOptions,
): Promise<void> {
  const name = typeof content.name === 'string' ? content.name : '';
  const instructions = typeof content.instructions === 'string' ? content.instructions : null;
  const template = templateRef(content);
  const sourceGroup = await getAgentGroup(session.agent_group_id);
  if (!name || !sourceGroup) return; // precheck already answered the requester

  const notify = (text: string): Promise<void> => notifyAgent(session, text);
  const localName = normalizeName(name);
  // Collision in the creator's destination namespace
  if (await getDestinationByName(sourceGroup.id, localName)) {
    await notify(`Cannot create agent "${name}": you already have a destination named "${localName}".`);
    return;
  }

  // Subagent path: a child inherits its creator's EFFECTIVE provider, NOT the
  // instance-wide default — so a child is never spawned on a runtime the parent
  // can't reach (e.g. a codex-only install where claude isn't authenticated).
  // A NULL parent resolves to claude. The operator can still flip a child
  // later with `ncl groups config update --provider`.
  const parentProvider = (await getContainerConfig(sourceGroup.id))?.provider ?? 'claude';

  // The child's id comes first, so the two destinations it will get are judged
  // before either kind of create fetches or writes anything: a refused one
  // leaves no group behind without them.
  const agentGroupId = `ag-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const now = new Date().toISOString();
  const wiring: NewAgentWiring = {
    toChild: {
      agent_group_id: sourceGroup.id,
      local_name: localName,
      target_type: 'agent',
      target_id: agentGroupId,
      created_at: now,
    },
    toParent: {
      agent_group_id: agentGroupId,
      local_name: 'parent',
      target_type: 'agent',
      target_id: sourceGroup.id,
      created_at: now,
    },
  };
  for (const proposed of [wiring.toChild, wiring.toParent]) {
    const refusal = await destinationRefusal({ proposed });
    if (refusal) {
      await notify(`Cannot create agent "${name}": ${refusal.reason}`);
      log.warn('create_agent refused by destination admission', {
        policy: refusal.policyId,
        name,
        parent: sourceGroup.id,
      });
      return;
    }
  }

  if (template) {
    await createFromTemplate(template, name, wiring, parentProvider, session, sourceGroup, notify, options);
  } else {
    await performCreateAgent(name, instructions, wiring, parentProvider, session, sourceGroup, notify, options);
  }
}

/** The two destinations a new child gets, judged before it is created. */
interface NewAgentWiring {
  /** The creator's row naming the child. */
  toChild: AgentDestination;
  /** The child's row naming its creator. */
  toParent: AgentDestination;
}

/**
 * Template branch: fetch, then stamp. The fetch comes before any DB write, so
 * a failed download leaves nothing behind. Same authorization caveat as
 * performCreateAgent.
 */
async function createFromTemplate(
  template: string,
  name: string,
  wiring: NewAgentWiring,
  parentProvider: string,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => Promise<void>,
  options?: CreateAgentOptions,
): Promise<void> {
  let fetched: boolean;
  let commit: string | undefined;
  try {
    ({ fetched, commit } = await ensureTemplateLocal(template));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await notify(`Cannot create agent "${name}" from template "${template}": ${msg}. Nothing was created.`);
    log.warn('create_agent template fetch failed', { template, err });
    return;
  }

  let stamped: Awaited<ReturnType<typeof createAgentFromTemplate>>;
  try {
    stamped = await createAgentFromTemplate(template, {
      id: wiring.toParent.agent_group_id,
      name,
      provider: parentProvider,
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await notify(`Cannot create agent "${name}": template "${template}" could not be applied: ${msg}.`);
    log.error('create_agent template stamp failed', { template, err });
    return;
  }

  await wireNewAgent(wiring, session);
  const localName = wiring.toChild.local_name;

  if (!options?.suppressCreatedNotify) {
    const notices = stamped.report.length > 0 ? `\n${stamped.report.join('\n')}` : '';
    await notify(
      `Agent "${localName}" created from template "${template}". You can now message it with send_message({ to: "${localName}", ... }).${notices}`,
    );
  }
  log.info('Agent group created from template', {
    agentGroupId: stamped.group.id,
    name,
    localName,
    template,
    fetched,
    commit,
    parent: sourceGroup.id,
  });
}

/**
 * Core creation: writes the new agent group + bidirectional destinations and
 * scaffolds its filesystem, then reports via `notify`. Authorization is the
 * CALLER's responsibility (the guard's agents.create decision) — never call
 * this from an unauthorized path, as it performs privileged central-DB
 * writes a confined container is
 * otherwise barred from.
 */
async function performCreateAgent(
  name: string,
  instructions: string | null,
  wiring: NewAgentWiring,
  parentProvider: string,
  session: Session,
  sourceGroup: AgentGroup,
  notify: (text: string) => Promise<void>,
  options?: CreateAgentOptions,
): Promise<void> {
  const localName = wiring.toChild.local_name;
  const agentGroupId = wiring.toParent.agent_group_id;
  // Derive a safe folder name, deduplicated globally across
  // agent_groups.folder AND the on-disk groups/ dir: a folder present on disk
  // with no claiming DB row is deleted-group residue, and adopting it would
  // silently re-scope the old group's data under the new agent's identity —
  // skip to the next suffix instead (templates/create-agent.ts precedent).
  let folder = localName;
  let suffix = 2;
  while ((await getAgentGroupByFolder(folder)) || groupFolderExistsOnDisk(folder)) {
    folder = `${localName}-${suffix}`;
    suffix++;
  }

  const groupPath = path.join(GROUPS_DIR, folder);
  const resolvedPath = path.resolve(groupPath);
  const resolvedGroupsDir = path.resolve(GROUPS_DIR);
  if (!resolvedPath.startsWith(resolvedGroupsDir + path.sep)) {
    await notify(`Cannot create agent "${name}": invalid folder path.`);
    log.error('create_agent path traversal attempt', { folder, resolvedPath });
    return;
  }

  const newGroup: AgentGroup = {
    id: agentGroupId,
    name,
    folder,
    agent_provider: null,
    created_at: wiring.toParent.created_at,
  };
  await createAgentGroup(newGroup);
  // Passing the provider pins the child's scaffold and stamps its config row in one step.
  await initGroupFilesystem(newGroup, { instructions: instructions ?? undefined, provider: parentProvider });
  await wireNewAgent(wiring, session);

  if (!options?.suppressCreatedNotify) {
    await notify(
      `Agent "${localName}" created. You can now message it with send_message({ to: "${localName}", ... }).`,
    );
  }
  log.info('Agent group created', { agentGroupId, name, localName, folder, parent: sourceGroup.id });
}

/** Wire a new child into its creator's messaging, for both kinds of create, with the rows judged before it. */
async function wireNewAgent({ toChild, toParent }: NewAgentWiring, session: Session): Promise<void> {
  // Insert bidirectional destination rows (= ACL grants).
  // Creator refers to child by the name it chose; child refers to creator as "parent".
  await createDestination(toChild);
  // Handle the unlikely case where the child already has a "parent" destination
  // (shouldn't happen for a brand-new agent, but be safe).
  let parentName = 'parent';
  let parentSuffix = 2;
  while (await getDestinationByName(toParent.agent_group_id, parentName)) {
    parentName = `parent-${parentSuffix}`;
    parentSuffix++;
  }
  await createDestination({ ...toParent, local_name: parentName });

  // REQUIRED: project the new destination into the running container's
  // inbound.db. See the top-of-file invariant in db/agent-destinations.ts
  // — forgetting this causes "dropped: unknown destination" when the parent
  // tries to send to the newly-created child.
  await writeDestinations(session.agent_group_id, session.id);
}
