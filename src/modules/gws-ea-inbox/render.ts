/**
 * Email that reads like a person's (R61, KTD6). The agent writes markdown and
 * a closing; the email carries it as minimal HTML and as plain text, signed
 * once by the host, with a reply's quote below the way Gmail quotes.
 *
 * The HTML is micromark's, with GFM and with raw HTML escaped, inside one
 * `<div dir="ltr">`. A line break the writer made inside a paragraph stays a
 * line break, as in any mail client, so "Best,\nJuno" reads as two lines.
 * The output is then narrowed: an image gives way to its words, and a link
 * whose target is not http(s) or mailto keeps only its words. With raw HTML
 * escaped, every tag in micromark's output is one micromark wrote, in a fixed
 * shape, so the narrowing reads that shape directly.
 *
 * The plain text is read from the same markdown, parsed the same way into
 * its syntax tree (mdast), so it says what the HTML says, as a person types
 * an email: emphasis and code without their markers, a heading as its line,
 * a link as "words (address)" for the links the HTML keeps, a list with "- "
 * or "1. " bullets, a quote with "> ", and every paragraph and line break
 * where the writer put it.
 *
 * The signature is the host's: a `-- ` line and two lines in text, the two
 * lines alone in HTML. It comes before the quote, as Gmail places it.
 */
import type { FootnoteDefinition, Nodes, RootContent } from 'mdast';
import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import { compile, parse, postprocess, preprocess } from 'micromark';
import { gfm, gfmHtml } from 'micromark-extension-gfm';
import { normalizeUri } from 'micromark-util-sanitize-uri';

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

// ---------------------------------------------------------------------------
// The plain-text part
// ---------------------------------------------------------------------------

/** A link as words and address, or the address alone when the words are the address, with or without its scheme. */
function linkText(words: string, url: string): string {
  if (!LINK_TARGET.test(url)) return words;
  // The address as the HTML part links it, its percent-escapes undone where they can be.
  let address = normalizeUri(url);
  try {
    address = decodeURI(address);
  } catch (error) {
    if (!(error instanceof URIError)) throw error;
  }
  if (words === '' || words === address) return address;
  return words === address.replace(/^(?:mailto:|https?:\/\/)/iu, '') ? words : `${words} (${address})`;
}

/** Every line after the first, indented under a list item's bullet. */
function indented(text: string, width: number): string {
  return text.replace(/\n(?=.)/gu, `\n${' '.repeat(width)}`);
}

/**
 * The markdown as plain text, as a person types the same email, from the
 * same parse as the HTML part: what each node shows, its markers dropped.
 */
