import type { ParsedMail } from './mime.js';

/** Observers see inbox mail without owning it. Their return type cannot select a routing outcome. */
type InboxObserver = (mail: ParsedMail) => void | Promise<void>;
const observers = new Set<InboxObserver>();
export function registerInboxObserver(observer: InboxObserver): () => void {
  observers.add(observer);
  return () => {
    observers.delete(observer);
  };
}
export async function observeInboxMail(mail: ParsedMail): Promise<void> {
  // Observer failures must never change routing, retries or settlement of the mail itself.
  await Promise.allSettled([...observers].map(async (observer) => observer(mail)));
}
