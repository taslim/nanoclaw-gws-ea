import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';
import { isValidTimezone } from './timezone.js';

// Read config values from .env (falls back to process.env).
const envConfig = readEnvFile([
  'ASSISTANT_NAME',
  'ASSISTANT_HAS_OWN_NUMBER',
  'EMAIL_EXTERNAL_DELAY',
  'EMAIL_POLL_INTERVAL',
  'GCHAT_POLL_INTERVAL',
  'PRINCIPAL_NAME',
  'PRINCIPAL_EMAILS',
  'ASSISTANT_EMAIL',
  'HEARTBEAT_SPACE_ID',
  'ONECLI_URL',
  'HOST_BROWSER_PORT',
  'TZ',
]);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;
export const EMAIL_EXTERNAL_DELAY = parseInt(
  process.env.EMAIL_EXTERNAL_DELAY ||
    envConfig.EMAIL_EXTERNAL_DELAY ||
    '360000', // 6min — avoid instant replies that look like AI
  10,
);

// --- GWS-EA config (all from .env) ---
export const EMAIL_POLL_INTERVAL = parseInt(
  process.env.EMAIL_POLL_INTERVAL || envConfig.EMAIL_POLL_INTERVAL || '60000',
  10,
);
export const GCHAT_POLL_INTERVAL = parseInt(
  process.env.GCHAT_POLL_INTERVAL || envConfig.GCHAT_POLL_INTERVAL || '30000',
  10,
);
export const PRINCIPAL_NAME =
  process.env.PRINCIPAL_NAME || envConfig.PRINCIPAL_NAME || '';
export const ASSISTANT_EMAIL =
  process.env.ASSISTANT_EMAIL || envConfig.ASSISTANT_EMAIL || '';
export const HEARTBEAT_SPACE_ID =
  process.env.HEARTBEAT_SPACE_ID || envConfig.HEARTBEAT_SPACE_ID || '';

const rawEmails = (
  process.env.PRINCIPAL_EMAILS ||
  envConfig.PRINCIPAL_EMAILS ||
  ''
)
  .split(',')
  .map((e) => e.trim())
  .filter(Boolean);
export const PRINCIPAL_EMAILS = new Set(rawEmails.map((e) => e.toLowerCase()));

export function isPrincipalEmail(email: string): boolean {
  return PRINCIPAL_EMAILS.has(email.toLowerCase());
}

export function validateEaConfig(): void {
  const errors: string[] = [];
  if (PRINCIPAL_EMAILS.size === 0) errors.push('PRINCIPAL_EMAILS is empty');
  if (!ASSISTANT_EMAIL) errors.push('ASSISTANT_EMAIL is not set');
  if (!PRINCIPAL_NAME) errors.push('PRINCIPAL_NAME is not set');
  if (errors.length > 0)
    throw new Error(
      `GWS-EA config error:\n${errors.map((e) => `  - ${e}`).join('\n')}`,
    );
}

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
export const MOUNT_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  HOME_DIR,
  '.config',
  'nanoclaw',
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(PROJECT_ROOT, 'store');
export const GROUPS_DIR = path.resolve(PROJECT_ROOT, 'groups');
export const DATA_DIR = path.resolve(PROJECT_ROOT, 'data');

export const HOST_BROWSER_PORT = parseInt(
  process.env.HOST_BROWSER_PORT || envConfig.HOST_BROWSER_PORT || '9222',
  10,
);

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const ONECLI_URL =
  process.env.ONECLI_URL || envConfig.ONECLI_URL || 'http://127.0.0.1:10254';
export const MAX_MESSAGES_PER_PROMPT = Math.max(
  1,
  parseInt(process.env.MAX_MESSAGES_PER_PROMPT || '10', 10) || 10,
);
export const ATTACHMENT_MAX_SIZE = 15 * 1024 * 1024; // 15MB
export const ATTACHMENT_MAX_PER_MESSAGE = 5;
export const ATTACHMENT_PRUNE_DAYS = 14;
export const SESSION_PRUNE_DAYS = 7;
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function buildTriggerPattern(trigger: string): RegExp {
  return new RegExp(`^${escapeRegex(trigger.trim())}\\b`, 'i');
}

export const DEFAULT_TRIGGER = `@${ASSISTANT_NAME}`;

export function getTriggerPattern(trigger?: string): RegExp {
  const normalizedTrigger = trigger?.trim();
  return buildTriggerPattern(normalizedTrigger || DEFAULT_TRIGGER);
}

export const TRIGGER_PATTERN = buildTriggerPattern(DEFAULT_TRIGGER);

// Timezone for scheduled tasks, message formatting, etc.
// Validates each candidate is a real IANA identifier before accepting.
function resolveConfigTimezone(): string {
  const candidates = [
    process.env.TZ,
    envConfig.TZ,
    Intl.DateTimeFormat().resolvedOptions().timeZone,
  ];
  for (const tz of candidates) {
    if (tz && isValidTimezone(tz)) return tz;
  }
  return 'UTC';
}
export const TIMEZONE = resolveConfigTimezone();
