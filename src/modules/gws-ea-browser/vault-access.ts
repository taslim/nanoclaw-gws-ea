/**
 * The principal's access to the assistant's 1Password vault (KTD4, R4-R6,
 * R16). An agent with browser access asks, through its host request and
 * guard. The host binds the account and vault from its own records and
 * shares only with the principal's exact, confirmed 1Password user, through
 * the host management service account, which may grant access only on the
 * vaults it created. Actual access is read before any grant and after it, so a repeat
 * is safe and an unknown outcome is observed before anything is granted
 * again. A share answers with the link to the account's sign-in address and
 * the vault's exact name, which 1Password lists in the account's sidebar:
 * 1Password documents no link to a vault itself. Whatever stops sharing, the
 * principal gets one message to forward to their operator, naming the
 * assistant, account, vault and email: there is no request table, inbox or
 * notification route behind it.
 *
 * An email that is not one of the principal's addresses waits for the
 * principal's own confirmation, and binds only to the share it confirms: it
 * never becomes a principal address, so it changes no mail or calendar
 * authority. The principal's explicit retry after adding a login lists the
 * vault again at once.
 */
import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { registerDeliveryAction } from '../../delivery.js';
import { ALLOW, DENY, HOLD, defineGuardedAction, guard, type GuardActor } from '../../guard/index.js';
import { identityMatchKey, normalizePrincipalEmail, resolvePrincipalAddress } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { registerApprovalHandler, requestApproval } from '../approvals/index.js';
import {
  getGwsEaProfile,
  isVerifiedPrincipalUser,
  listPrincipalAddresses,
  principalApproverUserId,
} from '../gws-ea-profile/db.js';
import { hasBrowserAccess } from './access.js';
import {
  OnePasswordCli,
  type OnePasswordFailureReason,
  type OnePasswordResult,
  type OnePasswordUser,
  type ServiceAccountIdentity,
  type VaultAccessRequest,
} from './onepassword-cli.js';
import {
  onePasswordAccountLink,
  onePasswordManagementIdentity,
  readOnePasswordHostPolicy,
  type OnePasswordHostPolicy,
  type OnePasswordVaultPermission,
} from './onepassword-policy.js';
import {
  browserVault,
  BrowserVaultError,
  onePasswordPolicyFile,
  vaultFailureStatus,
  type BrowserVault,
} from './onepassword.js';

/** The provider operations sharing needs, each made as the host management service account. */
export interface VaultSharingProvider {
  /** The vault as 1Password names it now (`op vault get <vault>`). */
  getVault(
    identity: ServiceAccountIdentity,
    vaultId: string,
  ): Promise<OnePasswordResult<{ readonly name: string | null }>>;
  /** The user 1Password holds under exactly this email (`op user get <email>`). */
  getUser(
    identity: ServiceAccountIdentity,
    email: string,
  ): Promise<OnePasswordResult<{ readonly user: OnePasswordUser }>>;
  /** The users with direct access to the vault (`op user list --vault <vault>`). */
  listVaultUsers(
    identity: ServiceAccountIdentity,
    vaultId: string,
  ): Promise<OnePasswordResult<{ readonly userIds: readonly string[] }>>;
  grantVaultAccess(identity: ServiceAccountIdentity, request: VaultAccessRequest): Promise<OnePasswordResult>;
}

export interface VaultAccessDependencies {
  /** The assistant's vault: its binding from local records, and the principal's explicit refresh. */
  readonly vault: Pick<BrowserVault, 'availability' | 'refresh'>;
  /** Where the 1Password host policy is, located for every use. */
  readonly onePasswordPolicyFile: () => string | undefined;
  /** The provider through the CLI the host policy recorded; undefined when this host cannot share. */
  readonly openProvider: (policy: OnePasswordHostPolicy) => Promise<VaultSharingProvider | undefined>;
}

/** View and edit, with the viewing that editing depends on: never management of the vault. */
const PRINCIPAL_GRANT: readonly OnePasswordVaultPermission[] = ['allow_viewing', 'allow_editing'];
/** The `pending_approvals.action` the principal's confirmation of another email resolves through. */
const EMAIL_APPROVAL = 'browser_vault_email';
const FIELDS: ReadonlySet<string> = new Set(['action', 'requestId', 'operation', 'email']);

