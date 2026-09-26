/**
 * The engine-to-driver contract. Steps report typed events; human input
 * reaches the engine only through the `Interaction` port. The driver
 * (setup/gws-ea*.ts) renders the events and supplies the terminal prompts;
 * nothing here imports setup/.
 */
import type { ProviderCredential, ProviderCredentialMetadata } from '../provider-credential.js';
import type { RetainedManagedIngressSetupSession } from './cloudflare-api.js';
import { describeSecretInput, SECRET_INPUTS, type SecretInput, type SecretSource } from './create-input.js';
import type { ProvisionHumanPause } from './phases.js';
import { registerSecret } from './redact.js';
import type { RunLog, StepLog } from './run-log.js';
import { GwsEaError, type GwsEaErrorOptions } from './types.js';

export type RunEvent =
  /** Unlabeled steps are logged but not rendered as progress. */
  | { readonly type: 'step-started'; readonly step: string; readonly label?: string }
  | { readonly type: 'step-waiting'; readonly step: string; readonly reason: string }
  | { readonly type: 'step-completed'; readonly step: string }
  /** `pause` is absent when the step stopped for an input it could not ask for (`PauseRequired`). */
  | { readonly type: 'step-paused'; readonly step: string; readonly pause?: ProvisionHumanPause }
  | { readonly type: 'step-failed'; readonly step: string; readonly error: unknown; readonly rawLog?: string };

/** Where a step reports: the driver's event listener and the run log. Both optional. */
export interface StepReporter {
  readonly emit?: (event: RunEvent) => void;
  readonly run?: RunLog;
}

export interface StepIdentity {
  readonly id: string;
  readonly label?: string;
}

/**
 * Run one named step: its commands log to its own raw log, and the driver
 * hears it start, wait, and complete, pause, or fail. `pauseOf` recognizes a
 * result that stops for a person; a thrown `PauseRequired` pauses too.
 */
export async function runStep<T>(
  reporter: StepReporter,
  step: StepIdentity,
  body: () => Promise<T>,
  pauseOf?: (result: T) => ProvisionHumanPause | undefined,
): Promise<T> {
  const emit = reporter.emit ?? (() => undefined);
  emit({ type: 'step-started', step: step.id, ...(step.label ? { label: step.label } : {}) });
  let log: StepLog | undefined;
  let pause: ProvisionHumanPause | undefined;
  const execute = async (stepLog?: StepLog): Promise<T> => {
    log = stepLog;
    const result = await body();
    pause = pauseOf?.(result);
    if (pause) stepLog?.mark('paused');
    return result;
  };
  try {
    const result = reporter.run ? await reporter.run.step(step.id, execute) : await execute();
    emit(pause ? { type: 'step-paused', step: step.id, pause } : { type: 'step-completed', step: step.id });
    return result;
  } catch (error) {
    emit(
      error instanceof PauseRequired
        ? { type: 'step-paused', step: step.id }
        : { type: 'step-failed', step: step.id, error, ...(log ? { rawLog: log.rawLog } : {}) },
    );
    throw error;
  }
}

const pendingActions = new WeakMap<object, ProvisionHumanPause>();

/** Attach the human action a failure blocked, so the stop summary still names it. */
export function withPendingAction<E extends object>(error: E, action: ProvisionHumanPause): E {
  pendingActions.set(error, action);
  return error;
}

export function pendingActionOf(error: unknown): ProvisionHumanPause | undefined {
  return typeof error === 'object' && error !== null ? pendingActions.get(error) : undefined;
}

/**
 * The run needs a person but none can be asked: the command pauses with exit
 * 10, and `instructions` say how to supply the input before resuming.
 */
export class PauseRequired extends GwsEaError {
  readonly instructions: readonly string[];

  constructor(code: string, message: string, instructions: readonly string[]) {
    super(code, message);
    this.name = 'PauseRequired';
    this.instructions = instructions;
  }
}

/**
 * Google Cloud refused a command because the operator's sign-in expired. The
 * step engine signs in through the `Interaction` port and runs the step again
 * from its observations, so nothing it already changed is changed twice.
 */
export class SignInRequired extends GwsEaError {
  constructor(message: string, options?: GwsEaErrorOptions) {
    super('gcloud_auth_required', message, options);
    this.name = 'SignInRequired';
  }
}

/**
 * Run `work`; when it finds the Google sign-in expired, sign in once and run
 * it again. Without `signIn` the refusal stands. `onSignIn` hears the refusal
 * first, so the caller can log it.
 */
export async function withGoogleSignIn<T>(
  work: () => Promise<T>,
  signIn: (() => Promise<void>) | undefined,
  onSignIn?: (refusal: SignInRequired) => void,
): Promise<T> {
  try {
    return await work();
  } catch (error) {
    if (!(error instanceof SignInRequired) || !signIn) throw error;
    onSignIn?.(error);
    await signIn();
    return work();
  }
}

/** Human decisions supplied on re-entry; the engine persists them. */
export interface HumanDecisions {
  /** `--chat-configured`: the operator finished the Google Chat app configuration. */
  readonly chatConfigured: boolean;
  /** `--messaging-group-id`: the principal conversation the operator chose. */
  readonly messagingGroupId?: string;
}

/** What to do after a human pause: stop and report it, or run on with any decisions the person made. */
export type PauseResponse =
  | { readonly kind: 'stop' }
  | { readonly kind: 'continue'; readonly decisions?: Partial<HumanDecisions> };

export interface ProviderCredentialRequest {
  readonly providerId: string;
  readonly metadata: ProviderCredentialMetadata;
}

