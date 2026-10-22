import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

export const chatReachOut = requestTool({
  name: 'chat_reach_out',
  description:
    'Start a WhatsApp conversation on the principal’s own recent request in their verified DM. The host checks first-contact rules, opens a direct chat or named group with the principal, and hands your words to the assistant working there, which writes the first message. Cite the host-marked principal message. A refusal must go by email or back to the principal; never retry it. After a timeout use request_status before repeating.',
  properties: {
    people: {
      type: 'array',
      minItems: 1,
      items: {
        type: 'object',
        properties: {
          name: {
            type: 'string',
            description: 'The person’s name, as the principal gave it or their person record lists it.',
          },
          number: { type: 'string', description: 'Their WhatsApp number, including + and the country code.' },
          person: { type: 'string', description: 'Their existing ncl people record key, when there is one.' },
        },
        required: ['name', 'number'],
        additionalProperties: false,
      },
    },
    message: {
      type: 'string',
      description:
        'Your words for the assistant working in the new chat. Up to 8,000 characters; include only context safe for the people there.',
    },
    group: {
      type: 'string',
      description: 'A name for a new group with the principal and these people. Omit for a DM to one person.',
    },
    principal_message: {
      type: 'string',
      description:
        'The host-marked id of the principal’s own unforwarded WhatsApp outreach request from their verified DM, no older than 24 hours.',
    },
  },
  required: ['people', 'message', 'principal_message'],
  additionalProperties: false,
  repeatable: false,
  timeoutMs: 120_000,
});

registerTools([chatReachOut], 'gws-ea-chat');
