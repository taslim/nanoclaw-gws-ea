import fs from 'fs';

import { getTrustLevel } from './mcp-tools/server.js';

type McpServerConfig = { command: string; args: string[]; env: Record<string, string> };

const SA_KEY_PATH = '/home/node/.gws/service-account.json';
const CALENDARS_CONFIG_PATH = '/home/node/.gws/calendars.json';

const WORKSPACE_BIN = '/opt/google_workspace_mcp/.venv/bin/python';
const WORKSPACE_ENTRY = '/opt/google_workspace_mcp/main.py';
const CALENDAR_ENTRY = '/opt/google-calendar-mcp/build/index.js';

// `WORKSPACE_MCP_PERMISSIONS` drives both service selection and per-tier
// filtering, and is silently dropped if `--tools` is also set — so we pass
// permissions only. Principal caps gmail at `drafts` (no send_gmail_message)
// so outbound mail goes through the email channel adapter only.
const EXTERNAL_WORKSPACE_PERMISSIONS = ['gmail', 'drive', 'docs', 'sheets', 'slides', 'contacts']
  .map((t) => `${t}:readonly`)
  .join(' ');

const PRINCIPAL_WORKSPACE_PERMISSIONS = [
  'gmail:drafts',
  'drive:full',
  'docs:full',
  'sheets:full',
  'slides:full',
  'contacts:full',
  'chat:full',
  'tasks:full',
].join(' ');

const EXTERNAL_CALENDAR_TOOLS = ['get-availability', 'respond-to-event'].join(',');

export function getGwsMcpServers(): Record<string, McpServerConfig> {
  const assistantEmail = process.env.ASSISTANT_EMAIL;
  if (!assistantEmail || !fs.existsSync(SA_KEY_PATH)) return {};

  const trust = getTrustLevel();
  const servers: Record<string, McpServerConfig> = {};

  const workspaceEnv: Record<string, string> = {
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: SA_KEY_PATH,
    USER_GOOGLE_EMAIL: assistantEmail,
    WORKSPACE_MCP_PERMISSIONS:
      trust === 'known' ? PRINCIPAL_WORKSPACE_PERMISSIONS : EXTERNAL_WORKSPACE_PERMISSIONS,
  };

  // Claude Code 2.1.128 reserved `workspace` as an internal MCP name and
  // silently skips any user server with that key. Use `gworkspace` instead.
  servers.gworkspace = {
    command: WORKSPACE_BIN,
    args: [WORKSPACE_ENTRY],
    env: workspaceEnv,
  };

  const calendarEnv: Record<string, string> = {
    GOOGLE_SERVICE_ACCOUNT_KEY_FILE: SA_KEY_PATH,
    USER_GOOGLE_EMAIL: assistantEmail,
  };
  if (trust === 'all') calendarEnv.ENABLED_TOOLS = EXTERNAL_CALENDAR_TOOLS;
  if (fs.existsSync(CALENDARS_CONFIG_PATH)) calendarEnv.EVENT_FILTER_CONFIG = CALENDARS_CONFIG_PATH;
  if (process.env.PRINCIPAL_EMAILS) calendarEnv.PRINCIPAL_EMAILS = process.env.PRINCIPAL_EMAILS;

  servers.calendar = {
    command: 'node',
    args: [CALENDAR_ENTRY],
    env: calendarEnv,
  };

  return servers;
}
