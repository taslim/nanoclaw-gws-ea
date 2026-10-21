import { BrowserQueue } from '../queue.js';
import { browserActions, browserQueueFollowUps } from '../index.js';
import type { BrowserActionName, BrowserExecutionContext } from '../actions.js';
import type { BrowserStore } from '../db.js';

const heldQueues = new Set<BrowserQueue>();
export async function stopHeldBrowserRequests(): Promise<void> {
  for (const queue of heldQueues) await queue.stop();
  heldQueues.clear();
}

/** Authority tests use a real accepted purchase request while its native worker owns the operation and job lock. */
export async function holdBrowserRequest(
  store: BrowserStore,
  runtime: BrowserQueue['runtime'],
  action: BrowserActionName = 'purchase',
) {
  let receive!: (context: BrowserExecutionContext) => void;
  const received = new Promise<BrowserExecutionContext>((resolve) => {
    receive = resolve;
  });
  const queue = new BrowserQueue(
    store,
    runtime,
    {
      ...browserActions,
      [action]: {
        ...browserActions[action],
        async execute(context: BrowserExecutionContext) {
          receive(context);
          await new Promise<void>((resolve) =>
            context.signal.addEventListener('abort', () => resolve(), { once: true }),
          );
          return { status: 'stopped' };
        },
      },
    },
    browserQueueFollowUps,
  );
  heldQueues.add(queue);
  // This is a new worker for this test's accepted row, rather than restart recovery of an old process.
  await queue.start();
  return { queue, context: await received };
}
