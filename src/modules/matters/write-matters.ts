/**
 * Project central matters + matter_artifacts into a session's `inbound.db`
 * so the running container can read them locally. Called on every container
 * wake (via `container-runner.ts::spawnContainer`, guarded by `hasTable`)
 * and after every system-action mutation for the calling session (via
 * `actions.ts`).
 *
 * The projection includes the context file content, so container-side
 * `find_matter` / `list_matters` return everything in a single inbound.db
 * read — no central DB mount, no FS reads from inside the container.
 */
import fs from 'fs';

import { replaceMatters } from '../../db/session-db.js';
import { log } from '../../log.js';
import { inboundDbPath, openInboundDb } from '../../session-manager.js';
import { readContextFile } from './context-file.js';
import { getAllArtifacts, getAllMatters } from './db/matters.js';

export function writeMatters(agentGroupId: string, sessionId: string): void {
  const dbPath = inboundDbPath(agentGroupId, sessionId);
  if (!fs.existsSync(dbPath)) return;

  const matters = getAllMatters().map((m) => ({
    id: m.id,
    title: m.title,
    description: m.description,
    status: m.status,
    context: readContextFile(m.id),
    updated_at: m.updated_at,
  }));
  const artifacts = getAllArtifacts();

  const db = openInboundDb(agentGroupId, sessionId);
  try {
    replaceMatters(db, matters, artifacts);
  } finally {
    db.close();
  }
  log.debug('Matters projection written', { sessionId, matters: matters.length, artifacts: artifacts.length });
}
