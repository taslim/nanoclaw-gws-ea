/**
 * The assistant's web alias (KTD13): one address of its own that it uses for
 * everything it does on the web in its own name. gws-ea derives its name,
 * the operator adds it in the Google Admin console, and a probe email from
 * the assistant to the alias verifies it before the host records it.
 *
 * The name is the assistant's name, lowercased, in ASCII, without spaces,
 * and reversed (R21); a palindrome moves its first letter to the end
 * instead. Later candidates number it: `onuj`, `onuj2`, `onuj3`, and so on.
 * A role address is never offered, and a name that gives no candidate (a
 * single repeated letter, or no ASCII letter at all) waits for the operator
 * to name the alias.
 *
 * The setup step runs once every journaled step is complete, and only while
 * the assistant's browser is enabled. It claims its candidate in the
 * registry under the machine lock, has the host ask for it, and pauses with
 * the Admin console steps; `--alias-added` sends the probe, `--alias-taken`
 * moves to the next candidate, and `--alias <name>` uses the operator's own.
 */
import { setTimeout as delay } from 'node:timers/promises';

import { runStep, type StepReporter } from './events.js';
import { runInstanceNclJson } from './ncl.js';
import type { ControlPlanePaths } from './paths.js';
import type { ProvisionHumanPause, ProvisionResult } from './phases.js';
import { claimInstanceAlias, getInstanceReservation, otherAssistantsMailboxes, readRegistry } from './registry.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { EMAIL_PATTERN, isRecord, optionalString, unwrapData } from './validation.js';

/** The longest stem: room for a four-digit number within the 64 characters an address's local part allows. */
const MAX_STEM_LENGTH = 60;
/** The longest local part Google Workspace takes for an address. */
const MAX_LOCAL_PART_LENGTH = 64;
/** The last numbered candidate; a stem's candidates stop there. */
const MAX_CANDIDATE = 9_999;

/**
 * Role addresses an alias never takes: the mailboxes RFC 2142 reserves, the
 * ones certificate authorities mail to prove control of a domain, and the
 * shared mailboxes sites and people treat as an organization's rather than
 * one person's. None ends in a digit, so only a stem itself can be one.
 */
const ROLE_ADDRESS_NAMES: ReadonlySet<string> = new Set([
  'abuse',
  'accounting',
  'accounts',
  'admin',
  'administrator',
  'billing',
  'careers',
  'compliance',
  'contact',
  'donotreply',
  'enquiries',
  'feedback',
  'ftp',
  'help',
  'helpdesk',
  'hostmaster',
  'hr',
  'info',
  'inquiries',
  'jobs',
  'legal',
  'mailerdaemon',
  'marketing',
  'media',
  'news',
  'noc',
  'nobody',
  'noreply',
  'office',
  'postmaster',
  'press',
  'privacy',
  'root',
  'sales',
  'security',
  'service',
  'support',
  'team',
  'usenet',
  'uucp',
  'webmaster',
  'www',
]);

/** A name's alias stem, or why the operator must name the alias with `--alias`. */
export type AliasStem =
  | { readonly status: 'derived'; readonly stem: string }
  | { readonly status: 'name_required'; readonly reason: string };

/** `name` as an address can carry it: accents dropped, lowercased, ASCII letters and digits only. */
function asciiName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

/** The first candidate's name, before any number: the assistant's name reversed, or rotated when that reads the same. */
export function aliasStem(assistantName: string): AliasStem {
  const name = asciiName(assistantName);
  if (!/[a-z]/u.test(name)) {
    return { status: 'name_required', reason: `"${assistantName}" has no ASCII letter to make an address of` };
  }
  const reversed = [...name].reverse().join('');
  const stem = reversed !== name ? reversed : `${name.slice(1)}${name.charAt(0)}`;
  if (stem === name) {
    return { status: 'name_required', reason: `"${assistantName}" reads the same reversed and rotated` };
  }
  return { status: 'derived', stem: stem.slice(0, MAX_STEM_LENGTH) };
}

/** The `index`th candidate: the stem, then the stem numbered from 2. */
function candidateName(stem: string, index: number): string {
  return index === 1 ? stem : `${stem}${index}`;
}

