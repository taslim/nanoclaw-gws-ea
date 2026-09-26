import { describe, expect, it } from 'vitest';

import { parsePrincipalCandidate } from './principal-selection.js';

const selected = {
  messagingGroupId: 'mg-principal',
  platformId: 'gchat:spaces/dm-principal',
  userId: 'gchat:users/principal',
  senderName: 'Principal',
  authenticatedMessageId: 'spaces/dm-principal/messages/first',
  authenticatedMessageAt: '2026-09-19T00:01:00.000Z',
} as const;

describe('recorded principal selection', () => {
  it('reads the exact authenticated candidate and ignores unknown fields', () => {
    expect(parsePrincipalCandidate({ ...selected, avatarUrl: 'https://example.test/a.png' })).toEqual(selected);
    expect(parsePrincipalCandidate({ ...selected, senderName: null })).toEqual({ ...selected, senderName: null });
  });

  it.each([
    ['a non-Google Chat identity', { userId: 'slack:U1' }],
    ['a missing conversation', { messagingGroupId: '' }],
    ['a non-canonical message time', { authenticatedMessageAt: '2026-09-19T00:01:00Z' }],
    ['a display name with control characters', { senderName: 'Prin\ncipal' }],
  ])('refuses %s', (_label, change) => {
    expect(() => parsePrincipalCandidate({ ...selected, ...change })).toThrow(
      expect.objectContaining({ code: 'invalid_principal_selection' }),
    );
  });
});
