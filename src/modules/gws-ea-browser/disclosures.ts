/**
 * Personal-data disclosures (KTD19; R25, R34). The principal's stored private values (a phone number, a date
 * of birth, a home address, as the privacy module holds them) and their email addresses go onto no website by
 * default. Main lets one errand give one site one stored value by recording a disclosure; its guidance keeps
 * disclosures to the sites the principal's own request names, never one a browser report brings up.
 *
 * A disclosure is keyed on the errand's browser job, the site's registrable domain and the value's id in the
 * privacy store. The job names the group that delegated the errand, so a disclosure serves that errand alone:
 * no other group's errand, nor a later errand of the same group, can use it. It names the value and never
 * copies it.
 *
 * Once a batch's refs are pinned, before any of its actions runs, the host reads everything it would give a
 * website: the text it types, the options it selects, the names of the files it uploads and the addresses it
 * opens, query and all. What goes into a field goes to the site of the field's own frame, so a cross-site frame
 * on a page (an ad, a chat widget, a newsletter popup) is a site of its own; a frame whose document has no web
 * address of its own (about:blank, srcdoc, data:) has no site, so nothing stored goes into it. What the batch
 * fills after opening an address counts against that address's site as well. An address goes to its own site.
 * Each site's share is read in order as one form's fields, so a value split across fields or an address's
 * parameters, or written another way, is found. A stored value on a site the errand has no disclosure for, or
 * one of the principal's addresses on any site, stops the batch with `personal_data` before anything is typed
 * or opened. The principal's addresses reach a site only through the host's own sign-in to their own account
 * from their login in 1Password (`fill_secret`), which no batch carries.
 */
import path from 'node:path';

import { answeredGuard, answeringAction, forbidden, invalidArgs } from '../../cli/delivery-action.js';
import { getDb } from '../../db/connection.js';
import type { DbDriver } from '../../db/driver.js';
import { registerDeliveryAction } from '../../delivery.js';
import type { Session } from '../../types.js';
import { loadPersonalData, privateValueReference } from '../gws-ea-privacy/index.js';
import { hasBrowserAccess } from './access.js';
import { browserDelegateGuard, resolveBrowserJob } from './cancel.js';
import { registrableSite } from './commit-classifier.js';
import type { BrowserAction } from './executor.js';
import type { BrowserRef, PinnedBrowserRef } from './observe.js';

// ---------------------------------------------------------------- main's disclosure

const DISCLOSURE_FIELDS: ReadonlySet<string> = new Set(['action', 'requestId', 'thread', 'site', 'value_id']);

/** A site as main names it, an address or a bare domain: its registrable domain, or undefined for no public site. */
function disclosureSite(named: string): string | undefined {
  const trimmed = named.trim();
  return registrableSite(/[/:]/u.test(trimmed) ? trimmed : `https://${trimmed}`);
}

/**
 * An agent with browser access records that one errand of its own may give one site one of the principal's
 * stored values, named by its id. None of the principal's addresses is ever disclosed (R34): a site gets the
 * assistant's web address. A repeat changes nothing.
 */
async function recordDisclosureRequest(
  content: Record<string, unknown>,
  session: Session,
): Promise<Record<string, unknown>> {
  if (!(await hasBrowserAccess(session.agent_group_id)))
    throw forbidden('Only an agent with browser access may disclose a private value to a site.');
  if (Object.keys(content).some((key) => !DISCLOSURE_FIELDS.has(key)))
    throw invalidArgs('Unknown record_disclosure field.');
  const { thread, site: named, value_id: valueId } = content;
  if (typeof thread !== 'string' || typeof named !== 'string' || typeof valueId !== 'string')
    throw invalidArgs('record_disclosure needs the job thread, the site and the id of one stored private value.');
  const site = disclosureSite(named);
  if (site === undefined) throw invalidArgs('The site must be a public website, given as its address or its domain.');
  const value = await privateValueReference(valueId);
  if (!value)
    throw invalidArgs(
      'No stored private value has that id: main reads the ids with `ncl private-values list`; another agent asks main.',
    );
  if (value.principalAddress)
    throw forbidden(
      "The principal's email addresses go onto a site only when the host signs them in to their own account: a site gets the assistant's web address instead.",
    );
  const db = getDb();
  return db.transaction(async () => {
    const job = await resolveBrowserJob(thread, undefined, session.agent_group_id);
    if (!job || job.cancelled) throw forbidden('No live browser job of yours exists for that thread.');
    await db.run(
      'INSERT INTO gws_ea_browser_disclosures(job_id,site,value_id,created_at) VALUES(?,?,?,?) ON CONFLICT(job_id,site,value_id) DO NOTHING',
      job.id,
      site,
      value.id,
      new Date().toISOString(),
    );
    return {
      status: 'recorded',
      thread: job.thread_id,
      site,
      value_id: value.id,
      kind: value.kind,
      label: value.label,
    };
  });
}