/** Why sharing needs the operator; each has its own sentence in the forwardable message. */
type HandoffReason = 'not_a_member' | 'not_confirmed' | 'refused' | 'host_cannot_share' | 'unconfirmed';

type ShareOutcome =
  | {
      readonly status: 'shared';
      readonly email: string;
      readonly account_id: string;
      readonly vault_id: string;
      /** Exactly as 1Password names the recorded vault. */
      readonly vault_name: string;
      /** Opens the recorded account on 1Password.com, from its recorded sign-in address. */
      readonly link: string;
    }
  | {
      readonly status: 'operator_needed';
      readonly email: string;
      readonly reason: HandoffReason;
      readonly operator_message: string;
    }
  | { readonly status: 'rate_limited' }
  | { readonly status: 'vault_unavailable' };

/** The exact CLI the host policy recorded; a host where it cannot open does not share. */
async function cliSharingProvider(policy: OnePasswordHostPolicy): Promise<VaultSharingProvider | undefined> {
  const opening = await OnePasswordCli.open({ command: policy.cliPath });
  return opening.status === 'ready' ? opening.cli : undefined;
}

const DEFAULT_DEPENDENCIES: VaultAccessDependencies = {
  vault: browserVault,
  onePasswordPolicyFile,
  openProvider: cliSharingProvider,
};

/** An agent the browser access setting names: it uses the vault's logins, so it may share them with the principal. */
async function mayManageVault(actor: GuardActor): Promise<boolean> {
  return actor.kind === 'agent' && (await hasBrowserAccess(actor.agentGroupId));
}

function agentActor(session: Session): GuardActor {
  return { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id };
}

/** The vault is shared only with the principal's own 1Password user, whichever agent with browser access asks. */
export const vaultAccessGuard = defineGuardedAction({
  action: 'gws_ea_browser.vault_access',
  async decide({ actor }) {
    return (await mayManageVault(actor))
      ? ALLOW("An agent with browser access asks to share the vault with the principal's own 1Password user.")
      : DENY("Only an agent with browser access manages the principal's access to the assistant's 1Password vault.");
  },
});

const emailPayload = (email: string): { readonly email: string } => ({ email });

/** Another email for the principal's 1Password account is theirs only on their own confirmation. */
const vaultEmailGuard = defineGuardedAction({
  action: 'gws_ea_browser.vault_email',
  grantActionName: EMAIL_APPROVAL,
  grantCoversRequest: (grant, input) =>
    typeof input.payload.email === 'string' && grant.payload === JSON.stringify(emailPayload(input.payload.email)),
  async decide({ actor }) {
    if (!(await mayManageVault(actor)))
      return DENY(
        "Only an agent with browser access manages the principal's access to the assistant's 1Password vault.",
      );
    const principal = await principalApproverUserId();
    return principal
      ? HOLD('Only the principal confirms an email that is not one of their addresses.', principal)
      : DENY('No verified principal can confirm that email.');
  },
});

let shares: Promise<unknown> = Promise.resolve();

/** One share at a time in this host: concurrent requests would only spend the shared request limit twice. */
function oneAtATime<T>(work: () => Promise<T>): Promise<T> {
  const result = shares.then(work);
  shares = result.then(
    () => undefined,
    () => undefined,
  );
  return result;
}

interface MessageFacts {
  readonly email: string;
  readonly accountId: string;
  readonly link: string;
  readonly vaultId: string;
  /** Known once 1Password has named the vault. */
  readonly vaultName: string | undefined;
  readonly guest: boolean;
}

