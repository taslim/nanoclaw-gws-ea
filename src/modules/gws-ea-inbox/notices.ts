/**
 * The inbox's plain sentences to the principal. Each goes once, through
 * gws-ea-notices, to the principal's direct message only.
 */
import { sendPrincipalNotice } from '../gws-ea-notices/index.js';

const SET_ASIDE_NOTICE = "I couldn't process an email in my inbox, so I set it aside and kept going with the rest.";

const UNHEALTHY_NOTICE = "I can't reach my email inbox right now, so new email waits until it's back.";

/** One notice for however many messages one pass set aside. */
export async function noticeSetAside(): Promise<void> {
  await sendPrincipalNotice(SET_ASIDE_NOTICE, 'inbox-set-aside');
}

/** Once per unhealthy spell. */
export async function noticeUnhealthy(): Promise<void> {
  await sendPrincipalNotice(UNHEALTHY_NOTICE, 'inbox-unhealthy');
}
