/** Pairing and principal proof are host-owned; credentials and binding codes never enter a group conversation. */
import { randomBytes } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

import { getChannelAdapterExact, startChannelAdapter, stopChannelAdapter } from '../../channels/channel-registry.js';
import { answeredGuard, answeringAction, invalidArgs } from '../../cli/delivery-action.js';
import { register } from '../../cli/registry.js';
import { registerDeliveryAction } from '../../delivery.js';
import { readEnvFile } from '../../env.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { resolveControlPlanePaths, type ControlPlanePaths } from '../../gws-ea/paths.js';
import { claimInstanceWhatsApp } from '../../gws-ea/registry.js';
import { log } from '../../log.js';
import { onHostShutdown } from '../../host-lifecycle.js';
import { bindWhatsAppPrincipal, removeWhatsAppPrincipalBinding } from '../gws-ea-profile/bind.js';
import { getGwsEaProfile, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { requirePrincipalDirectMessage } from '../gws-ea-profile/marks.js';
import { writeNoteForMain } from '../gws-ea-profile/main-note.js';
import type { WhatsAppAdapter } from './adapter.js';
import { WhatsAppIndex } from './index-store.js';
import {
  observeWhatsAppLinkNotice,
  registerWhatsAppObserver,
  type WhatsAppReceived,
  type WhatsAppLinkNotice,
} from './observers.js';
import {
  readWhatsAppLink,
  writeWhatsAppLink,
  whatsappDirectory,
  type WhatsAppLink,
  type WhatsAppPerson,
} from './paths.js';

export const PAIRING_WINDOW_MS = 180_000;
const BINDING_WINDOW_MS = 30 * 60_000;
export type WhatsAppLinkCaller =
  | { readonly kind: 'operator' }
  | { readonly kind: 'principal'; readonly agentGroupId: string; readonly principalMessages: readonly string[] };
export interface WhatsAppLinkStatus {
  readonly state: 'unlinked' | WhatsAppLink['state'];
  readonly number?: string;
  readonly principal?: WhatsAppPerson;
  readonly bindingPending?: boolean;
}
export interface WhatsAppLinkingOptions {
  readonly directory: string;
  readonly paths: ControlPlanePaths;
  readonly instanceId: string;
}

/** E.164 as written by a person; only presentation punctuation and spacing are ignored. */
export function normalizeWhatsAppNumber(value: string): string {
  if (!/^\+?[\d\s().-]+$/u.test(value)) throw new Error('Give a phone number with its country code.');
  const digits = value.replace(/[^\d]/gu, '');
  const normalized = `+${digits}`;
  if (!/^\+[1-9]\d{6,14}$/u.test(normalized)) throw new Error('Give a phone number with its country code.');
  return normalized;
}
function containsNumber(text: string, number: string): boolean {
  return [...text.matchAll(/\+?\d(?:[\d\s().-]*\d)?/gu)].some(
    ([written]) => written.replace(/\D/gu, '') === number.slice(1),
  );
}
function transport(): WhatsAppAdapter | undefined {
  return getChannelAdapterExact('whatsapp') as WhatsAppAdapter | undefined;
}
function status(record: WhatsAppLink | undefined): WhatsAppLinkStatus {
  return record
    ? { state: record.state, number: record.number, principal: record.principal, bindingPending: !!record.binding }
    : { state: 'unlinked' };
}

export class WhatsAppLinking {
  private readonly unregister: () => void;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private pairingDeadline: number | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(readonly options: WhatsAppLinkingOptions) {
    if (options.directory !== path.join(options.paths.instanceRoot(options.instanceId), 'secrets', 'whatsapp'))
      throw new Error('WhatsApp account state is not this assistant’s secrets directory');
    this.unregister = registerWhatsAppObserver({
      onMessage: (received) => this.receive(received),
      onConnectionUpdate: ({ update }) => this.connection(update.connection),
    });
  }
  close(): void {
    this.unregister();
    if (runtime === this) runtime = undefined;
    if (this.timer) clearTimeout(this.timer);
  }
  private serialize<T>(work: () => Promise<T>): Promise<T> {
    const run = this.tail.then(work);
    this.tail = run.catch(() => undefined);
    return run;
  }
  async status(): Promise<WhatsAppLinkStatus> {
    return status(await readWhatsAppLink(this.options.directory));
  }
  private async note(id: string, text: string): Promise<void> {
    const result = await writeNoteForMain({
      id: `whatsapp-link:${id}`,
      timestamp: new Date().toISOString(),
      text,
      wake: true,
    });
    if (result !== 'written' && result !== 'already-written')
      throw new Error('The principal’s conversation is unavailable for the WhatsApp linking note');
  }
  private notice(notice: WhatsAppLinkNotice): Promise<boolean> {
    return observeWhatsAppLinkNotice(notice);
  }
  private arm(expiresAt: number): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.serialize(() => this.expire()).catch((error: unknown) =>
          log.error('Could not expire WhatsApp pairing', { err: error }),
        );
      },
      Math.max(1, expiresAt - Date.now()),
    );
    this.timer.unref();
  }
  /** Before channel startup, an interrupted attempt retains its deadline and restores the former state once expired. */
  async reconcile(): Promise<void> {
    const record = await readWhatsAppLink(this.options.directory);
    if (record?.state === 'needs-relink' && !record.pairing) await this.connection('close');
    if (!record?.pairing) return;
    if (record.pairing.expiresAt <= Date.now() || this.pairingDeadline !== record.pairing.expiresAt)
      await this.expire();
    else this.arm(record.pairing.expiresAt);
  }
  private async admitted(caller: WhatsAppLinkCaller, number?: string, principalNumber?: string): Promise<void> {
    if (caller.kind === 'operator') return;
    if (caller.agentGroupId !== (await getMainAgentGroupId()))
      throw new Error('Only the principal’s assistant may link WhatsApp.');
    if (caller.principalMessages.length === 0)
      throw new Error('Cite the principal’s own recent message from their direct conversation.');
    const messages = await Promise.all(caller.principalMessages.map((id) => requirePrincipalDirectMessage(id)));
    for (const wanted of [number, principalNumber])
      if (wanted && !messages.some(({ text }) => containsNumber(text, wanted)))
        throw new Error(`The principal did not give ${wanted} in the cited messages.`);
  }
  link(
    numberInput: string | undefined,
    principalInput: string | undefined,
    caller: WhatsAppLinkCaller,
  ): Promise<WhatsAppLinkStatus & { readonly pairingCode?: string }> {
    return this.serialize(async () => {
      let previous = await readWhatsAppLink(this.options.directory);
      const number = numberInput === undefined ? previous?.number : normalizeWhatsAppNumber(numberInput);
      const principalNumber =
        principalInput === undefined ? previous?.principalNumber : normalizeWhatsAppNumber(principalInput);
      if (!number || !principalNumber)
        throw new Error('Give the assistant’s own phone number and the number the principal uses.');
      if (number === principalNumber)
        throw new Error('The assistant needs its own number, different from the principal’s.');
      if (previous && (previous.number !== number || previous.principalNumber !== principalNumber))
        throw new Error('A re-link keeps the existing numbers and principal. Unlink first to link different numbers.');
      if ((numberInput === undefined) !== (principalInput === undefined))
        throw new Error('Give both numbers for a new link, or neither for a re-link.');
      await this.admitted(
        caller,
        previous && !numberInput ? undefined : number,
        previous && !principalInput ? undefined : principalNumber,
      );
      if (previous?.state === 'connected') {
        if (!previous.principal && (!previous.binding || previous.binding.expiresAt <= Date.now())) {
          await this.setOwnProfile();
          await this.issueBinding(previous);
        }
        return status(await readWhatsAppLink(this.options.directory));
      }
      if (previous?.pairing && previous.pairing.expiresAt > Date.now())
        throw new Error('The current pairing code is still waiting to be entered.');
      if (previous?.pairing) {
        await this.expire();
        previous = await readWhatsAppLink(this.options.directory);
      }
      const profile = await getGwsEaProfile();
      if (!profile.main_agent_group_id || !profile.assistant_display_name)
        throw new Error('The assistant’s identity and principal conversation must be ready before linking WhatsApp.');
      await claimInstanceWhatsApp(this.options.paths, this.options.instanceId, number);
      const expiresAt = Date.now() + PAIRING_WINDOW_MS;
      this.pairingDeadline = expiresAt;
      await writeWhatsAppLink(this.options.directory, {
        schema_version: 1,
        state: 'linking',
        number,
        principalNumber,
        ...(previous?.account ? { account: previous.account } : {}),
        ...(previous?.principal ? { principal: previous.principal } : {}),
        ...(previous?.outage ? { outage: previous.outage } : {}),
        pairing: { expiresAt, previousState: previous ? 'needs-relink' : null },
      });
      this.arm(expiresAt);
      try {
        await startChannelAdapter('whatsapp');
        const adapter = transport();
        if (!adapter) throw new Error('WhatsApp could not start its pairing connection.');
        const pairingCode = await adapter.requestPairingCode(number.slice(1));
        return { ...status(await readWhatsAppLink(this.options.directory)), pairingCode };
      } catch (error) {
        await this.expire();
        throw error;
      }
    });
  }
  private async issueBinding(record: WhatsAppLink): Promise<void> {
    const binding = (record.binding && record.binding.expiresAt > Date.now() ? record.binding : undefined) ?? {
      code: `EA-${randomBytes(4).toString('hex').toUpperCase()}`,
      expiresAt: Date.now() + BINDING_WINDOW_MS,
    };
    await writeWhatsAppLink(this.options.directory, { ...record, binding });
    await this.note(
      `bind:${binding.code}`,
      `WhatsApp is connected as ${record.number}. Give the principal this binding code: ${binding.code}. Ask them to send it to ${record.number} from their own WhatsApp number, ${record.principalNumber}, within 30 minutes. No message has been sent to that number.`,
    );
  }
  private async setOwnProfile(): Promise<void> {
    const profile = await getGwsEaProfile();
    if (!profile.assistant_display_name) throw new Error('The assistant’s display name is unavailable.');
    const adapter = transport();
    if (!adapter) throw new Error('WhatsApp is not connected.');
    await adapter.setProfile(profile.assistant_display_name, 'Personal assistant');
  }
  private async connection(connection: 'open' | 'close' | 'connecting' | undefined): Promise<void> {
    const record = await readWhatsAppLink(this.options.directory);
    if (!record) return;
    if (connection === 'open') {
      this.pairingDeadline = undefined;
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      if (record.number && record.account?.phoneJid !== `${record.number.slice(1)}@s.whatsapp.net`)
        throw new Error('The connected WhatsApp account does not match its admitted number.');
      await this.setOwnProfile();
      const { pairing: _pairing, outage: _outage, ...connected } = record;
      await writeWhatsAppLink(this.options.directory, { ...connected, state: 'connected' });
      if (!record.principal) await this.issueBinding({ ...connected, state: 'connected' });
      else await transport()?.releaseHeldPrincipal(record.principal.lid);
    } else if (connection === 'close' && record.pairing) {
      // Do not teardown inside the transport's own awaited event: teardown waits for this event.
      this.arm(Date.now());
    } else if (connection === 'close' && record.state === 'needs-relink') {
      const outage = record.outage ?? { id: randomBytes(12).toString('hex') };
      await writeWhatsAppLink(this.options.directory, { ...record, outage });
      if (!outage.notified) {
        const accepted = await this.notice({
          id: `outage:${outage.id}`,
          kind: 'needs-relink',
          link: record,
          text: 'WhatsApp has disconnected. Tell the principal once in their Google Chat conversation, and ask them to reply when ready to re-link. Request a fresh pairing code only after they reply.',
        });
        if (accepted)
          await writeWhatsAppLink(this.options.directory, { ...record, outage: { ...outage, notified: true } });
      }
    }
  }
  private async receive(received: WhatsAppReceived): Promise<'consume' | 'hold' | 'route'> {
    if (received.isGroup || !received.person) return 'route';
    const record = await readWhatsAppLink(this.options.directory);
    if (!record) return 'route';
    if (record.principal?.lid === received.person.lid) {
      if (record.principal.phoneJid !== received.person.phoneJid) {
        await this.notice({
          id: `number-changed:${record.principal.lid}`,
          kind: 'principal-number-changed',
          link: record,
          text: 'The principal’s WhatsApp phone number changed. Their messages are held out of the assistant’s conversation. Ask them in Google Chat to unlink WhatsApp and link the new numbers with a fresh binding proof. A re-link cannot change the bound principal.',
        });
        return 'consume';
      }
      return 'route';
    }
    if (
      record.principal ||
      !record.principalNumber ||
      received.person.phoneJid !== `${record.principalNumber.slice(1)}@s.whatsapp.net`
    )
      return 'route';
    const binding = record.binding;
    const carriesCode =
      binding &&
      received.content.text
        .split(/\s+/u)
        .some((word) => word.replace(/^[^A-Z0-9]+|[^A-Z0-9]+$/gu, '') === binding.code);
    if (!binding || binding.expiresAt <= Date.now() || received.content.forwarded || !carriesCode) return 'hold';
    await bindWhatsAppPrincipal(received.person, new Date().toISOString());
    const { binding: _binding, ...bound } = record;
    await writeWhatsAppLink(this.options.directory, { ...bound, principal: received.person });
    await transport()?.releaseHeldPrincipal(received.person.lid);
    return 'consume';
  }
  private discardPending(record: WhatsAppLink): void {
    const number = record.number;
    if (!number) throw new Error('The WhatsApp account number is missing');
    const index = new WhatsAppIndex(this.options.directory, () => `${number.slice(1)}@s.whatsapp.net`);
    try {
      index.discardUnrouted();
    } finally {
      index.close();
    }
  }
  private async expire(): Promise<void> {
    const record = await readWhatsAppLink(this.options.directory);
    if (!record?.pairing) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    transport()?.clearAuth();
    await stopChannelAdapter('whatsapp');
    this.pairingDeadline = undefined;
    this.discardPending(record);
    await fs.rm(path.join(this.options.directory, 'auth.sqlite'), { force: true });
    if (record.pairing.previousState) {
      const { pairing: _pairing, binding: _binding, ...previous } = record;
      await writeWhatsAppLink(this.options.directory, { ...previous, state: record.pairing.previousState });
    } else {
      await fs.rm(path.join(this.options.directory, 'link.json'), { force: true });
      await claimInstanceWhatsApp(this.options.paths, this.options.instanceId, undefined);
    }
    await this.note(
      `expired:${record.pairing.expiresAt}`,
      'The WhatsApp pairing code expired before the account connected. Tell the principal and get a fresh code when they are ready.',
    );
  }
  unlink(): Promise<WhatsAppLinkStatus> {
    return this.serialize(async () => {
      if (this.timer) clearTimeout(this.timer);
      this.timer = undefined;
      await transport()?.logout();
      await stopChannelAdapter('whatsapp');
      const record = await readWhatsAppLink(this.options.directory);
      this.pairingDeadline = undefined;
      if (record) this.discardPending(record);
      if (record?.principal) await removeWhatsAppPrincipalBinding(record.principal.lid);
      // contacts.sqlite is account-number scoped and survives unlink, including refusals and time locks.
      for (const file of ['auth.sqlite', 'link.json'])
        await fs.rm(path.join(this.options.directory, file), { force: true });
      await claimInstanceWhatsApp(this.options.paths, this.options.instanceId, undefined);
      return { state: 'unlinked' };
    });
  }
}

