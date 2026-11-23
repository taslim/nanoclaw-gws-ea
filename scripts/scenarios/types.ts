import type { Destination, SessionRouting } from '../../src/mailbox/types.js';
import type { TaskRecord } from '../../src/mailbox/model.js';
import type { RuntimeInferenceInput } from '../../container/agent-runner/src/provider-contracts/registry.js';
export interface ScenarioCase {
  readonly id: string;
  readonly requirement: string;
  readonly unit: string;
  readonly audience: 'main' | 'external-email' | 'external-chat';
  readonly input: string;
  readonly facts: readonly string[];
  readonly validOutcomes: readonly string[];
  readonly unacceptable: readonly string[];
  readonly task?: boolean;
  readonly retry?: boolean;
  readonly privateMarkers?: readonly string[];
  /** When true, the turn wakes solely on seeded prior messages and/or main's handoff — no synthetic outsider input is appended. */
  readonly handoffOnly?: boolean;
  /** Optional mechanical cap on outward messages sent during the scenario (0 for restraint/stay-quiet cases, 1 for single-message outreach). */
  readonly maxOutwardMessages?: number;
  /** Opt out of the default US-English spelling hygiene check when a case explicitly requests UK spelling. */
  readonly allowUkSpelling?: boolean;
}

export interface Effect {
  readonly kind: 'message' | 'event' | 'tool';
  readonly operation: string;
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actor: 'main' | 'external-email' | 'external-chat' | 'look-back' | 'look-ahead';
  readonly attempt: number;
}

export interface MechanicalScore {
  readonly pass: boolean;
  readonly violations: readonly string[];
}

export interface JudgeDimensions {
  readonly outcome: number;
  readonly voice: number;
  readonly conciseness: number;
  readonly guardrails: number;
}

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly rationale: string;
  readonly observedOutcome: string;
  readonly dimensions?: JudgeDimensions;
}

export interface PriorMessage {
  readonly id: string;
  readonly timestamp: string;
  readonly channelType: string;
  readonly platformId: string;
  readonly threadId: string | null;
  readonly content: string;
  readonly trigger?: 0 | 1;
}

export interface PlannerPolicy {
  readonly agentId?: string;
  readonly role: 'look-back' | 'look-ahead';
  readonly runFile: string;
  readonly memoryDirectory?: string;
  readonly allowedNclPairs: readonly string[];
}

/** Only synthetic identity/configuration and module-authored nonsecret contributions are saved. */
export interface ScenarioComposition {
  readonly audience: ScenarioCase['audience'];
  readonly group: { readonly id: string; readonly name: string; readonly folder: string };
  readonly capabilities: string[];
  readonly storedCapabilities: readonly string[] | 'all';
  readonly skills: string[];
  readonly moduleEnvironment: Readonly<Record<string, string>>;
  readonly reservedEnvironmentKeys: readonly string[];
  readonly session: { readonly id: string; readonly messagingGroupId: string | null };
  readonly destinations: readonly Destination[];
  readonly routing: SessionRouting;
  readonly close?: {
    readonly runId: string;
    readonly task: TaskRecord;
    readonly scheduledAt: string;
    readonly scope: {
      readonly referenceAt: string;
      readonly today: string;
      readonly tomorrow: string;
      readonly due: string;
      readonly matterId?: string;
    };
  };
  readonly context?: string;
  readonly priorMessages?: readonly PriorMessage[];
  readonly handoff?: {
    readonly id: string;
    readonly timestamp: string;
    readonly content: string;
    readonly channelType?: string;
    readonly platformId?: string;
    readonly threadId?: string | null;
  };
  readonly weekViewFile?: string;
  /** The model, effort and speed the materialized container.json gives the runner. */
  readonly inference: RuntimeInferenceInput;
  readonly db: string;
}
