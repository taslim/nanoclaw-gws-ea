import { randomUUID } from 'node:crypto';
import {
  ActionRefusal,
  ANSWER_LATER,
  answeringAction,
  forbidden,
  requestIdOf,
  writeActionResponse,
} from '../../cli/delivery-action.js';
import type { ResponseFrame } from '../../cli/frame.js';
import { getDb } from '../../db/connection.js';
import { getPendingApproval, getSession } from '../../db/sessions.js';
import type { DeliveryGuardSpec } from '../../delivery-guard.js';
import { guard } from '../../guard/index.js';
import { isRecord } from '../../gws-ea/validation.js';
import { clearOutbox, withExistingMailboxSession } from '../../session-manager.js';
import type { PendingApproval, Session } from '../../types.js';
import { registerApprovalHandler, requestApproval, type ApprovalHandlerContext } from '../approvals/index.js';
import { quoted } from '../approvals/request-text.js';
import { privateKindNoun } from '../gws-ea-privacy/outbound.js';
import { registerApprovalResolvedHandler } from '../approvals/primitive.js';
import { PRINCIPAL_MESSAGE_LIFETIME_MS } from '../gws-ea-profile/marks.js';
import { isVerifiedPrincipalUser, listPrincipalAddresses } from '../gws-ea-profile/db.js';
import {
  ARTIFACT_SHARE_APPROVAL,
  artifactShareAction,
  authorizeArtifactShare,
  parseArtifactShare,
  type ArtifactShareAuthority,
  type ArtifactShareInput,
} from './authority.js';
import { artifactDigest, artifactRequestResult, getArtifactRequest } from './db.js';
import { artifactActor, readArtifactsPolicy, type ArtifactsPolicyFile } from './policy.js';