/** What the principal forwards to their operator as it is: the assistant, account, exact vault and email. */
async function operatorMessage(reason: HandoffReason, facts: MessageFacts): Promise<string> {
  const profile = await getGwsEaProfile();
  const name = profile.assistant_display_name ?? 'my assistant';
  const assistant = profile.assistant_workspace_email ? `${name} (${profile.assistant_workspace_email})` : name;
  const why = ((): string => {
    switch (reason) {
      case 'not_a_member':
        return "1Password has no confirmed member or guest with that email in the account, so they need to be added and confirmed first. An Individual account can't share vaults.";
      case 'not_confirmed':
        return '1Password lists that email in the account, but not yet as a confirmed, active member.';
      case 'refused':
        return facts.guest
          ? '1Password refused to share it: that email belongs to a guest, and a guest can use only one vault.'
          : "1Password refused to share it with them; an Individual account can't share vaults.";
      case 'host_cannot_share':
        return `${name} can't share this vault itself, so it needs to be shared in 1Password directly.`;
      case 'unconfirmed':
        return `${name} couldn't confirm with 1Password whether they have access.`;
    }
  })();
  const vault =
    facts.vaultName === undefined
      ? `the vault with ID ${facts.vaultId}`
      : `the vault "${facts.vaultName}" (ID ${facts.vaultId})`;
  return `Could you give ${facts.email} view and edit access to the 1Password vault my assistant ${assistant} keeps its logins in? It is ${vault} in the 1Password account at ${facts.link} (ID ${facts.accountId}). ${why} Once that's done, I'll ask ${name} to check again.`;
}

/** How a failed provider call ends a share. */
function failureKind(reason: OnePasswordFailureReason): 'rate_limited' | 'refused' | 'authority' | 'unknown' {
  switch (reason) {
    case 'rate_limited':
      return 'rate_limited';
    case 'forbidden':
    case 'not_found':
      return 'refused';
    case 'token_unavailable':
    case 'not_signed_in':
    case 'wrong_account':
      return 'authority';
    case 'unexpected_output':
    case 'outcome_unknown':
    case 'failed':
      return 'unknown';
  }
}

/** How a share ends without access: a forwardable handoff, or a provider failure as one. */
function endings(facts: Omit<MessageFacts, 'guest'>): {
  readonly handoff: (reason: HandoffReason, guest?: boolean) => Promise<ShareOutcome>;
  readonly failure: (reason: OnePasswordFailureReason) => Promise<ShareOutcome>;
} {
  const handoff = async (reason: HandoffReason, guest = false): Promise<ShareOutcome> => {
    log.info('Vault sharing needs the operator', { reason });
    return {
      status: 'operator_needed',
      email: facts.email,
      reason,
      operator_message: await operatorMessage(reason, { ...facts, guest }),
    };
  };
  const failure = async (reason: OnePasswordFailureReason): Promise<ShareOutcome> => {
    switch (failureKind(reason)) {
      case 'rate_limited':
        return { status: 'rate_limited' };
      case 'refused':
      case 'authority':
        return handoff('host_cannot_share');
      case 'unknown':
        return handoff('unconfirmed');
    }
  };
  return { handoff, failure };
}

/**
 * Share the recorded vault with the exact user 1Password holds under
 * `email`, which the caller established as the principal's. Access is read
 * first, so a repeat grants nothing and an earlier unknown outcome is seen
 * before any new grant; a grant counts only once access reads back. The
 * answer's link and vault name come from the host's records and 1Password's
 * own name for that vault, never from the request.
 */
