/**
 * Heartbeat group configuration for NanoClaw GWS-EA
 *
 * One-way group for scheduled sweeps. Posts to GChat via workspace MCP.
 */
import { ASSISTANT_NAME } from './config.js';

export const HEARTBEAT_GROUP = {
  jid: 'heartbeat:sweep',
  name: 'Proactive Sweep',
  folder: 'heartbeat',
  trigger: `@${ASSISTANT_NAME}`,
  requiresTrigger: false,
  containerConfig: {
    builtins: [
      'Bash',
      'Read',
      'Write',
      'Edit',
      'Glob',
      'Grep',
      'WebSearch',
      'WebFetch',
      'Task',
      'TaskOutput',
      'TaskStop',
      'ToolSearch',
    ],
    mcpConfig: {
      calendar: [
        'get-availability',
        'list-events',
        'respond-to-event',
        'create-event',
        'update-event',
        'delete-event',
        'list-calendars',
        'search-events',
      ],
      workspace: ['gmail', 'contacts', 'chat'],
      '1password': true as const,
    },
  },
};
