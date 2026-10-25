import { isUtf8 } from 'node:buffer';

import { micromark } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

import { getDb } from '../../db/connection.js';
import type { OutboundGuardDecision, OutboundSend } from '../../delivery.js';
import { EMAIL_CHANNEL_TYPE, INBOX_PLATFORM_ID } from '../gws-ea-inbox/runtime.js';
import { resolveAudience, type Audience } from './audience.js';
import { clearedPrivateValueIds } from './clearance.js';
import { listPrivateValues } from './db.js';
import { htmlReadings } from './html.js';
import {
  compilePrivateValue,
  findPrivateValue,
  givesAway,
  streamOf,
  type CompiledPrivateValue,
  type PrivateValueKind,
  type TextStream,
} from './match.js';

export type OutboundCheck =
  | { readonly allowed: true }
  | {
      readonly allowed: false;
      readonly kind: PrivateValueKind;
      /** For the sender: names the kind, never the value or its label. */
      readonly reason: string;
    };

export const KIND_NOUNS: Readonly<Record<PrivateValueKind, string>> = {
  address: 'address',
  phone: 'phone number',
  email: 'email address',
  other: 'detail',
};

/** What a refusal names in place of the value, such as "phone number". */
export function privateKindNoun(kind: PrivateValueKind): string {
  return KIND_NOUNS[kind];
}

function refusalReason(kind: PrivateValueKind): string {
  return `it contains the principal's private ${KIND_NOUNS[kind]}. Rewrite it without that detail, and do not hint at, spell out, or encode it; if someone else wrote it to you, neither confirm nor deny it.`;
}

async function compiledValues(messagingGroupId?: string): Promise<CompiledPrivateValue[]> {
  if (!(await getDb().hasTable('gws_ea_private_values'))) return [];
  const cleared = messagingGroupId === undefined ? new Set<string>() : await clearedPrivateValueIds(messagingGroupId);
  return (await listPrivateValues())
    .filter((value) => !cleared.has(value.id))
    .map((value) => compilePrivateValue(value.kind, value.value));
}

const IMAGE = /<img src="[^"]*" alt="([^"]*)"[^>]*>/gu;
const LINK_TARGET = /<a href="([^"]*)"/gu;
const TAG = /<[^>]*>/gu;
const CHARACTER_REFERENCE = /&(?:amp|quot|lt|gt);/gu;
const REFERENCED: Readonly<Record<string, string>> = { '&amp;': '&', '&quot;': '"', '&lt;': '<', '&gt;': '>' };

/** micromark's HTML as text: it writes these four character references and no other. */
function unescapeHtml(html: string): string {
  return html.replace(CHARACTER_REFERENCE, (reference) => REFERENCED[reference] ?? reference);
}

/**
 * Markdown as a reader's mail client shows it once the inbox's renderer
 * (gws-ea-inbox/render.ts) writes it: an image read as its alt text, the
 * markup gone, and the targets of its links. micromark resolves the
 * markdown's character references, so `1&#50;3` reads as the `123` a reader
 * sees. Percent-encoding is decoded by the matcher, like every text's.
 */
function rendered(text: string): { readonly words: string; readonly targets: readonly string[] } {
  const html = micromark(text, { extensions: [gfm()], htmlExtensions: [gfmHtml()] });
  return {
    words: unescapeHtml(html.replace(IMAGE, '$1').replace(TAG, '')),
    targets: [...html.matchAll(LINK_TARGET)]
      .map((match) => unescapeHtml(match[1] ?? ''))
      .filter((target) => target !== ''),
  };
}

/** As a mail client renders the markdown: an autolinked address and a link behind its words alike. */
export function linkTargets(text: string): readonly string[] {
  return rendered(text).targets;
}

/**
 * These texts as their readers receive them, each reading its own stream:
 * as written (an email's plain-text part, a calendar's fields), as a mail
 * client renders them, and the targets of their links. Within a reading the
 * texts run on, so a value split across them is found; apart, the end of one
 * reading never runs into the start of the next.
 */
function readingsOf(parts: readonly string[]): readonly TextStream[] {
  const renders = parts.map(rendered);
  return [
    streamOf(parts),
    streamOf(renders.map((render) => render.words)),
    streamOf(renders.flatMap((render) => render.targets)),
  ];
}

