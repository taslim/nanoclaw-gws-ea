import { describe, expect, it } from 'vitest';

import { renderMarkdownToHtml } from './email.js';

describe('renderMarkdownToHtml', () => {
  it('renders bold markdown to <strong>', () => {
    expect(renderMarkdownToHtml('hello **world**')).toContain('<strong>world</strong>');
  });

  it('renders markdown links to anchor tags', () => {
    const html = renderMarkdownToHtml('[click](https://example.com)');
    expect(html).toContain('<a href="https://example.com">click</a>');
  });

  it('renders GFM tables to <table>', () => {
    const md = '| h1 | h2 |\n| --- | --- |\n| a  | b  |';
    const html = renderMarkdownToHtml(md);
    expect(html).toContain('<table>');
    expect(html).toContain('<th>h1</th>');
    expect(html).toContain('<td>a</td>');
  });

  it('renders unordered lists', () => {
    const html = renderMarkdownToHtml('- one\n- two');
    expect(html).toContain('<ul>');
    expect(html).toContain('<li>one</li>');
    expect(html).toContain('<li>two</li>');
  });

  it('renders blockquotes', () => {
    expect(renderMarkdownToHtml('> quoted')).toContain('<blockquote>');
  });

  it('returns empty string for empty input', () => {
    expect(renderMarkdownToHtml('')).toBe('');
    expect(renderMarkdownToHtml('   \n  ')).toBe('');
  });

  it('preserves raw HTML in the body (passthrough by design)', () => {
    // The agent is trusted; we allow raw HTML in markdown rather than
    // adding tokenizer overrides to strip it.
    const html = renderMarkdownToHtml('text with <em>inline html</em>');
    expect(html).toContain('<em>inline html</em>');
  });

  it('renders single newlines as <br> (breaks: true — email signature semantics)', () => {
    const html = renderMarkdownToHtml('Best,\nAlex Assistant\nEA to Jordan Principal');
    expect(html).toContain('<br>');
    // Two newlines → two breaks inside one paragraph.
    const breaks = html.match(/<br/g) ?? [];
    expect(breaks.length).toBe(2);
  });

  it('still splits on blank lines into separate paragraphs', () => {
    const html = renderMarkdownToHtml('paragraph one\n\nparagraph two');
    const paragraphs = html.match(/<p>/g) ?? [];
    expect(paragraphs.length).toBe(2);
  });
});
