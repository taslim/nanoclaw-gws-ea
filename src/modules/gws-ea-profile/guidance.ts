/**
 * A GWS-EA agent's guidance: how it works, as a required section of the
 * project document only that agent receives (src/project-doc-sections.ts).
 * The file ships with the release, read from the checkout the host runs
 * from as NanoClaw reads its other instruction files, and never lives where
 * the agent can edit it.
 *
 * A missing or empty file is tolerated but never silent, like a missing base
 * document (src/project-doc-compose.ts): throwing would fail every spawn.
 * The release preflight refuses a release without it.
 */
import fs from 'node:fs';
import path from 'node:path';

import { log } from '../../log.js';
import { registerRequiredProjectDocSection } from '../../project-doc-sections.js';

export type Guidance = {
  /** The agent it is for, as the host's log names it. */
  readonly agent: string;
  /** The section's heading. */
  readonly heading: string;
  /** The file, relative to the checkout. */
  readonly file: string;
} & (
  | {
      /** The agent's group, or null before the host has created it. */
      readonly agentGroupId: () => Promise<string | null>;
    }
  | {
      /** Whether `agentGroupId` receives it: guidance for every group a setting names. */
      readonly receives: (agentGroupId: string) => Promise<boolean>;
    }
);

const guidanceFiles = new Set<string>();

/** Every registered guidance file, relative to the checkout: what the release's caps and command checks cover. */
export function registeredGuidanceFiles(): string[] {
  return [...guidanceFiles].sort();
}

export function registerGuidance(id: string, guidance: Guidance): void {
  guidanceFiles.add(guidance.file.split(path.sep).join('/'));
  registerRequiredProjectDocSection(id, async (group) => {
    const receives =
      'receives' in guidance ? await guidance.receives(group.id) : group.id === (await guidance.agentGroupId());
    if (!receives) return undefined;
    const file = path.resolve(process.cwd(), guidance.file);
    if (!fs.existsSync(file)) {
      log.error(`${guidance.agent}'s guidance is missing; it starts without it`, { file });
      return undefined;
    }
    const body = fs.readFileSync(file, 'utf8');
    if (!body.trim()) {
      log.error(`${guidance.agent}'s guidance is empty; it starts without it`, { file });
      return undefined;
    }
    return { name: guidance.heading, body };
  });
}
