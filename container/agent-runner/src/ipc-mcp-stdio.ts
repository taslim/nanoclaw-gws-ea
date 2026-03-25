/**
 * Stdio MCP Server for NanoClaw
 * Standalone process that agent teams subagents can inherit.
 * Reads context from environment variables, writes IPC files for the host.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import fs from 'fs';
import path from 'path';
import { CronExpressionParser } from 'cron-parser';

const IPC_DIR = '/workspace/ipc';
const MESSAGES_DIR = path.join(IPC_DIR, 'messages');
const TASKS_DIR = path.join(IPC_DIR, 'tasks');

// Context from environment variables (set by the agent runner)
const chatJid = process.env.NANOCLAW_CHAT_JID!;
const groupFolder = process.env.NANOCLAW_GROUP_FOLDER!;
const isMain = process.env.NANOCLAW_IS_MAIN === '1';

function writeIpcFile(dir: string, data: object): string {
  fs.mkdirSync(dir, { recursive: true });

  const filename = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`;
  const filepath = path.join(dir, filename);

  // Atomic write: temp file then rename
  const tempPath = `${filepath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filepath);

  return filename;
}

const server = new McpServer({
  name: 'nanoclaw',
  version: '1.0.0',
});

server.tool(
  'send_message',
  "Send a message to the user or group immediately while you're still running. Use this for progress updates or to send multiple messages. You can call this multiple times.",
  {
    text: z.string().describe('The message text to send'),
    sender: z.string().optional().describe('Your role/identity name (e.g. "Researcher"). When set, messages appear from a dedicated bot in Telegram.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'message',
      chatJid,
      text: args.text,
      sender: args.sender || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: 'Message sent.' }] };
  },
);

server.tool(
  'react_to_message',
  'React to a message with an emoji. Omit message_id to react to the most recent message in the chat.',
  {
    emoji: z.string().describe('The emoji to react with (e.g. "👍", "❤️", "🔥")'),
    message_id: z.string().optional().describe('The message ID to react to. If omitted, reacts to the latest message in the chat.'),
  },
  async (args) => {
    const data: Record<string, string | undefined> = {
      type: 'reaction',
      chatJid,
      emoji: args.emoji,
      messageId: args.message_id || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(MESSAGES_DIR, data);

    return { content: [{ type: 'text' as const, text: `Reaction ${args.emoji} sent.` }] };
  },
);

server.tool(
  'schedule_task',
  `Schedule a recurring or one-time task. The task will run as a full agent with access to all tools. Returns the task ID for future reference. To modify an existing task, use update_task instead.

CONTEXT MODE - Choose based on task type:
\u2022 "group": Task runs in the group's conversation context, with access to chat history. Use for tasks that need context about ongoing discussions, user preferences, or recent interactions.
\u2022 "isolated": Task runs in a fresh session with no conversation history. Use for independent tasks that don't need prior context. When using isolated mode, include all necessary context in the prompt itself.

If unsure which mode to use, you can ask the user. Examples:
- "Remind me about our discussion" \u2192 group (needs conversation context)
- "Check the weather every morning" \u2192 isolated (self-contained task)
- "Follow up on my request" \u2192 group (needs to know what was requested)
- "Generate a daily report" \u2192 isolated (just needs instructions in prompt)

MESSAGING BEHAVIOR - The task agent's output is sent to the user or group. It can also use send_message for immediate delivery, or wrap output in <internal> tags to suppress it. Include guidance in the prompt about whether the agent should:
\u2022 Always send a message (e.g., reminders, daily briefings)
\u2022 Only send a message when there's something to report (e.g., "notify me if...")
\u2022 Never send a message (background maintenance tasks)

SCHEDULE VALUE FORMAT (all times are LOCAL timezone):
\u2022 cron: Standard cron expression (e.g., "*/5 * * * *" for every 5 minutes, "0 9 * * *" for daily at 9am LOCAL time)
\u2022 interval: Milliseconds between runs (e.g., "300000" for 5 minutes, "3600000" for 1 hour)
\u2022 once: Local time WITHOUT "Z" suffix (e.g., "2026-02-01T15:30:00"). Do NOT use UTC/Z suffix.`,
  {
    prompt: z.string().describe('What the agent should do when the task runs. For isolated mode, include all necessary context here.'),
    schedule_type: z.enum(['cron', 'interval', 'once']).describe('cron=recurring at specific times, interval=recurring every N ms, once=run once at specific time'),
    schedule_value: z.string().describe('cron: "*/5 * * * *" | interval: milliseconds like "300000" | once: local timestamp like "2026-02-01T15:30:00" (no Z suffix!)'),
    context_mode: z.enum(['group', 'isolated']).default('group').describe('group=runs with chat history and memory, isolated=fresh session (include context in prompt)'),
    target_group_jid: z.string().optional().describe('(Main group only) JID of the group to schedule the task for. Defaults to the current group.'),
  },
  async (args) => {
    // Validate schedule_value before writing IPC
    if (args.schedule_type === 'cron') {
      try {
        CronExpressionParser.parse(args.schedule_value);
      } catch {
        return {
          content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}". Use format like "0 9 * * *" (daily 9am) or "*/5 * * * *" (every 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'interval') {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}". Must be positive milliseconds (e.g., "300000" for 5 min).` }],
          isError: true,
        };
      }
    } else if (args.schedule_type === 'once') {
      if (/[Zz]$/.test(args.schedule_value) || /[+-]\d{2}:\d{2}$/.test(args.schedule_value)) {
        return {
          content: [{ type: 'text' as const, text: `Timestamp must be local time without timezone suffix. Got "${args.schedule_value}" — use format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
      const date = new Date(args.schedule_value);
      if (isNaN(date.getTime())) {
        return {
          content: [{ type: 'text' as const, text: `Invalid timestamp: "${args.schedule_value}". Use local time format like "2026-02-01T15:30:00".` }],
          isError: true,
        };
      }
    }

    // Non-main groups can only schedule for themselves
    const targetJid = isMain && args.target_group_jid ? args.target_group_jid : chatJid;

    const taskId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const data = {
      type: 'schedule_task',
      taskId,
      prompt: args.prompt,
      schedule_type: args.schedule_type,
      schedule_value: args.schedule_value,
      context_mode: args.context_mode || 'group',
      targetJid,
      createdBy: groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Task ${taskId} scheduled: ${args.schedule_type} - ${args.schedule_value}` }],
    };
  },
);