export function registerDisclosureDelivery(): void {
  registerDeliveryAction(
    'record_disclosure',
    answeringAction('record_disclosure', recordDisclosureRequest),
    answeredGuard(browserDelegateGuard),
  );
}

// ---------------------------------------------------------------- the check before a batch runs

/** What opening `url` gives its site: the address, and each parameter's value as the site reads it. */
export function addressFields(url: string): string[] {
  return URL.canParse(url) ? [url, ...new URL(url).searchParams.values()] : [url];
}

/** The pinned refs of a batch, by ref: the frame each field is in. */
export type FieldFrames = ReadonlyMap<string, Pick<PinnedBrowserRef, 'frame'>>;

/** What a batch gives each website, in order, keyed by the site's registrable domain. */
function siteShares(actions: readonly BrowserAction[], frames: FieldFrames): Map<string | undefined, string[]> {
  const shares = new Map<string | undefined, string[]>();
  // The site of the last address the batch opened, once it opened one.
  let opened: { readonly site: string | undefined } | undefined;
  const give = (to: string | undefined, fields: readonly string[]): void => {
    shares.set(to, [...(shares.get(to) ?? []), ...fields]);
  };
  const fill = (ref: BrowserRef, fields: readonly string[]): void => {
    const frame = frames.get(ref.ref)?.frame;
    const site = frame ? registrableSite(frame.url()) : undefined;
    give(site, fields);
    if (opened && opened.site !== site) give(opened.site, fields);
  };
  for (const action of actions) {
    switch (action.kind) {
      case 'navigate':
        opened = { site: registrableSite(action.url) };
        give(opened.site, addressFields(action.url));
        break;
      case 'type':
        fill(action, [action.text]);
        break;
      case 'select':
        fill(action, [action.value]);
        break;
      case 'form_input':
        // Each field by its own frame, in order: a form's fields in one frame read as one form.
        for (const field of action.fields) fill(field, [field.value]);
        break;
      case 'upload':
        fill(action, [path.basename(action.path)]);
        break;
      case 'observe':
      case 'screenshot':
      case 'click':
      case 'download':
      case 'key':
      case 'scroll':
      case 'wait_for':
        break;
      default: {
        const unreachable: never = action;
        throw new Error(`Unknown browser action: ${JSON.stringify(unreachable)}`);
      }
    }
  }
  return shares;
}

/**
 * `personal_data` when a batch whose refs `frames` pinned would give a website one of the principal's
 * addresses, or a stored value job `jobId` has no disclosure for on that site. Read through `db`, the job's
 * store; a batch that types, selects, uploads and opens nothing reads nothing.
 */
export async function personalDataStop(
  db: DbDriver,
  jobId: string,
  actions: readonly BrowserAction[],
  frames: FieldFrames,
): Promise<'personal_data' | undefined> {
  const shares = siteShares(actions, frames);
  if (shares.size === 0) return undefined;
  const data = await loadPersonalData(db);
  if (data.empty) return undefined;
  const readings = [...shares].map(([site, fields]) => ({ site, ...data.read(fields) }));
  if (readings.some((reading) => reading.principalAddress)) return 'personal_data';
  const given = readings.filter((reading) => reading.values.length > 0);
  if (given.length === 0) return undefined;
  const disclosed = new Set(
    (
      await db.all<{ site: string; value_id: string }>(
        'SELECT site, value_id FROM gws_ea_browser_disclosures WHERE job_id = ?',
        jobId,
      )
    ).map((row) => `${row.site} ${row.value_id}`),
  );
  return given.some(({ site, values }) =>
    values.some(({ id }) => site === undefined || !disclosed.has(`${site} ${id}`)),
  )
    ? 'personal_data'
    : undefined;
}
