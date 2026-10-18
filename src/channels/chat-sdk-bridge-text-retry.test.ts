import { expect, it } from 'vitest';
import type { Adapter, AdapterPostableMessage } from 'chat';
import { createChatSdkBridge } from './chat-sdk-bridge.js';

it('passes stable per-part delivery keys only to an adapter’s opt-in text poster', async () => {
  const messages = new Map<string, string>();
  const keys: string[] = [];
  const ordinary: AdapterPostableMessage[] = [];
  let ambiguous = true;
  const adapter = {
    name: 'text-retry-fixture',
    postMessage: async (threadId: string, message: AdapterPostableMessage) => {
      ordinary.push(message);
      return { id: 'ordinary', threadId, raw: {} };
    },
    postTextOnce: async (threadId: string, text: string, key: string) => {
      keys.push(key);
      messages.set(key, text);
      if (ambiguous) {
        ambiguous = false;
        throw new Error('accepted before disconnect');
      }
      return { id: key, threadId, raw: {} };
    },
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({ adapter, supportsThreads: false, maxTextLength: 5 });
  const message = { kind: 'chat', content: { text: 'hello\nworld' } };
  await expect(bridge.deliver('space', null, message, 'durable-row')).rejects.toThrow('accepted before disconnect');
  await bridge.deliver('space', null, message, 'durable-row');
  expect(keys).toEqual(['durable-row:0', 'durable-row:0', 'durable-row:1']);
  expect([...messages.values()]).toEqual(['hello', 'world']);
  expect(ordinary).toEqual([]);
  await bridge.deliver('space', null, { kind: 'chat', content: { text: 'direct' } });
  expect(ordinary.length).toBeGreaterThan(0);
});
