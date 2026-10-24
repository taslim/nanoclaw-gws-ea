import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { ARTIFACT_STATIC_NOTICE, parseArtifactDocument } from './document.js';

describe('artifact document policy', () => {
  it('keeps information while removing every static executable surface and suppressing controls', () => {
    const document = parseArtifactDocument(
      '<!doctype html><html><head><style>body{color:#123}</style></head><body><h1>Forecast</h1><p>Base case: $42</p><button onclick="this.textContent=42">Calculate</button><script>document.title="executed"</script><svg><text>42</text></svg></body></html>',
    );
    expect(document.staticHtml).toContain('Base case: $42');
    expect(document.staticHtml).toContain('<text>42</text>');
    expect(document.scripted).toBe(true);
    expect(document.staticHtml).toContain('disabled=""');
    expect(document.staticHtml).toContain(ARTIFACT_STATIC_NOTICE);
    expect(document.staticHtml).not.toContain('<script');
    expect(document.staticHtml).not.toContain('onclick');
    expect(document.html).toContain('onclick');
  });
  it('keeps an entirely static document readable without claiming interactions are unavailable', () => {
    const document = parseArtifactDocument(
      '<!doctype html><h1>Decision brief</h1><p>Choose the local option.</p><details><summary>Evidence</summary><p>Nearby facts</p></details>',
    );
    expect(document.scripted).toBe(false);
    expect(document.staticHtml).toContain('<details>');
    expect(document.staticHtml).toContain('Nearby facts');
    expect(document.staticHtml).not.toContain(ARTIFACT_STATIC_NOTICE);
  });
  it('leaves controls on an unscripted page usable for CSS, without claiming they need another browser', () => {
    const document = parseArtifactDocument(
      '<!doctype html><label><input type="checkbox" id="nonstop"> Nonstop only</label><p>Flights</p>',
    );
    expect(document.scripted).toBe(false);
    expect(document.staticHtml).not.toContain('disabled');
    expect(document.staticHtml).not.toContain(ARTIFACT_STATIC_NOTICE);
  });
  it('reads a well-formed page language and otherwise falls back to English', () => {
    expect(parseArtifactDocument('<!doctype html><html lang="pt-BR"><p>Olá</p></html>').lang).toBe('pt-BR');
    expect(parseArtifactDocument('<!doctype html><html lang="en&quot;><x"><p>Hi</p></html>').lang).toBe('en');
    expect(parseArtifactDocument('<!doctype html><p>Hi</p>').lang).toBe('en');
  });
  it('keeps ordinary new-tab links on an unscripted page and lists their exact sources', () => {
    const document = parseArtifactDocument(
      '<!doctype html><a href="https://example.com/p?a=1&amp;b=2" target="_self" rel="opener">Evidence</a><a href="#detail">Detail</a><h2 id="detail">Details</h2>',
    );
    expect(document.sources).toEqual([{ id: 'source-1', label: 'Evidence', url: 'https://example.com/p?a=1&b=2' }]);
    expect(document.html).toContain(
      '<a href="https://example.com/p?a=1&amp;b=2" target="_blank" rel="noopener noreferrer">Evidence</a>',
    );
    expect(document.html).toContain('href="#detail"');
  });
  it('never puts an external href in a scripted page, handing each exact source to the viewer instead', () => {
    const document = parseArtifactDocument(
      '<!doctype html><a href="https://example.com/p">Evidence</a><script>document.title="x"</script>',
    );
    expect(document.sources).toEqual([{ id: 'source-1', label: 'Evidence', url: 'https://example.com/p' }]);
    expect(document.html).not.toContain('href="https:');
    expect(document.html).toContain('data-artifact-source="source-1"');
  });
  it('allows a bare phone number or one email address on an unscripted page only', () => {
    const document = parseArtifactDocument(
      '<!doctype html><a href="tel:+1 415-555-0148">+1 415-555-0148</a><a href="mailto:host@example.com">host@example.com</a>',
    );
    expect(document.sources).toEqual([]);
    expect(document.html).toContain(
      '<a href="tel:+1 415-555-0148" target="_blank" rel="noopener noreferrer">+1 415-555-0148</a>',
    );
    expect(document.html).toContain(
      '<a href="mailto:host@example.com" target="_blank" rel="noopener noreferrer">host@example.com</a>',
    );
    expect(() =>
      parseArtifactDocument('<!doctype html><a href="tel:+14155550148">Call</a><script>void 0</script>'),
    ).toThrow('without scripts');
    for (const href of [
      'mailto:host@example.com?body=private',
      'mailto:a@example.com,b@example.com',
      'tel:call-me',
      'tel:+1;ext=2',
    ])
      expect(() => parseArtifactDocument(`<!doctype html><a href="${href}">Contact</a>`), href).toThrow();
  });
  it('rejects oversized source and ambiguous duplicate HTML attributes before rendering', () => {
    expect(() => parseArtifactDocument('x'.repeat(4 * 1024 * 1024 + 1))).toThrow('4 MiB');
    expect(() => parseArtifactDocument('<!doctype html><div title="a" title="b">Text</div>')).toThrow(
      'duplicate-attribute',
    );
  });
  it('accepts the design skill starter page and modern scroll properties', () => {
    const starter = fs
      .readFileSync('container/skills/artifact-designer/starter.html', 'utf8')
      .replace('<title></title>', '<title>Plan</title><style>html{scroll-behavior:smooth}</style>')
      .replace('<main></main>', '<main><h1>Plan</h1></main>');
    expect(parseArtifactDocument(starter).staticHtml).toContain('<h1>Plan</h1>');
  });
  it.each([
    '<style>body{behavior:none}</style>',
    '<form><input></form>',
    '<iframe src="about:blank"></iframe>',
    '<base href="https://example.com">',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<script src="https://example.com/s.js"></script>',
    '<img src="https://example.com/p">',
    '<style>body{background:url(https://example.com)}</style>',
    '<style>@im/**/port "https://example.com";</style>',
    '<style>body{background:u\\72l(https://example.com)}</style>',
    '<a href="javascript:alert(1)">bad</a>',
    '<svg><animate attributeName="href" to="https://example.com"/></svg>',
  ])('rejects unsupported or remote features: %s', (source) => {
    expect(() => parseArtifactDocument(`<!doctype html>${source}`)).toThrow();
  });
});