interface Reservation {
  readonly input: ArtifactShareInput;
  readonly scope_hash: string;
  readonly share_id: string;
  readonly generation: number;
  readonly policy_hash: string;
}
interface PendingRequest {
  readonly session_id: string;
  readonly request_id: string;
  readonly payload_json: string;
}
export interface ArtifactShareMetadata {
  readonly share_id: string;
  readonly kind: 'named' | 'public';
  readonly state: 'pending' | 'active' | 'revoked';
  readonly revision: number | null;
  readonly source_hash: string | null;
  readonly title: string | null;
  readonly generation: number;
  readonly expires_at: string | null;
  readonly recipients: readonly string[];
  readonly url: string;
}
export async function artifactShares(
  artifactId: string,
  config: ArtifactsPolicyFile,
): Promise<ArtifactShareMetadata[]> {
  const shares = await getDb().all<Omit<ArtifactShareMetadata, 'recipients' | 'url'>>(
    `SELECT s.share_id,s.kind,s.state,s.revision,s.source_hash,r.title,s.generation,s.expires_at FROM gws_ea_artifact_shares s LEFT JOIN gws_ea_artifact_revisions r ON r.artifact_id=s.artifact_id AND r.revision=s.revision WHERE s.artifact_id=? ORDER BY s.created_at,s.share_id`,
    artifactId,
  );
  if (!shares.length) return [];
  const recipients = new Map<string, string[]>();
  const rows = await getDb().all<{ share_id: string; email: string }>(
    'SELECT g.share_id,g.email FROM gws_ea_artifact_share_recipients g JOIN gws_ea_artifact_shares s ON s.share_id=g.share_id WHERE s.artifact_id=? ORDER BY g.share_id,g.email',
    artifactId,
  );
  for (const row of rows) {
    const emails = recipients.get(row.share_id) ?? [];
    emails.push(row.email);
    recipients.set(row.share_id, emails);
  }
  return shares.map((share) => ({
    ...share,
    recipients: recipients.get(share.share_id) ?? [],
    url: shareUrl(config, share.kind, share.share_id),
  }));
}
/** Also callable while disabled: capability intent survives a temporary shutdown. */
export async function artifactAdmissionEmails(): Promise<string[]> {
  const principals = (await listPrincipalAddresses()).map(({ email }) => email);
  const now = new Date().toISOString();
  const grants = await getDb().all<{ email: string }>(
    `SELECT DISTINCT g.email FROM gws_ea_artifact_share_recipients g JOIN gws_ea_artifact_shares s ON s.share_id=g.share_id JOIN gws_ea_artifacts a ON a.artifact_id=s.artifact_id WHERE s.kind='named' AND s.state IN ('pending','active') AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) AND (s.expires_at IS NULL OR s.expires_at>?)`,
    now,
    now,
  );
  return [...new Set([...principals, ...grants.map(({ email }) => email)])].sort();
}
function shareUrl(config: ArtifactsPolicyFile, kind: 'named' | 'public', id: string): string {
  return `https://${config.hostname}${config.pathPrefix}/${kind === 'named' ? 'share' : 'public'}/${id}`;
}
function reservation(value: string): Reservation {
  const payload: unknown = JSON.parse(value);
  if (
    !isRecord(payload) ||
    !isRecord(payload.input) ||
    typeof payload.scope_hash !== 'string' ||
    typeof payload.share_id !== 'string' ||
    typeof payload.generation !== 'number' ||
    typeof payload.policy_hash !== 'string'
  )
    throw forbidden('The pending artifact share is unreadable.');
  return {
    input: parseArtifactShare(payload.input),
    scope_hash: payload.scope_hash,
    share_id: payload.share_id,
    generation: payload.generation,
    policy_hash: payload.policy_hash,
  };
}
function failure(id: string, error: unknown): ResponseFrame {
  return {
    id,
    ok: false,
    error: {
      code: error instanceof ActionRefusal ? error.code : 'handler-error',
      message:
        error instanceof ActionRefusal
          ? error.message
          : 'Artifact access could not be verified. Nothing was published.',
    },
  };
}
function storedFrame(value: Record<string, unknown>, requestId: string): ResponseFrame {
  if (value.id !== requestId || typeof value.ok !== 'boolean') throw new Error('Unreadable artifact share result.');
  if (value.ok && isRecord(value.data)) return { id: requestId, ok: true, data: value.data };
  if (!value.ok && isRecord(value.error) && typeof value.error.message === 'string')
    return {
      id: requestId,
      ok: false,
      error: {
        code:
          value.error.code === 'invalid-args'
            ? 'invalid-args'
            : value.error.code === 'forbidden'
              ? 'forbidden'
              : 'handler-error',
        message: value.error.message,
      },
    };
  throw new Error('Unreadable artifact share result.');
}
export interface ArtifactSharingDependencies {
  /** Concrete Access admission owner. Invoked outside central transactions. */
  readonly verifyAdmission: (config: ArtifactsPolicyFile) => Promise<void>;
  readonly publicationReady: (config: ArtifactsPolicyFile) => boolean;
}
export class ArtifactSharing {
  private readonly running = new Set<string>();
  private pendingCursor: readonly [string, string] = ['', ''];
  private answerCursor: readonly [string, string] = ['', ''];
  readonly handler = answeringAction('artifact_share', async (content, session, requestId) => {
    const input = parseArtifactShare(isRecord(content.input) ? content.input : content);
    await this.submit(session, requestId, input);
    return ANSWER_LATER;
  });
  readonly deliveryGuard: DeliveryGuardSpec = {
    guardAction: artifactShareAction,
    precheck: async (content, session) => {
      const requestId = requestIdOf(content);
      if (!requestId) return false;
      let ownsPending = false;
      /* eslint-disable no-catch-all/no-catch-all -- malformed requests must receive a native terminal answer */
      try {
        const input = parseArtifactShare(content);
        const actor = await artifactActor(session);
        if (!actor?.isMain) throw forbidden('Only current canonical main may share artifacts.');
        const previous = await getArtifactRequest(actor, {
          requestId,
          action: 'share',
          fingerprint: artifactDigest(input),
        });
        if (previous?.state === 'settled') {
          await this.replay(session, storedFrame(artifactRequestResult(previous), requestId));
          return false;
        }
        ownsPending = previous?.state === 'pending';
        const authority = await authorizeArtifactShare(session, input, previous ? { requestId } : undefined);
        Object.assign(content, {
          input,
          scope_hash: authority.scopeHash,
          ...(previous ? { reservation_request_id: requestId } : {}),
        });
        return true;
      } catch (error) {
        if (ownsPending) await this.fail(session, requestId, error);
        else await this.answer(session, failure(requestId, error));
        return false;
      }
      /* eslint-enable no-catch-all/no-catch-all */
    },
    requestHold: async (content, session) => this.handler(content, session),
    onDeny: async (content, session, reason) => {
      const requestId = requestIdOf(content);
      if (requestId) await this.fail(session, requestId, forbidden(reason));
    },
  };
  constructor(private readonly dependencies: ArtifactSharingDependencies) {}

