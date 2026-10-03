/**
 * Module-contributed container environment: how a module gives an agent
 * group's containers non-secret configuration derived from what the group may
 * do, such as the command settings of a tool only some groups hold.
 *
 * A module registers one contributor under a `<module-id>:<contributor-id>`
 * id. At every spawn composition calls each contributor with the group's id
 * and its resolved capabilities (src/capabilities.ts), and puts the merged
 * result on the agent container's contributed lane
 * (`ContainerSpec.contributedEnv`): a credential-named key such as a
 * placeholder token the gateway replaces is allowed there, and a credential
 * value is still refused (`validateSpec`).
 *
 * A contributor adds settings and never overrides one. A key that is not an
 * environment variable name, a key composition owns or already composed for
 * this container (the reserved set its caller passes: the timezone, the home
 * directory, the mailbox's keys, the model provider's and the gateway's), or a
 * key another contributor also set refuses the spawn as `spec-invalid`: the
 * session does not start while the collision stands. A collision means two
 * owners disagree about one setting, and letting either win silently would
 * hide that.
 */
import { specInvalid } from './drivers/types.js';

export interface ContainerEnvContext {
  /** The agent group being spawned. */
  readonly agentGroupId: string;
  /** Its capabilities, resolved exactly as the spawn grants them. */
  readonly capabilities: ReadonlySet<string>;
}

/** A module's settings for one spawn; an empty record adds nothing. */
export type ContainerEnvContributor = (ctx: ContainerEnvContext) => Readonly<Record<string, string>>;

const contributors = new Map<string, ContainerEnvContributor>();
const CONTRIBUTOR_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;
/** A POSIX environment variable name: nothing a realization could split into a second key. */
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/u;

/** Register a module's container env contributor. A malformed or duplicate id throws. */
export function registerContainerEnv(id: string, contributor: ContainerEnvContributor): void {
  if (!CONTRIBUTOR_ID.test(id)) {
    throw new Error(`Container env contributor "${id}" must use "<module-id>:<contributor-id>"`);
  }
  if (contributors.has(id)) throw new Error(`Container env contributor "${id}" is already registered`);
  contributors.set(id, contributor);
}

/**
 * Every contributor's settings for one spawn, merged. `reserved` names the
 * keys composition owns or has composed for this container; setting one of
 * them, or a key another contributor set, refuses the spawn.
 */
export function composeContainerEnv(ctx: ContainerEnvContext, reserved: ReadonlySet<string>): Record<string, string> {
  const env: Record<string, string> = {};
  const owners = new Map<string, string>();
  for (const [id, contributor] of contributors) {
    for (const [key, value] of Object.entries(contributor(ctx))) {
      if (!ENV_NAME.test(key)) {
        throw specInvalid(`container env contributor "${id}" set '${key}', which is not an environment variable name`);
      }
      if (reserved.has(key)) {
        throw specInvalid(`container env contributor "${id}" may not set '${key}': core composes it`);
      }
      const owner = owners.get(key);
      if (owner !== undefined) {
        throw specInvalid(`container env contributors "${owner}" and "${id}" both set '${key}'`);
      }
      owners.set(key, id);
      env[key] = value;
    }
  }
  return env;
}
