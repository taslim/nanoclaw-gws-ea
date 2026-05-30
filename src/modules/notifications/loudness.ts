// The container resolves priority → surface destination; the host applies
// loudness. `<users/all>` is injected here and only here — the container
// strips any literal one the agent wrote, so the only mention that ever
// ships is the one this file prepends for `attention`.
export type Priority = 'urgent' | 'attention' | 'awareness';

export const USERS_ALL_MENTION = '<users/all>';

export function applyPriorityLoudness(priority: string | null | undefined, body: string): string {
  if (priority !== 'attention') return body;
  if (body.startsWith(USERS_ALL_MENTION)) return body;
  return `${USERS_ALL_MENTION} ${body}`;
}
