/**
 * Per-install state sync — detect drift between `.env` values that get
 * copied to persistent surfaces (CLAUDE.md text, role grants, etc.) and
 * propagate changes on host boot. The `install_state` table holds the
 * last-synced value per tracked key; on each boot we compare stored vs.
 * current env and dispatch the per-key handler when they diverge.
 *
 * First boot has stored=null for every key. Handlers decide what that
 * means: substitution-style handlers (text rewrites) treat it as "baseline
 * already on disk, just record it"; the PRINCIPAL_EMAILS handler treats it
 * as "all current emails are new" and grants owner to each — auto-seeding
 * principal privileges without a separate setup ritual.
 */
import fs from 'fs';
import path from 'path';

import { escapeRegex } from './config.js';
import { getAllAgentGroups, updateAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import { parseCsvSet, readEnvFile } from './env.js';
import { log } from './log.js';
import { upsertUser } from './modules/permissions/db/users.js';
import { grantRole, revokeRole, isOwner } from './modules/permissions/db/user-roles.js';

// Files that copy identity values from .env. Anchored-substitution targets.
const CONTAINER_CLAUDE_MD = path.join(process.cwd(), 'container', 'CLAUDE.md');
const IDENTITY_FILES = [CONTAINER_CLAUDE_MD];

// — DB accessor —

function readState(key: string): string | null {
  const row = getDb().prepare('SELECT value FROM install_state WHERE key = ?').get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

function writeState(key: string, value: string): void {
  getDb()
    .prepare(
      `INSERT INTO install_state (key, value, updated_at)
       VALUES (?, ?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
    )
    .run(key, value, new Date().toISOString());
}

// — Identity file substitution (batched) —

interface IdentityRewrite {
  oldValue: string;
  newValue: string;
  label: string;
}

const pendingRewrites: IdentityRewrite[] = [];

function queueIdentityRewrite(oldValue: string | null, newValue: string, label: string): void {
  if (!oldValue || oldValue === newValue) return;
  pendingRewrites.push({ oldValue, newValue, label });
}

/**
 * Apply all queued substitutions per file with a single read/write. Avoids
 * 5x file IO when multiple identity vars change in one boot.
 */
function flushIdentityRewrites(): void {
  if (pendingRewrites.length === 0) return;
  for (const file of IDENTITY_FILES) {
    if (!fs.existsSync(file)) continue;
    const before = fs.readFileSync(file, 'utf-8');
    let after = before;
    const appliedLabels: string[] = [];
    for (const { oldValue, newValue, label } of pendingRewrites) {
      const re = new RegExp(`\\b${escapeRegex(oldValue)}\\b`, 'g');
      const next = after.replace(re, newValue);
      if (next !== after) appliedLabels.push(label);
      after = next;
    }
    if (after !== before) {
      fs.writeFileSync(file, after);
      log.info('identity rewrite', {
        file: path.relative(process.cwd(), file),
        applied: appliedLabels,
      });
    }
  }
  pendingRewrites.length = 0;
}

// — Handlers —

type ChangeHandler = (oldValue: string | null, newValue: string) => void;

function handleAssistantNameChange(oldValue: string | null, newValue: string): void {
  queueIdentityRewrite(oldValue, newValue, 'ASSISTANT_NAME');
  if (!oldValue || oldValue === newValue) return;

  // container-runner reconciles container.json's groupName/assistantName
  // from agent_groups.name on every spawn, so the DB update suffices.
  // Hand-renamed groups (name !== oldValue) are left alone.
  let renamed = 0;
  for (const ag of getAllAgentGroups()) {
    if (ag.name === oldValue) {
      updateAgentGroup(ag.id, { name: newValue });
      renamed++;
    }
  }
  if (renamed > 0) {
    log.info('assistant name change: rolled forward agent_groups', {
      from: oldValue,
      to: newValue,
      count: renamed,
    });
  }

  // launchd / systemd unit labels embed the slug; reload required.
  log.warn('assistant name changed; reload service to update launchd/systemd label', {
    from: oldValue,
    to: newValue,
  });
}

function handleAssistantLastNameChange(oldValue: string | null, newValue: string): void {
  queueIdentityRewrite(oldValue, newValue, 'ASSISTANT_LAST_NAME');
}

function handleAssistantEmailChange(oldValue: string | null, newValue: string): void {
  queueIdentityRewrite(oldValue, newValue, 'ASSISTANT_EMAIL');
}

function handlePrincipalNameChange(oldValue: string | null, newValue: string): void {
  queueIdentityRewrite(oldValue, newValue, 'PRINCIPAL_NAME');
}

function handlePrincipalLastNameChange(oldValue: string | null, newValue: string): void {
  queueIdentityRewrite(oldValue, newValue, 'PRINCIPAL_LAST_NAME');
}

/**
 * Source of owner-eligible email identities. Diff old vs new; grant owner
 * for added, revoke for removed. User rows retained on revoke (FK
 * references; revocation is reversible by re-adding to the env list).
 *
 * Non-email principal identities (gchat, telegram, …) need owner role too
 * for approval-routing tie-break — covered today by `init-first-agent.ts
 * --role owner` for fresh installs and one-shot SQL otherwise. A future
 * inbound auto-promote hook (resolver-driven) is the long-term fix.
 */
function handlePrincipalEmailsChange(oldValue: string | null, newValue: string): void {
  const oldSet = parseCsvSet(oldValue);
  const newSet = parseCsvSet(newValue);
  const now = new Date().toISOString();

  for (const email of newSet) {
    if (oldSet.has(email)) continue;
    const userId = `email:${email}`;
    upsertUser({ id: userId, kind: 'email', display_name: null, created_at: now });
    if (!isOwner(userId)) {
      grantRole({ user_id: userId, role: 'owner', agent_group_id: null, granted_by: null, granted_at: now });
      log.info('principal granted owner', { userId });
    }
  }

  for (const email of oldSet) {
    if (newSet.has(email)) continue;
    const userId = `email:${email}`;
    revokeRole(userId, 'owner', null);
    log.info('principal owner revoked', { userId });
  }
}

const HANDLERS = [
  { key: 'ASSISTANT_NAME', apply: handleAssistantNameChange },
  { key: 'ASSISTANT_LAST_NAME', apply: handleAssistantLastNameChange },
  { key: 'ASSISTANT_EMAIL', apply: handleAssistantEmailChange },
  { key: 'PRINCIPAL_NAME', apply: handlePrincipalNameChange },
  { key: 'PRINCIPAL_LAST_NAME', apply: handlePrincipalLastNameChange },
  { key: 'PRINCIPAL_EMAILS', apply: handlePrincipalEmailsChange },
] as const satisfies ReadonlyArray<{ key: string; apply: ChangeHandler }>;

// — Dispatcher —

/**
 * Reads tracked vars from `.env` (not just `process.env`) — launchd plists
 * carry only a subset of env into the host process. Mirrors how
 * `src/config.ts` reads ASSISTANT_NAME etc.
 */
export function syncInstallState(): void {
  const keys = HANDLERS.map((h) => h.key);
  const envValues = readEnvFile(keys);
  for (const { key, apply } of HANDLERS) {
    const env = (process.env[key] || envValues[key])?.trim();
    const stored = readState(key);
    if (!env) continue;
    if (env === stored) continue;
    try {
      apply(stored, env);
      writeState(key, env);
      log.info('install_state synced', { key, from: stored, to: env });
    } catch (err) {
      log.error('install_state sync failed', { key, err });
      // Don't writeState — next boot retries.
    }
  }
  flushIdentityRewrites();
}