async function shareVault(email: string, dependencies: VaultAccessDependencies): Promise<ShareOutcome> {
  const availability = await dependencies.vault.availability();
  if (availability.status !== 'available') return { status: 'vault_unavailable' };
  const { accountId, vaultId } = availability.binding;
  const policyFile = dependencies.onePasswordPolicyFile();
  const host = policyFile === undefined ? undefined : await readOnePasswordHostPolicy(policyFile);
  // While the operator has 1Password disabled, its management account is theirs alone: no agent request reaches it.
  if (host?.status !== 'ready' || !host.policy.enabled || host.policy.accountId !== accountId)
    return { status: 'vault_unavailable' };
  const known = { email, accountId, link: onePasswordAccountLink(host.policy), vaultId };
  const unnamed = endings({ ...known, vaultName: undefined });

  // Only the management service account may grant access, and only on the vaults it created.
  const management = onePasswordManagementIdentity(host.policy, host.paths);
  if (!management) return unnamed.handoff('host_cannot_share');
  const provider = await dependencies.openProvider(host.policy);
  if (!provider) return unnamed.handoff('host_cannot_share');
  const vault = await provider.getVault(management, vaultId);
  if (vault.status !== 'ok') return unnamed.failure(vault.reason);
  if (vault.name === null) return unnamed.failure('unexpected_output');
  const { handoff, failure } = endings({ ...known, vaultName: vault.name });

  const found = await provider.getUser(management, email);
  if (found.status !== 'ok') return found.reason === 'not_found' ? handoff('not_a_member') : failure(found.reason);
  const { user } = found;
  if (user.email.toLowerCase() !== email || user.type === 'service_account') return handoff('not_a_member');
  if (!user.active) return handoff('not_confirmed');
  const shared: ShareOutcome = {
    status: 'shared',
    email,
    account_id: accountId,
    vault_id: vaultId,
    vault_name: vault.name,
    link: known.link,
  };

  const before = await provider.listVaultUsers(management, vaultId);
  if (before.status !== 'ok') return failure(before.reason);
  if (before.userIds.includes(user.userId)) return shared;
  const granted = await provider.grantVaultAccess(management, {
    vaultId,
    userId: user.userId,
    permissions: PRINCIPAL_GRANT,
  });
  if (granted.status !== 'ok') {
    // Only a refusal is about this user; a vault or user 1Password no longer knows ends like any other lookup.
    if (granted.reason === 'forbidden') return handoff('refused', user.type === 'guest');
    // A grant that may have taken effect is observed, never repeated.
    if (failureKind(granted.reason) !== 'unknown') return failure(granted.reason);
  }
  const after = await provider.listVaultUsers(management, vaultId);
  if (after.status !== 'ok')
    return failureKind(after.reason) === 'rate_limited' ? { status: 'rate_limited' } : handoff('unconfirmed');
  return after.userIds.includes(user.userId) ? shared : handoff('unconfirmed');
}

/** AE6: list the vault again now, so a login the principal just added is usable. */
async function refreshVault(dependencies: VaultAccessDependencies): Promise<Record<string, unknown>> {
  try {
    await dependencies.vault.refresh();
  } catch (error) {
    if (!(error instanceof BrowserVaultError)) throw error;
    return { status: vaultFailureStatus(error) };
  }
  return { status: 'usable' };
}

type Recipient = { readonly kind: 'principal' | 'other'; readonly email: string };

/** Whose 1Password user the share is for: the principal's own address, or another email they must confirm. */
async function recipient(value: unknown): Promise<Recipient> {
  const listed = (await listPrincipalAddresses()).map((address) => address.email);
  if (value === undefined) {
    const [only] = listed;
    if (listed.length === 1 && only !== undefined) return { kind: 'principal', email: only };
    throw invalidArgs(
      `${listed.length ? 'The principal has several email addresses' : 'No principal address is recorded'}: ask which email their 1Password account uses, then pass it as email.`,
    );
  }
  const email = typeof value === 'string' ? normalizePrincipalEmail(value) : undefined;
  // Never read as a flag by the provider's CLI.
  if (email === undefined || email.startsWith('-')) throw invalidArgs('email must be one email address.');
  const assistant = (await getGwsEaProfile()).assistant_workspace_email;
  if (assistant !== null && identityMatchKey(`email:${email}`) === identityMatchKey(`email:${assistant}`))
    throw forbidden("That is the assistant's own address: the vault is shared only with the principal.");
  return { kind: resolvePrincipalAddress(email, listed) === undefined ? 'other' : 'principal', email };
}

