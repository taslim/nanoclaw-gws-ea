/**
 * The operator's browser access setting as a test needs it: the
 * owner-only policy file at `file`, read by every host check for the rest
 * of the test. With `agentGroupIds`, a version-2 list of exactly those
 * groups; without, version 1, main alone. The caller clears the stubbed
 * environment (`vi.unstubAllEnvs`, or by deleting the variable).
 */
import fs from 'node:fs';
import path from 'node:path';
import { vi } from 'vitest';

export function writeBrowserAccess(
  file: string,
  access: { readonly agentGroupIds?: readonly string[]; readonly enabled?: boolean } = {},
): void {
  const enabled = access.enabled ?? true;
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(
    file,
    JSON.stringify(
      access.agentGroupIds === undefined
        ? { schemaVersion: 1, enabled }
        : { schemaVersion: 2, enabled, agentGroupIds: access.agentGroupIds },
    ),
    { mode: 0o600 },
  );
  vi.stubEnv('GWS_EA_BROWSER_POLICY_FILE', file);
}
