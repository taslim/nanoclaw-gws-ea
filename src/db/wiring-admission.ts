import type { AgentDestination, MessagingGroupAgent } from '../types.js';

export interface WiringAdmissionInput {
  readonly operation: 'create' | 'update';
  readonly proposed: MessagingGroupAgent;
  readonly current?: MessagingGroupAgent;
}

export type WiringAdmissionPolicy = (input: WiringAdmissionInput) => void | Promise<void>;

const policies = new Map<string, WiringAdmissionPolicy>();
const POLICY_ID = /^[a-z0-9][a-z0-9._-]*:[a-z0-9][a-z0-9._-]*$/u;

/** Register an invariant checked by every supported wiring mutation path. */
export function registerWiringAdmissionPolicy(id: string, policy: WiringAdmissionPolicy): void {
  if (!POLICY_ID.test(id)) throw new Error(`Invalid wiring admission policy ID: ${id}`);
  if (policies.has(id)) throw new Error(`Wiring admission policy already registered: ${id}`);
  policies.set(id, policy);
}

export async function assertWiringAdmitted(input: WiringAdmissionInput): Promise<void> {
  for (const policy of policies.values()) await policy(input);
}

export interface DestinationAdmissionInput {
  /** The `agent_destinations` row about to be written: by `ncl destinations add`, a wiring's companion row, or `create_agent`. */
  readonly proposed: AgentDestination;
}

/** Returns why the destination is refused, or undefined to admit it. */
export type DestinationAdmissionPolicy = (
  input: DestinationAdmissionInput,
) => string | undefined | Promise<string | undefined>;

/** A registered policy refused a destination; nothing was written. */
export class DestinationRefusedError extends Error {
  constructor(
    readonly policyId: string,
    readonly reason: string,
  ) {
    super(`Destination refused: ${reason}`);
    this.name = 'DestinationRefusedError';
  }
}

const destinationPolicies = new Map<string, DestinationAdmissionPolicy>();

/**
 * Register an invariant checked before every destination row is written.
 * A destination is an ACL grant: the row lets its owner send to its target.
 */
export function registerDestinationAdmissionPolicy(id: string, policy: DestinationAdmissionPolicy): void {
  if (!POLICY_ID.test(id)) throw new Error(`Invalid destination admission policy ID: ${id}`);
  if (destinationPolicies.has(id)) throw new Error(`Destination admission policy already registered: ${id}`);
  destinationPolicies.set(id, policy);
}

/** Why a registered policy refuses the destination, or undefined when every policy admits it. */
export async function destinationRefusal(
  input: DestinationAdmissionInput,
): Promise<DestinationRefusedError | undefined> {
  for (const [id, policy] of destinationPolicies) {
    const reason = await policy(input);
    if (reason !== undefined) return new DestinationRefusedError(id, reason);
  }
  return undefined;
}

export async function assertDestinationAdmitted(input: DestinationAdmissionInput): Promise<void> {
  const refusal = await destinationRefusal(input);
  if (refusal) throw refusal;
}
