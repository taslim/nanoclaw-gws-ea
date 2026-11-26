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
  const message = { kind: 'chat', content: { text: 'hello\nworld' }, deliveryId: 'durable-row' };
  await expect(bridge.deliver('space', null, message)).rejects.toThrow('accepted before disconnect');
  await bridge.deliver('space', null, message);
  expect(keys).toEqual(['durable-row:0', 'durable-row:0', 'durable-row:1']);
  expect([...messages.values()]).toEqual(['hello', 'world']);
  expect(ordinary).toEqual([]);
  await bridge.deliver('space', null, { kind: 'chat', content: { text: 'direct' } });
  expect(ordinary.length).toBeGreaterThan(0);
});

it('forwards stable delivery keys to FileAttacher.postWithFiles for text+files, files-only, and ask_question pictures', async () => {
  const fileCalls: Array<{ text: unknown; filenames: string[]; key: string | undefined }> = [];
  const textCalls: Array<{ text: string; key: string }> = [];
  const adapter = {
    name: 'file-retry-fixture',
    postMessage: async (threadId: string) => ({ id: 'ordinary', threadId, raw: {} }),
    postTextOnce: async (threadId: string, text: string, key: string) => {
      textCalls.push({ text, key });
      return { id: key, threadId, raw: {} };
    },
    postWithFiles: async (
      threadId: string,
      message: AdapterPostableMessage,
      files: ReadonlyArray<{ filename: string }>,
      key?: string,
    ) => {
      fileCalls.push({ text: message, filenames: files.map((f) => f.filename), key });
      return { id: key ?? 'no-key', threadId, raw: {} };
    },
  } as unknown as Adapter;
  const bridge = createChatSdkBridge({
    adapter,
    supportsThreads: false,
    textRequests: { postedAt: () => new Date('2026-10-10T17:00:00Z') },
  });
  const file = { filename: 'receipt.png', mimeType: 'image/png', data: Buffer.from('png') };

  await bridge.deliver('space', null, {
    kind: 'chat',
    content: { text: 'Here is the receipt' },
    files: [file],
    deliveryId: 'row-with-file',
  });
  await bridge.deliver('space', null, {
    kind: 'chat',
    content: { text: 'Here is the receipt' },
    files: [file],
    deliveryId: 'row-with-file',
  });
  await bridge.deliver('space', null, {
    kind: 'chat',
    content: {},
    files: [file],
    deliveryId: 'files-only-row',
  });
  await bridge.deliver('space', null, {
    kind: 'chat-sdk',
    content: {
      type: 'card',
      card: { title: 'Summary', description: 'Ready.' },
    },
    deliveryId: 'card-row',
  });

  expect(fileCalls).toEqual([
    { text: { markdown: 'Here is the receipt' }, filenames: ['receipt.png'], key: 'row-with-file:0' },
    { text: { markdown: 'Here is the receipt' }, filenames: ['receipt.png'], key: 'row-with-file:0' },
    { text: { markdown: '' }, filenames: ['receipt.png'], key: 'files-only-row:0' },
  ]);
  expect(textCalls).toEqual([{ text: '**Summary**\n\nReady.', key: 'card-row:0' }]);
});
