/**
 * Pure classification helpers for inbound email.
 *
 * The route is `principal` only when every From/To/Cc participant is the
 * principal or the assistant. Any third party in the thread → `external`.
 * Per-message classification (no thread state); v1's ratchet was a workaround
 * for tracking what's already a function of the current message's headers.
 *
 * `isRelevantEmail` is a cheap noise filter to avoid waking an agent on
 * obvious newsletters / no-reply / marketing. Heuristic; not a security
 * boundary.
 */
export type EmailRoute = 'principal' | 'external';

export interface ParsedEmail {
  from: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
}

export function extractEmailAddress(header: string): string {
  const match = header.match(/<([^>]+)>/);
  return match ? match[1] : header;
}

export function extractAllParticipants(email: ParsedEmail): string[] {
  const addresses = new Set<string>();
  if (email.from) addresses.add(extractEmailAddress(email.from).toLowerCase());
  for (const raw of [email.to, email.cc]) {
    if (!raw) continue;
    for (const part of raw.split(',')) {
      const addr = extractEmailAddress(part.trim());
      if (addr) addresses.add(addr.toLowerCase());
    }
  }
  return [...addresses];
}

export function classifyEmailRoute(
  email: ParsedEmail,
  principalEmails: ReadonlySet<string>,
  assistantEmail: string,
): EmailRoute {
  const assistant = assistantEmail.toLowerCase();
  for (const addr of extractAllParticipants(email)) {
    if (addr === assistant) continue;
    if (principalEmails.has(addr)) continue;
    return 'external';
  }
  return 'principal';
}

const NOISE_PATTERNS = [
  'unsubscribe',
  'no-reply@',
  'noreply@',
  'notifications@',
  'newsletter',
  'marketing@',
  'promo',
  'donotreply',
  'account verification',
  'verify your email',
  'welcome to',
  'your receipt',
  'order confirmation',
  'shipping notification',
];

export function isRelevantEmail(
  email: ParsedEmail,
  principalEmails: ReadonlySet<string>,
  principalName: string,
): boolean {
  const fromLower = extractEmailAddress(email.from).toLowerCase();
  const subjectLower = email.subject.toLowerCase();
  const bodyLower = email.body.toLowerCase().slice(0, 3000);

  if (principalEmails.has(fromLower)) return true;

  const nameVariants = [principalName.toLowerCase(), ...principalName.toLowerCase().split(/\s+/), ...principalEmails];
  for (const name of nameVariants) {
    if (name && (subjectLower.includes(name) || bodyLower.includes(name))) return true;
  }

  const recipientsLower = `${email.to}, ${email.cc}`.toLowerCase();
  for (const addr of principalEmails) {
    if (recipientsLower.includes(addr)) return true;
  }

  for (const pattern of NOISE_PATTERNS) {
    if (fromLower.includes(pattern) || subjectLower.includes(pattern) || bodyLower.includes(pattern)) {
      return false;
    }
  }

  return true;
}
