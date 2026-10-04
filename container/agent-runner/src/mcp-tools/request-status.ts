/**
 * `request_status`: the answer to a request the host was slow to answer.
 *
 * A tool that sends a typed request (`requestAction`) stops waiting after its
 * timeout, and the host's answer may come later. That answer is a system
 * message the poll loop never shows the agent, so this tool reads it from
 * the session's own mailbox by the request id the timeout gave. The mailbox
 * holds only this session's requests, so nothing else is reachable.
 */
import { answerResult, readAnswer } from '../action-request.js';
import { registerTools } from './server.js';
import type { McpToolDefinition } from './types.js';

/** The key that grants it: both of GWS-EA's agents hold it, since both send typed requests. */
const REQUEST_STATUS_CAPABILITY = 'request-status';

const REQUEST_ID = /^act-[A-Za-z0-9-]{1,100}$/u;

export const requestStatus: McpToolDefinition = {
  tool: {
    name: 'request_status',
    description:
      "Check a request the host was slow to answer, by the request id its timeout gave you: the host's answer, word for word, once it has come, or that it has not come yet.",
    inputSchema: {
      type: 'object' as const,
      properties: {
        request_id: { type: 'string', description: 'The request id the timeout gave you, such as act-….' },
      },
      required: ['request_id'],
    },
  },
  async handler(args) {
    const requestId = args.request_id;
    if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
      return {
        content: [{ type: 'text', text: 'Error: request_id must be the request id a timeout gave you, such as act-….' }],
        isError: true,
      };
    }
    const frame = readAnswer(requestId);
    if (frame) return answerResult(frame);
    return {
      content: [
        {
          type: 'text',
          text: `The host has not answered request ${requestId} yet. It may still go through: check again in a minute.`,
        },
      ],
    };
  },
};

registerTools([requestStatus], REQUEST_STATUS_CAPABILITY);
