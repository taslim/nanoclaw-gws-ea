import type { MessagingGroupAgent } from '../types.js';

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
