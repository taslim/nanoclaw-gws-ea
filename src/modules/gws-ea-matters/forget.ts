/**
 * Forgetting a person across matters. The people store runs this module's
 * review, then its hook, before it deletes the person:
 *
 * - The review puts to main every matter, open or closed, that links the
 *   person or a thread, chat, event or file they were on, or whose title, open
 *   loop or outcome may name them: a matter's words are main's, and only main
 *   rewrites them. It reads before any hook purges, while the inbox still holds
 *   the person's addresses on its threads. Only Google knows who is on an event
 *   or a file, so those are read live.
 * - The hook takes the person off every matter and clears the account on
 *   each thread of a matter that linked them; the inbox clears those on the
 *   threads they were on, and the chat module those on chats whose roster
 *   holds them. A matter left with nothing but memory files was kept only for
 *   them: it is deleted, and its look cancelled. A strand kept only for them
 *   goes with it, and a project one of whose strands stays is kept. Such a
 *   matter links no thread, so it leaves no thread account behind.
 *
 * Both repeat safely: once the hook has run, no matter links the person, and
 * running it again, as the forget after a snapshot restore may, changes
 * nothing. A render never names a forgotten person (`live.ts`).
 */
import { getDb } from '../../db/connection.js';
import { identityMatchKey } from '../../gws-ea/validation.js';
import { log } from '../../log.js';
import { clearThreadAccounts, threadsWithAddresses } from '../gws-ea-inbox/thread-map.js';
import { mayNamePerson, type ForgottenPerson, type PersonToForget } from '../gws-ea-people/db.js';
import { linkKey, type LinkRef } from './db.js';
import { isEventOrFile, linksOn } from './live.js';
import { cancelTaskSeries, oneAtATime } from './looks.js';
import { chatsWithPerson } from './chat-links.js';

/** A matter kept only for the person, with what deleting it takes along. */
interface KeptOnlyFor {
  readonly id: string;
  readonly parent_id: string | null;
  readonly look_task_id: string | null;
}

/** Whether an address a source shows is one of the person's, in any spelling that reaches the same mailbox. */
function addressOf(handles: readonly string[]): (address: string) => boolean {
  const theirs = new Set(
    handles.filter((handle) => handle.toLowerCase().startsWith('email:')).map((handle) => identityMatchKey(handle)),
  );
  return (address) => theirs.has(identityMatchKey(`email:${address}`));
}

/**
 * The matters kept only for the person: each links them and nothing else but
 * memory files. A project one of whose strands is not among them stays, so
 * no strand loses its project; strands go one level deep, so one pass
 * decides.
 */
async function keptOnlyFor(personId: string): Promise<KeptOnlyFor[]> {
  const db = getDb();
  const matters = await db.all<KeptOnlyFor>(
    `SELECT m.id, m.parent_id, m.look_task_id
       FROM gws_ea_matters m
       JOIN gws_ea_matter_links mine ON mine.matter_id = m.id AND mine.kind = 'person' AND mine.reference = ?
      WHERE NOT EXISTS (
        SELECT 1 FROM gws_ea_matter_links other
         WHERE other.matter_id = m.id AND other.kind <> 'memory'
           AND NOT (other.kind = 'person' AND other.reference = ?))`,
    personId,
    personId,
  );
  const going = new Set(matters.map((matter) => matter.id));
  const strands = await db.all<{ readonly id: string; readonly parent_id: string }>(
    'SELECT id, parent_id FROM gws_ea_matters WHERE parent_id IS NOT NULL',
  );
  return matters.filter((matter) => strands.every((strand) => strand.parent_id !== matter.id || going.has(strand.id)));
}

/**
 * Every matter, open or closed, that may still tell of the person once the
 * hook has run, oldest first, each as `matter <id>`, for main to rewrite.
 */
