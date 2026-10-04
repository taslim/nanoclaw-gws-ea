/**
 * Email that reads like a person's (R61, KTD6). The agent writes markdown and
 * a closing; the email carries it as minimal HTML and as the plain text it was
 * written in, signed once by the host, with a reply's quote below the way
 * Gmail quotes.
 *
 * The HTML is micromark's, with GFM and with raw HTML escaped, inside one
 * `<div dir="ltr">`. A line break the writer made inside a paragraph stays a
 * line break, as in any mail client, so "Best,\nJuno" reads as two lines.
 * The output is then narrowed: an image gives way to its words, and a link
 * whose target is not http(s) or mailto keeps only its words. With raw HTML
 * escaped, every tag in micromark's output is one micromark wrote, in a fixed
 * shape, so the narrowing reads that shape directly.
 *
 * The signature is the host's: a `-- ` line and two lines in text, the two
 * lines alone in HTML. It comes before the quote, as Gmail places it.
 */
import { compile, parse, postprocess, preprocess } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';

import { TIMEZONE } from '../../config.js';
import { formatLocalTime } from '../../timezone.js';
import type { GwsEaProfile } from '../gws-ea-profile/db.js';
import { oneLine, type Mailbox } from './mime.js';

/** The message a reply answers, as its readers received it. */
export interface QuotedMessage {
  readonly from: Mailbox;
  readonly sentAt: Date;
  /** Its readable text, its own quotes included. */
  readonly text: string;
}

export interface EmailContent {
  /** What the agent wrote, in markdown, its closing included. */
  readonly markdown: string;
  /** The lines `emailSignature` gives. */
  readonly signature: readonly string[];
  /** The message a reply answers, quoted below it. */
  readonly quote?: QuotedMessage;
}

/** An email's body, as both parts of `multipart/alternative` carry it. */
export interface RenderedEmail {
  readonly text: string;
  readonly html: string;
}

/** Gmail's own quote style: the one style attribute the HTML carries. */
const QUOTE_STYLE = 'margin:0 0 0 .8ex;border-left:1px #ccc solid;padding-left:1ex';
const IMAGE = /<img src="[^"]*" alt="([^"]*)"[^>]*>/gu;
const LINK = /<a href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gu;
const LINK_TARGET = /^(?:https?|mailto):/iu;

type MarkdownEvent = ReturnType<typeof postprocess>[number];

/** The assistant's signature: its name, then whose assistant it is. */
export function emailSignature(
  profile: Pick<GwsEaProfile, 'assistant_display_name' | 'principal_display_name'>,
): readonly string[] {
  const { assistant_display_name: assistant, principal_display_name: principal } = profile;
  if (!assistant || !principal) throw new Error("The signature needs the assistant's and the principal's names");
  return [assistant, `Assistant to ${principal}`];
}

function escapeHtml(text: string): string {
  return text.replace(/[&<>"]/gu, (character) =>
    character === '&' ? '&amp;' : character === '<' ? '&lt;' : character === '>' ? '&gt;' : '&quot;',
  );
}

/** Every line ending inside a paragraph, outside code, as a hard break unless it already is one. */
function withLineBreaks(events: readonly MarkdownEvent[]): MarkdownEvent[] {
  const out: MarkdownEvent[] = [];
  let paragraphs = 0;
  let codeSpans = 0;
  for (const event of events) {
    const [kind, token, context] = event;
    const step = kind === 'enter' ? 1 : -1;
    if (token.type === 'paragraph') paragraphs += step;
    else if (token.type === 'codeText') codeSpans += step;
    else if (kind === 'enter' && token.type === 'lineEnding' && paragraphs > 0 && codeSpans === 0) {
      const previous = out[out.length - 1]?.[1].type;
      if (previous !== 'hardBreakEscape' && previous !== 'hardBreakTrailing') {
        const hardBreak: MarkdownEvent[1] = { type: 'hardBreakTrailing', start: token.start, end: token.start };
        out.push(['enter', hardBreak, context], ['exit', hardBreak, context]);
      }
    }
    out.push(event);
  }
  return out;
}

function markdownHtml(markdown: string): string {
  const events = postprocess(
    parse({ extensions: [gfm()] })
      .document()
      .write(preprocess()(markdown, undefined, true)),
  );
  return compile({ htmlExtensions: [gfmHtml()] })(withLineBreaks(events))
    .replace(IMAGE, '$1')
    .replace(LINK, (_link, href: string, words: string) =>
      LINK_TARGET.test(href) ? `<a href="${href}">${words}</a>` : words,
    );
}

/** Someone else's text as it can be quoted: no control character but line breaks and tabs, no trailing blanks. */
function quotedLines(text: string): string[] {
  return Array.from(text.replace(/\r\n?/gu, '\n'), (character) => {
    const code = character.codePointAt(0) ?? 0;
    return character !== '\n' && character !== '\t' && (code <= 0x1f || code === 0x7f) ? ' ' : character;
  })
    .join('')
    .trim()
    .split('\n')
    .map((line) => line.trimEnd());
}

function attribution(quote: QuotedMessage): string {
  const name = quote.from.displayName === undefined ? '' : oneLine(quote.from.displayName);
  const writer = name === '' ? quote.from.address : `${name} <${quote.from.address}>`;
  return `On ${formatLocalTime(quote.sentAt.toISOString(), TIMEZONE)}, ${writer} wrote:`;
}

/** The email's text and HTML: the body, the signature, and a reply's quote. */
export function renderEmail(content: EmailContent): RenderedEmail {
  const markdown = content.markdown.replace(/\r\n?/gu, '\n').trim();
  const text = [markdown, '', '-- ', ...content.signature];
  let html = `<div dir="ltr">\n${markdownHtml(markdown)}\n<p>${content.signature.map(escapeHtml).join('<br>')}</p>\n</div>`;
  if (content.quote !== undefined) {
    const said = attribution(content.quote);
    const lines = quotedLines(content.quote.text);
    text.push('', said, '', ...lines.map((line) => (line === '' ? '>' : `> ${line}`)));
    html +=
      `\n<br>\n<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(said)}<br></div>` +
      `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${lines.map(escapeHtml).join('<br>\n')}</blockquote></div>`;
  }
  return { text: text.join('\n'), html };
}
