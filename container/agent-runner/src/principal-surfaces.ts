// Defined once so the priority router (poll-loop parser) and the send_message
// guard agree on what counts as a principal surface; adding a future personal
// surface here updates both at once.
export type Priority = 'urgent' | 'attention' | 'awareness';

export const PRIORITIES: readonly Priority[] = ['urgent', 'attention', 'awareness'] as const;

export const PRINCIPAL_SURFACE = 'principal';
export const HEARTBEAT_SURFACE = 'heartbeat';
export const PRINCIPAL_SURFACES: ReadonlySet<string> = new Set([PRINCIPAL_SURFACE, HEARTBEAT_SURFACE]);

export function isPrincipalSurface(name: string): boolean {
  return PRINCIPAL_SURFACES.has(name);
}

export function isPriority(value: string): value is Priority {
  return (PRIORITIES as readonly string[]).includes(value);
}

export function surfaceForPriority(priority: Priority): string {
  return priority === 'urgent' ? PRINCIPAL_SURFACE : HEARTBEAT_SURFACE;
}