export async function mattersToRewrite(person: PersonToForget): Promise<string[]> {
  const db = getDb();
  const going = new Set((await keptOnlyFor(person.id)).map((matter) => matter.id));
  const isTheirs = addressOf(person.handles);
  const theirThreads = new Set((await threadsWithAddresses(isTheirs)).threadKeys);
  const theirChats = await chatsWithPerson(person);
  const links = await db.all<LinkRef & { readonly matter_id: string }>(
    'SELECT matter_id, kind, reference FROM gws_ea_matter_links',
  );
  const matters = await db.all<{
    readonly id: string;
    readonly title: string;
    readonly open_loop: string;
    readonly outcome: string | null;
    readonly place: string | null;
  }>('SELECT id, title, open_loop, outcome, place FROM gws_ea_matters ORDER BY created_at, id');

  const named = new Set<string>();
  for (const link of links) {
    const theirs =
      (link.kind === 'person' && link.reference === person.id) ||
      (link.kind === 'thread' && theirThreads.has(link.reference)) ||
      (link.kind === 'chat' && theirChats.has(link.reference));
    if (theirs) named.add(link.matter_id);
  }
  for (const matter of matters) {
    if (
      [matter.title, matter.open_loop, matter.outcome, matter.place].some(
        (text) => text !== null && mayNamePerson(person, text),
      )
    ) {
      named.add(matter.id);
    }
  }
  // The events and files of the matters not named yet, each read once however many matters link it.
  const unsure = links.filter((link) => !named.has(link.matter_id)).filter(isEventOrFile);
  const pieces = new Map(unsure.map((link) => [linkKey(link.kind, link.reference), link]));
  const on = new Set((await linksOn([...pieces.values()], isTheirs)).map((link) => linkKey(link.kind, link.reference)));
  for (const link of unsure) if (on.has(linkKey(link.kind, link.reference))) named.add(link.matter_id);

  return matters
    .filter((matter) => named.has(matter.id) && !going.has(matter.id))
    .map((matter) => `matter ${matter.id}`);
}

export function forgetFromMatters(person: ForgottenPerson): Promise<void> {
  return oneAtATime(async () => {
    const db = getDb();
    const looks = await db.transaction(async () => {
      const going = await keptOnlyFor(person.id);
      const goingIds = new Set(going.map((matter) => matter.id));
      const linking = await db.all<{ readonly matter_id: string }>(
        "SELECT matter_id FROM gws_ea_matter_links WHERE kind = 'person' AND reference = ?",
        person.id,
      );
      const threads = await db.all<{ readonly reference: string }>(
        `SELECT DISTINCT reference FROM gws_ea_matter_links
          WHERE kind = 'thread'
            AND matter_id IN (SELECT matter_id FROM gws_ea_matter_links WHERE kind = 'person' AND reference = ?)`,
        person.id,
      );
      await clearThreadAccounts(threads.map((thread) => thread.reference));
      await db.run("DELETE FROM gws_ea_matter_links WHERE kind = 'person' AND reference = ?", person.id);
      const now = new Date().toISOString();
      for (const { matter_id } of linking) {
        if (!goingIds.has(matter_id))
          await db.run('UPDATE gws_ea_matters SET updated_at = ? WHERE id = ?', now, matter_id);
      }
      const strandsFirst = [...going].sort((a, b) => Number(a.parent_id === null) - Number(b.parent_id === null));
      for (const matter of strandsFirst) await db.run('DELETE FROM gws_ea_matters WHERE id = ?', matter.id);
      return going.flatMap((matter) => (matter.look_task_id === null ? [] : [matter.look_task_id]));
    });
    for (const taskId of looks) {
      /* eslint-disable no-catch-all/no-catch-all -- a look whose matter is gone wakes nothing, and the host's next pass cancels it */
      try {
        await cancelTaskSeries(taskId);
      } catch (error) {
        log.warn("A forgotten person's matter is deleted; the host's next pass cancels its look", {
          taskId,
          err: error,
        });
      }
      /* eslint-enable no-catch-all/no-catch-all */
    }
  });
}