/** Where `name` falls among the stem's candidates, or undefined when it is none of them. */
function candidateIndex(stem: string, name: string): number | undefined {
  if (name === stem) return 1;
  if (!name.startsWith(stem)) return undefined;
  const suffix = name.slice(stem.length);
  return /^[1-9][0-9]*$/u.test(suffix) && Number(suffix) >= 2 ? Number(suffix) : undefined;
}

/** The first candidate the stem gives at or after `index`, past a role address, or undefined when none is left. */
function candidateFrom(stem: string, index: number): string | undefined {
  for (let next = index; next <= MAX_CANDIDATE; next += 1) {
    const name = candidateName(stem, next);
    if (!ROLE_ADDRESS_NAMES.has(name)) return name;
  }
  return undefined;
}

/** The first name offered for a stem: the stem itself, unless it is a role address. */
export function firstAliasCandidate(stem: string): string {
  // A role address never ends in a digit, so the stem numbered 2 never is one.
  return candidateFrom(stem, 1) ?? candidateName(stem, 2);
}

/**
 * The candidate after `current`, when the operator finds it taken: the next
 * number, or the first candidate when `current` is a name of the operator's
 * own. Undefined once the numbers run out.
 */
export function aliasCandidateAfter(stem: string, current: string): string | undefined {
  const index = candidateIndex(stem, current);
  return index === undefined ? firstAliasCandidate(stem) : candidateFrom(stem, index + 1);
}

/** The alias the operator named with `--alias`: its local part, and its domain when they gave a whole address. */
export interface AliasName {
  readonly local: string;
  readonly domain?: string;
}

/**
 * Letters, digits, and single dots, dashes or underscores between them, as
 * a Workspace address takes them; at least one letter.
 */
const LOCAL_PART_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

/** The operator's own alias name, checked as the Admin console would take it, and never a role address. */
export function parseAliasName(value: string): AliasName {
  const normalized = value.trim().toLowerCase();
  const at = normalized.indexOf('@');
  const local = at < 0 ? normalized : normalized.slice(0, at);
  const domain = at < 0 ? undefined : normalized.slice(at + 1);
  const invalid = (reason: string): GwsEaError =>
    new GwsEaError('invalid_arguments', `--alias ${JSON.stringify(value)} cannot be the assistant's alias: ${reason}`);
  if (domain !== undefined && (!EMAIL_PATTERN.test(normalized) || domain.includes('@'))) {
    throw invalid('it is not an email address');
  }
  if (local.length === 0 || local.length > MAX_LOCAL_PART_LENGTH || !LOCAL_PART_PATTERN.test(local)) {
    throw invalid('use letters, digits, and single dots, dashes or underscores between them, up to 64 characters');
  }
  if (!/[a-z]/u.test(local)) throw invalid('it has no letter');
  if (ROLE_ADDRESS_NAMES.has(local.replace(/[._-]/gu, ''))) {
    throw invalid('it is a role address, which sites and certificate authorities treat as the whole domain’s');
  }
  return domain === undefined ? { local } : { local, domain };
}

// ---------------------------------------------------------------------------
// The setup step: after the journaled steps, while the browser is enabled
// ---------------------------------------------------------------------------

/** The operator's word on the alias: `--alias-added` (with `--alias`, for that name), `--alias-taken`, or `--alias`. */
export type AliasDecision =
  | { readonly kind: 'added'; readonly name?: string }
  | { readonly kind: 'taken' }
  | { readonly kind: 'named'; readonly name: string };

/**
 * The decision the alias flags make, or undefined without one; `--alias-taken`
 * moves past a name, so it stands alone.
 */
export function aliasDecision(flags: {
  readonly added: boolean;
  readonly taken: boolean;
  readonly name: string | undefined;
}): AliasDecision | undefined {
  if (flags.taken && (flags.added || flags.name !== undefined)) {
    throw new GwsEaError('invalid_arguments', '--alias-taken cannot be combined with --alias-added or --alias');
  }
  // Checked now, so a malformed name is refused before anything runs; the step resolves its domain.
  if (flags.name !== undefined) parseAliasName(flags.name);
  if (flags.added) return flags.name === undefined ? { kind: 'added' } : { kind: 'added', name: flags.name };
  if (flags.taken) return { kind: 'taken' };
  return flags.name === undefined ? undefined : { kind: 'named', name: flags.name };
}