server.tool(
  'list_tasks',
  "List all scheduled tasks. From main: shows all tasks. From other groups: shows only that group's tasks.",
  {},
  async () => {
    const tasksFile = path.join(IPC_DIR, 'current_tasks.json');

    try {
      if (!fs.existsSync(tasksFile)) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const allTasks = JSON.parse(fs.readFileSync(tasksFile, 'utf-8'));

      const tasks = isMain
        ? allTasks
        : allTasks.filter((t: { groupFolder: string }) => t.groupFolder === groupFolder);

      if (tasks.length === 0) {
        return { content: [{ type: 'text' as const, text: 'No scheduled tasks found.' }] };
      }

      const formatted = tasks
        .map(
          (t: { id: string; prompt: string; schedule_type: string; schedule_value: string; status: string; next_run: string }) =>
            `- [${t.id}] ${t.prompt.slice(0, 50)}... (${t.schedule_type}: ${t.schedule_value}) - ${t.status}, next: ${t.next_run || 'N/A'}`,
        )
        .join('\n');

      return { content: [{ type: 'text' as const, text: `Scheduled tasks:\n${formatted}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text' as const, text: `Error reading tasks: ${err instanceof Error ? err.message : String(err)}` }],
      };
    }
  },
);

server.tool(
  'pause_task',
  'Pause a scheduled task. It will not run until resumed.',
  { task_id: z.string().describe('The task ID to pause') },
  async (args) => {
    const data = {
      type: 'pause_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} pause requested.` }] };
  },
);

server.tool(
  'resume_task',
  'Resume a paused task.',
  { task_id: z.string().describe('The task ID to resume') },
  async (args) => {
    const data = {
      type: 'resume_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} resume requested.` }] };
  },
);

server.tool(
  'cancel_task',
  'Cancel and delete a scheduled task.',
  { task_id: z.string().describe('The task ID to cancel') },
  async (args) => {
    const data = {
      type: 'cancel_task',
      taskId: args.task_id,
      groupFolder,
      isMain,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} cancellation requested.` }] };
  },
);

server.tool(
  'update_task',
  'Update an existing scheduled task. Only provided fields are changed; omitted fields stay the same.',
  {
    task_id: z.string().describe('The task ID to update'),
    prompt: z.string().optional().describe('New prompt for the task'),
    schedule_type: z.enum(['cron', 'interval', 'once']).optional().describe('New schedule type'),
    schedule_value: z.string().optional().describe('New schedule value (see schedule_task for format)'),
  },
  async (args) => {
    // Validate schedule_value if provided
    if (args.schedule_type === 'cron' || (!args.schedule_type && args.schedule_value)) {
      if (args.schedule_value) {
        try {
          CronExpressionParser.parse(args.schedule_value);
        } catch {
          return {
            content: [{ type: 'text' as const, text: `Invalid cron: "${args.schedule_value}".` }],
            isError: true,
          };
        }
      }
    }
    if (args.schedule_type === 'interval' && args.schedule_value) {
      const ms = parseInt(args.schedule_value, 10);
      if (isNaN(ms) || ms <= 0) {
        return {
          content: [{ type: 'text' as const, text: `Invalid interval: "${args.schedule_value}".` }],
          isError: true,
        };
      }
    }

    const data: Record<string, string | undefined> = {
      type: 'update_task',
      taskId: args.task_id,
      groupFolder,
      isMain: String(isMain),
      timestamp: new Date().toISOString(),
    };
    if (args.prompt !== undefined) data.prompt = args.prompt;
    if (args.schedule_type !== undefined) data.schedule_type = args.schedule_type;
    if (args.schedule_value !== undefined) data.schedule_value = args.schedule_value;

    writeIpcFile(TASKS_DIR, data);

    return { content: [{ type: 'text' as const, text: `Task ${args.task_id} update requested.` }] };
  },
);

server.tool(
  'register_group',
  `Register a new chat/group so the agent can respond to messages there. Main group only.

Use available_groups.json to find the JID for a group. The folder name must be channel-prefixed: "{channel}_{group-name}" (e.g., "whatsapp_family-chat", "telegram_dev-team", "discord_general"). Use lowercase with hyphens for the group name part.`,
  {
    jid: z.string().describe('The chat JID (e.g., "120363336345536173@g.us", "tg:-1001234567890", "dc:1234567890123456")'),
    name: z.string().describe('Display name for the group'),
    folder: z.string().describe('Channel-prefixed folder name (e.g., "whatsapp_family-chat", "telegram_dev-team")'),
    trigger: z.string().describe('Trigger word (e.g., "@Andy")'),
  },
  async (args) => {
    if (!isMain) {
      return {
        content: [{ type: 'text' as const, text: 'Only the main group can register new groups.' }],
        isError: true,
      };
    }

    const data = {
      type: 'register_group',
      jid: args.jid,
      name: args.name,
      folder: args.folder,
      trigger: args.trigger,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Group "${args.name}" registered. It will start receiving messages immediately.` }],
    };
  },
);

