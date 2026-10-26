/**
 * The assistant's web alias: one address of its own that it uses for
 * everything it does on the web in its own name. gws-ea derives its name,
 * the operator adds it in the Google Admin console and confirms it before
 * the host records it.
 *
 * The name is the assistant's name in lowercase ASCII letters and digits,
 * reversed; a palindrome moves its first letter to the end instead. Later
 * candidates number it: `onuj`, `onuj2`, `onuj3`, and so on. A role address
 * is never offered, and a name that gives no candidate (a single repeated
 * letter, or no ASCII letter at all) waits for the operator to name the alias.
 */
import { runStep, type StepReporter } from './events.js';
import { runInstanceNclJson } from './ncl.js';
import type { ControlPlanePaths } from './paths.js';
import type { ProvisionHumanPause, ProvisionResult } from './phases.js';
import { claimInstanceAlias, getInstanceReservation, otherAssistantsMailboxes, readRegistry } from './registry.js';
import type { InstanceRuntimeConfig } from './service.js';
import { GwsEaError } from './types.js';
import { EMAIL_PATTERN, isRecord, optionalString, unwrapData } from './validation.js';

/** Leaves room for a four-digit candidate number within the 64 characters a local part allows. */
const MAX_STEM_LENGTH = 60;
const MAX_LOCAL_PART_LENGTH = 64;
const MAX_CANDIDATE = 9_999;

/**
 * The mailboxes RFC 2142 reserves, the ones certificate authorities mail to
 * prove control of a domain, and the shared mailboxes sites and people treat
 * as an organization's rather than one person's. None ends in a digit, so only
 * an unnumbered stem can be one.
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

export type AliasStem =
  | { readonly status: 'derived'; readonly stem: string }
  | { readonly status: 'name_required'; readonly reason: string };

function asciiName(name: string): string {
  return name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]/gu, '');
}

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

function candidateName(stem: string, index: number): string {
  return index === 1 ? stem : `${stem}${index}`;
}

function candidateIndex(stem: string, name: string): number | undefined {
  if (name === stem) return 1;
  if (!name.startsWith(stem)) return undefined;
  const suffix = name.slice(stem.length);
  return /^[1-9][0-9]*$/u.test(suffix) && Number(suffix) >= 2 ? Number(suffix) : undefined;
}

function candidateFrom(stem: string, index: number): string | undefined {
  for (let next = index; next <= MAX_CANDIDATE; next += 1) {
    const name = candidateName(stem, next);
    if (!ROLE_ADDRESS_NAMES.has(name)) return name;
  }
  return undefined;
}

export function firstAliasCandidate(stem: string): string {
  // A role address never ends in a digit, so the stem numbered 2 never is one.
  return candidateFrom(stem, 1) ?? candidateName(stem, 2);
}

/**
 * A `current` that is none of the stem's candidates, such as a name of the
 * operator's own, restarts at the first. Undefined once the numbers run out.
 */
export function aliasCandidateAfter(stem: string, current: string): string | undefined {
  const index = candidateIndex(stem, current);
  return index === undefined ? firstAliasCandidate(stem) : candidateFrom(stem, index + 1);
}

/** `domain` only when the operator gave `--alias` a whole address. */
export interface AliasName {
  readonly local: string;
  readonly domain?: string;
}

/** A local part as a Workspace address takes it; `parseAliasName` also requires a letter. */
const LOCAL_PART_PATTERN = /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/u;

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

/**
 * `--alias-added` confirms the candidate (or `--alias`'s name when given),
 * `--alias-taken` moves to the next candidate, and `--alias` names the
 * operator's own.
 */
export type AliasDecision = (
  | { readonly kind: 'added'; readonly name?: string }
  | { readonly kind: 'taken' }
  | { readonly kind: 'named'; readonly name: string }
) & { readonly expectedCandidate?: string | null };

/** `--alias-taken` moves past a name, so it combines with no other alias flag. */
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

export const ALIAS_STEP = { id: 'provision_alias', label: "Setting up the assistant's web alias…" } as const;

const ADMIN_CONSOLE_USERS_URL = 'https://admin.google.com/ac/users';

export interface AliasIdentity {
  readonly name: string;
  readonly email: string;
  readonly domain: string;
  readonly principalEmails: readonly string[];
}

export interface HostAliasSetup {
  readonly alias: string | null;
  readonly candidate: string | null;
}

export interface AliasHost {
  identity(): Promise<AliasIdentity>;
  setup(): Promise<HostAliasSetup>;
  propose(address: string | null): Promise<HostAliasSetup>;
  confirm(address: string): Promise<HostAliasSetup>;
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
  if (!isRecord(data)) throw invalidHostOutput();
  return { alias: nullableText(data.alias), candidate: nullableText(data.candidate) };
}

/** `run` is `ncl <args> --json` against the assistant's own host. */
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
    confirm: async (address) => parseSetup(await run(['gws-ea-alias', 'confirm', '--address', address])),
  };
}