  registerApprovals(): void {
    registerApprovalResolvedHandler(async ({ approval, session, outcome }) => {
      if (approval.action !== ARTIFACT_SHARE_APPROVAL || (outcome !== 'expired' && outcome !== 'withdrawn')) return;
      const payload: unknown = JSON.parse(approval.payload);
      if (isRecord(payload) && typeof payload.reservation_request_id === 'string')
        await this.fail(
          session,
          payload.reservation_request_id,
          forbidden(`Artifact sharing ${outcome}. Nothing was published.`),
        );
    });
    registerApprovalHandler(ARTIFACT_SHARE_APPROVAL, (context) => this.approve(context), {
      restartSafe: true,
      rejectionNote: () => null,
      finalizeRejection: async ({ approval, reason }) => {
        const payload: unknown = JSON.parse(approval.payload);
        const session = approval.session_id ? await getSession(approval.session_id) : undefined;
        if (session && isRecord(payload) && typeof payload.reservation_request_id === 'string')
          await this.fail(
            session,
            payload.reservation_request_id,
            forbidden(`Artifact sharing was declined or expired${reason ? `: ${reason}` : '.'}`),
          );
      },
    });
  }
  private async answer(session: Session, frame: ResponseFrame): Promise<void> {
    await writeActionResponse(session, frame.id, frame);
    clearOutbox(session.agent_group_id, session.id, frame.id);
  }
  private async replay(session: Session, frame: ResponseFrame): Promise<void> {
    if (!(await artifactActor(session))?.isMain)
      throw forbidden('Only current canonical main may read sharing results.');
    if (frame.ok && isRecord(frame.data) && typeof frame.data.share_id === 'string') {
      const now = new Date().toISOString();
      const current = await getDb().get<{ state: string; generation: number; live: number }>(
        `SELECT s.state,s.generation,CASE WHEN s.state='active' AND a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at>?) AND (s.expires_at IS NULL OR s.expires_at>?) THEN 1 ELSE 0 END AS live FROM gws_ea_artifact_shares s JOIN gws_ea_artifacts a ON a.artifact_id=s.artifact_id WHERE s.share_id=?`,
        now,
        now,
        frame.data.share_id,
      );
      const policy = await readArtifactsPolicy();
      const ready = policy.status === 'enabled' && this.dependencies.publicationReady(policy.config);
      frame = {
        ...frame,
        data: {
          ...frame.data,
          current_access: {
            state: current?.state ?? 'unavailable',
            generation: current?.generation ?? null,
            usable: ready && current?.live === 1 && current.generation === frame.data.generation,
          },
        },
      };
    }
    await this.answer(session, frame);
  }
  private async settle(session: Session, requestId: string, frame: ResponseFrame): Promise<void> {
    await getDb().run(
      "UPDATE gws_ea_artifact_requests SET state='settled',result_json=? WHERE session_id=? AND request_id=? AND state='pending'",
      JSON.stringify(frame),
      session.id,
      requestId,
    );
  }
  private async fail(session: Session, requestId: string, error: unknown): Promise<void> {
    const completed = await getDb().get<{ result_json: string }>(
      "SELECT result_json FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=? AND action='share' AND state='settled'",
      session.id,
      requestId,
    );
    if (completed && (await artifactActor(session))?.isMain) {
      const result: unknown = JSON.parse(completed.result_json);
      if (isRecord(result)) {
        await this.replay(session, storedFrame(result, requestId));
        return;
      }
    }
    const frame = failure(requestId, error);
    await getDb().transaction(async () => {
      const row = await getDb().get<{ payload_json: string }>(
        "SELECT payload_json FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=? AND state='pending' AND action='share'",
        session.id,
        requestId,
      );
      if (row) {
        const held = reservation(row.payload_json);
        await getDb().run(
          "UPDATE gws_ea_artifact_shares SET state='revoked',generation=generation+1,updated_at=? WHERE share_id=? AND generation=? AND state='pending'",
          new Date().toISOString(),
          held.share_id,
          held.generation,
        );
        await this.settle(session, requestId, frame);
      }
    });
    await this.answer(session, frame);
  }
  async submit(session: Session, requestId: string, input: ArtifactShareInput): Promise<void> {
    const key = `${session.id}:${requestId}`;
    if (this.running.has(key)) return;
    this.running.add(key);
    /* eslint-disable no-catch-all/no-catch-all -- journal every refusal/failure before answering the native request */
    try {
      const request = { requestId, action: 'share' as const, fingerprint: artifactDigest(input) };
      const actor = await artifactActor(session);
      if (!actor?.isMain) throw forbidden('Only current canonical main may share artifacts.');
      const previous = await getArtifactRequest(actor, request);
      if (previous?.state === 'settled') {
        await this.replay(session, storedFrame(artifactRequestResult(previous), requestId));
        return;
      }
      if (!previous) await this.reserve(session, requestId, input);
      if (input.operation === 'revoke') return;
      await this.process(session, requestId);
    } catch (error) {
      const recorded = await getDb().get<{ state: string; result_json: string | null; fingerprint: string }>(
        'SELECT state,result_json,fingerprint FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=?',
        session.id,
        requestId,
      );
      if (recorded?.state === 'settled' && recorded.result_json && recorded.fingerprint === artifactDigest(input)) {
        const result: unknown = JSON.parse(recorded.result_json);
        if (isRecord(result)) await this.replay(session, storedFrame(result, requestId));
      } else if (recorded && recorded.fingerprint !== artifactDigest(input))
        await this.answer(session, failure(requestId, error));
      else await this.fail(session, requestId, error);
    } finally {
      this.running.delete(key);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  private async reserve(session: Session, requestId: string, input: ArtifactShareInput): Promise<void> {
    let completed: ResponseFrame | undefined;
    await getDb().transaction(async () => {
      const authority = await authorizeArtifactShare(session, input);
      const policy = await readArtifactsPolicy();
      if (policy.status !== 'enabled') throw forbidden('Artifacts are unavailable.');
      const decision = await guard(artifactShareAction, {
        actor: { kind: 'agent', agentGroupId: session.agent_group_id, sessionId: session.id },
        payload: { input, scope_hash: authority.scopeHash },
        grant: null,
      });
      if (decision.effect === 'deny') throw forbidden(decision.reason);
      const now = new Date().toISOString();
      if (input.operation === 'revoke') {
        const changed = await getDb().run(
          "UPDATE gws_ea_artifact_shares SET state='revoked',generation=generation+1,updated_at=? WHERE share_id=? AND artifact_id=? AND generation=? AND state!='revoked'",
          now,
          input.share_id,
          input.artifact_id,
          input.expected_generation,
        );
        if (changed.changes !== 1) throw forbidden('This share changed.');
        await getDb().run('DELETE FROM gws_ea_artifact_share_recipients WHERE share_id=?', input.share_id);
        completed = {
          id: requestId,
          ok: true,
          data: {
            artifact_id: input.artifact_id,
            share_id: input.share_id,
            generation: input.expected_generation + 1,
            state: 'revoked',
          },
        };
        await getDb().run(
          "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,result_json,created_at) VALUES(?,?,?,'share',?,?,?)",
          session.id,
          requestId,
          session.agent_group_id,
          artifactDigest(input),
          JSON.stringify(completed),
          now,
        );
        return;
      }
      const shareId = 'share_id' in input ? input.share_id : randomUUID();
      const generation = 'expected_generation' in input ? input.expected_generation + 1 : 1;
      const payload: Reservation = {
        input,
        scope_hash: authority.scopeHash,
        share_id: shareId,
        generation,
        policy_hash: artifactDigest(policy.config),
      };
      const encoded = JSON.stringify(payload);
      if (Buffer.byteLength(encoded, 'utf8') > 16384)
        throw forbidden(
          'The exact artifact sharing request exceeds the durable 16 KiB limit. Reduce the recipients or names.',
        );
      const kind = input.operation === 'named_publish' || input.operation === 'named_replace' ? 'named' : 'public';
      if ('share_id' in input) {
        const changed = await getDb().run(
          "UPDATE gws_ea_artifact_shares SET revision=?,source_hash=?,generation=?,state='pending',expires_at=?,principal_messaging_group_id=?,principal_message_id=?,scope_hash=?,updated_at=? WHERE share_id=? AND generation=? AND (state!='revoked' OR kind='public')",
          input.revision,
          input.expected_hash,
          generation,
          authority.expiresAt,
          input.principal_message.messaging_group_id,
          input.principal_message.id,
          authority.scopeHash,
          now,
          shareId,
          input.expected_generation,
        );
        if (changed.changes !== 1) throw forbidden('This share changed.');
        await getDb().run('DELETE FROM gws_ea_artifact_share_recipients WHERE share_id=?', shareId);
      } else {
        if (
          kind === 'public' &&
          (await getDb().get(
            "SELECT share_id FROM gws_ea_artifact_shares WHERE artifact_id=? AND kind='public'",
            input.artifact_id,
          ))
        )
          throw forbidden(
            'This artifact already has a public publication slot. Read its current generation and explicitly replace it.',
          );
        await getDb().run(
          "INSERT INTO gws_ea_artifact_shares(share_id,artifact_id,kind,revision,source_hash,generation,state,expires_at,principal_messaging_group_id,principal_message_id,scope_hash,created_at,updated_at) VALUES(?,?,?,?,?,?,'pending',?,?,?,?,?,?)",
          shareId,
          input.artifact_id,
          kind,
          input.revision,
          input.expected_hash,
          generation,
          authority.expiresAt,
          input.principal_message.messaging_group_id,
          input.principal_message.id,
          authority.scopeHash,
          now,
          now,
        );
      }
      if ('recipients' in input)
        for (const { email } of input.recipients)
          await getDb().run('INSERT INTO gws_ea_artifact_share_recipients(share_id,email) VALUES(?,?)', shareId, email);
      await getDb().run(
        "INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,state,payload_json,created_at) VALUES(?,?,?,'share',?,?,'pending',?,?)",
        session.id,
        requestId,
        session.agent_group_id,
        artifactDigest(input),
        input.expected_hash,
        encoded,
        now,
      );
    });
    if (completed) await this.answer(session, completed);
  }
  private async approvals(
    session: Session,
    requestId: string,
    held: Reservation,
  ): Promise<PendingApproval | undefined> {
    return getDb().get<PendingApproval>(
      'SELECT * FROM pending_approvals WHERE action=? AND session_id=? AND payload=?',
      ARTIFACT_SHARE_APPROVAL,
      session.id,
      JSON.stringify({ input: held.input, scope_hash: held.scope_hash, reservation_request_id: requestId }),
    );
  }
  private async process(session: Session, requestId: string, grant: PendingApproval | null = null): Promise<void> {
    const row = await getDb().get<{ payload_json: string }>(
      "SELECT payload_json FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=? AND state='pending' AND action='share'",
      session.id,
      requestId,
    );
    if (!row) return;
    const held = reservation(row.payload_json);
    const authority = await authorizeArtifactShare(session, held.input, { requestId });
    const payload = { input: held.input, scope_hash: authority.scopeHash, reservation_request_id: requestId };
    const consult = () =>
      guard(artifactShareAction, {
        actor: { kind: 'agent' as const, agentGroupId: session.agent_group_id, sessionId: session.id },
        payload,
        grant,
      });
    const decision = await consult();
    if (decision.effect === 'deny') throw forbidden(decision.reason);
    if (decision.effect === 'hold') {
      if (!(await this.approvals(session, requestId, held))) {
        const id = await requestApproval({
          session,
          action: ARTIFACT_SHARE_APPROVAL,
          payload,
          agentName: 'Assistant',
          approverUserId: decision.approverUserId,
          title: 'Share these private details?',
          question: approvalQuestion(authority),
          expiresAt: new Date(
            Math.min(
              Date.parse(authority.principalMessage.timestamp) + PRINCIPAL_MESSAGE_LIFETIME_MS,
              authority.expiresAt ? Date.parse(authority.expiresAt) : Infinity,
            ),
          ).toISOString(),
        });
        if (!id) throw forbidden('The principal confirmation could not be delivered. Nothing was published.');
      }
      return;
    }
    const policy = await readArtifactsPolicy();
    if (policy.status !== 'enabled' || artifactDigest(policy.config) !== held.policy_hash)
      throw forbidden('Artifact capability coordinates changed.');
    if (!this.dependencies.publicationReady(policy.config)) {
      if (grant)
        throw forbidden('The artifact origin is unavailable. Nothing was published; ask again when it is ready.');
      return;
    }
    if ('recipients' in held.input) await this.dependencies.verifyAdmission(policy.config);
    let frame: ResponseFrame | undefined;
    await getDb().transaction(async () => {
      const current = await authorizeArtifactShare(session, held.input, { requestId });
      const fresh = await readArtifactsPolicy();
      if (
        fresh.status !== 'enabled' ||
        artifactDigest(fresh.config) !== held.policy_hash ||
        current.scopeHash !== held.scope_hash ||
        !this.dependencies.publicationReady(fresh.config)
      )
        throw forbidden('Artifact sharing authority changed.');
      if (grant && (!(await isVerifiedPrincipalUser(grant.approver_user_id ?? '')) || grant.session_id !== session.id))
        throw forbidden('Only the current principal may confirm this share.');
      const rechecked = await consult();
      if (rechecked.effect !== 'allow') throw forbidden(rechecked.reason);
      const changed = await getDb().run(
        "UPDATE gws_ea_artifact_shares SET state='active',updated_at=? WHERE share_id=? AND generation=? AND state='pending' AND scope_hash=?",
        new Date().toISOString(),
        held.share_id,
        held.generation,
        held.scope_hash,
      );
      if (changed.changes !== 1) throw forbidden('This share changed or was revoked.');
      frame = {
        id: requestId,
        ok: true,
        data: {
          artifact_id: held.input.artifact_id,
          share_id: held.share_id,
          generation: held.generation,
          revision: current.revision?.revision,
          source_hash: current.revision?.source_hash,
          title: current.revision?.title,
          state: 'active',
          expires_at: current.expiresAt,
          url: shareUrl(fresh.config, 'recipients' in held.input ? 'named' : 'public', held.share_id),
        },
      };
      await this.settle(session, requestId, frame);
    });
    if (frame) await this.answer(session, frame);
  }
  private async approve({ session, payload, approval, userId }: ApprovalHandlerContext): Promise<void> {
    const requestId = payload.reservation_request_id;
    if (typeof requestId !== 'string') return;
    /* eslint-disable no-catch-all/no-catch-all -- principal approval always receives a final native tool result */
    try {
      const live = await getPendingApproval(approval.approval_id);
      if (
        !(await isVerifiedPrincipalUser(userId)) ||
        !live ||
        live.status !== 'approved' ||
        live.approver_user_id !== userId ||
        live.session_id !== session.id ||
        live.payload !== approval.payload
      )
        throw forbidden('Only the current principal may confirm this exact live approval.');
      await this.process(session, requestId, live);
    } catch (error) {
      await this.fail(session, requestId, error);
    }
    /* eslint-enable no-catch-all/no-catch-all */
  }
  async recover(): Promise<void> {
    await this.reconcile();
  }
  private async recoverAnswers(): Promise<void> {
    const [sessionId, requestId] = this.answerCursor;
    const rows = await getDb().all<{ session_id: string; request_id: string }>(
      "SELECT session_id,request_id FROM gws_ea_artifact_requests WHERE action='share' AND state='settled' AND (session_id>? OR (session_id=? AND request_id>?)) ORDER BY session_id,request_id LIMIT 32",
      sessionId,
      sessionId,
      requestId,
    );
    for (const row of rows) {
      this.answerCursor = [row.session_id, row.request_id];
      const session = await getSession(row.session_id);
      if (!session || !(await artifactActor(session))?.isMain) continue;
      const exists = await withExistingMailboxSession(session.agent_group_id, session.id, (mailbox) =>
        mailbox.hasMessage(`action-resp-${row.request_id}`),
      );
      if (exists) continue;
      const missing = await getDb().get<{ result_json: string }>(
        "SELECT result_json FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=? AND action='share' AND state='settled'",
        row.session_id,
        row.request_id,
      );
      if (!missing) continue;
      const result: unknown = JSON.parse(missing.result_json);
      if (isRecord(result)) await this.replay(session, storedFrame(result, row.request_id));
    }
    if (rows.length < 32) this.answerCursor = ['', ''];
  }
  async reconcile(): Promise<void> {
    await this.recoverAnswers();
    const [sessionId, requestId] = this.pendingCursor;
    const pending = await getDb().all<PendingRequest>(
      "SELECT session_id,request_id,payload_json FROM gws_ea_artifact_requests WHERE action='share' AND state='pending' AND (session_id>? OR (session_id=? AND request_id>?)) ORDER BY session_id,request_id LIMIT 32",
      sessionId,
      sessionId,
      requestId,
    );
    for (const row of pending) {
      this.pendingCursor = [row.session_id, row.request_id];
      const session = await getSession(row.session_id);
      if (!session || this.running.has(`${session.id}:${row.request_id}`)) continue;
      const held = reservation(row.payload_json);
      const approval = await this.approvals(session, row.request_id, held);
      if (approval?.status === 'approved') continue; // Native restart-safe approval replay owns its still-live grant.
      await this.submit(session, row.request_id, held.input);
    }
    if (pending.length < 32) this.pendingCursor = ['', ''];
  }
}
function approvalQuestion(authority: ArtifactShareAuthority): string {
  const recipients =
    'recipients' in authority.input
      ? authority.input.recipients
          .map(({ email, name }) => (name ? `${email} (${quoted(name, 256)})` : email))
          .join(', ')
      : 'anyone with the public link';
  const details = [...new Set(authority.privateValues.map(({ kind }) => `private ${privateKindNoun(kind)}`))].join(
    ', ',
  );
  return `May I share ${quoted(authority.revision?.title ?? 'Artifact', 256)}, saved version ${authority.revision?.revision}, with ${recipients}? Access expires ${authority.expiresAt ?? 'never'}. It contains your ${details}. This confirms only this saved version and audience.`;
}
