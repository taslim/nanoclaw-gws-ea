/**
 * Delivery-action handlers for the matters module.
 *
 * Containers cannot write to the central DB (no mount, by design), so
 * agent-side mutations arrive as system actions on `messages_out`. Each
 * handler applies the change, then re-projects matters into the calling
 * session's `inbound.db` so the agent sees its own write on the very next
 * read. Other sessions get the update on their next container wake.
 *
 * Handlers are fire-and-forget — validation failures log and return; the
 * agent finds out by re-reading. Mirrors `src/modules/agent-to-agent/
 * create-agent.ts` (handler shape, projection-refresh-after-mutation).
 */
import fs from 'fs';
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import type { MatterStatus, Session } from '../../types.js';
import {
  appendToPendingSection,
  contextFilePath,
  readContextFile,
  sanitizePendingEntry,
  writeContextFile,
} from './context-file.js';
import {
  createMatter as dbCreateMatter,
  getMatter,
  linkArtifactIfFree,
  touchMatter,
  updateMatter as dbUpdateMatter,
} from './db/matters.js';
import { writeMatters } from './write-matters.js';

export async function handleCreateMatter(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const title = content.title as string | undefined;
  if (!title) {
    log.warn('create_matter: missing title');
    return;
  }
  const description = (content.description as string | null | undefined) ?? null;
  const initialContext = content.context as string | null | undefined;

  const id = dbCreateMatter({ title, description });
  if (initialContext != null && initialContext.length > 0) {
    writeContextFile(id, initialContext);
  }
  log.info('Matter created', { id, title });
  writeMatters(session.agent_group_id, session.id);
}

export async function handleUpdateMatter(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const matterId = content.matterId as number | undefined;
  if (matterId == null) {
    log.warn('update_matter: missing matterId');
    return;
  }
  if (!getMatter(matterId)) {
    log.warn('update_matter: unknown matter', { matterId });
    return;
  }
  const patch: { title?: string; description?: string | null; status?: MatterStatus } = {};
  if (typeof content.title === 'string') patch.title = content.title;
  if ('description' in content) patch.description = (content.description as string | null) ?? null;
  if (typeof content.status === 'string') patch.status = content.status as MatterStatus;
  if (Object.keys(patch).length === 0) {
    log.warn('update_matter: no fields to update', { matterId });
    return;
  }
  dbUpdateMatter(matterId, patch);
  log.info('Matter updated', { matterId, fields: Object.keys(patch) });
  writeMatters(session.agent_group_id, session.id);
}

export async function handleUpdateMatterContext(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const matterId = content.matterId as number | undefined;
  const body = content.context as string | null | undefined;
  if (matterId == null || body == null) {
    log.warn('update_matter_context: missing matterId or context');
    return;
  }
  if (!getMatter(matterId)) {
    log.warn('update_matter_context: unknown matter', { matterId });
    return;
  }
  if (body.length === 0) {
    fs.rmSync(contextFilePath(matterId), { force: true });
  } else {
    writeContextFile(matterId, body);
  }
  touchMatter(matterId);
  log.info('Matter context updated', { matterId, bytes: body.length });
  writeMatters(session.agent_group_id, session.id);
}

export async function handleAppendPendingLog(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const matterId = content.matterId as number | undefined;
  const entryRaw = content.entry as string | undefined;
  if (matterId == null || !entryRaw) {
    log.warn('append_pending_log: missing fields');
    return;
  }
  if (!getMatter(matterId)) {
    log.warn('append_pending_log: unknown matter', { matterId });
    return;
  }
  const entry = sanitizePendingEntry(entryRaw);
  if (entry.length === 0) {
    log.warn('append_pending_log: entry empty after sanitize', { matterId });
    return;
  }
  const artifactType = content.artifactType as string | undefined;
  const artifactId = content.artifactId as string | undefined;
  const artifactRef = artifactType && artifactId ? ` (${artifactType}:${artifactId})` : '';
  const tag = `[${session.agent_group_id} session=${session.id}]`;
  const line = `- ${new Date().toISOString()} ${tag}${artifactRef} — ${entry}`;
  const next = appendToPendingSection(readContextFile(matterId), line);
  writeContextFile(matterId, next);
  touchMatter(matterId);
  log.info('Matter pending entry appended', { matterId, agentGroupId: session.agent_group_id });
  writeMatters(session.agent_group_id, session.id);
}

export async function handleLinkArtifact(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const matterId = content.matterId as number | undefined;
  const artifactType = content.artifactType as string | undefined;
  const artifactId = content.artifactId as string | undefined;
  if (matterId == null || !artifactType || !artifactId) {
    log.warn('link_artifact: missing fields');
    return;
  }
  if (!getMatter(matterId)) {
    log.warn('link_artifact: unknown matter', { matterId });
    return;
  }
  const existing = linkArtifactIfFree(matterId, artifactType, artifactId);
  if (existing) {
    if (existing.id !== matterId) {
      log.warn('link_artifact: artifact already linked to different matter', {
        artifactType,
        artifactId,
        existingMatterId: existing.id,
        requestedMatterId: matterId,
      });
    }
    return;
  }
  touchMatter(matterId);
  log.info('Artifact linked', { matterId, artifactType, artifactId });
  writeMatters(session.agent_group_id, session.id);
}
