/**
 * Every GWS-EA answer that pairs a `message` with other fields is reviewed
 * (KTD9): an agent reads a tool answer's `message` alone, so data it needs
 * must be rendered there, unless the fields beyond it are for the host's own
 * callers or the whole object is the agent's text. A new answer, or a new
 * field on one, fails here until it is reviewed and listed.
 *
 * Found statically, with the TypeScript compiler, across the non-test,
 * non-fixture sources under `src/modules/gws-ea-*`.
 */
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
import { describe, expect, it } from 'vitest';

const MODULES = path.resolve(import.meta.dirname);

type Review =
  /** The fields' data is written into `message` in words. */
  | { readonly kind: 'rendered'; readonly reason: string }
  /** The fields serve host code, or echo the agent's own input; `message` says all the agent needs. */
  | { readonly kind: 'host-only'; readonly reason: string }
  /** The whole object is the agent's text (a notice's JSON), so every field reaches it. */
  | { readonly kind: 'read-whole'; readonly reason: string };

/**
 * Each answer by `<file> <enclosing name>: <other fields>`, its file under
 * `src/modules`, its other fields sorted, a spread written `...name`.
 */
const REVIEWED: Readonly<Record<string, Review>> = {
  'gws-ea-browser/authority.ts notifyPurchaseWaiters: job, site, type': {
    kind: 'read-whole',
    reason: 'a browser notice: its JSON is the chat text the browser reads',
  },
  'gws-ea-browser/consent-approval.ts notifyConsentOutcome: job, site, status, stop_id, type, wording': {
    kind: 'read-whole',
    reason: 'a browser notice: its JSON is the chat text the browser reads',
  },
  'gws-ea-browser/incidents.ts notifyIncident: kind': {
    kind: 'host-only',
    reason: 'the log line written while nobody can be told yet',
  },
  'gws-ea-browser/purchase-outcome.ts recordPurchaseOutcome: recorded, status, thread': {
    kind: 'rendered',
    reason:
      "the possible duplicate's alarm says what was recorded first and what to do (KTD15); the thread is the recorder's own input",
  },
  'gws-ea-browser/notices.ts notifyUnconfirmedPurchase: kind': {
    kind: 'host-only',
    reason: 'the log line written while nobody can be told yet',
  },
  'gws-ea-browser/purchase.ts checkoutChanging: reason, repeat_safe, status': {
    kind: 'rendered',
    reason: 'the change the host read is written into the sentence (U11)',
  },
  'gws-ea-browser/purchase.ts told: repeat_safe, safe_to_rebuild': {
    kind: 'read-whole',
    reason: 'spread into the purchase-outcome notice, whose JSON is the chat text the browser reads',
  },
  'gws-ea-browser/queue.ts wakeWaiters: job, type': {
    kind: 'read-whole',
    reason: 'a browser notice: its JSON is the chat text the browser reads',
  },
  'gws-ea-browser/queue.ts frame: ...(diagnostics && diagnostics.events.length ? { metadata: { diagnostics } } : {}), code':
    {
      kind: 'rendered',
      reason:
        'the runner appends the code and safe diagnostics as JSON to the refusal text when metadata exists; otherwise the code serves the host',
    },
  'gws-ea-browser/watches.ts termsOverBounds: exposure, max_total, reason, status': {
    kind: 'rendered',
    reason: 'the exposure, the maximum and the terms as the host read them are written into the sentence (U11)',
  },
  'gws-ea-chat/adapter.ts notification: eventTime, eventType, space, subscription, targetResource': {
    kind: 'host-only',
    reason: 'a Google Chat event for the Chat SDK; `message` is the Chat message, not an answer',
  },
  'gws-ea-chat/adapter.ts readMessageIn: space': {
    kind: 'host-only',
    reason: 'a Chat message and its space for the Chat SDK, not an answer',
  },
  'gws-ea-chat/adapter.ts dispatch: adapter, added, emoji, messageId, raw, rawEmoji, reactedAt, reactionName, threadId, user':
    { kind: 'host-only', reason: 'a reaction event for the Chat SDK, not an answer' },
  'gws-ea-chat/health.ts chatHealthError: at, kind': {
    kind: 'host-only',
    reason: "the Chat transport's health record for the operator",
  },
  'gws-ea-chat/hydrate.ts createChatHydrator: displayName, reaction, space': {
    kind: 'host-only',
    reason: "the hydrator's methods, one named message",
  },
  'gws-ea-chat/pubsub-pull.ts dispatch: event': {
    kind: 'host-only',
    reason: 'a pulled Pub/Sub message and its decoded event, not an answer',
  },
  'gws-ea-chat/subscription.ts error: code': {
    kind: 'host-only',
    reason: "Google's error status, read by host code",
  },
  'gws-ea-external-email/bridge.ts admit: bookingCalendar, context, files, matter, target': {
    kind: 'host-only',
    reason: "a handoff's parts on their way to external-email's inbound row, not an answer",
  },
  'gws-ea-external-email/bridge.ts handOver: thread_key': {
    kind: 'host-only',
    reason: 'the message already names the thread key',
  },
  'gws-ea-external-email/bridge.ts PRINCIPAL_SOURCES: main, written': {
    kind: 'host-only',
    reason: 'a table keyed by where an address came from, one source named message',
  },
  'gws-ea-inbox/gmail-api.ts labelsAdded: labelIds': {
    kind: 'host-only',
    reason: "a Gmail history entry read by host code; `message` is Gmail's message reference",
  },
  'gws-ea-inbox/outbound.ts toPrincipal: thread_key': {
    kind: 'host-only',
    reason: "the thread key is the agent's own input",
  },
  'gws-ea-inbox/outbound.ts inThread: thread_key': {
    kind: 'host-only',
    reason: "the thread key is the agent's own input",
  },
  'gws-ea-meetings/calendar-facts.ts findConflicts: conflicts, conflicts_not_listed': {
    kind: 'rendered',
    reason: 'one line per conflict in words, then how many more are not listed; the fields serve browser watches',
  },
  'gws-ea-meetings/calendar-facts.ts peopleStats: events, people, people_not_listed, since': {
    kind: 'rendered',
    reason: 'the summary line, then one line per person, then how many more are not listed',
  },
  'gws-ea-meetings/principal-events.ts createEvent: calendar, end, event, start': {
    kind: 'rendered',
    reason: 'the message names the calendar, the time and the event id main changes it by',
  },
  'gws-ea-meetings/principal-events.ts answered: calendar, event, guests': {
    kind: 'rendered',
    reason: 'the message names the guests and the event as Google now shows them',
  },
  'gws-ea-meetings/principal-events.ts answered: calendar, event, response': {
    kind: 'rendered',
    reason: "the message says the principal's answer as Google now shows it",
  },
  'gws-ea-meetings/tools.ts freeTime: windows, windows_not_listed': {
    kind: 'rendered',
    reason: 'one line per window, then how many later ones are not listed',
  },
  'gws-ea-meetings/tools.ts book: booking, end, start': {
    kind: 'rendered',
    reason: 'the message gives the time and the booking id',
  },
  'gws-ea-meetings/tools.ts changeBooking: booking, end, start': {
    kind: 'rendered',
    reason: "the message gives the new time; the booking id is the agent's own input",
  },
  'gws-ea-meetings/tools.ts cancelBooking: booking': {
    kind: 'host-only',
    reason: "the booking id is the agent's own input",
  },
  'gws-ea-privacy/index.ts requestRemovalCard: id, status': {
    kind: 'host-only',
    reason: "the value id is main's own input, and the message words the status",
  },
  'gws-ea-profile/index.ts requestAddAddressCard: email, status': {
    kind: 'host-only',
    reason: "the address is main's own input, and the message words the status",
  },
  'gws-ea-profile/index.ts setPrincipalProfile: ...answer': {
    kind: 'host-only',
    reason: "the saved name and time zone are main's own input, and the message says what changed",
  },
};

