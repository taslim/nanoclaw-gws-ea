/**
 * Runner config — reads /workspace/agent/container.json at startup.
 *
 * This file is mounted read-only inside the container. The host writes it;
 * the runner only reads. All NanoClaw-specific configuration lives here
 * instead of environment variables.
 */
import fs from 'fs';

import type { McpServerConfig, ProviderSpeed } from './providers/types.js';

const CONFIG_PATH = '/workspace/agent/container.json';

export interface RunnerConfig {
  provider: string;
  assistantName: string;
  groupName: string;
  agentGroupId: string;
  maxMessagesPerPrompt: number;
  mcpServers: Record<string, McpServerConfig>;
  model?: string;
  effort?: string;
  speed?: ProviderSpeed;
  /**
   * The capability keys this group holds: the host resolves the group's
   * stored list (or `all`) and writes it out explicitly, so the runner never
   * expands a default itself. A missing or malformed list grants nothing.
   */
  capabilities: ReadonlySet<string>;
}

const DEFAULT_MAX_MESSAGES = 10;

const NO_CAPABILITIES: ReadonlySet<string> = new Set();

let _config: RunnerConfig | null = null;

/**
 * Load config from container.json. Called once at startup.
 * Falls back to sensible defaults for any missing field.
 */
export function loadConfig(): RunnerConfig {
  if (_config) return _config;

  let raw: Record<string, unknown> = {};
  try {
    raw = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    console.error(`[config] Failed to read ${CONFIG_PATH}, using defaults`);
  }

  _config = runnerConfigFromRaw(raw);

  return _config;
}

/** Build the runner config from a parsed container.json; missing fields take their defaults. */
export function runnerConfigFromRaw(raw: Record<string, unknown>): RunnerConfig {
  return {
    provider: (raw.provider as string) || 'claude',
    assistantName: (raw.assistantName as string) || '',
    groupName: (raw.groupName as string) || '',
    agentGroupId: (raw.agentGroupId as string) || '',
    maxMessagesPerPrompt: (raw.maxMessagesPerPrompt as number) || DEFAULT_MAX_MESSAGES,
    mcpServers: (raw.mcpServers as RunnerConfig['mcpServers']) || {},
    model: (raw.model as string) || undefined,
    effort: (raw.effort as string) || undefined,
    speed: readSpeed(raw),
    capabilities: readCapabilities(raw),
  };
}

/**
 * Deny-all unless the host wrote a list of keys. A container.json from a host
 * older than capabilities has none, and an agent then starts with no tools
 * rather than with every tool.
 */
function readCapabilities(raw: Record<string, unknown>): ReadonlySet<string> {
  const value = raw.capabilities;
  if (Array.isArray(value) && value.every((key): key is string => typeof key === 'string')) return new Set(value);
  console.error('[config] container.json carries no valid capability list; granting no capabilities');
  return NO_CAPABILITIES;
}

/**
 * The capabilities of the loaded config. Nothing is granted before
 * `loadConfig()` has run, so a provider or tool server built outside the
 * runner's startup can never hold more than its group was given.
 */
export function runnerCapabilities(): ReadonlySet<string> {
  return _config?.capabilities ?? NO_CAPABILITIES;
}

/**
 * `speed` wins when present; the host already validated it against the
 * provider's declared tiers, so any non-empty name passes through. A host from
 * before `speed` existed wrote only `fastMode: true`, so that alone still
 * means `fast`.
 */
function readSpeed(raw: Record<string, unknown>): ProviderSpeed | undefined {
  if (typeof raw.speed === 'string' && raw.speed !== '') return raw.speed;
  return raw.fastMode === true ? 'fast' : undefined;
}

/** Get the loaded config. Throws if loadConfig() hasn't been called. */
export function getConfig(): RunnerConfig {
  if (!_config) throw new Error('Config not loaded — call loadConfig() first');
  return _config;
}
