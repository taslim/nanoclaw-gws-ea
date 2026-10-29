import type { GmailMessage } from '../../../src/modules/gws-ea-inbox/gmail-api.js';

const headers = (message: GmailMessage): Record<string, string> =>
  Object.fromEntries((message.payload?.headers ?? []).map((header) => [header.name.toLowerCase(), header.value]));
const read = (message: GmailMessage) => ({
  id: message.id,
  threadId: message.threadId,
  headers: headers(message),
  body: Buffer.from(message.payload?.body?.data ?? '', 'base64url').toString('utf8'),
  snippet: message.snippet,
});

/** CLI read views of the host's one canonical native Gmail store. No send operation exists here. */
export function gogMail(argv: readonly string[], mail: readonly GmailMessage[]): unknown {
  const verb = argv[1];
  if (verb === 'get') {
    const message = mail.find((entry) => entry.id === argv[2]);
    if (!message) throw new Error('No such synthetic Gmail message');
    return read(message);
  }
  if (verb === 'thread' && argv[2] === 'get') {
    const id = argv[3];
    const messages = mail.filter((entry) => entry.threadId === id);
    if (!messages.length) throw new Error('No such synthetic Gmail thread');
    return { id, messages: messages.map(read) };
  }
  if (verb === 'search') {
    const ids = [...new Set(mail.map((message) => message.threadId))];
    return {
      threads: ids.map((id) => {
        const messages = mail.filter((message) => message.threadId === id);
        const latest = messages.at(-1);
        if (!latest) throw new Error('Synthetic thread has no messages');
        const fields = headers(latest);
        return { id, date: fields.date, from: fields.from, subject: fields.subject, messageCount: messages.length };
      }),
    };
  }
  if (verb === 'messages' && argv[2] === 'search')
    return {
      messages: mail.map((message) => ({
        ...read(message),
        date: headers(message).date,
        from: headers(message).from,
        subject: headers(message).subject,
      })),
    };
  throw new Error(`Unsupported synthetic Gmail command: ${argv.slice(0, 3).join(' ')}`);
}
