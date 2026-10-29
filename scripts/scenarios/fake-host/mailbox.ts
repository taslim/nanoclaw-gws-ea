import fs from 'node:fs';
import path from 'node:path';
import type {
  AgentMailbox,
  InboundMessage,
  MailboxOperations,
  MailboxSessionKey,
  OutboundMessage,
  OutboundMessageDraft,
  ProcessingStatus,
  SessionRouting,
  StateValue,
} from '../../../container/agent-runner/src/mailbox/types.js';
import {
  createInboundRecord,
  parseOutboundRecord,
  parseIsoTimestamp,
  parseDestinationRecord,
  parseSessionRoutingRecord,
} from '../../../container/agent-runner/src/mailbox/model.generated.js';
import type { Destination } from '../../../container/agent-runner/src/mailbox/types.js';
import { callHost, readState } from './state.js';

export class FixtureMailbox implements AgentMailbox, MailboxOperations {
  readonly operations = this;
  private readonly inbound = new Map<string, InboundMessage>();
  private readonly destinations: Destination[];
  private readonly routing: SessionRouting;
  constructor(private readonly file: string) {
    const composition = JSON.parse(
      fs.readFileSync(path.join(path.dirname(file), 'composition.json'), 'utf8'),
    ) as import('../types.js').ScenarioComposition;
    this.destinations = composition.destinations.map(parseDestinationRecord);
    this.routing = parseSessionRoutingRecord(composition.routing);
  }
  async start(_key: MailboxSessionKey | null): Promise<void> {}
  async stop(): Promise<void> {}
  async run<T>(action: () => T | Promise<T>): Promise<T> {
    return action();
  }
  getPendingMessages(limit: number): InboundMessage[] {
    return [...this.inbound.values()].filter((entry) => entry.status === 'pending').slice(0, limit);
  }
  markMessages(ids: string[], status: ProcessingStatus): void {
    for (const id of ids) {
      const entry = this.inbound.get(id);
      if (entry) {
        if (status === 'script-skip:error') this.inbound.delete(id);
        else entry.status = status;
      }
    }
  }
  markScriptSkipped(skips: Array<{ id: string; reason: string }>): void {
    this.markMessages(
      skips.map((entry) => entry.id),
      'script-skip:error',
    );
  }
  getMessageIn(id: string): InboundMessage | undefined {
    return this.inbound.get(id);
  }
  findQuestionResponse(id: string): InboundMessage | undefined {
    return this.inbound.get(`question-resp-${id}`);
  }
  findCliResponse(id: string): InboundMessage | undefined {
    return this.inbound.get(`cli-resp-${id}`);
  }
  async writeMessageOut(message: OutboundMessageDraft): Promise<number> {
    const fixture = readState(this.file);
    if (message.kind === 'chat') {
      if (fixture.scenario.observationOnly)
        throw new Error('Unsupported fixture outward delivery: this case observes an internal report only.');
      const destination =
        message.channelType === 'agent'
          ? this.destinations.find((entry) => entry.type === 'agent' && entry.agentGroupId === message.platformId)
          : this.findDestinationByRouting(message.channelType ?? null, message.platformId ?? null);
      if (!destination) throw new Error('Unsupported or ungranted fixture destination.');
    }
    const row = parseOutboundRecord(await callHost(this.file, 'outbound', { draft: message }));
    const seq = row.sequence;
    if (seq === null) throw new Error('Native synthetic outbox has no sequence');
    const content = JSON.parse(message.content) as Record<string, unknown>;
    if (message.kind === 'system' && typeof content.action === 'string' && typeof content.requestId === 'string') {
      let frame: unknown;
      try {
        const answer = (await callHost(this.file, 'action', content)) as { frame?: unknown; pending?: boolean };
        if (!answer.frame) throw new Error('Native action has no answer yet. The fixture cannot confirm it.');
        frame = answer.frame;
        // eslint-disable-next-line no-catch-all/no-catch-all -- the native tool receives a failure frame for every host transport error
      } catch (error) {
        frame = { id: content.requestId, ok: false, error: { code: 'fixture-unsupported', message: String(error) } };
      }
      const id = `action-resp-${content.requestId}`;
      this.inbound.set(
        id,
        createInboundRecord(
          {
            id,
            kind: 'system',
            timestamp: new Date().toISOString(),
            platformId: null,
            channelType: null,
            threadId: null,
            processAfter: null,
            recurrence: null,
            content: JSON.stringify({ frame }),
          },
          seq + 1,
        ),
      );
    } else if (message.kind === 'task_log') {
      // Native task output is an internal report, never an email/chat delivery.
      return seq;
    } else if (message.kind === 'chat') {
      await callHost(this.file, 'deliver', { messageId: row.id });
    } else throw new Error(`Unsupported fixture outbound kind: ${message.kind}`);
    return seq;
  }
  getMessageIdBySeq(sequence: number): string | null {
    return this.getUndeliveredMessages().find((entry) => entry.sequence === sequence)?.id ?? null;
  }
  getRoutingBySeq(_sequence: number): SessionRouting {
    return this.getSessionRouting();
  }
  getLatestInboundRoute(
    channelType: string,
    platformId: string,
  ): { threadId: string | null; inReplyTo: string } | null {
    return this.routing.channelType === channelType && this.routing.platformId === platformId
      ? { threadId: this.routing.threadId, inReplyTo: 'synthetic-input' }
      : null;
  }
  getUndeliveredMessages(): OutboundMessage[] {
    return readState(this.file).outbound.map(parseOutboundRecord);
  }
  private sharedState(): Record<string, StateValue> {
    const file = path.join(path.dirname(this.file), 'mailbox-state.json');
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, StateValue>) : {};
  }
  getState(key: string): StateValue | undefined {
    return this.sharedState()[key];
  }
  setState(key: string, value: string): void {
    const state = this.sharedState();
    state[key] = { value, updatedAt: parseIsoTimestamp(new Date().toISOString()) };
    fs.writeFileSync(path.join(path.dirname(this.file), 'mailbox-state.json'), JSON.stringify(state));
  }
  deleteState(key: string): void {
    const state = this.sharedState();
    delete state[key];
    fs.writeFileSync(path.join(path.dirname(this.file), 'mailbox-state.json'), JSON.stringify(state));
  }
  getSessionRouting(): SessionRouting {
    return this.routing;
  }
  getDestinations(): Destination[] {
    return this.destinations;
  }
  findDestinationByName(name: string): Destination | undefined {
    return this.destinations.find((entry) => entry.name === name);
  }
  findDestinationByRouting(channelType: string | null, platformId: string | null): Destination | undefined {
    return this.destinations.find(
      (entry) => entry.type === 'channel' && entry.channelType === channelType && entry.platformId === platformId,
    );
  }
  setContainerToolInFlight(_tool: string, _declaredTimeoutMs: number | null): void {}
  clearContainerToolInFlight(): void {}
  clearStaleProcessingAcks(): void {}
}
