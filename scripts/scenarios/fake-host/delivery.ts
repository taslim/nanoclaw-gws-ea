/** Start the registered native inbox adapter without starting inbox polling or a container runtime. */
export async function startSyntheticDelivery(): Promise<() => Promise<void>> {
  const {
    initChannelAdapters,
    createChannelDeliveryAdapter,
    teardownChannelAdapters,
    getRegisteredChannelNames,
    registerChannelAdapter,
  } = await import('../../../src/channels/channel-registry.js');
  const { setDeliveryAdapter } = await import('../../../src/delivery.js');
  const { routeInbound } = await import('../../../src/router.js');
  // Only email has a closed HTTP transport here; other factories could read inherited host credentials.
  for (const name of getRegisteredChannelNames())
    if (name !== 'email') registerChannelAdapter(name, { factory: () => null });
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
