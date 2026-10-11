import { expect, it } from 'vitest';
import { gatewayApprovalPresentation } from './gateway-approval-presentation.js';
import type { GatewayApprovalRequest } from './gateway-providers/gateway-provider-registry.js';

const request = (summary?: GatewayApprovalRequest['summary']) =>
  ({ title: 'Legacy', question: 'Legacy question', summary }) as GatewayApprovalRequest;
const summary = {
  agent: 'Nano',
  action: 'Read external data',
  resource: 'GET api.example.test/repos?token=secret',
  reason: 'Policy requires approval',
};

it('asks as the assistant: the resource first, then the action and reason, and one-request scope, without query values', () => {
  const card = gatewayApprovalPresentation(request(summary));
  expect(card.title).toBe('May I make this request?');
  expect(card.question.split('\n')).toEqual([
    '*Resource:* GET api.example.test/repos',
    '*Action:* Read external data',
    "*Why I'm asking:* Policy requires approval",
    "Approving lets this one request through. It doesn't connect an account or change what I'm allowed to do.",
  ]);
  expect(card.question).not.toContain('secret');
});

it('escapes supplied formatting, mentions, and links, and bounds the card', () => {
  const card = gatewayApprovalPresentation(
    request({
      ...summary,
      details: [
        { label: 'To', value: '<users/all>\n*Admin* <https://evil.example|Approve>' },
        ...Array.from({ length: 5 }, () => ({ label: 'Detail', value: 'a'.repeat(600) })),
      ],
    }),
  );
  expect(card.question).not.toMatch(/<users\/all>|<https:/u);
  expect(card.question).toContain('*To:* ‹users/all› \\*Admin\\* ‹https://evil.example|Approve›');
  expect(card.question.length).toBeLessThanOrEqual(2600);
});

it('rejects malformed structured details instead of trusting them', () => {
  expect(() => gatewayApprovalPresentation(request({ ...summary, details: 'bad' as never }))).toThrow();
  expect(() => gatewayApprovalPresentation(request({ ...summary, action: '' }))).toThrow();
});

it('keeps legacy adapters compatible', () => {
  expect(gatewayApprovalPresentation(request())).toEqual({ title: 'Legacy', question: 'Legacy question' });
});

it('shows a concrete action, full issue number and submitted comment without generic padding', () => {
  const card = gatewayApprovalPresentation(
    request({
      agent: 'Nano',
      action: 'Post a comment',
      resource: 'example/repo · issue or PR #548',
      reason: 'This action changes external data.',
      details: [{ label: 'Comment', value: 'great job' }],
    }),
  );
  expect(card.title).toBe('Post a comment');
  expect(card.question).toContain('*Where:* example/repo · issue or PR #548');
  expect(card.question).toContain('*Comment:* great job');
  expect(card.question).not.toContain('business action');
});

it('preserves all typed policy display fields and explicit list overflow', () => {
  const card = gatewayApprovalPresentation({
    ...request(),
    displayFields: [
      ...Array.from({ length: 23 }, (_, i) => ({
        label: `Field ${i}`,
        type: 'long_text' as const,
        value: 'x'.repeat(1000),
      })),
      { label: 'Items', type: 'list', value: Array.from({ length: 50 }, (_, i) => `item-${i}`), overflow: 7 },
    ],
  });
  expect(card.question).toContain('Field 22');
  expect(card.question).toContain('item-49');
  expect(card.question).toContain('7 additional items');
  expect(card.question.length).toBeGreaterThan(23000);
});

// Backslash escapes are decoded by channel Markdown renderers, preserving the value.
it('preserves account names and resource punctuation in summaries and typed fields', () => {
  const value = 'john_doe+test@x.com';
  const escaped = 'john\\_doe+test@x.com';
  const card = gatewayApprovalPresentation(request({ ...summary, details: [{ label: 'To', value }] }));
  expect(card.question).toContain(escaped);
  expect(card.question).not.toContain('john doe');
  const typed = gatewayApprovalPresentation({
    ...request(),
    displayFields: [
      { label: 'To', type: 'text', value },
      { label: 'Files', type: 'list', value: ['some_file(1).txt'] },
    ],
  });
  expect(typed.question).toContain(escaped);
  expect(typed.question).toContain('some\\_file\\(1\\).txt');
});