// --- Matters ---

const ARTIFACT_TYPES = ['email_thread', 'calendar_event', 'task', 'doc'] as const;

type MatterEntry = {
  id: number; title: string; status: string; artifacts?: string;
  context?: string; tracking_file?: string; updated_at: string;
};

/** Read and parse the matters snapshot. Returns [] if the file doesn't exist. */
function readMattersSnapshot(): MatterEntry[] {
  const mattersFile = path.join(IPC_DIR, 'current_matters.json');
  try {
    return JSON.parse(fs.readFileSync(mattersFile, 'utf-8'));
  } catch {
    return [];
  }
}

server.tool(
  'create_matter',
  `Create a new matter to track a workstream. Every piece of tracked work — an email exchange, a project, a calendar event requiring prep — is a matter. Matters scale from quick email replies (created and resolved on the spot) to complex multi-month projects.

Artifact types: email_thread (Gmail thread ID), calendar_event (Google Calendar event ID), task (scheduled_tasks task ID), doc (Google Drive/Docs file ID).`,
  {
    title: z.string().describe('Short descriptive title for the matter'),
    context: z.string().optional().describe('Living summary of current state — rewritten (not appended) on meaningful updates'),
    artifacts: z.array(z.object({
      type: z.enum(ARTIFACT_TYPES),
      id: z.string(),
    })).optional().describe('Linked artifacts (email threads, calendar events, tasks, docs)'),
    tracking_file: z.string().regex(/^[^/\\]+$/, 'tracking_file must be a plain filename').optional().describe('Filename in group memory/ for detailed dossier'),
  },
  async (args) => {
    const data = {
      type: 'create_matter',
      title: args.title,
      context: args.context || undefined,
      artifacts: args.artifacts ? JSON.stringify(args.artifacts) : undefined,
      tracking_file: args.tracking_file || undefined,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Matter created: "${args.title}"` }],
    };
  },
);

server.tool(
  'update_matter',
  `Update an existing matter. Only provided fields are changed; omitted fields stay the same. Use this to update status, context, add artifacts, or link a tracking file.

Statuses: active (work remains), waiting (blocked on someone/something), paused (intentionally on hold), resolved (done).`,
  {
    matter_id: z.number().describe('The matter ID'),
    title: z.string().optional().describe('New title'),
    status: z.enum(['active', 'waiting', 'paused', 'resolved']).optional().describe('New status'),
    context: z.string().optional().describe('Updated living summary — rewrite the whole context, not append'),
    artifacts: z.array(z.object({
      type: z.enum(ARTIFACT_TYPES),
      id: z.string(),
    })).optional().describe('Full replacement artifact list'),
    tracking_file: z.string().regex(/^[^/\\]+$/, 'tracking_file must be a plain filename').optional().describe('Filename in group memory/'),
  },
  async (args) => {
    const data: Record<string, unknown> = {
      type: 'update_matter',
      matterId: args.matter_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };
    if (args.title !== undefined) data.title = args.title;
    if (args.status !== undefined) data.status = args.status;
    if (args.context !== undefined) data.context = args.context;
    if (args.artifacts !== undefined) data.artifacts = JSON.stringify(args.artifacts);
    if (args.tracking_file !== undefined) data.tracking_file = args.tracking_file;

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Matter ${args.matter_id} update requested.` }],
    };
  },
);

