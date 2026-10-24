import { parse, type DefaultTreeAdapterMap } from 'parse5';
import { fieldStreamOf, streamOf, type TextStream } from './match.js';

const TEXT_BOUNDARIES = new Set([
  'address',
  'article',
  'aside',
  'blockquote',
  'br',
  'dd',
  'details',
  'desc',
  'dialog',
  'div',
  'dl',
  'dt',
  'fieldset',
  'figcaption',
  'figure',
  'footer',
  'form',
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'header',
  'hr',
  'li',
  'main',
  'nav',
  'ol',
  'p',
  'pre',
  'script',
  'section',
  'style',
  'summary',
  'table',
  'td',
  'template',
  'text',
  'th',
  'title',
  'tr',
  'ul',
]);

/** Every source byte is shared, including invisible content, comments, templates and script text. */
export function htmlReadings(source: string): readonly TextStream[] {
  const text: string[] = [];
  const attributes: string[] = [];
  const comments: string[] = [];
  function visit(node: DefaultTreeAdapterMap['node']): void {
    const boundary = 'tagName' in node && TEXT_BOUNDARIES.has(node.tagName);
    if (boundary) text.push('\n');
    if ('value' in node) text.push(node.value);
    if ('data' in node) comments.push(node.data);
    if ('attrs' in node) attributes.push(...node.attrs.map(({ value }) => value));
    if ('childNodes' in node) for (const child of node.childNodes) visit(child);
    if ('tagName' in node && node.tagName === 'template') visit((node as DefaultTreeAdapterMap['template']).content);
    if (boundary) text.push('\n');
  }
  visit(parse(source));
  return [streamOf([source]), streamOf([text.join('')]), streamOf(text), fieldStreamOf(attributes), streamOf(comments)];
}
