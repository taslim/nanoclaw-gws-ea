/**
 * Text other people wrote, marked as untrusted the way gog marks it
 * (`<<<EXTERNAL_UNTRUSTED_CONTENT …>>>`), which both agents' guidance tells
 * them to read as information and never as instructions. Any marker or model
 * control token inside the text is neutralized first, so it cannot close the
 * wrapper early.
 */
import { randomBytes } from 'node:crypto';

const SOURCE = 'gmail';
const MARKER = /<<<\s*(?:END[\s_]+)?EXTERNAL[\s_]+UNTRUSTED[\s_]+CONTENT(?:\s+[^>]*)?\s*>>>/giu;
const SPECIAL_TOKENS = [
  '<|im_start|>',
  '<|im_end|>',
  '<|endoftext|>',
  '<|begin_of_text|>',
  '<|end_of_text|>',
  '<|start_header_id|>',
  '<|end_header_id|>',
  '<|eot_id|>',
  '<|python_tag|>',
  '<|eom_id|>',
  '[INST]',
  '[/INST]',
  '<<SYS>>',
  '<</SYS>>',
];
const RESERVED_SPECIAL_TOKEN = /<\|reserved_special_token_\d+\|>/gu;

/** Control characters other than newline and tab become spaces. */
function withoutControls(text: string): string {
  return Array.from(text, (character) => {
    const code = character.codePointAt(0) ?? 0;
    return character !== '\n' && character !== '\t' && (code <= 0x1f || code === 0x7f) ? ' ' : character;
  }).join('');
}

function sanitize(text: string): string {
  let clean = text.replace(MARKER, (marker) =>
    /^<<<\s*END/iu.test(marker) ? '[[END_MARKER_SANITIZED]]' : '[[MARKER_SANITIZED]]',
  );
  for (const token of SPECIAL_TOKENS) clean = clean.split(token).join('[REMOVED_SPECIAL_TOKEN]');
  return withoutControls(clean.replace(RESERVED_SPECIAL_TOKEN, '[REMOVED_SPECIAL_TOKEN]'));
}

function cap(text: string, limit: number): string {
  const characters = Array.from(text);
  return characters.length <= limit
    ? text
    : `${characters
        .slice(0, limit - 1)
        .join('')
        .trimEnd()}…`;
}

/** `text`, capped at `limit` characters and wrapped in untrusted markers under a fresh id. */
export function untrusted(text: string, limit: number): string {
  const body = cap(sanitize(text.replace(/\r\n?/gu, '\n')).trim(), limit);
  const id = randomBytes(8).toString('hex');
  return `<<<EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>\nSource: ${SOURCE}\n---\n${body}\n<<<END_EXTERNAL_UNTRUSTED_CONTENT id="${id}">>>`;
}

/** One line of someone else's text (a name, a subject), wrapped the same way. */
export function untrustedLine(text: string, limit: number): string {
  return untrusted(text.replace(/\s+/gu, ' '), limit);
}