/** The name a node sits under: its function, method, variable, or the property holding its function. */
function enclosingName(node: ts.Node): string {
  for (let at: ts.Node | undefined = node.parent; at !== undefined; at = at.parent) {
    if ((ts.isFunctionDeclaration(at) || ts.isMethodDeclaration(at)) && at.name !== undefined) return at.name.getText();
    if (ts.isVariableDeclaration(at) && ts.isIdentifier(at.name)) return at.name.text;
    if (
      ts.isPropertyAssignment(at) &&
      (ts.isArrowFunction(at.initializer) || ts.isFunctionExpression(at.initializer))
    ) {
      return at.name.getText();
    }
  }
  return '(module)';
}

/** Every object literal in `text` that pairs `message` with other fields, by its review key. */
function answersIn(file: string, text: string): string[] {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      const fields = node.properties.map((property) =>
        ts.isSpreadAssignment(property) ? `...${property.expression.getText()}` : (property.name?.getText() ?? '?'),
      );
      if (fields.includes('message') && fields.length > 1) {
        const others = fields.filter((field) => field !== 'message').sort();
        found.push(`${file} ${enclosingName(node)}: ${others.join(', ')}`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}

/** The non-test, non-fixture sources of every GWS-EA module, relative to `src/modules`. */
function moduleSources(): string[] {
  const sources: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(path.join(MODULES, dir), { withFileTypes: true })) {
      const relative = path.posix.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== 'testing') walk(relative);
      } else if (entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts') && !entry.name.includes('fixture')) {
        sources.push(relative);
      }
    }
  };
  for (const entry of fs.readdirSync(MODULES, { withFileTypes: true })) {
    if (entry.isDirectory() && entry.name.startsWith('gws-ea-')) walk(entry.name);
  }
  return sources;
}

/** The answers found that the review does not list. */
function unreviewed(found: readonly string[]): string[] {
  return found.filter((key) => !Object.hasOwn(REVIEWED, key));
}

describe('GWS-EA answers with a message and other fields', () => {
  const found = new Set(
    moduleSources().flatMap((file) => answersIn(file, fs.readFileSync(path.join(MODULES, file), 'utf8'))),
  );

  it('are each reviewed as rendered, host-only or read whole', () => {
    expect(unreviewed([...found])).toEqual([]);
  });

  it('lists no answer that no longer exists', () => {
    expect(Object.keys(REVIEWED).filter((key) => !found.has(key))).toEqual([]);
  });

  it('gives every review a reason', () => {
    for (const [key, review] of Object.entries(REVIEWED)) expect(review.reason.trim(), key).not.toBe('');
  });

  it('fails on a new answer that pairs message with a field the review does not list', () => {
    const text = `export function lookUp() {\n  return { message: 'Found it.', extra: 1 };\n}\n`;
    expect(unreviewed(answersIn('gws-ea-example/look-up.ts', text))).toEqual([
      'gws-ea-example/look-up.ts lookUp: extra',
    ]);
    const widened = `const freeTime = async () => ({ windows: [], windows_not_listed: 0, calendar: 'x', message: '' });`;
    expect(unreviewed(answersIn('gws-ea-meetings/tools.ts', widened))).toEqual([
      'gws-ea-meetings/tools.ts freeTime: calendar, windows, windows_not_listed',
    ]);
  });
});
