import { afterEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  adopted: false,
  approvalReady: false,
  releaseAdoption: undefined as (() => void) | undefined,
  routeInbound: vi.fn(),
  startChannels: vi.fn(),
  ready: vi.fn(),
  responseHandlers: [] as Array<(payload: import('./response-registry.js').ResponsePayload) => Promise<boolean>>,
}));
vi.mock('./backfill-container-configs.js', () => ({ backfillContainerConfigs: vi.fn() }));
vi.mock('./config.js', () => ({ CENTRAL_DB_PATH: ':memory:' }));
vi.mock('./circuit-breaker.js', () => ({ enforceStartupBackoff: vi.fn(), resetCircuitBreaker: vi.fn() }));
vi.mock('./upgrade-state.js', () => ({ enforceUpgradeTripwire: vi.fn() }));
vi.mock('./db/connection.js', () => ({ initDb: async () => ({ dialect: 'sqlite' }), closeDb: vi.fn() }));
vi.mock('./db/migrations/index.js', () => ({ runMigrations: vi.fn() }));
vi.mock('./drivers/index.js', () => ({ getSessionDriver: () => ({ ensureReady: vi.fn() }) }));
vi.mock('./container-runner.js', () => ({
  adoptRunningSessions: async () => {
    expect(state.approvalReady).toBe(true);
    await new Promise<void>((resolve) => {
      state.releaseAdoption = resolve;
    });
    state.adopted = true;
  },
  abortGatewaySessionObservers: vi.fn(),
  resumeGatewaySessionAdmission: vi.fn(),
  stopGatewaySessionsForUnavailability: vi.fn(),
}));
vi.mock('./host-instance.js', () => ({ startHostInstanceLease: vi.fn(), stopHostInstanceLease: vi.fn() }));
vi.mock('./gateway-providers/index.js', () => ({ getGatewayProvider: () => ({}), resetGatewayProvider: vi.fn() }));
vi.mock('./gateway-availability.js', () => ({
  startGatewayAvailabilityMonitor: async () => {
    expect(state.approvalReady).toBe(true);
  },
}));
vi.mock('./gateway-approval-coordinator.js', () => ({
  startGatewayApprovalCoordinator: async (
    _provider: unknown,
    _delivery: unknown,
    _unavailable: unknown,
    options: { waitUntilReady?: boolean },
  ) => {
    expect(options.waitUntilReady).toBe(true);
    state.approvalReady = true;
  },
  stopGatewayApprovalCoordinator: vi.fn(),
}));
vi.mock('./delivery.js', () => ({
  startActiveDeliveryPoll: vi.fn(),
  startSweepDeliveryPoll: vi.fn(),
  setDeliveryAdapter: vi.fn(),
  stopDeliveryPolls: vi.fn(),
}));
vi.mock('./host-sweep.js', () => ({ startHostSweep: vi.fn(), stopHostSweep: vi.fn() }));
vi.mock('./host-lifecycle.js', async () => ({
  ...(await vi.importActual<typeof import('./host-lifecycle.js')>('./host-lifecycle.js')),
  startHostModules: vi.fn(),
  stopHostModules: vi.fn(),
}));
vi.mock('./router.js', () => ({ routeInbound: state.routeInbound }));
vi.mock('./response-registry.js', () => ({ getResponseHandlers: () => state.responseHandlers }));
vi.mock('./channels/index.js', () => ({}));
vi.mock('./modules/index.js', () => ({}));
vi.mock('./cli/commands/index.js', () => ({}));
vi.mock('./cli/delivery-action.js', () => ({}));
vi.mock('./cli/socket-server.js', () => ({ startCliServer: state.ready, stopCliServer: vi.fn() }));
vi.mock('./log.js', () => ({ log: { info: vi.fn(), error: vi.fn(), warn: vi.fn(), fatal: vi.fn() } }));
vi.mock('./channels/channel-registry.js', () => ({
  createChannelDeliveryAdapter: () => ({}),
  teardownChannelAdapters: vi.fn(),
  initChannelAdapters: state.startChannels,
}));

afterEach(() => {
  vi.restoreAllMocks();
  state.adopted = false;
  state.approvalReady = false;
  state.releaseAdoption = undefined;
  state.responseHandlers = [];
  state.routeInbound.mockReset();
  state.startChannels.mockReset();
  state.ready.mockReset();
});

it.each(['startup-failure', 'shutdown-failure'] as const)(
  'cleans up and exits unsuccessfully after %s',
  async (failure) => {
    vi.resetModules();
    vi.clearAllMocks();
    const lifecycle = await import('./host-lifecycle.js');
    const circuit = await import('./circuit-breaker.js');
    const db = await import('./db/connection.js');
    const delivery = await import('./delivery.js');
    const sweep = await import('./host-sweep.js');
    const channels = await import('./channels/channel-registry.js');
    let signal: AbortSignal | undefined;
    vi.mocked(lifecycle.startHostModules)
      .mockReset()
      .mockImplementation(async (context) => {
        signal = context.signal;
      });
    vi.mocked(lifecycle.stopHostModules).mockReset().mockResolvedValue();
    const on = vi.spyOn(process, 'on').mockReturnValue(process);
    const exit = vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    let failCleanup: ((reason: Error) => void) | undefined;
    if (failure === 'startup-failure') state.ready.mockRejectedValue(new Error('CLI startup failed'));
    else
      vi.mocked(lifecycle.stopHostModules).mockImplementation(
        () =>
          new Promise((_resolve, reject) => {
            failCleanup = reject;
          }),
      );
    try {
      await import('./index.js');
      await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
      state.releaseAdoption?.();
      if (failure === 'shutdown-failure') {
        await vi.waitFor(() => expect(state.ready).toHaveBeenCalled());
        const term = on.mock.calls.find(([event]) => event === 'SIGTERM')?.[1];
        const interrupt = on.mock.calls.find(([event]) => event === 'SIGINT')?.[1];
        if (!term || !interrupt) throw new Error('Shutdown signals were not registered');
        term('SIGTERM');
        interrupt('SIGINT');
        await vi.waitFor(() => expect(failCleanup).toBeDefined());
        failCleanup?.(new Error('Module cleanup failed'));
      }
      await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
      expect(signal?.aborted).toBe(true);
      expect(lifecycle.stopHostModules).toHaveBeenCalledOnce();
      expect(delivery.stopDeliveryPolls).toHaveBeenCalledOnce();
      expect(sweep.stopHostSweep).toHaveBeenCalledOnce();
      expect(channels.teardownChannelAdapters).toHaveBeenCalledOnce();
      expect(db.closeDb).toHaveBeenCalledOnce();
      expect(circuit.resetCircuitBreaker).not.toHaveBeenCalled();
    } finally {
      vi.mocked(lifecycle.startHostModules).mockReset();
      vi.mocked(lifecycle.stopHostModules).mockReset();
    }
  },
);

