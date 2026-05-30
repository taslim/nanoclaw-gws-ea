/**
 * Per-assistant OneCLI vault namespace.
 *
 * Multi-install on one Mac shares one OneCLI vault. To keep secrets and
 * agents isolated across installs, this fork uses the convention:
 *
 *     <assistant>-<purpose>      (e.g. assistant-anthropic, assistant-1password)
 *
 * where `<assistant>` is `ASSISTANT_NAME.toLowerCase()` (spaces → hyphens).
 *
 * This helper is the "per-install all": instead of OneCLI's mode='all'
 * (which pulls every secret in the shared vault — including those owned by
 * other assistants), it assigns only secrets matching the current
 * ASSISTANT_NAME prefix. Container agents stay mode='selective' with
 * explicit secret IDs.
 *
 * Called on every container spawn (idempotent — `set-secrets` is destructive
 * replace, so re-running with the same set is a no-op). Soft-fails on CLI
 * errors so secret-assignment problems surface as 401s at first API call
 * rather than blocking spawn — same failure mode as upstream's documented
 * gotcha at CLAUDE.md:99-126.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';

import { ASSISTANT_NAME } from './config.js';
import { log } from './log.js';

const exec = promisify(execFile);

interface VaultSecret {
  id: string;
  name: string;
}

interface VaultAgent {
  id: string;
  identifier: string;
}

export function getNamespacePrefix(): string {
  return ASSISTANT_NAME.toLowerCase().replace(/\s+/g, '-') + '-';
}

async function listSecrets(): Promise<VaultSecret[]> {
  const { stdout } = await exec('onecli', ['secrets', 'list']);
  return JSON.parse(stdout) as VaultSecret[];
}

async function listAgents(): Promise<VaultAgent[]> {
  const { stdout } = await exec('onecli', ['agents', 'list']);
  return JSON.parse(stdout) as VaultAgent[];
}

export async function assignNamespacedSecrets(agentIdentifier: string): Promise<void> {
  const prefix = getNamespacePrefix();

  let secrets: VaultSecret[];
  let agents: VaultAgent[];
  try {
    [secrets, agents] = await Promise.all([listSecrets(), listAgents()]);
  } catch (err) {
    log.warn('OneCLI list failed — skipping namespace assignment', { err, prefix, agentIdentifier });
    return;
  }

  const agent = agents.find((a) => a.identifier === agentIdentifier);
  if (!agent) {
    log.warn('Agent not found in OneCLI vault — skipping namespace assignment', { agentIdentifier });
    return;
  }

  const matching = secrets.filter((s) => s.name.toLowerCase().startsWith(prefix));
  if (matching.length === 0) {
    log.warn('No namespaced secrets in vault — agent has no credentials', { prefix, agentIdentifier });
    return;
  }

  try {
    await exec('onecli', [
      'agents',
      'set-secrets',
      '--id',
      agent.id,
      '--secret-ids',
      matching.map((s) => s.id).join(','),
    ]);
    log.info('Assigned namespaced secrets', {
      prefix,
      agentIdentifier,
      count: matching.length,
      names: matching.map((s) => s.name),
    });
  } catch (err) {
    log.warn('OneCLI set-secrets failed', { err, prefix, agentIdentifier });
  }
}