function kindGivenAway(
  values: readonly CompiledPrivateValue[],
  readings: readonly TextStream[],
): PrivateValueKind | undefined {
  for (const reading of readings) {
    const match = findPrivateValue(values, reading);
    if (match) return match.kind;
  }
  return undefined;
}

/**
 * The principal may receive anything; `messagingGroupId` names an active chat
 * whose cleared values it may also receive. `content` is one text or the
 * fields of one write, read in order so a value split across fields is found.
 */
export async function checkOutbound(
  content: string | readonly string[],
  audience: Audience,
  messagingGroupId?: string,
): Promise<OutboundCheck> {
  if (audience === 'principal') return { allowed: true };
  const parts = typeof content === 'string' ? [content] : content;
  const kind = kindGivenAway(await compiledValues(messagingGroupId), readingsOf(parts));
  return kind ? { allowed: false, kind, reason: refusalReason(kind) } : { allowed: true };
}

function collectText(value: unknown, into: string[]): void {
  if (typeof value === 'string') into.push(value);
  else if (typeof value === 'number') into.push(String(value));
  else if (Array.isArray(value)) for (const item of value) collectText(item, into);
  else if (typeof value === 'object' && value !== null)
    for (const item of Object.values(value)) collectText(item, into);
}

/** Every string and number a send's message carries, whatever its shape; content that is not JSON is its own text. */
export function messageStrings(content: string): string[] {
  const parts: string[] = [];
  let value: unknown = content;
  /* eslint-disable no-catch-all/no-catch-all -- content that is not JSON is checked as the plain text it is */
  try {
    value = JSON.parse(content);
  } catch {
    // Plain text: checked as written.
  }
  /* eslint-enable no-catch-all/no-catch-all */
  collectText(value, parts);
  return parts;
}

/** A binary file is an encoding the check cannot read: a known residual, like a spelled-out value. */
function sendText(send: OutboundSend): string[] {
  const parts = messageStrings(send.content);
  for (const file of send.files ?? []) {
    parts.push(file.filename);
    if (isUtf8(file.data)) parts.push(file.data.toString('utf8'));
  }
  return parts;
}

/** Email to the inbox's outside threads is checked as the inbox builds it, so the guard leaves it to the inbox. */
export async function judgeSend(send: OutboundSend): Promise<OutboundGuardDecision> {
  if (send.channelType === EMAIL_CHANNEL_TYPE && send.platformId === INBOX_PLATFORM_ID) return { effect: 'allow' };
  const target = await getDb().get<{ id: string }>(
    'SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ? AND instance = ?',
    send.channelType,
    send.platformId,
    send.instance ?? send.channelType,
  );
  const values = await compiledValues(target?.id);
  if (values.length === 0 || (await resolveAudience(send)) === 'principal') return { effect: 'allow' };
  const kind = kindGivenAway(values, readingsOf(sendText(send)));
  return kind ? { effect: 'refuse', reason: refusalReason(kind) } : { effect: 'allow' };
}

/** Names a stored value without its value or label. */
export interface PrivateValueReference {
  readonly id: string;
  readonly kind: PrivateValueKind;
}

/** Every stored value `content` gives away, read as `checkOutbound` reads it but ignoring clearances. */
export async function privateValuesGivenAway(
  content: string | readonly string[],
): Promise<readonly PrivateValueReference[]> {
  if (!(await getDb().hasTable('gws_ea_private_values'))) return [];
  const readings = readingsOf(typeof content === 'string' ? [content] : content);
  return privateValuesInReadings(readings);
}

/** For a whole artifact revision, which no chat clearance or browser disclosure carries over to. */
export async function privateValuesGivenAwayInHtml(
  html: string,
  title: string,
): Promise<readonly PrivateValueReference[]> {
  if (!(await getDb().hasTable('gws_ea_private_values'))) return [];
  return privateValuesInReadings([...htmlReadings(html), ...readingsOf([title])]);
}

async function privateValuesInReadings(readings: readonly TextStream[]): Promise<readonly PrivateValueReference[]> {
  return (await listPrivateValues())
    .filter((value) => {
      const compiled = compilePrivateValue(value.kind, value.value);
      return readings.some((reading) => givesAway(compiled, reading));
    })
    .map(({ id, kind }) => ({ id, kind }));
}