it('finishes adoption before a channel can route its first inbound message', async () => {
  vi.resetModules();
  vi.spyOn(process, 'on').mockReturnValue(process);
  state.routeInbound.mockImplementation(async () => {
    expect(state.adopted).toBe(true);
  });
  state.startChannels.mockImplementation(async (setup) => {
    setup({ channelType: 'fixture' }).onInbound('chat', null, {
      id: 'message',
      kind: 'text',
      content: 'hello',
      timestamp: new Date().toISOString(),
    });
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  expect(state.routeInbound).not.toHaveBeenCalled();
  state.releaseAdoption!();
  await vi.waitFor(() => expect(state.ready).toHaveBeenCalled());
  expect(state.routeInbound).toHaveBeenCalledOnce();
});

it("hands the router a channel's marks: a copy its platform may redeliver, quiet context, and a reaction", async () => {
  vi.resetModules();
  vi.spyOn(process, 'on').mockReturnValue(process);
  const content = { sender: 'Remy Vance', reaction: { emoji: 'thumbs_up', target: { self: false } } };
  const message = {
    id: 'spaces/AAAAroom/messages/juno.1/reactions/r1',
    kind: 'chat-sdk' as const,
    timestamp: '2026-10-10T17:00:00.000Z',
    isMention: false,
    isGroup: true,
    authenticatedSender: { userId: 'users/2002', displayName: 'Remy Vance', kind: 'human' as const },
    deduplicate: true,
    quiet: true,
    reaction: true,
  };
  state.startChannels.mockImplementation(async (setup) => {
    void setup({ channelType: 'gchat', instance: 'gchat' }).onInbound(
      'gchat:spaces/AAAAroom',
      'gchat:spaces/AAAAroom:thread-lunch',
      { ...message, content },
    );
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  state.releaseAdoption!();

  await vi.waitFor(() => expect(state.routeInbound).toHaveBeenCalledOnce());
  expect(state.routeInbound).toHaveBeenCalledWith({
    channelType: 'gchat',
    instance: 'gchat',
    platformId: 'gchat:spaces/AAAAroom',
    threadId: 'gchat:spaces/AAAAroom:thread-lunch',
    message: { ...message, content: JSON.stringify(content) },
  });
});

it('holds an answer until inbound is ready, and settles it only once its handler has finished', async () => {
  vi.resetModules();
  vi.spyOn(process, 'on').mockReturnValue(process);
  let finish!: () => void;
  const handler = vi.fn(async () => {
    expect(state.adopted).toBe(true);
    await new Promise<void>((resolve) => {
      finish = resolve;
    });
    return true;
  });
  state.responseHandlers = [handler];
  let answered: void | Promise<void> = undefined;
  state.startChannels.mockImplementation(async (setup) => {
    answered = setup({ channelType: 'fixture' }).onAction(
      'q-1',
      'reject',
      'users/2001',
      { platformId: 'fixture:dm', messageId: 'fixture:dm/m-1' },
      { deferResolution: true, reason: 'too expensive' },
    );
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  expect(handler).not.toHaveBeenCalled();

  let settled = false;
  const settling = Promise.resolve(answered).then(() => {
    settled = true;
  });
  state.releaseAdoption!();
  await vi.waitFor(() => expect(handler).toHaveBeenCalledOnce());
  expect(handler).toHaveBeenCalledWith({
    questionId: 'q-1',
    value: 'reject',
    reason: 'too expensive',
    userId: 'users/2001',
    channelType: 'fixture',
    instance: 'fixture',
    messageId: 'fixture:dm/m-1',
    platformId: 'fixture:dm',
    threadId: null,
    deferResolution: true,
  });
  await Promise.resolve();
  expect(settled).toBe(false);
  finish();
  await settling;
  expect(settled).toBe(true);
});

it('rejects an answer whose handler fails, so its channel can hand it over again', async () => {
  vi.resetModules();
  vi.spyOn(process, 'on').mockReturnValue(process);
  state.responseHandlers = [
    async () => {
      throw new Error('database is locked');
    },
  ];
  let answered: void | Promise<void> = undefined;
  state.startChannels.mockImplementation(async (setup) => {
    answered = setup({ channelType: 'fixture' }).onAction('q-1', 'approve', 'users/2001');
  });
  await import('./index.js');
  await vi.waitFor(() => expect(state.releaseAdoption).toBeDefined());
  state.releaseAdoption!();

  await expect(Promise.resolve(answered)).rejects.toThrow('database is locked');
});
