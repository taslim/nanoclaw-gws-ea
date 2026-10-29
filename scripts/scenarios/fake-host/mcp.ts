import '../fake-host/mailbox.js';
import '../../../container/agent-runner/src/mcp-tools/index.js';
import {
  resetAgentMailboxForTesting,
  registerAgentMailbox,
} from '../../../container/agent-runner/src/mailbox/index.js';
import { startMcpServer } from '../../../container/agent-runner/src/mcp-tools/server.js';
import { FixtureMailbox } from './mailbox.js';

const [file, encodedGrants] = process.argv.slice(2);
if (!file || !encodedGrants) throw new Error('MCP fixture requires a state and grants.');
resetAgentMailboxForTesting();
const mailbox = new FixtureMailbox(file);
registerAgentMailbox(() => mailbox);
await startMcpServer((action) => mailbox.run(action), new Set(JSON.parse(encodedGrants) as string[]));
