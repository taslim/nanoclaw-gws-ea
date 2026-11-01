import { randomInt, randomUUID } from 'node:crypto';
import { EMAIL_PATTERN, hasControlCharacters } from '../../gws-ea/validation.js';
import { httpsOrigin } from './authentication-signatures.js';
import {
  getLoginStore,
  LoginDetailsError,
  LoginStoreError,
  registrableDomain,
  type LoginStore,
  type SavedLogin,
} from './login-store.js';
import { isAssistantAccount } from './web-address.js';
import {
  CredentialAttemptError,
  credentialEvidenceJson,
  type CredentialAttempt,
  type CredentialEvidence,
  type CredentialAttemptPhase,
} from './credential-types.js';

export interface DisclosedCredential {
  readonly username: string;
  readonly password: string;
  readonly currentPassword?: string;
}
type StoreFailure = { readonly status: 'vault_unavailable' };
type Refused<Reason extends string> = { readonly status: 'refused'; readonly reason: Reason };
export type CredentialPrepareResult =
  | { readonly status: 'prepared'; readonly attempt: CredentialAttempt }
  | { readonly status: 'not_owned' | 'busy' }
  | StoreFailure;
export type CredentialDisclosure =
  | { readonly status: 'disclosed'; readonly credential: DisclosedCredential }
  | Refused<'not_saved' | 'wrong_job' | 'origin_mismatch' | 'not_owned' | 'source_changed'>
  | StoreFailure;
export type CredentialConfirmResult = { readonly status: 'finalized'; readonly attempt: CredentialAttempt };
export type CredentialReleaseResult =
  | CredentialConfirmResult
  | {
      readonly status: 'released';
      readonly from: CredentialAttemptPhase;
      readonly attempt: CredentialAttempt;
    };
