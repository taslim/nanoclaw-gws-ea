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
 * The plain text is read from that same narrowed HTML, so it says exactly
 * what the HTML says, as a person types an email: emphasis and code without
 * their markers, a heading as its line, a link as "words (address)", a list
 * with "- " or "1. " bullets, a quote with "> ", and every paragraph and
 * line break where the writer put it.
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

// ---------------------------------------------------------------------------
// The plain-text part
// ---------------------------------------------------------------------------

/** A node of the narrowed HTML: words, or a tag micromark wrote with what it holds. */
type HtmlNode = string | HtmlElement;

interface HtmlElement {
  readonly tag: string;
  readonly attributes: string;
  readonly children: HtmlNode[];
}

/** Every tag micromark writes; none holds a `>`, since its attribute values are escaped. */
const TAG = /<(\/?)([a-z][a-z0-9]*)([^>]*)>/gu;
const VOID_TAGS: ReadonlySet<string> = new Set(['br', 'hr', 'img', 'input']);
const BLOCK_TAGS: ReadonlySet<string> = new Set([
  'blockquote',
  'div',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'hr',
  'li',
  'ol',
  'p',
  'pre',
  'section',
  'table',
  'tbody',
  'thead',
  'tr',
  'ul',
]);
/** The four characters micromark escapes in its output. */
const ESCAPED: Readonly<Record<string, string>> = { amp: '&', lt: '<', gt: '>', quot: '"' };

function unescapeHtml(text: string): string {
  return text.replace(/&(amp|lt|gt|quot);/gu, (entity, name: string) => ESCAPED[name] ?? entity);
}

/** micromark's HTML as a tree: its output is well formed, so each closing tag closes the latest one open. */
function parseHtml(html: string): HtmlNode[] {
  const root: HtmlElement = { tag: '', attributes: '', children: [] };
  const open: HtmlElement[] = [root];
  let at = 0;
  for (const match of html.matchAll(TAG)) {
    const current = open[open.length - 1] ?? root;
    if (match.index > at) current.children.push(unescapeHtml(html.slice(at, match.index)));
    at = match.index + match[0].length;
    const [, closing, tag = '', attributes = ''] = match;
    if (closing === '/') {
      if (open.length > 1) open.pop();
      continue;
    }
    const element: HtmlElement = { tag, attributes, children: [] };
    current.children.push(element);
    if (!VOID_TAGS.has(tag) && !attributes.endsWith('/')) open.push(element);
  }
  if (at < html.length) (open[open.length - 1] ?? root).children.push(unescapeHtml(html.slice(at)));
  return root.children;
}

function attribute(element: HtmlElement, name: string): string | undefined {
  const value = new RegExp(`\\s${name}="([^"]*)"`, 'u').exec(element.attributes)?.[1];
  return value === undefined ? undefined : unescapeHtml(value);
}

/** An address as a person reads it: percent-escapes undone where they can be. */
function readableAddress(href: string): string {
  try {
    return decodeURI(href);
  } catch (error) {
    if (error instanceof URIError) return href;
    throw error;
  }
}

/** A link as words and address, or the address alone when the words are the address, with or without its scheme. */
function linkText(words: string, href: string): string {
  const address = readableAddress(href);
  if (words === '' || words === address) return address;
  return words === address.replace(/^(?:mailto:|https?:\/\/)/iu, '') ? words : `${words} (${address})`;
}

/** Words as they read in a line: markers dropped, links spelled out. */
function inlineText(nodes: readonly HtmlNode[]): string {
  let text = '';
  let broke = false;
  for (const node of nodes) {
    if (typeof node === 'string') {
      // micromark writes a hard break's own line ending after it.
      text += broke && node.startsWith('\n') ? node.slice(1) : node;
      broke = false;
      continue;
    }
    broke = node.tag === 'br';
    if (node.tag === 'br') text += '\n';
    else if (node.tag === 'input') text += node.attributes.includes('checked') ? '[x]' : '[ ]';
    else if (node.tag === 'a') text += linkText(inlineText(node.children), attribute(node, 'href') ?? '');
    else text += inlineText(node.children);
  }
  return text;
}

function isBlock(node: HtmlNode): node is HtmlElement {
  return typeof node !== 'string' && BLOCK_TAGS.has(node.tag);
}

function elements(nodes: readonly HtmlNode[], tags: ReadonlySet<string>): HtmlElement[] {
  return nodes.filter((node): node is HtmlElement => typeof node !== 'string' && tags.has(node.tag));
}

/** Every line after the first, indented under a list item's bullet. */
function indented(text: string, width: number): string {
  return text.replace(/\n(?=.)/gu, `\n${' '.repeat(width)}`);
}

function listText(list: HtmlElement): string {
  const items = elements(list.children, new Set(['li']));
  // A loose list, its items written apart, keeps them apart.
  const loose = items.some((item) => elements(item.children, new Set(['p'])).length > 0);
  const first = Number(attribute(list, 'start') ?? '1');
  return items
    .map((item, index) => {
      const bullet = list.tag === 'ol' ? `${first + index}. ` : '- ';
      return bullet + indented(blocksOf(item.children).join(loose ? '\n\n' : '\n'), bullet.length);
    })
    .join(loose ? '\n\n' : '\n');
}

function blockText(element: HtmlElement): string {
  switch (element.tag) {
    case 'ul':
    case 'ol':
      return listText(element);
    case 'blockquote':
      return blocksOf(element.children)
        .join('\n\n')
        .split('\n')
        .map((line) => (line === '' ? '>' : `> ${line}`))
        .join('\n');
    case 'pre':
      return inlineText(element.children).replace(/\n$/u, '');
    case 'hr':
      return '---';
    case 'table':
    case 'thead':
    case 'tbody':
      return blocksOf(element.children).join('\n');
    case 'tr':
      return element.children
        .filter((cell): cell is HtmlElement => typeof cell !== 'string')
        .map((cell) => inlineText(cell.children).trim())
        .join(' | ');
    case 'li':
    case 'section':
    case 'div':
      return blocksOf(element.children).join('\n\n');
    default:
      return inlineText(element.children).trim();
  }
}

/** What a container holds, as blocks of text: each run of words between its blocks is one more. */
function blocksOf(nodes: readonly HtmlNode[]): string[] {
  const blocks: string[] = [];
  let words: HtmlNode[] = [];
  const endWords = (): void => {
    const text = inlineText(words).trim();
    if (text !== '') blocks.push(text);
    words = [];
  };
  for (const node of nodes) {
    if (!isBlock(node)) {
      words.push(node);
      continue;
    }
    endWords();
    const text = blockText(node);
    if (text !== '') blocks.push(text);
  }
  endWords();
  return blocks;
}

/** The narrowed HTML as plain text, as a person would type the same email. */
function plainText(html: string): string {
  return blocksOf(parseHtml(html)).join('\n\n');
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

function attribution(quote: QuotedMessage): string {
  const name = quote.from.displayName === undefined ? '' : oneLine(quote.from.displayName);
  const writer = name === '' ? quote.from.address : `${name} <${quote.from.address}>`;
  return `On ${formatLocalTime(quote.sentAt.toISOString(), TIMEZONE)}, ${writer} wrote:`;
}

/** The email's text and HTML: the body, the signature, and a reply's quote. */
export function renderEmail(content: EmailContent): RenderedEmail {
  const body = markdownHtml(content.markdown.replace(/\r\n?/gu, '\n').trim());
  const text = [plainText(body), '', '-- ', ...content.signature];
  let html = `<div dir="ltr">\n${body}\n<p>${content.signature.map(escapeHtml).join('<br>')}</p>\n</div>`;
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