/** The step a create, resume or browser enable shows while it sets the alias up. */
export const ALIAS_STEP = { id: 'provision_alias', label: "Setting up the assistant's web alias…" } as const;

/** Where the operator adds an alias: the Admin console's user list, which opens the assistant's account. */
const ADMIN_CONSOLE_USERS_URL = 'https://admin.google.com/ac/users';

/** Seconds between read-backs of a probe just sent, before the step pauses until a later resume. */
const PROBE_READ_BACK_WAITS_SECONDS = [2, 3, 5, 5, 5, 10] as const;

/** The assistant as the alias step names it, from the profile its host serves. */
export interface AliasIdentity {
  readonly name: string;
  readonly email: string;
  readonly domain: string;
  readonly principalEmails: readonly string[];
}

/** The alias's setup as the host reports it. */
export interface HostAliasSetup {
  readonly alias: string | null;
  readonly candidate: string | null;
  readonly probeSent: boolean;
}

/** Where the host's probe left the candidate (`gws-ea-alias probe`; src/modules/gws-ea-inbox/alias-probe.ts). */
const PROBE_OUTCOMES = ['verified', 'bounced', 'group', 'not_yet', 'not_sent', 'superseded'] as const;
export type ProbeOutcome = (typeof PROBE_OUTCOMES)[number];

/** The running host's alias commands, and the profile they serve. */
export interface AliasHost {
  identity(): Promise<AliasIdentity>;
  setup(): Promise<HostAliasSetup>;
  propose(address: string | null): Promise<HostAliasSetup>;
  probe(address: string, send: boolean): Promise<ProbeOutcome>;
}

function invalidHostOutput(): GwsEaError {
  return new GwsEaError('invalid_child_output', "ncl returned an invalid report of the assistant's web alias");
}

function nullableText(value: unknown): string | null {
  if (value === null) return null;
  if (typeof value === 'string' && EMAIL_PATTERN.test(value)) return value;
  throw invalidHostOutput();
}

function parseSetup(value: unknown): HostAliasSetup {
  const data = unwrapData(value);
  if (!isRecord(data) || typeof data.probe_sent !== 'boolean') throw invalidHostOutput();
  return { alias: nullableText(data.alias), candidate: nullableText(data.candidate), probeSent: data.probe_sent };
}

/** The host's alias commands, run through `run`: `ncl <args> --json` against the assistant's own host. */
export function aliasHost(run: (args: readonly string[]) => Promise<unknown>): AliasHost {
  return {
    async identity() {
      const profile = unwrapData(await run(['gws-ea-profile', 'get']));
      if (!isRecord(profile)) throw invalidHostOutput();
      const name = optionalString(profile.assistant_display_name);
      const email = optionalString(profile.assistant_workspace_email)?.toLowerCase();
      const principals = profile.principal_emails;
      if (!name || !email || !EMAIL_PATTERN.test(email) || !Array.isArray(principals)) throw invalidHostOutput();
      return {
        name,
        email,
        domain: email.slice(email.lastIndexOf('@') + 1),
        principalEmails: principals.filter((value): value is string => typeof value === 'string'),
      };
    },
    setup: async () => parseSetup(await run(['gws-ea-alias', 'get'])),
    propose: async (address) =>
      parseSetup(await run(['gws-ea-alias', 'propose', ...(address === null ? ['--none'] : ['--address', address])])),
    async probe(address, send) {
      const result = unwrapData(
        await run(['gws-ea-alias', 'probe', '--address', address, ...(send ? ['--send'] : [])]),
      );
      const outcome = isRecord(result) ? result.outcome : undefined;
      if (!PROBE_OUTCOMES.some((known) => known === outcome)) throw invalidHostOutput();
      return outcome as ProbeOutcome;
    },
  };
}

export interface AliasStepInput {
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
  readonly host: AliasHost;
  readonly decision?: AliasDecision;
}