server.tool(
  'list_matters',
  'List tracked matters. By default shows active and waiting matters. Use status to filter.',
  {
    status: z.enum(['active', 'waiting', 'paused', 'resolved']).optional().describe('Filter by status (default: active + waiting)'),
  },
  async (args) => {
    const all = readMattersSnapshot();
    const matters = args.status
      ? all.filter((m) => m.status === args.status)
      : all.filter((m) => m.status === 'active' || m.status === 'waiting');

    if (matters.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matters matching filters.' }] };
    }

    const formatted = matters
      .map((m) => `- [${m.id}] ${m.title} (${m.status}) — updated ${m.updated_at}`)
      .join('\n');

    return { content: [{ type: 'text' as const, text: `Matters:\n${formatted}` }] };
  },
);

server.tool(
  'get_matter',
  'Get full details of a specific matter, including context and artifacts. From main group: also includes tracking file contents if set.',
  {
    matter_id: z.number().describe('The matter ID'),
  },
  async (args) => {
    const matter = readMattersSnapshot().find((m) => m.id === args.matter_id);
    if (!matter) {
      return { content: [{ type: 'text' as const, text: `Matter ${args.matter_id} not found.` }] };
    }

    let result = `Matter #${matter.id}: ${matter.title}\nStatus: ${matter.status}\nUpdated: ${matter.updated_at}`;
    if (matter.artifacts) result += `\nArtifacts: ${matter.artifacts}`;
    if (matter.context) result += `\nContext: ${matter.context}`;
    if (matter.tracking_file) result += `\nTracking file: ${matter.tracking_file}`;

    // If main and tracking_file is set, read its contents
    if (isMain && matter.tracking_file) {
      try {
        const memoryBase = path.resolve('/workspace/group/memory');
        const trackingPath = path.resolve(memoryBase, matter.tracking_file);
        if (!trackingPath.startsWith(memoryBase + path.sep) && trackingPath !== memoryBase) {
          result += `\n\nTracking file path "${matter.tracking_file}" escapes memory directory — skipped.`;
        } else {
          const contents = fs.readFileSync(trackingPath, 'utf-8');
          result += `\n\n--- Tracking File Contents ---\n${contents}`;
        }
      } catch {
        // File may not exist yet — that's fine
      }
    }

    return { content: [{ type: 'text' as const, text: result }] };
  },
);

server.tool(
  'find_matter',
  'Find matters by linked artifact. Use this to check if an email thread, calendar event, task, or doc already has a matter.',
  {
    artifact_type: z.enum(ARTIFACT_TYPES).optional().describe('Filter by artifact type'),
    artifact_id: z.string().optional().describe('Filter by artifact ID (e.g., Gmail thread ID)'),
  },
  async (args) => {
    const matches = readMattersSnapshot().filter((m) => {
      if (!m.artifacts) return false;
      try {
        const artifacts: Array<{ type: string; id: string }> = JSON.parse(m.artifacts);
        return artifacts.some(
          (a) =>
            (!args.artifact_type || a.type === args.artifact_type) &&
            (!args.artifact_id || a.id === args.artifact_id),
        );
      } catch {
        return false;
      }
    });

    if (matches.length === 0) {
      return { content: [{ type: 'text' as const, text: 'No matters found with matching artifacts.' }] };
    }

    const formatted = matches
      .map((m) => {
        let line = `- [${m.id}] ${m.title} (${m.status}) — updated ${m.updated_at}`;
        if (m.context) line += `\n  Context: ${m.context}`;
        return line;
      })
      .join('\n');

    return { content: [{ type: 'text' as const, text: `Matching matters:\n${formatted}` }] };
  },
);

server.tool(
  'delete_matter',
  'Permanently delete a matter. Use for duplicates or matters created in error — not for completed work (use update_matter with status="resolved" instead).',
  {
    matter_id: z.number().describe('The matter ID to delete'),
  },
  async (args) => {
    const data = {
      type: 'delete_matter',
      matterId: args.matter_id,
      groupFolder,
      timestamp: new Date().toISOString(),
    };

    writeIpcFile(TASKS_DIR, data);

    return {
      content: [{ type: 'text' as const, text: `Delete requested for matter ${args.matter_id}.` }],
    };
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
