import type { Tool, CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export type TrustLevel = 'known' | 'all';

export interface McpToolDefinition {
  tool: Tool;
  handler: (args: Record<string, unknown>) => Promise<CallToolResult>;
  // Omit to expose to both trust levels.
  availableToTrust?: TrustLevel[];
}