export interface AliasStepOptions {
  /** The operator's word on the alias, from the command's flags. */
  readonly decision?: AliasDecision;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
}

const READY: ProvisionResult = Object.freeze({ status: 'ready' });

function pause(
  code: string,
  message: string,
  details: readonly string[],
  extra: Pick<ProvisionHumanPause, 'resumeFlag' | 'actionUrl'> = {},
): ProvisionResult {
  return { status: 'paused', pause: { kind: 'human-action', phase: ALIAS_STEP.id, code, message, details, ...extra } };
}

/** Where in the Admin console the alias is added, for `identity`'s account. */
function aliasesPage(identity: AliasIdentity): string {
  return `Open ${identity.name} (${identity.email}), then User information > Alternate email addresses (email aliases)`;
}

const TAKEN_HINT =
  'If the Admin console says the address is already in use, continue with --alias-taken for the next name';
const OWN_NAME_HINT = 'To choose the name yourself, continue with --alias <name>';

/** Ask the operator to add `address`: exactly where, and what to say if they cannot. */
function addPause(identity: AliasIdentity, address: string): ProvisionResult {
  const at = address.lastIndexOf('@');
  return pause(
    'alias_required',
    `Add ${address} as an alias of ${identity.email} in the Google Admin console, then confirm it.`,
    [
      aliasesPage(identity),
      `Add the alternate email ${address.slice(0, at)} on ${address.slice(at + 1)}, then Save`,
      TAKEN_HINT,
      OWN_NAME_HINT,
    ],
    { resumeFlag: '--alias-added', actionUrl: ADMIN_CONSOLE_USERS_URL },
  );
}

/** Ask the operator to name the alias, when no name of the assistant's own is left to offer. */
function namePause(identity: AliasIdentity, reason: string): ProvisionResult {
  return pause(
    'alias_name_required',
    `Name ${identity.name}'s web alias: ${reason}.`,
    [
      `Choose an address on ${identity.domain} for everything ${identity.name} does on the web in its own name`,
      'Continue with --alias <name>; once it is added in the Google Admin console, with --alias <name> --alias-added',
    ],
    { resumeFlag: '--alias <name>' },
  );
}

/** How `ncl` fails when the assistant's host does not answer at all, as when it is stopped. */
const HOST_UNREACHABLE_CODES: ReadonlySet<string> = new Set(['command_failed', 'command_timeout']);

/** The alias is set up through the running host, so a stopped assistant waits to be started. */
function hostPause(instanceId: string, error: GwsEaError): ProvisionResult {
  return pause(
    'alias_host_unavailable',
    "The assistant's host did not answer, and its web alias is set up through it.",
    [`Start the assistant with gws-ea start --id ${instanceId}, then continue`, `ncl: ${error.message}`],
  );
}

/** What a probe's read-back means for the operator, once it did not verify the alias. */
function probePause(
  identity: AliasIdentity,
  address: string,
  outcome: Exclude<ProbeOutcome, 'verified'>,
): ProvisionResult {
  switch (outcome) {
    case 'bounced':
      return pause(
        'alias_not_added',
        `The test message to ${address} bounced: it is not an alias of ${identity.email} yet.`,
        [
          `Add it in the Google Admin console if you have not: ${aliasesPage(identity)}`,
          'A new alias can take up to 24 hours to start receiving mail; then continue with --alias-added to send another test message',
          TAKEN_HINT,
        ],
        { resumeFlag: '--alias-added', actionUrl: ADMIN_CONSOLE_USERS_URL },
      );
    case 'group':
      return pause(
        'alias_is_group',
        `${address} is a Google Group: the test message reached ${identity.name} as a group member, not as an alias.`,
        [
          'Continue with --alias-taken for the next name, or --alias <name> for one of your own',
          'Or delete the group, add the alias in the Google Admin console, and continue with --alias-added',
        ],
        { resumeFlag: '--alias-taken' },
      );
    case 'not_yet':
      return pause(
        'alias_not_delivered',
        `The test message to ${address} has not arrived yet: Google can take up to 24 hours to start delivering to a new alias.`,
        [
          'Resume later to read it back again; nothing more is sent',
          'If the Admin console refused the address, continue with --alias-taken or --alias <name> instead',
        ],
      );
    case 'not_sent':
      return addPause(identity, address);
    case 'superseded':
      throw new GwsEaError(
        'alias_candidate_changed',
        `The web alias candidate changed while ${address} was being checked; run the command again.`,
      );
    default: {
      const unhandled: never = outcome;
      throw new GwsEaError('invalid_child_output', `Unknown alias probe outcome ${String(unhandled)}`);
    }
  }
}

