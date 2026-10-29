export interface ScenarioCase {
  readonly id: string;
  readonly available: boolean;
  readonly requirement: string;
  readonly unit: string;
  readonly audience: 'main' | 'external-email';
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
  readonly actor: 'main' | 'external-email' | 'look-back' | 'look-ahead' | 'unattributed-planner';
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
  readonly role: 'look-back' | 'look-ahead';
  readonly runFile: string;
  readonly memoryDirectory?: string;
  readonly allowedNclPairs: readonly string[];
}
