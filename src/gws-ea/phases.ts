/**
 * The step engine. Each step owns resources it observes as present,
 * absent, or unknown, and the step is complete only when all are present.
 * A run checks completed runtime steps once, then advances the first
 * incomplete step onward; the journal records only when each step started and
 * completed, so resume needs no attempt bookkeeping.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { PauseRequired, runStep, withGoogleSignIn, withPendingAction, type StepReporter } from './events.js';
import {
  readProvisionJournal,
  recordStepCompleted,
  recordStepFailure,
  recordStepStarted,
  type InstanceOperation,
  type ProvisionJournal,
} from './journal.js';
import { activeStep } from './run-log.js';
import { GwsEaError, PROVISION_STEPS, type ProvisionStepId } from './types.js';

export interface ProvisionHumanPause {
  readonly kind: 'human-action';
  readonly phase: ProvisionStepId;
  readonly code: string;
  readonly message: string;
  readonly details?: readonly string[];
  readonly actionUrl?: string;
  readonly resumeFlag?: string;
  readonly choices?: readonly { readonly id: string; readonly label: string }[];
}

export type Observation =
  | { readonly status: 'present' }
  /** `reason` says what was seen, for the wait message and a failure after setup. */
  | { readonly status: 'absent'; readonly reason?: string }
  /** The observation could not decide; `evidence` is what was seen, for the log and the stop summary. */
  | { readonly status: 'unknown'; readonly reason: string; readonly evidence: string }
  | { readonly status: 'pause'; readonly pause: ProvisionHumanPause };

export const PRESENT: Observation = Object.freeze({ status: 'present' });
export const ABSENT: Observation = Object.freeze({ status: 'absent' });

export interface StepResource<Context> {
  /** Names the resource in waits and errors, e.g. "the NanoClaw host". */
  readonly name: string;
  /**
   * What an unknown observation permits. By default the engine waits and
   * re-observes, then stops without changing anything; `create-by-unique-id`
   * applies anyway, for a resource created under the instance's own unique ID.
   */
  readonly unknown?: 'wait' | 'create-by-unique-id';
  /**
   * The observation reports a runtime that is still starting as unknown, so
   * absent means stopped: liveness repairs it at once instead of waiting.
   */
  readonly absentMeansStopped?: boolean;
  readonly observe: (context: Context) => Promise<Observation>;
  /** Create or repair the resource; returns a pause when only a person can continue. */
  readonly apply: (context: Context) => Promise<ProvisionHumanPause | undefined>;
}

export interface ProvisionStep<Context> {
  readonly label: string;
  readonly resources: readonly StepResource<Context>[];
  /**
   * A runtime step: once complete, every run re-checks it first and repairs
   * it locally. The label names that check.
   */
  readonly liveness?: { readonly label: string };
  /** Completed runtime steps this step's pause needs; re-checked before pausing. */
  readonly pauseNeeds?: readonly ProvisionStepId[];
}

export type ProvisionSteps<Context> = Readonly<Record<ProvisionStepId, ProvisionStep<Context>>>;

/** Seconds between observations of a resource that is not yet conclusive. */
export const OBSERVATION_WAITS_SECONDS = [1, 2, 4, 8, 16, 30] as const;

export interface ProvisionRuntime extends StepReporter {
  /** Waits between observations. */
  readonly sleep?: (milliseconds: number) => Promise<void>;
  /** Renews the reserved account's Google sign-in when a step finds it expired. */
  readonly signIn?: () => Promise<void>;
}

export type ProvisionResult =
  | { readonly status: 'ready' }
  | { readonly status: 'paused'; readonly pause: ProvisionHumanPause };

type Pause = ProvisionHumanPause | undefined;

/**
 * Run order: one liveness pass over completed runtime steps, then every
 * incomplete step in order. The caller runs prerequisites first and owns the
 * instance operation; a returned pause lets it release the lock.
 */
