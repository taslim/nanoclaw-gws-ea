export const lifecycleTasks = new Map<string, () => Promise<void>>();
export function registerChatLifecycleTask(id: string, task: () => Promise<void>): void {
  if (lifecycleTasks.has(id)) throw new Error(`Chat lifecycle task already registered: ${id}`);
  lifecycleTasks.set(id, task);
}