export interface AliasStepInput {
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
  readonly host: AliasHost;
  readonly decision?: AliasDecision;
}

export interface AliasStepOptions {
  readonly decision?: AliasDecision;
  /** `ncl <args> --json` through the assistant's own host. */
  readonly ncl?: (runtime: InstanceRuntimeConfig, args: readonly string[]) => Promise<unknown>;
}

const READY: ProvisionResult = Object.freeze({ status: 'ready' });

function pause(
  code: string,
  message: string,
  details: readonly string[],
  extra: Pick<ProvisionHumanPause, 'resumeFlag' | 'actionUrl' | 'aliasCandidate'> = {},
): ProvisionResult {
  return { status: 'paused', pause: { kind: 'human-action', phase: ALIAS_STEP.id, code, message, details, ...extra } };
}

function addPause(identity: AliasIdentity, address: string): ProvisionResult {
  const at = address.lastIndexOf('@');
  return pause(
    'alias_required',
    `Add ${address} as an alias of ${identity.email} in the Google Admin console, then confirm it.`,
    [
      '1. Open Google Admin:',
      `   ${ADMIN_CONSOLE_USERS_URL}`,
      '',
      `2. Select ${identity.name} (${identity.email}).`,
      '   Go to User information > Alternate email addresses (email aliases).',
      '',
      '3. Add the alias:',
      `   Alternate email: ${address.slice(0, at)}`,
      `   Domain: ${address.slice(at + 1)}`,
      '',
      '4. Save, then return here to confirm.',
    ],
    { resumeFlag: '--alias-added', actionUrl: ADMIN_CONSOLE_USERS_URL, aliasCandidate: address },
  );
}

function namePause(identity: AliasIdentity, reason: string): ProvisionResult {
  return pause(
    'alias_name_required',
    `Name ${identity.name}'s web alias: ${reason}.`,
    [
      `Choose an address on ${identity.domain} for everything ${identity.name} does on the web in its own name`,
      'Continue with --alias <name>; once it is added in the Google Admin console, with --alias <name> --alias-added',
    ],
    { resumeFlag: '--alias <name>', aliasCandidate: null },
  );
}

/** How `ncl` fails when the assistant's host does not answer at all, as when it is stopped. */
const HOST_UNREACHABLE_CODES: ReadonlySet<string> = new Set(['command_failed', 'command_timeout']);

function hostPause(instanceId: string, error: GwsEaError): ProvisionResult {
  return pause(
    'alias_host_unavailable',
    "The assistant's host did not answer, and its web alias is set up through it.",
    [`Start the assistant with gws-ea start --id ${instanceId}, then continue`, `ncl: ${error.message}`],
  );
}

/**
 * A candidate is claimed in the registry, under the machine lock, before the
 * host asks for it, so two assistants are never asked to add the same address;
 * the host records the alias only once the operator confirms it. The caller
 * holds the assistant's instance lock.
 */
export async function ensureAssistantAlias(input: AliasStepInput, reporter: StepReporter): Promise<ProvisionResult> {
  const { paths, instanceId, host } = input;
  let decision = input.decision;
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
      // The operator may have answered while another command changed the candidate.
      if (decision?.expectedCandidate !== undefined && decision.expectedCandidate !== setup.candidate) {
        decision = undefined;
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
            `The assistant's web alias is already ${setup.alias}, configured; it is not changed here.`,
          );
        }
        // A configured alias stays the assistant's own on this machine, whatever wrote the registry since.
        await claim(setup.alias);
        return READY;
      }
      const identity = await host.identity();
      const stem = aliasStem(identity.name);

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
      const offerFrom = async (start: string | undefined, skip: string | null): Promise<string | undefined> => {
        const address = await claimFree(start, skip);
        await propose(address ?? null);
        if (address === undefined) await claim(undefined);
        return address;
      };
      const firstCandidate = stem.status === 'derived' ? firstAliasCandidate(stem.stem) : undefined;

      const confirm = async (address: string): Promise<ProvisionResult> => {
        const confirmed = await host.confirm(address);
        if (confirmed.alias !== address) throw invalidHostOutput();
        changed();
        return READY;
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
            return addPause(identity, address);
          } else {
            await claim(address);
          }
          return decision.kind === 'added' ? confirm(address) : addPause(identity, address);
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
          return addPause(identity, setup.candidate);
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

/** The caller holds the assistant’s instance lock. */
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

/** Recovery for identity setup is independent of browser availability. */
export function aliasNextActions(
  instanceId: string,
  pause: Pick<ProvisionHumanPause, 'resumeFlag' | 'message' | 'actionUrl'>,
): readonly import('./result.js').NextAction[] {
  return [
    ...(pause.actionUrl ? [{ kind: 'external' as const, instruction: pause.message, url: pause.actionUrl }] : []),
    {
      kind: 'command',
      argv: [
        'gws-ea',
        'alias',
        '--id',
        instanceId,
        ...(pause.resumeFlag && !pause.resumeFlag.includes('<') ? pause.resumeFlag.split(' ') : []),
      ],
    },
  ];
}
