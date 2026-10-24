import { createHash, randomUUID } from 'node:crypto';
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import { isRecord } from '../../gws-ea/validation.js';

export const MAX_ARTIFACT_BYTES = 4 * 1024 * 1024;
export interface ArtifactActor {
  readonly agentGroupId: string;
  readonly sessionId: string;
  readonly isMain: boolean;
}
export interface ArtifactMetadata {
  readonly artifact_id: string;
  readonly author_group_id: string;
  readonly title: string;
  readonly head_revision: number;
  readonly generation: number;
  readonly expires_at: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly source_hash: string;
  readonly byte_count: number;
}
export interface ArtifactRevision {
  readonly artifact_id: string;
  readonly revision: number;
  readonly title: string;
  readonly html: string;
  readonly source_hash: string;
  readonly byte_count: number;
  readonly created_at: string;
}
export type ArtifactRevisionMetadata = Omit<ArtifactRevision, 'html' | 'artifact_id' | 'revision'>;
export type ArtifactSave =
  | { readonly create_key: string; readonly title: string; readonly expires_at?: string | null }
  | {
      readonly artifact_id: string;
      readonly expected_revision: number;
      readonly title: string;
      readonly expires_at?: string | null;
    };
export interface ArtifactSaveResult {
  readonly artifact_id: string;
  readonly revision: number;
  readonly source_hash: string;
  readonly byte_count: number;
  readonly generation: number;
}
export interface ArtifactDeleteResult {
  readonly artifact_id: string;
  readonly deleted: true;
  readonly generation: number;
}
export interface ArtifactRequest {
  readonly requestId: string;
  readonly action: 'save' | 'share' | 'delete';
  readonly fingerprint: string;
}
interface ArtifactRequestBase {
  readonly actor_group_id: string;
  readonly fingerprint: string;
  readonly source_hash: string | null;
}
export type ArtifactRequestRecord = ArtifactRequestBase &
  (
    | {
        readonly action: ArtifactRequest['action'];
        readonly state: 'settled';
        readonly result_json: string;
        readonly payload_json: string | null;
      }
    | { readonly action: 'share'; readonly state: 'pending'; readonly result_json: null; readonly payload_json: string }
  );
const preparedSource: unique symbol = Symbol('artifact-source');
export interface PreparedArtifactSource {
  readonly html: string;
  readonly source_hash: string;
  readonly byte_count: number;
  readonly [preparedSource]: true;
}

