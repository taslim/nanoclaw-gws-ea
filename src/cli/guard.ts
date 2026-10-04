/**
 * CLI guard adapter — the command registry's catalog derivation and
 * structural decision, moved verbatim out of dispatch.ts.
 * Declaration is registration: registry.register() derives one
 * catalog entry per command from the CommandDef itself; no second file is
 * edited when a command is added.
 *
 * The decide fn carries today's decisions exactly:
 *   host caller → allow (the 0600 socket is the auth story — in code,
 *   unremovable by data);
 *   cli_scope 'disabled' → deny; 'group' → resource allowlist, cross-group
 *   arg denial, cli_scope-change denial;
 *   access 'approval' for agent callers → hold for the group's admin chain.
 * One registration seam on top: a protected agent group (registered by the
 * module that owns it) is the host's alone, so any agent caller's command
 * that names one is denied, whatever its CLI scope or an approval.
 *
 * Arg auto-fill, the sessions-get existence oracle, and post-handler row
 * filtering stay in dispatch.ts — mechanics, not policy.
 */
import { getContainerConfig } from '../db/container-configs.js';
import { getMessagingGroupAgent } from '../db/messaging-groups.js';
import { getSession } from '../db/sessions.js';
import { ALLOW, DENY, HOLD, type GuardedActionSpec, type GuardInput } from '../guard/index.js';
import { GROUP_SCOPE_RESOURCES, type CommandDef } from './registry.js';

const GROUP_WIRING_COMMANDS = new Set(['wirings-get', 'wirings-update']);
const GROUP_WIRING_UPDATE_ARGS = new Set(['id', 'agent_group_id', 'group', 'help', 'engage_mode', 'engage_pattern']);

/**
 * Says why an agent group is the host's alone, or undefined when it is not.
 * A module registers one for a group whose configuration and reach no agent
 * may change, not even with an admin's approval.
 */
export type ProtectedGroupPolicy = (agentGroupId: string) => string | undefined | Promise<string | undefined>;

const protectedGroupPolicies = new Map<string, ProtectedGroupPolicy>();
const PROTECTED_GROUP_POLICY_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

/**
 * Register a protected-group policy. Every agent caller's `ncl` command that
 * names a protected group is denied, and so is any self-modification request
 * from one (src/modules/self-mod/guard.ts). The host caller is unaffected.
 */
export function registerProtectedGroupPolicy(id: string, policy: ProtectedGroupPolicy): void {
  if (!PROTECTED_GROUP_POLICY_ID.test(id)) throw new Error(`Invalid protected group policy ID: ${id}`);
  if (protectedGroupPolicies.has(id)) throw new Error(`Protected group policy already registered: ${id}`);
  protectedGroupPolicies.set(id, policy);
}

/** Why `agentGroupId` is protected, or undefined when no registered policy protects it. */
export async function protectedGroupReason(agentGroupId: string): Promise<string | undefined> {
  for (const policy of protectedGroupPolicies.values()) {
    const reason = await policy(agentGroupId);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * The agent groups a command names: its group arguments, `--id` where it is
 * the group (groups, destinations) or names a row of one (a wiring, a
 * session), and both ends of an agent message policy.
 */
async function namedGroups(cmd: CommandDef, args: Record<string, unknown>): Promise<string[]> {
  const named = new Set<string>();
  const add = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) named.add(value);
  };
  for (const key of ['agent_group_id', 'agent-group-id', 'group']) add(args[key]);
  if (cmd.resource === 'policies') for (const key of ['from', 'to']) add(args[key]);
  if (typeof args.id === 'string') {
    if (cmd.resource === 'groups' || cmd.resource === 'destinations') add(args.id);
    else if (cmd.resource === 'wirings') add((await getMessagingGroupAgent(args.id))?.agent_group_id);
    else if (cmd.resource === 'sessions') add((await getSession(args.id))?.agent_group_id);
  }
  return [...named];
}

/** Dotted catalog action name for a command. */
export function commandGuardAction(cmd: Pick<CommandDef, 'name' | 'action'>): string {
  return cmd.action ?? `cli.${cmd.name}`;
}

/** Catalog entry derived from a CommandDef at registration time. */
export function commandGuardSpec(cmd: CommandDef): GuardedActionSpec {
  return {
    action: commandGuardAction(cmd),
    grantActionName: cmd.access === 'approval' ? 'cli_command' : undefined,
    // Bind a cli_command grant to the exact command it was approved for.
    grantCoversRequest: (grant) => {
      try {
        const payload = JSON.parse(grant.payload) as { frame?: { command?: string } };
        return payload.frame?.command === cmd.name;
      } catch {
        return false;
      }
    },
    decide: (input) => commandDecide(cmd, input),
  };
}

async function commandDecide(cmd: CommandDef, input: GuardInput) {
  const { actor } = input;
  if (actor.kind === 'host') return ALLOW('host caller (trusted socket)');
  if (actor.kind !== 'agent') return DENY('CLI commands accept host or agent callers only.');

  // Host-only commands (e.g. mount management) are operator-only: rejected for
  // ANY container caller, regardless of cli_scope (even `global`) or approval.
  // The mount allowlist is the boundary cli_scope itself lives inside, so an
  // agent must never alter it — not even with admin approval.
  if (cmd.hostOnly) {
    return DENY(`"${cmd.name}" is operator-only and cannot be run from inside a container.`);
  }

  if (protectedGroupPolicies.size > 0) {
    for (const agentGroupId of await namedGroups(cmd, input.payload)) {
      const reason = await protectedGroupReason(agentGroupId);
      if (reason !== undefined) return DENY(`"${cmd.name}" may not address agent group ${agentGroupId}: ${reason}`);
    }
  }

  const args = input.payload;
  const cliScope = (await getContainerConfig(actor.agentGroupId))?.cli_scope ?? 'group';

  if (cliScope === 'disabled') {
    return DENY('CLI access is disabled for this agent group.');
  }

  if (cliScope === 'group') {
    const groupWiringCommand = cmd.resource === 'wirings' && GROUP_WIRING_COMMANDS.has(cmd.name);

    // Only allow whitelisted resources and general commands (no resource, like help)
    if (cmd.resource && !GROUP_SCOPE_RESOURCES.has(cmd.resource) && !groupWiringCommand) {
      return DENY(`CLI access is scoped to this agent group. Cannot access "${cmd.resource}".`);
    }

    // Enforce group scope on all agent-group-related args.
    // Different resources use different arg names for the agent group ID.
    // Only check --id for resources where it IS the agent group ID.
    for (const key of ['agent_group_id', 'group'] as const) {
      if (args[key] && args[key] !== actor.agentGroupId) {
        return DENY('CLI access is scoped to this agent group.');
      }
    }
    if ((cmd.resource === 'groups' || cmd.resource === 'destinations') && args.id && args.id !== actor.agentGroupId) {
      return DENY('CLI access is scoped to this agent group.');
    }

    if (
      groupWiringCommand &&
      cmd.name === 'wirings-update' &&
      Object.keys(args).some((key) => !GROUP_WIRING_UPDATE_ARGS.has(key.replace(/-/g, '_')))
    ) {
      return DENY('Group-scoped wiring updates may only change engage_mode or engage_pattern.');
    }

    // Block cli_scope changes from group-scoped agents (privilege escalation)
    if (args.cli_scope !== undefined || args['cli-scope'] !== undefined) {
      return DENY('Cannot change cli_scope from a group-scoped agent.');
    }
  }

  if (cmd.access === 'approval') {
    return HOLD(`agent-initiated "${cmd.name}" requires admin approval`);
  }

  return ALLOW('open command');
}
