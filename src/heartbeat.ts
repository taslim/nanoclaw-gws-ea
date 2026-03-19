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
  allowedTools: [
    // Standard tools
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
    // NanoClaw IPC
    'mcp__nanoclaw__send_message',
    'mcp__nanoclaw__schedule_task',
    'mcp__nanoclaw__list_tasks',
    'mcp__nanoclaw__create_matter',
    'mcp__nanoclaw__update_matter',
    'mcp__nanoclaw__list_matters',
    'mcp__nanoclaw__get_matter',
    'mcp__nanoclaw__find_matter',
    // Full calendar access
    'mcp__calendar__*',
    // Time MCP
    'mcp__time__*',
    // Gmail (search + read, send for follow-ups)
    'mcp__workspace__send_gmail_message',
    'mcp__workspace__draft_gmail_message',
    'mcp__workspace__search_gmail_messages',
    'mcp__workspace__get_gmail_message_content',
    'mcp__workspace__get_gmail_messages_content_batch',
    'mcp__workspace__get_gmail_thread_content',
    'mcp__workspace__get_gmail_attachment_content',
    'mcp__workspace__list_gmail_labels',
    // Contacts (tier lookups + relationship management)
    'mcp__workspace__contacts_search',
    'mcp__workspace__contacts_get',
    'mcp__workspace__manage_contact',
    'mcp__workspace__list_contact_groups',
    'mcp__workspace__manage_contact_group',
    // Workspace Chat (heartbeat logging)
    'mcp__workspace__chat_send_message',
    'mcp__workspace__chat_get_messages',
  ],
};