export function artifactDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}
export function prepareArtifactSource(bytes: Uint8Array, expectedHash?: string): PreparedArtifactSource {
  if (bytes.byteLength > MAX_ARTIFACT_BYTES) throw invalidArgs('Artifact source exceeds the 4 MiB limit.');
  let html: string;
  try {
    html = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (error) {
    if (error instanceof TypeError) throw invalidArgs('Artifact source must be valid UTF-8.');
    throw error;
  }
  const source_hash = createHash('sha256').update(bytes).digest('hex');
  if (expectedHash !== undefined && source_hash !== expectedHash)
    throw forbidden('Artifact source does not match expected_hash. Read the current file before retrying.');
  return { html, source_hash, byte_count: bytes.byteLength, [preparedSource]: true };
}
const META = `a.artifact_id,a.author_group_id,a.title,a.head_revision,a.generation,a.expires_at,a.created_at,a.updated_at,r.source_hash,r.byte_count`;
const LIVE = `a.deleted_at IS NULL AND (a.expires_at IS NULL OR a.expires_at > ?)`;
export async function getArtifact(actor: ArtifactActor, artifactId: string): Promise<ArtifactMetadata | undefined> {
  return getDb().get<ArtifactMetadata>(
    `SELECT ${META} FROM gws_ea_artifacts a JOIN gws_ea_artifact_revisions r ON r.artifact_id=a.artifact_id AND r.revision=a.head_revision WHERE a.artifact_id=? AND ${LIVE}${actor.isMain ? '' : ' AND a.author_group_id=?'}`,
    artifactId,
    new Date().toISOString(),
    ...(actor.isMain ? [] : [actor.agentGroupId]),
  );
}
export async function listArtifacts(
  actor: ArtifactActor,
  page: { readonly limit?: number; readonly after?: string } = {},
): Promise<{ readonly artifacts: ArtifactMetadata[]; readonly next_cursor: string | null }> {
  const limit = page.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
    throw invalidArgs('Artifact list limit must be between 1 and 100.');
  const rows = await getDb().all<ArtifactMetadata>(
    `SELECT ${META} FROM gws_ea_artifacts a JOIN gws_ea_artifact_revisions r ON r.artifact_id=a.artifact_id AND r.revision=a.head_revision WHERE ${LIVE}${actor.isMain ? '' : ' AND a.author_group_id=?'} AND a.artifact_id>? ORDER BY a.artifact_id LIMIT ?`,
    new Date().toISOString(),
    ...(actor.isMain ? [] : [actor.agentGroupId]),
    page.after ?? '',
    limit + 1,
  );
  return { artifacts: rows.slice(0, limit), next_cursor: rows.length > limit ? rows[limit - 1].artifact_id : null };
}
/** Host-only authoritative source read. Callers enforce the relevant author or viewer authority before calling. */
export async function getArtifactRevision(artifactId: string, revision: number): Promise<ArtifactRevision | undefined> {
  return getDb().get<ArtifactRevision>(
    'SELECT artifact_id,revision,title,html,source_hash,byte_count,created_at FROM gws_ea_artifact_revisions WHERE artifact_id=? AND revision=?',
    artifactId,
    revision,
  );
}
export async function getArtifactRevisionMetadata(
  artifactId: string,
  revision: number,
): Promise<ArtifactRevisionMetadata | undefined> {
  return getDb().get<ArtifactRevisionMetadata>(
    'SELECT title,source_hash,byte_count,created_at FROM gws_ea_artifact_revisions WHERE artifact_id=? AND revision=?',
    artifactId,
    revision,
  );
}
export async function getArtifactRequest(
  actor: ArtifactActor,
  request: ArtifactRequest,
): Promise<ArtifactRequestRecord | undefined> {
  const row = await getDb().get<ArtifactRequestRecord>(
    'SELECT actor_group_id,action,fingerprint,source_hash,state,result_json,payload_json FROM gws_ea_artifact_requests WHERE session_id=? AND request_id=?',
    actor.sessionId,
    request.requestId,
  );
  if (
    row &&
    (row.actor_group_id !== actor.agentGroupId ||
      row.action !== request.action ||
      row.fingerprint !== request.fingerprint)
  )
    throw forbidden('This artifact request ID was already used for different work.');
  return row;
}
export function artifactRequestResult(row: ArtifactRequestRecord): Record<string, unknown> {
  if (row.state !== 'settled' || row.result_json === null) throw new Error('This artifact request has not settled.');
  const result: unknown = JSON.parse(row.result_json);
  if (!isRecord(result)) throw new Error('The recorded artifact result is unreadable.');
  return result;
}
/** Must run in the same central transaction as its local mutation. Remote work never belongs here. */
export async function settleArtifactRequest(
  actor: ArtifactActor,
  request: ArtifactRequest,
  result: object,
  sourceHash: string | null = null,
): Promise<void> {
  await getDb().run(
    'INSERT INTO gws_ea_artifact_requests(session_id,request_id,actor_group_id,action,fingerprint,source_hash,result_json,created_at) VALUES(?,?,?,?,?,?,?,?)',
    actor.sessionId,
    request.requestId,
    actor.agentGroupId,
    request.action,
    request.fingerprint,
    sourceHash,
    JSON.stringify(result),
    new Date().toISOString(),
  );
}
interface StoredArtifact {
  readonly artifact_id: string;
  readonly author_group_id: string;
  readonly initial_fingerprint: string;
  readonly head_revision: number | null;
  readonly generation: number;
  readonly expires_at: string | null;
  readonly deleted_at: string | null;
}
function assertOwned(actor: ArtifactActor, row: StoredArtifact | undefined): asserts row is StoredArtifact {
  if (!row || (!actor.isMain && row.author_group_id !== actor.agentGroupId))
    throw forbidden('Only your own artifacts may be changed.');
  if (row.deleted_at !== null) throw forbidden('This artifact was deleted.');
  if (row.expires_at !== null && row.expires_at <= new Date().toISOString())
    throw forbidden('This artifact has expired.');
}
export function artifactSaveRequestResult(row: ArtifactRequestRecord): ArtifactSaveResult {
  const result = artifactRequestResult(row);
  if (
    Object.keys(result).some(
      (key) => !['artifact_id', 'revision', 'source_hash', 'byte_count', 'generation'].includes(key),
    ) ||
    typeof result.artifact_id !== 'string' ||
    typeof result.source_hash !== 'string' ||
    !/^[a-f0-9]{64}$/u.test(result.source_hash) ||
    typeof result.revision !== 'number' ||
    !Number.isSafeInteger(result.revision) ||
    result.revision < 1 ||
    typeof result.generation !== 'number' ||
    !Number.isSafeInteger(result.generation) ||
    result.generation < 1 ||
    typeof result.byte_count !== 'number' ||
    !Number.isSafeInteger(result.byte_count) ||
    result.byte_count < 0 ||
    result.byte_count > MAX_ARTIFACT_BYTES
  )
    throw new Error('The recorded artifact save result is unreadable.');
  return {
    artifact_id: result.artifact_id,
    revision: result.revision,
    source_hash: result.source_hash,
    byte_count: result.byte_count,
    generation: result.generation,
  };
}
function savedDeleteResult(row: ArtifactRequestRecord): ArtifactDeleteResult {
  const result = artifactRequestResult(row);
  if (
    Object.keys(result).some((key) => !['artifact_id', 'deleted', 'generation'].includes(key)) ||
    typeof result.artifact_id !== 'string' ||
    result.deleted !== true ||
    typeof result.generation !== 'number' ||
    !Number.isSafeInteger(result.generation) ||
    result.generation < 1
  )
    throw new Error('The recorded artifact deletion result is unreadable.');
  return { artifact_id: result.artifact_id, deleted: true, generation: result.generation };
}
export async function saveArtifact(
  actor: ArtifactActor,
  request: ArtifactRequest,
  input: ArtifactSave,
  source: PreparedArtifactSource,
): Promise<ArtifactSaveResult> {
  if (request.action !== 'save') throw new Error('Artifact save requires a save request.');
  const initial = artifactDigest([input.title, source.source_hash, source.byte_count, input.expires_at ?? null]);
  const db = getDb();
  return db.transaction(async () => {
    const previous = await getArtifactRequest(actor, request);
    if (previous) {
      if (previous.source_hash !== source.source_hash)
        throw forbidden('This artifact request ID was already used for different work.');
      return artifactSaveRequestResult(previous);
    }
    if (input.expires_at !== undefined && input.expires_at !== null && input.expires_at <= new Date().toISOString())
      throw invalidArgs('expires_at must be a future ISO timestamp or null.');
    let artifactId: string;
    let revision: number;
    let generation: number;
    let expiresAt: string | null;
    const now = new Date().toISOString();
    if ('create_key' in input) {
      const earlier = await db.get<StoredArtifact>(
        'SELECT artifact_id,author_group_id,initial_fingerprint,head_revision,generation,expires_at,deleted_at FROM gws_ea_artifacts WHERE author_group_id=? AND create_key=?',
        actor.agentGroupId,
        input.create_key,
      );
      if (earlier) {
        assertOwned(actor, earlier);
        if (earlier.initial_fingerprint !== initial)
          throw forbidden('This create key was already used for different artifact content.');
        const original = await getArtifactRevisionMetadata(earlier.artifact_id, 1);
        if (!original) throw new Error('Artifact initial revision is missing.');
        const result: ArtifactSaveResult = {
          artifact_id: earlier.artifact_id,
          revision: 1,
          source_hash: original.source_hash,
          byte_count: original.byte_count,
          generation: 1,
        };
        await settleArtifactRequest(actor, request, result, source.source_hash);
        return result;
      }
      artifactId = randomUUID();
      revision = 1;
      generation = 1;
      expiresAt = input.expires_at ?? null;
      await db.run(
        'INSERT INTO gws_ea_artifacts(artifact_id,author_group_id,create_key,initial_fingerprint,title,head_revision,generation,expires_at,created_at,updated_at) VALUES(?,?,?,?,?,NULL,?,?,?,?)',
        artifactId,
        actor.agentGroupId,
        input.create_key,
        initial,
        input.title,
        generation,
        input.expires_at ?? null,
        now,
        now,
      );
    } else {
      const held = await db.get<StoredArtifact>(
        'SELECT artifact_id,author_group_id,initial_fingerprint,head_revision,generation,expires_at,deleted_at FROM gws_ea_artifacts WHERE artifact_id=?',
        input.artifact_id,
      );
      assertOwned(actor, held);
      if (held.head_revision !== input.expected_revision)
        throw forbidden('The artifact changed. Read its current revision before saving again.');
      artifactId = held.artifact_id;
      revision = input.expected_revision + 1;
      generation = held.generation + 1;
      expiresAt = input.expires_at === undefined ? held.expires_at : input.expires_at;
    }
    await db.run(
      'INSERT INTO gws_ea_artifact_revisions(artifact_id,revision,title,html,source_hash,byte_count,created_at) VALUES(?,?,?,?,?,?,?)',
      artifactId,
      revision,
      input.title,
      source.html,
      source.source_hash,
      source.byte_count,
      now,
    );
    const changed = await db.run(
      `UPDATE gws_ea_artifacts SET title=?,head_revision=?,generation=?,expires_at=?,updated_at=? WHERE artifact_id=? AND ${'create_key' in input ? 'head_revision IS NULL' : 'head_revision=?'}`,
      input.title,
      revision,
      generation,
      expiresAt,
      now,
      artifactId,
      ...('create_key' in input ? [] : [input.expected_revision]),
    );
    if (changed.changes !== 1) throw forbidden('The artifact changed. Read its current revision before saving again.');
    const result: ArtifactSaveResult = {
      artifact_id: artifactId,
      revision,
      source_hash: source.source_hash,
      byte_count: source.byte_count,
      generation,
    };
    await settleArtifactRequest(actor, request, result, source.source_hash);
    return result;
  });
}
export async function deleteArtifact(
  actor: ArtifactActor,
  request: ArtifactRequest,
  artifactId: string,
  expectedGeneration: number,
): Promise<ArtifactDeleteResult> {
  if (request.action !== 'delete') throw new Error('Artifact deletion requires a delete request.');
  const db = getDb();
  return db.transaction(async () => {
    const previous = await getArtifactRequest(actor, request);
    if (previous) return savedDeleteResult(previous);
    const held = await db.get<StoredArtifact>(
      'SELECT artifact_id,author_group_id,initial_fingerprint,head_revision,generation,expires_at,deleted_at FROM gws_ea_artifacts WHERE artifact_id=?',
      artifactId,
    );
    if (!held || (!actor.isMain && held.author_group_id !== actor.agentGroupId))
      throw forbidden('Only your own artifacts may be deleted.');
    if (held.deleted_at !== null) throw forbidden('This artifact was deleted.');
    if (held.generation !== expectedGeneration)
      throw forbidden('The artifact changed. Read its current generation before deleting.');
    const generation = held.generation + 1;
    const now = new Date().toISOString();
    const changed = await db.run(
      'UPDATE gws_ea_artifacts SET title=NULL,head_revision=NULL,expires_at=NULL,deleted_at=?,updated_at=?,generation=? WHERE artifact_id=? AND generation=?',
      now,
      now,
      generation,
      artifactId,
      expectedGeneration,
    );
    if (changed.changes !== 1) throw forbidden('The artifact changed. Read its current generation before deleting.');
    await db.run(
      "UPDATE gws_ea_artifact_shares SET state='revoked',revision=NULL,source_hash=NULL,scope_hash=NULL,principal_messaging_group_id=NULL,principal_message_id=NULL,generation=generation+1,updated_at=? WHERE artifact_id=?",
      now,
      artifactId,
    );
    await db.run(
      'DELETE FROM gws_ea_artifact_share_recipients WHERE share_id IN (SELECT share_id FROM gws_ea_artifact_shares WHERE artifact_id=?)',
      artifactId,
    );
    await db.run('DELETE FROM gws_ea_artifact_revisions WHERE artifact_id=?', artifactId);
    const result: ArtifactDeleteResult = { artifact_id: artifactId, deleted: true, generation };
    await settleArtifactRequest(actor, request, result);
    return result;
  });
}