/** Ask the principal to confirm another email for their 1Password account; one open question per email. */
async function askPrincipal(email: string, session: Session): Promise<Record<string, unknown>> {
  const payload = emailPayload(email);
  const decision = await guard(vaultEmailGuard, { actor: agentActor(session), payload });
  if (decision.effect !== 'hold') throw forbidden(decision.reason);
  const open = await getDb().get<{ present: number }>(
    'SELECT 1 AS present FROM pending_approvals WHERE action = ? AND payload = ? LIMIT 1',
    EMAIL_APPROVAL,
    JSON.stringify(payload),
  );
  if (open) return { status: 'awaiting_principal', email };
  const approvalId = await requestApproval({
    session,
    agentName: 'main',
    action: EMAIL_APPROVAL,
    payload,
    title: 'Share my 1Password vault with this email?',
    question: `I'd like to give ${email} view and edit access to my 1Password vault, as the email your own 1Password account uses. Whoever signs in to 1Password with it can see and change every login I keep there, so approve only if it is yours.`,
    approverUserId: decision.approverUserId,
    details: { facts: { email } },
  });
  if (approvalId === null) throw forbidden('The principal could not be asked to confirm that email right now.');
  return { status: 'awaiting_principal', email };
}

async function vaultAccessRequest(
  content: Record<string, unknown>,
  session: Session,
  dependencies: VaultAccessDependencies,
): Promise<Record<string, unknown>> {
  // The host binds the vault, account, permissions and provider calls; a caller chooses none of them.
  if (Object.keys(content).some((key) => !FIELDS.has(key)))
    throw invalidArgs('vault_access takes only operation, and an email to share with.');
  if (content.operation === 'refresh') {
    if (content.email !== undefined) throw invalidArgs('Only share takes an email.');
    return refreshVault(dependencies);
  }
  if (content.operation !== 'share') throw invalidArgs('operation must be share or refresh.');
  const to = await recipient(content.email);
  if (to.kind === 'other') return askPrincipal(to.email, session);
  return { ...(await oneAtATime(() => shareVault(to.email, dependencies))) };
}

/** What main is told once the principal confirmed another email and the host acted on it. */
function confirmedNote(email: string, outcome: ShareOutcome): string {
  const confirmed = `The principal confirmed ${email} as the email their 1Password account uses.`;
  switch (outcome.status) {
    case 'shared':
      return `${confirmed} The assistant's vault is now shared with it, and 1Password shows their access. Give the principal ${outcome.link} to open their 1Password account, where the vault "${outcome.vault_name}" is listed.`;
    case 'operator_needed':
      return `${confirmed} The vault could not be shared with it. Give the principal this message to forward to their operator, exactly as written:\n\n${outcome.operator_message}`;
    case 'rate_limited':
      return `${confirmed} 1Password's request limit is spent for now, so nothing was shared and nothing was retried. Ask again later with vault_access.`;
    case 'vault_unavailable':
      return `${confirmed} The assistant's vault cannot be used right now, so nothing was shared.`;
  }
}

/**
 * Main's `vault_access` host request, and the principal's confirmation of
 * another email. The browser module registers the defaults; nothing else
 * reaches the provider.
 */
export function registerVaultAccessDelivery(dependencies: VaultAccessDependencies = DEFAULT_DEPENDENCIES): void {
  registerDeliveryAction(
    'vault_access',
    answeringAction('vault_access', (content, session) => vaultAccessRequest(content, session, dependencies)),
    answeredGuard(vaultAccessGuard),
  );
  registerApprovalHandler(
    EMAIL_APPROVAL,
    async ({ session, payload, approval, userId, notify }) => {
      const email = typeof payload.email === 'string' ? normalizePrincipalEmail(payload.email) : undefined;
      if (email === undefined || email !== payload.email) return;
      if (!(await isVerifiedPrincipalUser(userId)) || approval.approver_user_id !== userId) {
        await notify(`The vault was not shared with ${email}: only the principal can confirm their 1Password email.`);
        return;
      }
      const decision = await guard(vaultEmailGuard, { actor: agentActor(session), payload, grant: approval });
      if (decision.effect !== 'allow') {
        await notify(`The vault was not shared with ${email}: ${decision.reason}`);
        return;
      }
      await notify(confirmedNote(email, await oneAtATime(() => shareVault(email, dependencies))));
    },
    // Sharing reads access before any grant, so resuming an approved row after a restart is safe.
    { restartSafe: true },
  );
}
