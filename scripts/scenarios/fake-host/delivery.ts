import path from 'node:path';
import { readState, writeState } from './state.js';
import type { ChannelAdapter } from '../../../src/channels/adapter.js';

/** Native delivery and ACLs run before these closed synthetic platform wires. */
export async function startSyntheticDelivery(root: string): Promise<() => Promise<void>> {
  const {
    initChannelAdapters,
    createChannelDeliveryAdapter,
    teardownChannelAdapters,
    getRegisteredChannelNames,
    registerChannelAdapter,
  } = await import('../../../src/channels/channel-registry.js');
  const { setDeliveryAdapter } = await import('../../../src/delivery.js');
  const { routeInbound } = await import('../../../src/router.js');
  // Only email keeps its native factory; all other real factories stay closed.
  for (const name of getRegisteredChannelNames())
    if (name !== 'email') registerChannelAdapter(name, { factory: () => null });
  for (const channelType of ['gchat', 'whatsapp']) {
    const adapter: ChannelAdapter = {
      name: channelType,
      channelType,
      supportsThreads: false,
      async setup() {},
      async teardown() {},
      isConnected: () => true,
      async deliver(platformId, threadId, message, messageId) {
        const target =
          channelType === 'gchat' && platformId === 'synthetic-morgan-dm'
            ? 'principal'
            : channelType === 'whatsapp' && platformId === 'synthetic-juno-chat'
              ? 'outward'
              : undefined;
        if (!target || threadId !== null || message.kind !== 'chat' || !messageId || message.files?.length)
          throw new Error('Unsupported synthetic platform delivery');
        if (!message.content || typeof message.content !== 'object' || Array.isArray(message.content))
          throw new Error('Unsupported synthetic message content');
        const file = path.join(root, 'fixture.json');
        const fixture = readState(file);
        fixture.effects.push({
          kind: 'message',
          operation: 'send',
          target,
          payload: message.content as Record<string, unknown>,
          actor: fixture.scenario.audience,
          attempt: fixture.attempt,
        });
        writeState(file, fixture);
        return `synthetic-${messageId}`;
      },
    };
    registerChannelAdapter(channelType, { factory: () => adapter });
  }
  await initChannelAdapters((adapter) => ({
    onInbound(platformId, threadId, message) {
      return routeInbound({
        channelType: adapter.channelType,
        instance: adapter.instance ?? adapter.channelType,
        platformId,
        threadId,
        message: {
          id: message.id,
          kind: message.kind,
          content: JSON.stringify(message.content),
          timestamp: message.timestamp,
          isMention: message.isMention,
          isGroup: message.isGroup,
          authenticatedSender: message.authenticatedSender,
          deduplicate: message.deduplicate,
          quiet: message.quiet,
          reaction: message.reaction,
        },
      });
    },
    onInboundEvent() {
      throw new Error('No admin inbound events are supplied by this synthetic transport');
    },
    onMetadata() {
      throw new Error('No metadata events are supplied by this synthetic transport');
    },
    onAction() {
      throw new Error('No human channel actions are supplied by this synthetic transport');
    },
  }));
  setDeliveryAdapter(createChannelDeliveryAdapter());
  return teardownChannelAdapters;
}