function plainText(markdown: string): string {
  const tree = fromMarkdown(markdown, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });
  // Every definition, wherever written, the first of a name counting; and every footnote call, in the
  // document's order, as micromark numbers them, a call written inside a footnote's own text included.
  const links = new Map<string, string>();
  const notes = new Map<string, FootnoteDefinition>();
  const calls = new Map<string, number>();
  const read = (node: Nodes): void => {
    if (node.type === 'definition' && !links.has(node.identifier)) links.set(node.identifier, node.url);
    if (node.type === 'footnoteDefinition' && !notes.has(node.identifier)) notes.set(node.identifier, node);
    if (node.type === 'footnoteReference') calls.set(node.identifier, (calls.get(node.identifier) ?? 0) + 1);
    if ('children' in node) node.children.forEach(read);
  };
  read(tree);

  const inline = (node: Nodes): string => {
    switch (node.type) {
      case 'text':
      case 'html':
        return node.value;
      case 'inlineCode':
        return node.value.replace(/\n/gu, ' ');
      case 'break':
        return '\n';
      case 'image':
      case 'imageReference':
        return node.alt ?? '';
      case 'link':
        return linkText(node.children.map(inline).join(''), node.url);
      case 'linkReference':
        return linkText(node.children.map(inline).join(''), links.get(node.identifier) ?? '');
      case 'footnoteReference':
        return String([...calls.keys()].indexOf(node.identifier) + 1);
      default:
        return 'children' in node ? node.children.map(inline).join('') : '';
    }
  };

  const block = (node: RootContent): string => {
    switch (node.type) {
      case 'list': {
        // A loose list, its items written apart, keeps them apart.
        const apart = node.spread === true || node.children.some((item) => item.spread === true) ? '\n\n' : '\n';
        return node.children
          .map((item, index) => {
            const bullet = node.ordered === true ? `${(node.start ?? 1) + index}. ` : '- ';
            const check = item.checked === true ? '[x] ' : item.checked === false ? '[ ] ' : '';
            return bullet + indented(check + blocks(item.children).join(apart), bullet.length);
          })
          .join(apart);
      }
      case 'blockquote':
        return blocks(node.children)
          .join('\n\n')
          .split('\n')
          .map((line) => (line === '' ? '>' : `> ${line}`))
          .join('\n');
      case 'code':
        return node.value;
      case 'thematicBreak':
        return '---';
      case 'table': {
        // Every row has the header's columns, as in the HTML part: extra cells dropped, missing ones empty.
        const columns = node.children[0]?.children.length ?? 0;
        return node.children
          .map((row) => Array.from({ length: columns }, (_, column) => row.children[column]))
          .map((cells) => cells.map((cell) => (cell === undefined ? '' : inline(cell).trim())).join(' | '))
          .join('\n');
      }
      case 'definition':
      case 'footnoteDefinition':
        return '';
      default:
        return inline(node).trim();
    }
  };
  const blocks = (nodes: readonly RootContent[]): string[] => nodes.map(block).filter((text) => text !== '');

  const body = blocks(tree.children);
  const footnotes = [...calls].flatMap(([identifier, called], index) => {
    const note = notes.get(identifier);
    if (note === undefined) return [];
    const back = Array.from({ length: called }, (_, call) => (call === 0 ? '↩' : `↩${call + 1}`)).join(' ');
    const said = blocks(note.children);
    const bullet = `${index + 1}. `;
    return [
      bullet + indented([...said.slice(0, -1), `${said.at(-1) ?? ''} ${back}`.trim()].join('\n\n'), bullet.length),
    ];
  });
  return [...body, ...(footnotes.length === 0 ? [] : ['Footnotes', footnotes.join('\n\n')])].join('\n\n');
}

// ---------------------------------------------------------------------------
// The email
// ---------------------------------------------------------------------------

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

/** The line above a quote: who wrote it, and when, in the install timezone. */
export function quotedBy(quote: QuotedMessage): string {
  const name = quote.from.displayName === undefined ? '' : oneLine(quote.from.displayName);
  const writer = name === '' ? quote.from.address : `${name} <${quote.from.address}>`;
  return `On ${formatLocalTime(quote.sentAt.toISOString(), TIMEZONE)}, ${writer} wrote:`;
}

/** The email's text and HTML: the body, the signature, and a reply's quote. */
export function renderEmail(content: EmailContent): RenderedEmail {
  const markdown = content.markdown.replace(/\r\n?/gu, '\n').trim();
  const body = markdownHtml(markdown);
  const text = [plainText(markdown), '', '-- ', ...content.signature];
  let html = `<div dir="ltr">\n${body}\n<p>${content.signature.map(escapeHtml).join('<br>')}</p>\n</div>`;
  if (content.quote !== undefined) {
    const said = quotedBy(content.quote);
    const lines = quotedLines(content.quote.text);
    text.push('', said, '', ...lines.map((line) => (line === '' ? '>' : `> ${line}`)));
    html +=
      `\n<br>\n<div class="gmail_quote"><div dir="ltr" class="gmail_attr">${escapeHtml(said)}<br></div>` +
      `<blockquote class="gmail_quote" style="${QUOTE_STYLE}">${lines.map(escapeHtml).join('<br>\n')}</blockquote></div>`;
  }
  return { text: text.join('\n'), html };
}
