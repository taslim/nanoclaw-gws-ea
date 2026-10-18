import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

export const whatsappLink = requestTool({
  name: 'whatsapp_link',
  description:
    'Link your own WhatsApp account on the principal’s request in their verified DM. Cite their host-marked messages stating both numbers; each must be their own unforwarded message from the last 24 hours. number is your own account, principal_number is theirs, and they must differ. Returns the pairingCode to give them in that DM. On connection a host note supplies a separate binding code they send to your WhatsApp from their own number. For a re-link cite their recent DM asking for it and omit both numbers: the existing principal stays bound. After timeout use request_status before repeating.',
  properties: {
    number: {
      type: 'string',
      description: 'Your own WhatsApp phone number with country code, as the principal wrote it.',
    },
    principal_number: {
      type: 'string',
      description: 'The principal’s WhatsApp number with country code, as they wrote it.',
    },
    principal_messages: {
      type: 'array',
      items: { type: 'string' },
      minItems: 1,
      description: 'The platform IDs in the host’s principal_message marks from the principal’s verified DM.',
    },
  },
  required: ['principal_messages'],
  additionalProperties: false,
  oneOf: [
    { required: ['number', 'principal_number'] },
    { not: { anyOf: [{ required: ['number'] }, { required: ['principal_number'] }] } },
  ],
  repeatable: false,
  timeoutMs: 30_000,
});
registerTools([whatsappLink], 'gws-ea-chat');
