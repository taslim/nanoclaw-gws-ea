/**
 * The probe that verifies the assistant's web alias (KTD13). gws-ea asks the
 * operator to add the alias in the Google Admin console, then the host sends
 * one bland, self-explaining email from the assistant to it, carrying a
 * nonce in its Message-ID and its text, and reads Gmail back:
 *
 * - a copy carrying the probe's Message-ID with a group's `List-Id` or
 *   `X-Google-Group-Id` means the address is a Google Group: refused;
 * - otherwise a copy of it in INBOX means it arrived, and the alias is
 *   recorded, only while it is still the candidate the probe was sent to;
 * - a delivery-failure notice quoting the nonce means it bounced: the
 *   address is not added yet;
 * - nothing yet means not yet: Google can take up to 24 hours to start
 *   delivering to a new alias.
 *
 * Gmail does not document how it labels mail a user sends to their own
 * alias; the first live alias setup confirms which labels the arriving
 * probe carries. The probe's copies come from the assistant, and its bounce
 * is automated, so the inbox's own routing never hands either to an agent.
 */
import { randomBytes } from 'node:crypto';

import { getAliasSetup, recordAliasProbe, recordVerifiedAlias } from '../gws-ea-profile/db.js';
import { escapeMarkdownInline } from '../gws-ea-profile/markdown.js';
import type { GmailApi, GmailMessage } from './gmail-api.js';
import { buildMime, domainOf, encodeRaw, headerValue, parseAddressList } from './mime.js';
import { renderEmail } from './render.js';
import type { InboxRuntime } from './runtime.js';
import { assistantMailbox, carriesMessageId } from './send.js';

/**
 * Where an alias's verification stands after one probe or read-back:
 * `verified` once recorded; `bounced`, `group` or `not_yet` from the read-back;
 * `not_sent` when no probe was sent to the candidate yet; `superseded` when
 * the address is no longer the candidate, so nothing was sent or recorded.
 */
export type AliasProbeOutcome = 'verified' | 'bounced' | 'group' | 'not_yet' | 'not_sent' | 'superseded';

export interface AliasProbeResult {
  readonly outcome: AliasProbeOutcome;
  /** The alias the profile holds, once one is verified. */
  readonly alias: string | null;
}

/** The copies and notices read back for one probe. */
const READ_BACK_LIMIT = 10;
const PROBE_ID = /^<alias-check\.([0-9a-f]{32})@[^<>\s]+>$/u;

/** The probe's words: who it is from and why, and that whoever else it reaches may delete it. */
function probeMarkdown(address: string, assistantName: string, nonce: string): string {
  return [
    `This automatic message checks that ${address} delivers to ${assistantName}'s mailbox. It was sent while that address was being set up.`,
    'If it reached you instead, the address is not set up yet, and you can delete it. No reply is needed.',
    `Check reference: ${nonce}\n${escapeMarkdownInline(assistantName)}`,
  ].join('\n\n');
}

/** Send a new probe to `candidate`, recorded as its probe before Gmail takes it, so a read-back always finds it. */
async function sendProbe(runtime: InboxRuntime, candidate: string): Promise<boolean> {
  const from = await assistantMailbox(runtime);
  const nonce = randomBytes(16).toString('hex');
  const messageId = `<alias-check.${nonce}@${domainOf(from.address)}>`;
  if (!(await recordAliasProbe(candidate, messageId))) return false;
  const name = from.displayName ?? from.address;
  const body = renderEmail({ markdown: probeMarkdown(candidate, name, nonce) });
  const raw = encodeRaw(
    buildMime({
      from,
      to: [candidate],
      cc: [],
      bcc: [],
      subject: 'Address check',
      messageId,
      references: [],
      text: body.text,
      html: body.html,
      date: runtime.now(),
    }),
  );
  await runtime.gmail.send({ raw });
  return true;
}

/** A delivery-failure notice: from a mail system, a delivery report, or naming failed recipients. */
function isDeliveryFailure(message: GmailMessage): boolean {
  const headers = message.payload?.headers ?? [];
  const sender = parseAddressList(headerValue(headers, 'From') ?? '')?.[0]?.address ?? '';
  const local = sender.slice(0, sender.lastIndexOf('@'));
  return (
    local === 'mailer-daemon' ||
    local === 'postmaster' ||
    headerValue(headers, 'X-Failed-Recipients') !== undefined ||
    /^\s*multipart\/report\b[^]*\breport-type\s*=\s*"?delivery-status/iu.test(
      headerValue(headers, 'Content-Type') ?? '',
    )
  );
}

/** What Gmail holds of probe `messageId`: its copies by Message-ID, and anything quoting its nonce. */
async function readBack(gmail: GmailApi, messageId: string): Promise<'arrived' | 'bounced' | 'group' | 'not_yet'> {
  const nonce = PROBE_ID.exec(messageId)?.[1];
  if (nonce === undefined) throw new Error(`Not an alias probe's Message-ID: ${messageId}`);
  const found = [
    ...(await gmail.listMessages({
      q: `rfc822msgid:${messageId.slice(1, -1)}`,
      includeSpamTrash: true,
      maxResults: READ_BACK_LIMIT,
    })),
    ...(await gmail.listMessages({ q: `"${nonce}"`, includeSpamTrash: true, maxResults: READ_BACK_LIMIT })),
  ];
  let arrived = false;
  let bounced = false;
  for (const id of new Set(found.map((ref) => ref.id))) {
    const message = await gmail.getMessage(id, 'full');
    if (message === undefined) continue;
    const headers = message.payload?.headers ?? [];
    if (carriesMessageId(headers, messageId)) {
      if (headerValue(headers, 'List-Id') !== undefined || headerValue(headers, 'X-Google-Group-Id') !== undefined) {
        return 'group';
      }
      if (message.labelIds?.includes('INBOX')) arrived = true;
    } else if (isDeliveryFailure(message)) {
      bounced = true;
    }
  }
  return arrived ? 'arrived' : bounced ? 'bounced' : 'not_yet';
}

/**
 * Probe `address`, the candidate gws-ea expects: with `send`, a new probe
 * first; then one read-back of the latest. An arrival records the alias by
 * compare-and-set against the candidate and that probe.
 */
export async function probeAlias(
  runtime: InboxRuntime,
  input: { readonly address: string; readonly send: boolean },
): Promise<AliasProbeResult> {
  const address = input.address.trim().toLowerCase();
  const before = await getAliasSetup();
  if (before.alias !== null) {
    return { outcome: before.alias === address ? 'verified' : 'superseded', alias: before.alias };
  }
  if (before.candidate !== address) return { outcome: 'superseded', alias: null };
  if (input.send && !(await sendProbe(runtime, address))) return { outcome: 'superseded', alias: null };
  const { probe_message_id: messageId } = await getAliasSetup();
  if (messageId === null) return { outcome: 'not_sent', alias: null };
  const seen = await readBack(runtime.gmail, messageId);
  if (seen !== 'arrived') return { outcome: seen, alias: null };
  if (await recordVerifiedAlias(address, messageId)) return { outcome: 'verified', alias: address };
  const after = await getAliasSetup();
  return after.alias === address ? { outcome: 'verified', alias: address } : { outcome: 'superseded', alias: null };
}
