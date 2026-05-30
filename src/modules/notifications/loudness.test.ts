import { describe, it, expect } from 'vitest';

import { applyPriorityLoudness, USERS_ALL_MENTION } from './loudness.js';

describe('applyPriorityLoudness', () => {
  it('prepends the <users/all> mention for attention', () => {
    expect(applyPriorityLoudness('attention', 'meeting prep brief')).toBe(`${USERS_ALL_MENTION} meeting prep brief`);
  });

  it('leaves awareness bodies untouched', () => {
    expect(applyPriorityLoudness('awareness', 'declined a low-priority ask')).toBe('declined a low-priority ask');
  });

  it('leaves urgent bodies untouched (a DM is already a ping)', () => {
    expect(applyPriorityLoudness('urgent', 'board prep cancelled')).toBe('board prep cancelled');
  });

  it('leaves null/undefined priority untouched', () => {
    expect(applyPriorityLoudness(null, 'plain reply')).toBe('plain reply');
    expect(applyPriorityLoudness(undefined, 'plain reply')).toBe('plain reply');
  });

  it('does not double-prepend if the body already leads with the mention', () => {
    const body = `${USERS_ALL_MENTION} already mentioned`;
    expect(applyPriorityLoudness('attention', body)).toBe(body);
  });
});