/**
 * Bring the assistant to a verified web alias, or pause for the operator
 * (KTD13). A candidate is claimed in the registry, under the machine lock,
 * before the host asks for it, so two assistants are never asked to add the
 * same address; the host records the alias only when its probe arrives.
 * Run under the assistant's instance lock, which the caller holds.
 */
export async function ensureAssistantAlias(
  input: AliasStepInput,
  reporter: StepReporter,
  sleep: (milliseconds: number) => Promise<void> = (milliseconds) => delay(milliseconds),
): Promise<ProvisionResult> {
  const { paths, instanceId, host, decision } = input;
  const changed = (): void => reporter.emit?.({ type: 'domain-effect', step: ALIAS_STEP.id, changed: true });
  const claim = async (address: string | undefined): Promise<void> => {
    const before = (await getInstanceReservation(paths, instanceId)).exclusive_resource_claims.alias_email;
    await claimInstanceAlias(paths, instanceId, address);
    if (before !== address) changed();
  };

  return runStep(
    reporter,
    ALIAS_STEP,
    async (): Promise<ProvisionResult> => {
      let setup: HostAliasSetup;
      try {
        setup = await host.setup();
      } catch (error) {
        if (error instanceof GwsEaError && HOST_UNREACHABLE_CODES.has(error.code)) return hostPause(instanceId, error);
        throw error;
      }
      const propose = async (address: string | null): Promise<void> => {
        await host.propose(address);
        if (setup.candidate !== address) changed();
      };
      if (setup.alias !== null) {
        const named = decision !== undefined && decision.kind !== 'taken' ? decision.name : undefined;
        if (decision?.kind === 'taken' || (named !== undefined && !sameAddress(named, setup.alias))) {
          throw new GwsEaError(
            'alias_recorded',
            `The assistant's web alias is already ${setup.alias}, verified; it is not changed here.`,
          );
        }
        // A verified alias stays the assistant's own on this machine, whatever wrote the registry since.
        await claim(setup.alias);
        return READY;
      }
      const identity = await host.identity();
      const stem = aliasStem(identity.name);

      /** Claim the first free candidate from `start`, skipping `skip`; undefined when none is left. */
      const claimFree = async (start: string | undefined, skip: string | null): Promise<string | undefined> => {
        if (stem.status !== 'derived') return undefined;
        const taken = new Set([
          ...otherAssistantsMailboxes(await readRegistry(paths), instanceId),
          identity.email,
          ...identity.principalEmails.map((email) => email.toLowerCase()),
          ...(skip === null ? [] : [skip]),
        ]);
        for (let name = start; name !== undefined; name = aliasCandidateAfter(stem.stem, name)) {
          const address = `${name}@${identity.domain}`;
          if (taken.has(address)) continue;
          try {
            await claim(address);
            return address;
          } catch (error) {
            // Another assistant claimed it since the registry was read.
            if (error instanceof GwsEaError && error.code === 'claim_conflict') continue;
            throw error;
          }
        }
        return undefined;
      };
      const nameRequired = (): ProvisionResult =>
        namePause(identity, stem.status === 'derived' ? 'no name of its own is left to offer' : stem.reason);
      /** Ask for the first free candidate from `start`, or for a name when none is left. */
      const offerFrom = async (start: string | undefined, skip: string | null): Promise<string | undefined> => {
        const address = await claimFree(start, skip);
        await propose(address ?? null);
        if (address === undefined) await claim(undefined);
        return address;
      };
      const firstCandidate = stem.status === 'derived' ? firstAliasCandidate(stem.stem) : undefined;

      /** Probe `address`, sending a new probe with `send`, and wait briefly for a probe just sent. */
      const probe = async (address: string, send: boolean): Promise<ProvisionResult> => {
        let outcome = await host.probe(address, send);
        if (send) changed();
        for (const seconds of send ? PROBE_READ_BACK_WAITS_SECONDS : []) {
          if (outcome !== 'not_yet') break;
          reporter.emit?.({
            type: 'step-waiting',
            step: ALIAS_STEP.id,
            reason: `Waiting for the test message to reach ${address}…`,
          });
          await sleep(seconds * 1_000);
          outcome = await host.probe(address, false);
        }
        if (outcome === 'verified') {
          changed();
          return READY;
        }
        return probePause(identity, address, outcome);
      };

      switch (decision?.kind) {
        case 'named':
        case 'added': {
          let address = setup.candidate;
          if (decision.name !== undefined) {
            address = await overrideAddress(decision.name, identity, claim);
            await propose(address);
          } else if (address === null) {
            address = (await offerFrom(firstCandidate, null)) ?? null;
            if (address === null) return nameRequired();
          } else {
            await claim(address);
          }
          return decision.kind === 'added' ? probe(address, true) : addPause(identity, address);
        }
        case 'taken': {
          const after = setup.candidate;
          // Only a candidate on the assistant's own domain can be one of its numbered names.
          const name = after?.endsWith(`@${identity.domain}`) ? after.slice(0, -identity.domain.length - 1) : undefined;
          const start =
            name === undefined || stem.status !== 'derived' ? firstCandidate : aliasCandidateAfter(stem.stem, name);
          const address = await offerFrom(start, after);
          return address === undefined ? nameRequired() : addPause(identity, address);
        }
        case undefined: {
          if (setup.candidate === null) {
            const address = await offerFrom(firstCandidate, null);
            return address === undefined ? nameRequired() : addPause(identity, address);
          }
          await claim(setup.candidate);
          return setup.probeSent ? probe(setup.candidate, false) : addPause(identity, setup.candidate);
        }
        default: {
          const unhandled: never = decision;
          throw new GwsEaError('invalid_arguments', `Unknown alias decision ${String(unhandled)}`);
        }
      }
    },
    (result) => (result.status === 'paused' ? result.pause : undefined),
  );
}