let runtime: WhatsAppLinking | undefined;
onHostShutdown(() => {
  runtime?.close();
  runtime = undefined;
});
export function whatsAppLinking(): WhatsAppLinking {
  if (runtime) return runtime;
  const directory = whatsappDirectory();
  const keys = ['GWS_EA_CONFIG_ROOT', 'GWS_EA_STATE_ROOT', 'GWS_EA_INSTANCE_ID'] as const;
  const values = { ...readEnvFile([...keys]), ...process.env };
  const configRoot = values.GWS_EA_CONFIG_ROOT;
  const stateRoot = values.GWS_EA_STATE_ROOT;
  const instanceId = values.GWS_EA_INSTANCE_ID;
  if (!directory || !configRoot || !stateRoot || !instanceId)
    throw new Error('The operator must update this assistant before linking WhatsApp.');
  runtime = new WhatsAppLinking({ directory, paths: resolveControlPlanePaths({ configRoot, stateRoot }), instanceId });
  return runtime;
}
export function linkWhatsApp(
  number: string | undefined,
  principalNumber: string | undefined,
  caller: WhatsAppLinkCaller,
) {
  return whatsAppLinking().link(number, principalNumber, caller);
}

const linkGuard = defineGuardedAction({
  action: 'whatsapp.link',
  async decide({ actor }) {
    return actor.kind === 'agent' && actor.agentGroupId === (await getMainAgentGroupId())
      ? ALLOW('Canonical main; the host additionally checks marked principal DM citations.')
      : DENY('Only canonical main may request WhatsApp linking.');
  },
});
registerDeliveryAction(
  'whatsapp_link',
  answeringAction('whatsapp_link', async (content, session) => {
    const ids = content.principal_messages;
    if (!Array.isArray(ids) || !ids.every((id: unknown): id is string => typeof id === 'string' && id.length > 0))
      throw invalidArgs('principal_messages must cite the principal’s marked messages.');
    if (
      (content.number !== undefined && typeof content.number !== 'string') ||
      (content.principal_number !== undefined && typeof content.principal_number !== 'string')
    )
      throw invalidArgs('Phone numbers must be strings.');
    return {
      ...(await linkWhatsApp(content.number, content.principal_number, {
        kind: 'principal',
        agentGroupId: session.agent_group_id,
        principalMessages: ids,
      })),
    };
  }),
  answeredGuard(linkGuard),
);
for (const operation of ['link', 'unlink', 'status'] as const)
  register({
    name: `gws-ea-whatsapp-${operation}`,
    description: `${operation} this assistant’s WhatsApp account.`,
    access: 'hidden',
    hostOnly: true,
    parseArgs(raw) {
      for (const key of Object.keys(raw))
        if (operation !== 'link' || !['number', 'principal-number'].includes(key))
          throw new Error(`Unknown WhatsApp option: ${key}`);
      const number = raw.number;
      const principal = raw['principal-number'];
      if (
        (number !== undefined && typeof number !== 'string') ||
        (principal !== undefined && typeof principal !== 'string')
      )
        throw new Error('Phone numbers must be strings.');
      return { number, principal };
    },
    handler: async (input) =>
      operation === 'link'
        ? linkWhatsApp(input.number, input.principal, { kind: 'operator' })
        : operation === 'unlink'
          ? whatsAppLinking().unlink()
          : whatsAppLinking().status(),
  });
