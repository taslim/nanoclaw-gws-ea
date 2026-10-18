import { initChannelAdapters, registerChannelAdapter } from '../../../channels/channel-registry.js';

/** A registered transport whose only controlled fact is whether it can accept a new send. */
export async function mountWhatsAppAvailability(isConnected: () => boolean): Promise<void> {
  registerChannelAdapter('whatsapp', {
    factory: () => ({
      name: 'whatsapp',
      channelType: 'whatsapp',
      instance: 'whatsapp',
      supportsThreads: false,
      async setup() {},
      async teardown() {},
      async setTyping() {},
      async deliver() {
        return undefined;
      },
      isConnected,
    }),
  });
  await initChannelAdapters(() => ({
    conversations: [],
    onInbound() {},
    onInboundEvent() {},
    onMetadata() {},
    onAction() {},
  }));
}