function sameAddress(name: string, address: string): boolean {
  const parsed = parseAliasName(name);
  const at = address.lastIndexOf('@');
  return parsed.local === address.slice(0, at) && (parsed.domain ?? address.slice(at + 1)) === address.slice(at + 1);
}

/** The operator's own name as an address, claimed for this assistant; refused when it is someone else's. */
async function overrideAddress(
  name: string,
  identity: AliasIdentity,
  claim: (address: string) => Promise<void>,
): Promise<string> {
  const parsed = parseAliasName(name);
  const address = `${parsed.local}@${parsed.domain ?? identity.domain}`;
  if (address === identity.email) {
    throw new GwsEaError('alias_unavailable', `${address} is the assistant's own address; an alias is another one.`);
  }
  if (identity.principalEmails.some((email) => email.toLowerCase() === address)) {
    throw new GwsEaError('alias_unavailable', `${address} is the principal's address, not the assistant's.`);
  }
  try {
    await claim(address);
  } catch (error) {
    if (error instanceof GwsEaError && error.code === 'claim_conflict') {
      throw new GwsEaError(
        'alias_unavailable',
        `${address} is another assistant's address on this machine; choose another with --alias <name>.`,
        { cause: error },
      );
    }
    throw error;
  }
  return address;
}

/**
 * The alias step for an assistant whose browser is enabled, through its
 * running host. The caller decides that the browser is enabled and holds
 * the assistant's instance lock.
 */
export function runAliasStep(
  paths: ControlPlanePaths,
  instanceId: string,
  runtime: InstanceRuntimeConfig,
  reporter: StepReporter,
  options: AliasStepOptions = {},
): Promise<ProvisionResult> {
  const ncl = options.ncl ?? runInstanceNclJson;
  return ensureAssistantAlias(
    {
      paths,
      instanceId,
      host: aliasHost((args) => ncl(runtime, args)),
      ...(options.decision ? { decision: options.decision } : {}),
    },
    reporter,
  );
}