export interface CloudflareTokenRequest {
  readonly accountId: string;
  /** Why the token is needed, shown to the operator. */
  readonly reason: string;
}

/** The engine's only way to obtain human input. */
export interface Interaction {
  readonly decisions: HumanDecisions;
  requestProviderCredential(request: ProviderCredentialRequest): Promise<ProviderCredential>;
  requestCloudflareAccountToken(request: CloudflareTokenRequest): Promise<string>;
  /** Always the browser flow (`gcloud auth login --force`); without an account, the operator picks one. */
  signInToGoogleCloud(account?: string): Promise<void>;
  /** Create: whether the signed-in `account` should own the new assistant's Google Cloud project. */
  confirmGoogleAccount(account: string): Promise<boolean>;
  /** Hand the terminal to an interactive child, suspending progress rendering around it. */
  withTerminal<T>(work: () => Promise<T>): Promise<T>;
  /**
   * Attend a human pause at a terminal: ask for a confirmation or a choice, or
   * wait for what the person was asked to do. Without a terminal it stops.
   * `signal` aborts a wait, which then stops.
   */
  attendPause(pause: ProvisionHumanPause, signal: AbortSignal): Promise<PauseResponse>;
  /** The same port, with the decisions made while attending a pause. */
  withDecisions(decisions: Partial<HumanDecisions>): Interaction;
}

/** What a person at the terminal can be asked. The driver supplies this only on a TTY. */
export interface InteractivePrompts {
  providerCredential(providerId: string): Promise<ProviderCredential>;
  cloudflareAccountToken(request: CloudflareTokenRequest): Promise<string>;
  googleCloudSignIn(account?: string): Promise<void>;
  googleAccount(account: string): Promise<boolean>;
  attendPause?(pause: ProvisionHumanPause, signal: AbortSignal): Promise<PauseResponse>;
}

export interface InteractionOptions {
  readonly decisions: HumanDecisions;
  readonly secrets: SecretSource;
  readonly prompts?: InteractivePrompts;
  readonly terminal?: { suspend(): void; resume(): void };
  readonly managedIngressSetup: Pick<
    RetainedManagedIngressSetupSession,
    'discoverZones' | 'retainAccountToken' | 'requireAccountToken'
  >;
}

function secretPause(input: SecretInput, message: string): PauseRequired {
  return new PauseRequired('input_required', message, [`Supply it without a prompt: ${describeSecretInput(input)}.`]);
}

/**
 * The standard port: a supplied secret wins, then a terminal prompt, else the
 * run pauses naming how to supply it. Every secret received is registered with
 * the redactor before anything else sees it.
 */
export function createInteraction(options: InteractionOptions): Interaction {
  const { secrets, prompts, terminal, managedIngressSetup } = options;
  const withTerminal = async <T>(work: () => Promise<T>): Promise<T> => {
    terminal?.suspend();
    try {
      return await work();
    } finally {
      terminal?.resume();
    }
  };
  const received = (value: string): string => {
    registerSecret(value);
    return value;
  };

  return {
    decisions: options.decisions,
    withTerminal,
    async requestProviderCredential({ providerId, metadata }) {
      const supplied = secrets.get('providerCredential');
      if (supplied) return { ...metadata, value: supplied };
      if (!prompts) {
        throw secretPause(
          'providerCredential',
          `The ${providerId} provider credential (${SECRET_INPUTS.providerCredential}) is required.`,
        );
      }
      const credential = await withTerminal(() => prompts.providerCredential(providerId));
      received(credential.value);
      return credential;
    },
    async requestCloudflareAccountToken(request) {
      let token = secrets.get('cloudflareAccountToken');
      if (!token) {
        if (!prompts) {
          throw secretPause(
            'cloudflareAccountToken',
            `A Cloudflare API token (${SECRET_INPUTS.cloudflareAccountToken}) is required: ${request.reason.replace(/\.$/u, '')}.`,
          );
        }
        token = received(await withTerminal(() => prompts.cloudflareAccountToken(request)));
      }
      const zones = await managedIngressSetup.discoverZones(token);
      if (!zones.some((zone) => zone.accountId === request.accountId)) {
        throw new GwsEaError(
          'cloudflare_capability_missing',
          'The Cloudflare token cannot access an active zone in the reserved account.',
        );
      }
      managedIngressSetup.retainAccountToken(token);
      return managedIngressSetup.requireAccountToken(request.accountId);
    },
    async signInToGoogleCloud(account) {
      if (!prompts) {
        throw new PauseRequired(
          'gcloud_sign_in_required',
          `Google Cloud sign-in is required${account ? ` for ${account}` : ''}.`,
          [`Sign in: gcloud auth login${account ? ` ${account}` : ''} --force`],
        );
      }
      await withTerminal(() => prompts.googleCloudSignIn(account));
    },
    async confirmGoogleAccount(account) {
      if (!prompts) {
        throw new GwsEaError(
          'input_required',
          `Confirm the Google account that owns this assistant's Google Cloud project: pass --google-account ${account}, or run gws-ea create in a terminal to be asked.`,
          { details: { flag: '--google-account' } },
        );
      }
      return withTerminal(() => prompts.googleAccount(account));
    },
    async attendPause(pause, signal) {
      if (!prompts?.attendPause) return { kind: 'stop' };
      const attend = prompts.attendPause;
      return withTerminal(() => attend(pause, signal));
    },
    withDecisions(decisions) {
      return createInteraction({ ...options, decisions: { ...options.decisions, ...decisions } });
    },
  };
}