export async function runProvisionSteps<Context>(
  operation: InstanceOperation,
  context: Context,
  steps: ProvisionSteps<Context>,
  runtime: ProvisionRuntime = {},
): Promise<ProvisionResult> {
  const sleep = runtime.sleep ?? ((milliseconds: number) => delay(milliseconds));
  let journal: ProvisionJournal = await readProvisionJournal(operation.paths, operation.instanceId);
  const completed = (id: ProvisionStepId): boolean => journal.steps[id]?.completed_at !== undefined;

  /**
   * Observe until conclusive. Unknown is re-observed on the wait schedule, and
   * so is absent when `waitOnAbsent` (a runtime may still be starting, or a
   * change may not be visible yet).
   */
  const observe = async (
    id: ProvisionStepId,
    resource: StepResource<Context>,
    { waitOnAbsent, applyOnUnknown }: { readonly waitOnAbsent: boolean; readonly applyOnUnknown: boolean },
  ): Promise<Observation> => {
    const settled = (seen: Observation): boolean =>
      seen.status === 'present' ||
      seen.status === 'pause' ||
      (seen.status === 'absent' && !waitOnAbsent) ||
      (seen.status === 'unknown' && applyOnUnknown);
    const look = async (): Promise<Observation> => {
      const seen = await resource.observe(context);
      if (seen.status === 'unknown') activeStep()?.write(`${resource.name}: ${seen.reason} (${seen.evidence})\n`);
      if (seen.status === 'absent' && seen.reason) activeStep()?.write(`${resource.name}: ${seen.reason}\n`);
      return seen;
    };
    let seen = await look();
    for (const seconds of OBSERVATION_WAITS_SECONDS) {
      if (settled(seen)) return seen;
      const reason =
        seen.status === 'unknown'
          ? seen.reason
          : seen.status === 'absent' && seen.reason
            ? `Waiting for ${resource.name}: ${seen.reason}`
            : `Waiting for ${resource.name}…`;
      runtime.emit?.({ type: 'step-waiting', step: id, reason });
      await sleep(seconds * 1_000);
      seen = await look();
    }
    if (seen.status !== 'unknown' || applyOnUnknown) return seen;
    throw new GwsEaError('observation_unknown', `Could not tell the state of ${resource.name}: ${seen.reason}`, {
      details: { evidence: seen.evidence },
    });
  };

  /** Bring one resource to present, applying only when it is absent. */
  const ensure = async (
    id: ProvisionStepId,
    resource: StepResource<Context>,
    waitOnAbsent: boolean,
  ): Promise<Pause> => {
    const before = await observe(id, resource, {
      waitOnAbsent: waitOnAbsent && resource.absentMeansStopped !== true,
      applyOnUnknown: resource.unknown === 'create-by-unique-id',
    });
    if (before.status === 'present') return undefined;
    if (before.status === 'pause') return before.pause;
    const applied = await resource.apply(context);
    if (applied) return applied;
    // A change can take a while to become visible, so absent is waited on here too.
    const after = await observe(id, resource, { waitOnAbsent: true, applyOnUnknown: false });
    if (after.status === 'present') return undefined;
    if (after.status === 'pause') return after.pause;
    const seenReason = after.status === 'absent' && after.reason ? `: ${after.reason}` : '';
    throw new GwsEaError('step_incomplete', `${resource.name} is still missing after it was set up${seenReason}`);
  };

  /**
   * A step that finds the Google sign-in expired signs in once, then runs
   * again from its observations: whatever it already changed now observes
   * present, so no change is made twice.
   */
  const withSignIn = (body: () => Promise<Pause>): Promise<Pause> =>
    withGoogleSignIn(body, runtime.signIn, (refusal) =>
      activeStep()?.write(`${refusal.message}; signing in, then running the step again\n`),
    );

  /** Run a step's body as a logged step, recording any failure in the journal. */
  const stepRun = (id: ProvisionStepId, label: string, body: () => Promise<Pause>): Promise<Pause> =>
    runStep(
      runtime,
      { id, label },
      async () => {
        try {
          return await withSignIn(body);
        } catch (error) {
          if (!(error instanceof PauseRequired)) {
            const log = activeStep()?.rawLog ?? runtime.run?.progressLog;
            journal = await recordStepFailure(operation, id, error, log).catch(() => journal);
          }
          throw error;
        }
      },
      (pause) => pause,
    );

  const ensureAll = async (id: ProvisionStepId, waitOnAbsent: boolean): Promise<Pause> => {
    for (const resource of steps[id].resources) {
      const pause = await ensure(id, resource, waitOnAbsent);
      if (pause) return pause;
    }
    return undefined;
  };

  /** Liveness: the same observation, waited on before any local repair. */
  const checkRuntime = (id: ProvisionStepId): Promise<Pause> =>
    stepRun(id, steps[id].liveness?.label ?? steps[id].label, () => ensureAll(id, true));

  const advance = (id: ProvisionStepId): Promise<Pause> =>
    stepRun(id, steps[id].label, async () => {
      journal = await recordStepStarted(operation, id);
      const pause = await ensureAll(id, false);
      if (!pause) journal = await recordStepCompleted(operation, id);
      return pause;
    });

  /** Before handing a person a pause, re-check the runtime it depends on. */
  const confirmPause = async (id: ProvisionStepId, pause: ProvisionHumanPause): Promise<ProvisionHumanPause> => {
    for (const need of steps[id].pauseNeeds ?? []) {
      if (!steps[need].liveness || !completed(need)) continue;
      let blocking: Pause;
      try {
        blocking = await checkRuntime(need);
      } catch (error) {
        throw error instanceof Error ? withPendingAction(error, pause) : error;
      }
      if (blocking) return blocking;
    }
    return pause;
  };

  for (const id of PROVISION_STEPS) {
    if (!steps[id].liveness || !completed(id)) continue;
    const pause = await checkRuntime(id);
    if (pause) return { status: 'paused', pause };
  }
  for (const id of PROVISION_STEPS) {
    if (completed(id)) continue;
    const pause = await advance(id);
    if (pause) return { status: 'paused', pause: await confirmPause(id, pause) };
  }
  return { status: 'ready' };
}
