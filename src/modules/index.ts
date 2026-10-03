/**
 * Modules barrel.
 *
 * Each module self-registers at import time. This barrel is imported by
 * src/index.ts for side effects (registry registrations, typing impl setup,
 * etc.). Core runs with an empty barrel — the registries have inline
 * fallbacks and `sqlite_master` guards.
 *
 * Default modules (ship with main, direct core import):
 *   - src/modules/typing/        → imported directly by router/delivery/container-runner
 *   - src/modules/mount-security/ → imported directly by container-runner
 *
 * Registry-based modules (installed via /add-<name> skills, pulled from the
 * `modules` branch): append imports below. The singular mailbox slot is the
 * exception: skills replace mailbox/compose.ts and leave this import intact.
 */
import '../mailbox/compose.js';
// Per-group capabilities: its migration adds the column the host reads to
// decide each group's tools, so it loads before anything spawns a group.
import './capabilities/index.js';

// Approvals (default tier) must load before self-mod (optional) so the
// registerApprovalHandler / requestApproval symbols are bound when self-mod
// registers its handlers at import time.
import './approvals/index.js';
import './interactive/index.js';
import './permissions/index.js';
import './agent-to-agent/index.js';
import './self-mod/index.js';
import './gws-ea-google/index.js';
import './gws-ea-main/index.js';
import './gws-ea-profile/index.js';
import './gws-ea-preferences/index.js';
import './gws-ea-people/index.js';
import './gws-ea-notices/index.js';
import './gws-ea-privacy/index.js';
import './gws-ea-external-email/index.js';
import './gws-ea-inbox/index.js';
import './gws-ea-meetings/index.js';
import './community-portal/index.js';