export const MAX_USERNAME = 256;
const active = async (): Promise<void> => undefined;
const refused = <Reason extends string>(reason: Reason): Refused<Reason> => ({ status: 'refused', reason });
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!#$%&*+?';
const DIGITS = '23456789';
const SYMBOLS = '!#$%&*+?';
function generatePassword(): string {
  const values = Array.from({ length: 18 }, () => ALPHABET[randomInt(ALPHABET.length)]);
  values.push(DIGITS[randomInt(DIGITS.length)], SYMBOLS[randomInt(SYMBOLS.length)]);
  for (let index = values.length - 1; index > 0; index--) {
    const other = randomInt(index + 1);
    [values[index], values[other]] = [values[other], values[index]];
  }
  return values.join('');
}
export function line(value: unknown, max: number): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= max &&
    value.trim() === value &&
    !hasControlCharacters(value)
  );
}
export interface CredentialAttemptsOptions {
  readonly store?: LoginStore;
}
export class CredentialAttempts {
  constructor(private readonly options: CredentialAttemptsOptions = {}) {}
  private store(): Promise<LoginStore> {
    return this.options.store ? Promise.resolve(this.options.store) : getLoginStore();
  }
  async get(id: string): Promise<CredentialAttempt | undefined> {
    return (await this.store()).getAttempt(id);
  }
  private async require(id: string): Promise<CredentialAttempt> {
    const attempt = await this.get(id);
    if (!attempt) throw new CredentialAttemptError('not_found');
    return attempt;
  }
  async unresolved(): Promise<CredentialAttempt[]> {
    return (await this.store()).unresolvedAttempts();
  }
  async accountForLogin(login: SavedLogin, site?: string): Promise<'assistant' | 'principal'> {
    if (site !== undefined && login.domain !== site) return 'principal';
    if (await isAssistantAccount(login.username)) return 'assistant';
    if (EMAIL_PATTERN.test(login.username)) return 'principal';
    return (await (await this.store()).hasOwnedSignup(login.domain, login.username)) ? 'assistant' : 'principal';
  }
  async ownedHandle(
    origin: string,
    username: string,
    assertActive = active,
  ): Promise<
    { readonly status: 'found'; readonly itemHandle: string } | { readonly status: 'not_owned' } | StoreFailure
  > {
    try {
      await assertActive();
      for (const login of await (await this.store()).forOrigin(origin))
        if (login.username === username && (await this.accountForLogin(login)) === 'assistant')
          return { status: 'found', itemHandle: login.id };
      return { status: 'not_owned' };
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: 'vault_unavailable' };
    }
  }
  private target(jobId: string, origin: string): { readonly origin: string; readonly site: string } {
    const url = httpsOrigin(origin);
    const site = url && registrableDomain(url.origin);
    if (!line(jobId, 512) || !url || !site) throw new CredentialAttemptError('invalid_request');
    return { origin: url.origin, site };
  }
  private async prepare(
    spec: { readonly kind: 'signup' } | { readonly kind: 'rotation'; readonly source: SavedLogin },
    input: { jobId: string; origin: string; username: string },
  ): Promise<CredentialPrepareResult> {
    const target = this.target(input.jobId, input.origin);
    if (!line(input.username, MAX_USERNAME)) throw new CredentialAttemptError('invalid_request');
    const at = new Date().toISOString();
    const common = {
      id: randomUUID(),
      job_id: input.jobId,
      origin: target.origin,
      site: target.site,
      username: input.username,
      phase: 'saved' as const,
      evidence_json: null,
      owned_login_id: null,
      created_at: at,
      updated_at: at,
      exposed_at: null,
      finalized_at: null,
    };
    const attempt: CredentialAttempt =
      spec.kind === 'rotation'
        ? { ...common, kind: spec.kind, source_login_id: spec.source.id, source_version: spec.source.version }
        : { ...common, kind: spec.kind, source_login_id: null, source_version: null };
    const status = await (await this.store()).saveAttempt(attempt, generatePassword());
    return status === 'busy' ? { status } : { status: 'prepared', attempt };
  }
  async prepareSignup(input: {
    readonly jobId: string;
    readonly origin: string;
    readonly username: string;
  }): Promise<CredentialPrepareResult> {
    try {
      return await this.prepare({ kind: 'signup' }, input);
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: 'vault_unavailable' };
    }
  }
  async prepareRotation(
    input: { readonly jobId: string; readonly origin: string; readonly username: string; readonly itemHandle: string },
    assertActive = active,
  ): Promise<CredentialPrepareResult> {
    const target = this.target(input.jobId, input.origin);
    try {
      await assertActive();
      const source = await (await this.store()).get(input.itemHandle);
      if (source.username !== input.username || (await this.accountForLogin(source, target.site)) !== 'assistant')
        return { status: 'not_owned' };
      return await this.prepare({ kind: 'rotation', source }, input);
    } catch (error) {
      if (error instanceof LoginDetailsError && error.reason === 'login_changed') return { status: 'busy' };
      if (!(error instanceof LoginStoreError)) throw error;
      return { status: error.reason === 'no_item_for_site' ? 'not_owned' : 'vault_unavailable' };
    }
  }
  async disclose(
    id: string,
    binding: { readonly jobId: string; readonly origin: string },
    assertActive = active,
  ): Promise<CredentialDisclosure> {
    const attempt = await this.require(id);
    if (attempt.job_id !== binding.jobId) return refused('wrong_job');
    if (attempt.phase !== 'saved') return refused('not_saved');
    if (registrableDomain(binding.origin) !== attempt.site) return refused('origin_mismatch');
    try {
      const store = await this.store();
      if (attempt.kind === 'rotation') {
        const login = await store.get(attempt.source_login_id);
        if (login.username !== attempt.username || (await this.accountForLogin(login, attempt.site)) !== 'assistant')
          return refused('not_owned');
        if (login.version !== attempt.source_version) return refused('source_changed');
      }
      const exposed = await store.exposeAttempt(id, assertActive);
      if (exposed.status !== 'exposed') return refused(exposed.status);
      return {
        status: 'disclosed',
        credential: {
          username: attempt.username,
          password: exposed.password,
          ...(exposed.currentPassword === undefined ? {} : { currentPassword: exposed.currentPassword }),
        },
      };
    } catch (error) {
      if (!(error instanceof LoginStoreError)) throw error;
      return error.reason === 'no_item_for_site' ? refused('not_owned') : { status: 'vault_unavailable' };
    }
  }
  private async move(
    id: string,
    from: readonly CredentialAttemptPhase[],
    to: CredentialAttemptPhase,
    evidence?: CredentialEvidence,
  ): Promise<CredentialAttempt> {
    if (evidence !== undefined) credentialEvidenceJson(evidence);
    return (await this.store()).moveAttempt(id, from, to, evidence);
  }
  markAwaitingVerification(id: string): Promise<CredentialAttempt> {
    return this.move(id, ['exposed'], 'awaiting_verification');
  }
  markVerificationRequested(id: string, evidence: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['unknown'], 'awaiting_verification', evidence);
  }
  markUnknown(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['exposed', 'awaiting_verification'], 'unknown', evidence);
  }
  markRejected(id: string, evidence?: CredentialEvidence): Promise<CredentialAttempt> {
    return this.move(id, ['awaiting_verification', 'unknown'], 'rejected', evidence);
  }
  async abandon(id: string, assertActive = active): Promise<CredentialAttempt> {
    await assertActive();
    return this.move(id, ['saved'], 'rejected');
  }
  async release(id: string, approvalId: string): Promise<CredentialReleaseResult> {
    return (await this.store()).releaseAttempt(id, approvalId);
  }
  async abandonForJob(jobId: string): Promise<CredentialAttempt[]> {
    return (await this.store()).abandonAttemptsForJob(jobId);
  }
  async confirm(id: string, evidence: CredentialEvidence): Promise<CredentialConfirmResult> {
    credentialEvidenceJson(evidence);
    return { status: 'finalized', attempt: await (await this.store()).confirmAttempt(id, evidence) };
  }
  async recover(): Promise<void> {
    await (await this.store()).recoverAttempts();
  }
}
export const credentialAttempts = new CredentialAttempts();
