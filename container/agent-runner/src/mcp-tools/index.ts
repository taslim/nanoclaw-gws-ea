/**
 * MCP tools barrel — loads each tool module for its side-effect
 * `registerTools([...])` call, then starts the MCP server.
 *
 * Adding a new tool module: create the file, call `registerTools([...])`
 * at module scope, and load it here under its capability key. No central list.
 * The server serves only the tools of the keys in the group's container.json.
 */
import { loadConfig } from '../config.js';
// core.ts names its own two keys: `reply` and `files-send`.
import './core.js';
import { getAgentMailbox, readMailboxContext } from '../mailbox/index.js';
import { loadToolModule, startMcpServer } from './server.js';

// One capability key per tool module, loaded before the module barrel so an
// installed module can extend any base tool.
await loadToolModule('interactive', () => import('./interactive.js'));
await loadToolModule('agents', () => import('./agents.js'));
await loadToolModule('self-mod', () => import('./self-mod.js'));
await loadToolModule('time', () => import('./time.js'));
await loadToolModule('schedule-stats', () => import('./schedule-stats.js'));
await loadToolModule('calendar-facts', () => import('./calendar-facts.js'));
// The meeting handoff and the email tools each name their own two keys, one
// for each agent, and request_status and the reminders their own: their
// tests load them ahead of this barrel.
await import('./gws-ea-meetings.js');
await import('./gws-ea-email.js');
await import('./reminders.js');
await import('./request-status.js');
// Module barrel — loads registration modules, including the singular mailbox
// slot. A module registering tools passes its own capability key.
await import('../modules/index.js');

function log(msg: string): void {
  console.error(`[mcp-tools] ${msg}`);
}

async function main(): Promise<void> {
  const { capabilities } = loadConfig();
  const mailbox = getAgentMailbox();
  await mailbox.start(await readMailboxContext());
  try {
    await startMcpServer((action) => mailbox.run(action), capabilities);
  } finally {
    await mailbox.stop();
  }
}

// Started as the entry point (`bun run .../mcp-tools/index.ts`); a test that
// imports the barrel gets its tool registrations without a stdio server.
if (import.meta.main) {
  main().catch((err) => {
    log(`MCP server error: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}
