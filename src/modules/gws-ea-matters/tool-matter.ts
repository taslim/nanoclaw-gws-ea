/**
 * The matter a tool's request names (KTD11): `main` names one of its open
 * matters, and what the tool writes joins it. `create_event` and
 * `change_guests` link their event, and `email_handoff` its thread.
 *
 * The matter is checked before the tool writes anything, so a refusal writes
 * nothing; what the tool wrote stands whether or not it then joins. Matters
 * are main's alone (R8), so a request from any other group that names one is
 * refused.
 */
import { forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { log } from '../../log.js';
import type { Session } from '../../types.js';
import { getMainAgentGroupId } from '../gws-ea-profile/db.js';
import { getMatter, placeInMatter, type LinkRef } from './db.js';

const MATTER_ID = /^m-[0-9a-f]{12}$/u;

/** The open matter a request's `matter` names, or undefined when it names none. */
export async function requestedMatter(value: unknown, session: Session): Promise<string | undefined> {
  if (value === undefined || value === null) return undefined;
  if (session.agent_group_id !== (await getMainAgentGroupId())) {
    throw forbidden('Only main keeps matters, so only main names one.');
  }
  const id = typeof value === 'string' ? value.trim() : '';
  if (!MATTER_ID.test(id)) throw invalidArgs('matter must be the id of an open matter, such as m-1a2b3c4d5e6f');
  const matter = await getMatter(id);
  if (matter === undefined) {
    throw invalidArgs(`There is no matter ${id}: name an open one by its id, as ncl matters list gives it.`);
  }
  if (!matter.open) throw forbidden(`${id} is closed: a next look reopens it before anything joins it.`);
  return matter.id;
}

/**
 * `piece`, which the tool wrote, joins the matter its request named: the
 * sentence the tool's answer ends with, saying so, or why it did not.
 */
export async function joinRequestedMatter(matterId: string, piece: LinkRef): Promise<string> {
  /* eslint-disable no-catch-all/no-catch-all -- what the tool wrote stands; its answer says it did not join, never that the write failed */
  try {
    await placeInMatter(matterId, [piece]);
    return `It joins matter ${matterId}.`;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn('What a tool wrote did not join the matter its request named', { matterId, piece, reason });
    return `It did not join matter ${matterId}: ${reason}.`;
  }
  /* eslint-enable no-catch-all/no-catch-all */
}
