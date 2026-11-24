/**
 * Main's requests to add or delete one of the principal's apps. The host holds each for the principal's approval and
 * makes the change; credentials never pass through these tools.
 */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

export const addApp = requestTool({
  name: 'add_app',
  description:
    'Ask to add a remote MCP app the principal wants, by its https address and a name for it. The host checks the address, then sends the principal a card to approve; awaiting_principal means the card is out, and a host message tells you the outcome once they decide. An app that needs a sign-in, a token or client details is added Not connected: send the principal the Connections link from principal_page then. Never put a token, key or client secret in the address or ask for one in chat; the principal enters those on the Connections page. A refusal says why; do not retry it unchanged. After a timeout use request_status before asking again.',
  properties: {
    url: { type: 'string', description: "The app's https address, with no query." },
    name: { type: 'string', description: 'What to call the app, up to 100 characters.' },
  },
  required: ['url', 'name'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: 120_000,
});

export const deleteApp = requestTool({
  name: 'delete_app',
  description:
    "Ask to delete an app the principal added, by the key principal_page connections lists for it (app_…). The host sends the principal a card to approve; deleting disconnects the app and removes it from their Connections page. An operator's server cannot be deleted here: the principal can disconnect it on the Connections page. After a timeout use request_status before asking again.",
  properties: {
    app: { type: 'string', description: "The app's key, starting with app_." },
  },
  required: ['app'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: 120_000,
});

export const appToolAsk = requestTool({
  name: 'app_tool_ask',
  description:
    "Ask the principal to change whether one tool on a connected app asks before running (ask_first: true to check with them first, false to run without asking). Every change in either direction sends the principal an approval request bound to the tool's current definition; awaiting_principal means the request is out, and a host message tells you once they decide. After a timeout use request_status before asking again.",
  properties: {
    app: { type: 'string', description: "The app's key, starting with app_." },
    tool: { type: 'string', description: 'Exact name of the tool on that app.' },
    ask_first: {
      type: 'boolean',
      description: 'true to require approval before running; false to run without asking.',
    },
    reason: { type: 'string', description: 'Optional short one-line note for the principal.' },
  },
  required: ['app', 'tool', 'ask_first'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: 120_000,
});

registerTools([addApp, deleteApp, appToolAsk], 'gws-ea-connections');
