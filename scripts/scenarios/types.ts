import type { Destination } from '../../src/mailbox/types.js';
import type { TaskRecord } from '../../src/mailbox/model.js';
export interface ScenarioCase {
  readonly id: string;
  readonly available: boolean;
  /** Native data can be prepared while an independently required model path is pending. */
  readonly datasetReady?: boolean;
  readonly requirement: string;
  readonly unit: string;
  readonly audience: 'main' | 'external-email' | 'external-chat';
  /** Internal task report only; no outward send is asserted by this case. */
  readonly observationOnly?: boolean;
  readonly input: string;
  readonly facts: readonly string[];
  readonly validOutcomes: readonly string[];
  readonly unacceptable: readonly string[];
  readonly task?: boolean;
  readonly retry?: boolean;
  readonly privateMarkers?: readonly string[];
}

export interface Effect {
  readonly kind: 'message' | 'event' | 'tool';
  readonly operation: string;
  readonly target: string;
  readonly payload: Readonly<Record<string, unknown>>;
  readonly actor: 'main' | 'external-email' | 'external-chat' | 'look-back' | 'look-ahead' | 'unattributed-planner';
  readonly attempt: number;
}

export interface MechanicalScore {
  readonly pass: boolean;
  readonly violations: readonly string[];
}

export interface JudgeVerdict {
  readonly pass: boolean;
  readonly score: number;
  readonly rationale: string;
  readonly observedOutcome: string;
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
  readonly close?: {
    readonly runId: string;
    readonly task: TaskRecord;
    readonly destinations: readonly Destination[];
    readonly scheduledAt: string;
    readonly scope: {
      readonly referenceAt: string;
      readonly today: string;
      readonly tomorrow: string;
      readonly due: string;
      readonly completedThrough: string;
      readonly matterId?: string;
    };
  };
  readonly context?: string;
  readonly handoff?: { readonly id: string; readonly timestamp: string; readonly content: string };
  readonly weekViewFile?: string;
  readonly fixturePublicWeb?: boolean;
  readonly fixturePlanning?: boolean;
  readonly db: string;
}
