import { createHash, randomUUID } from 'node:crypto';

import { getChannelAdapterExact } from '../../channels/channel-registry.js';
import {
  answeredGuard,
  answeringAction,
  forbidden,
  invalidArgs,
  type ActionAnswer,
} from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import {
  createMessagingGroupIfAbsent,
  getMessagingGroupAgents,
  getMessagingGroupByPlatform,
} from '../../db/messaging-groups.js';
import type { DeliveryGuardSpec, GuardedDeliveryHandler } from '../../delivery-guard.js';
import { hasControlCharacters, isRecord } from '../../gws-ea/validation.js';
import { ALLOW, DENY, defineGuardedAction } from '../../guard/index.js';
import { runInConversationTail } from '../../router.js';
import { addPerson, getPerson, updatePerson } from '../gws-ea-people/db.js';
import { checkOutbound } from '../gws-ea-privacy/outbound.js';
import { getExternalChatAgentGroupId, getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { requirePrincipalDirectMessage } from '../gws-ea-profile/marks.js';
import type { WhatsAppAdapter } from '../gws-ea-whatsapp/adapter.js';
import type { WhatsAppOutreachRequest } from '../gws-ea-whatsapp/contacts.js';
import type { WhatsAppPerson } from '../gws-ea-whatsapp/paths.js';
import { flushChatHandoffs } from './bridge.js';
import { getChat } from './db.js';
import { recordChatHandoff } from './handoffs.js';
import type { ChatJoinFacts } from './join.js';
import { personForMember, refreshChatRoster } from './roster.js';
import { ensureChatWiring } from './wiring-policy.js';

interface OutreachPerson {
  readonly name: string;
  readonly number: string;
  readonly person?: string;
}
function textOf(value: unknown, field: string, max: number): string {
  const text = typeof value === 'string' ? value.replace(/\r\n?/gu, '\n').trim() : '';
  if (!text || text.length > max || hasControlCharacters(text.replace(/[\n\t]/gu, ' ')))
    throw invalidArgs(`${field} must be text of 1 to ${max} characters.`);
  return text;
}
function peopleOf(value: unknown): OutreachPerson[] {
  if (!Array.isArray(value) || value.length === 0)
    throw invalidArgs('people must list the people to reach, with their names and country-code numbers.');
  const people = value.map((entry: unknown) => {
    if (!isRecord(entry) || Object.keys(entry).some((key) => !['name', 'number', 'person'].includes(key)))
      throw invalidArgs('people must list {name,number,person?} entries.');
    const number = textOf(entry.number, 'people.number', 16);
    if (!/^\+\d{7,15}$/u.test(number)) throw invalidArgs('Each number needs + and the country code.');
    return {
      name: textOf(entry.name, 'people.name', 120),
      number,
      ...(entry.person === undefined ? {} : { person: textOf(entry.person, 'people.person', 256) }),
    };
  });
  if (new Set(people.map(({ number }) => number)).size !== people.length)
    throw invalidArgs('List each person only once.');
  return people;
}
async function keepKnown(input: OutreachPerson, person: WhatsAppPerson): Promise<void> {
  const identity = `whatsapp:${person.lid}`;
  const existing = await personForMember(identity);
  if (input.person !== undefined) {
    if (existing !== null && existing !== input.person)
      throw invalidArgs('That WhatsApp identity belongs to a different person record.');
    if (existing === null) await updatePerson({ id: input.person, source: 'principal', addIdentity: identity });
  } else if (existing === null) {
    await addPerson({
      name: input.name,
      level: 'known',
      source: 'principal',
      levelSource: 'learned',
      basis: 'The principal asked the assistant to contact this person on WhatsApp.',
      identity,
    });
  }
}
const mainOutreach = defineGuardedAction({
  action: 'gws_ea_chats.reach_out',
  decide: async ({ actor }) =>
    actor.kind === 'agent' && actor.agentGroupId === (await getMainAgentGroupId())
      ? ALLOW('main, by the profile pointer')
      : DENY('Only main may start a WhatsApp conversation with someone new.'),
});
async function assertOutreachConversation(platformId: string, external: string): Promise<void> {
  const group = await getMessagingGroupByPlatform('whatsapp', platformId, 'whatsapp');
  if (!group) return;
  const chat = await getChat(group.id);
  if (
    chat
      ? chat.serving_agent_group_id !== external || chat.state === 'job' || chat.state === 'moving'
      : (await getMessagingGroupAgents(group.id)).length > 0
  )
    throw forbidden('This conversation already belongs to another assistant session.');
}
const reachOut: ActionAnswer = async (content, session, requestId) => {
  const unknown = Object.keys(content).find(
    (key) => !['action', 'requestId', 'delivers', 'people', 'message', 'group', 'principal_message'].includes(key),
  );
  if (unknown) throw invalidArgs(`Unknown outreach field ${unknown}.`);
  const principal = await requirePrincipalDirectMessage(textOf(content.principal_message, 'principal_message', 512));
  const people = peopleOf(content.people);
  const message = textOf(content.message, 'message', 8_000);
  const subject = content.group === undefined ? undefined : textOf(content.group, 'group', 100);
  if (subject === undefined && people.length !== 1)
    throw invalidArgs('A direct conversation needs one person; give group a name for a group.');
  const check = await checkOutbound([message, ...(subject === undefined ? [] : [subject])], 'others');
  if (!check.allowed) throw forbidden(`Nothing was handed over: ${check.reason}`);
  const external = await getExternalChatAgentGroupId();
  if (!external) throw forbidden('The assistant cannot work in outside chats yet.');
  const adapter = getChannelAdapterExact('whatsapp') as WhatsAppAdapter | undefined;
  if (!adapter?.isConnected()) throw forbidden('WhatsApp is unavailable. Use email or tell the principal.');
  const resolved: { readonly input: OutreachPerson; readonly person: WhatsAppPerson }[] = [];
  for (const input of people) {
    if (input.person !== undefined && !(await getPerson(input.person)))
      throw invalidArgs('That person record does not exist.');
    const person = await adapter.resolveNumber(input.number);
    if (!person) throw forbidden(`${input.name} is not registered on WhatsApp. Use email or tell the principal.`);
    const existing = await personForMember(`whatsapp:${person.lid}`);
    if (input.person !== undefined && existing !== null && input.person !== existing)
      throw invalidArgs('That WhatsApp identity belongs to a different person record.');
    resolved.push({ input, person });
  }
  if (new Set(resolved.map(({ person }) => person.lid)).size !== resolved.length)
    throw invalidArgs('Those numbers resolve to the same person; list each person once.');
  const id = `chat-outreach-${createHash('sha256').update(`${session.id}\0${requestId}`).digest('hex')}`;
  const admitted: WhatsAppOutreachRequest = { requestId: id, principalMessageId: principal.id };
  let facts: ChatJoinFacts;
  let participants: readonly Record<string, unknown>[] | undefined;
  if (subject === undefined) {
    const { person, input } = resolved[0];
    const platformId = await adapter.openDM(person.lid);
    if (!platformId) throw new Error('WhatsApp could not open this conversation.');
    await assertOutreachConversation(platformId, external);
    await adapter.prepareReachOutDM(person, admitted);
    facts = {
      channelType: 'whatsapp',
      platformId,
      name: input.name,
      isGroup: false,
      members: [{ key: `whatsapp:${person.lid}`, name: input.name, isPrincipal: false }],
    };
  } else {
    const group = await adapter.createGroup(
      subject,
      resolved.map(({ person }) => person),
      admitted,
    );
    const roster = await adapter.fetchGroupMembers(group.platformId);
    facts = {
      channelType: 'whatsapp',
      platformId: group.platformId,
      name: roster.name,
      isGroup: true,
      members: roster.members,
    };
    participants = group.participants.map(({ person, outcome, reason }) => ({
      person: `whatsapp:${person.lid}`,
      outcome,
      ...(reason === undefined ? {} : { reason }),
    }));
  }
  return runInConversationTail({ channelType: 'whatsapp', platformId: facts.platformId }, async () => {
    await assertOutreachConversation(facts.platformId, external);
    for (const { input, person } of resolved) await keepKnown(input, person);
    const now = new Date().toISOString();
    await createMessagingGroupIfAbsent({
      id: `mg-chat-${randomUUID()}`,
      channel_type: 'whatsapp',
      instance: 'whatsapp',
      platform_id: facts.platformId,
      name: facts.name,
      is_group: Number(facts.isGroup),
      unknown_sender_policy: 'public',
      created_at: now,
    });
    const group = await getMessagingGroupByPlatform('whatsapp', facts.platformId, 'whatsapp');
    if (!group) throw new Error('The outreach conversation was not stored.');
    await getDb().transaction(async () => {
      await getDb().run(
        `INSERT INTO gws_ea_chats(messaging_group_id,state,serving_agent_group_id,principal_present,connected_at,placed_nowhere,created_at,updated_at)
        VALUES(?,'connected',?,?,?,1,?,?) ON CONFLICT(messaging_group_id) DO UPDATE SET state='connected',connected_at=COALESCE(gws_ea_chats.connected_at,excluded.connected_at),placed_nowhere=1,updated_at=excluded.updated_at`,
        group.id,
        external,
        Number(facts.members.some((member) => member.isPrincipal)),
        now,
        now,
        now,
      );
      await getDb().run(
        "UPDATE messaging_groups SET denied_at=NULL,detached_at=NULL,unknown_sender_policy='public',name=COALESCE(?,name) WHERE id=?",
        facts.name,
        group.id,
      );
      await refreshChatRoster(group.id, facts.members);
      const chat = await getChat(group.id);
      if (!chat) throw new Error('The outreach chat was not stored.');
      await ensureChatWiring(chat);
      await recordChatHandoff({ id, messaging_group_id: group.id, message, matter_id: null, created_at: now }, []);
    });
    await flushChatHandoffs(group.id);
    return {
      chat: group.id,
      message: 'The conversation is connected and your request has been handed over.',
      ...(participants === undefined ? {} : { participants }),
    };
  });
};

export const CHAT_OUTREACH_ACTIONS: ReadonlyArray<readonly [string, GuardedDeliveryHandler, DeliveryGuardSpec]> = [
  ['chat_reach_out', answeringAction('chat_reach_out', reachOut), answeredGuard(mainOutreach)],
];
