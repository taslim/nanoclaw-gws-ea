/**
 * The link to one of the principal's own pages on the assistant's web address. Each page's host guard decides
 * which groups get its link; src/modules/gws-ea-web/page-link.ts decides which groups hold the tool.
 */
import { requestTool } from '../action-request.js';
import { registerTools } from './server.js';

export const principalPage = requestTool({
  name: 'principal_page',
  description:
    "Get the link to one of the principal's private pages on your web address. home lists their pages. logins holds their saved logins: they add or remove logins and change or reveal saved passwords there. connections holds the apps they connect you to, which they connect, reconnect, disconnect and delete there. Only main gets home and connections. available returns its url: send that exact link to the principal and no one else. operator_needed means web is not set up: tell the principal to ask their operator to finish setup. unavailable means web is enabled but cannot serve the page right now: tell the principal to try again later. Any answer may carry facts: what the page holds now, such as each app's status. Never ask for passwords, tokens or client secrets in chat. A group other than main takes the need and the link to main for the principal. Repeating is safe.",
  properties: {
    page: { type: 'string', enum: ['home', 'logins', 'connections'] },
  },
  required: ['page'],
  additionalProperties: false,
  repeatable: true,
  timeoutMs: 120_000,
});

registerTools([principalPage], 'gws-ea-principal-pages');
