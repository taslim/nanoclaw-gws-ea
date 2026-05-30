/**
 * Matters module — workstream tracking. Custom build for GWS-EA.
 *
 * Registers five delivery actions: `create_matter`, `update_matter`,
 * `update_matter_context`, `link_artifact`, `append_pending_log`.
 * Container-side MCP tools at
 * `container/agent-runner/src/mcp-tools/matters.ts` post these actions.
 *
 * Host integration points:
 *   - `src/container-runner.ts::spawnContainer` dynamically imports
 *     `./write-matters.js` on every wake (guarded by
 *     `hasTable('matters')`).
 *   - System-action handlers in `./actions.ts` re-project for the calling
 *     session so agents see their own writes immediately.
 *
 * Without this module: `matters` table absent ⇒ container-runner skips
 * projection, container-side reads return empty, system actions log
 * "Unknown system action".
 */
import { registerDeliveryAction } from '../../delivery.js';
import {
  handleAppendPendingLog,
  handleCreateMatter,
  handleLinkArtifact,
  handleUpdateMatter,
  handleUpdateMatterContext,
} from './actions.js';

registerDeliveryAction('create_matter', handleCreateMatter);
registerDeliveryAction('update_matter', handleUpdateMatter);
registerDeliveryAction('update_matter_context', handleUpdateMatterContext);
registerDeliveryAction('link_artifact', handleLinkArtifact);
registerDeliveryAction('append_pending_log', handleAppendPendingLog);
